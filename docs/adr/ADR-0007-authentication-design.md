# ADR-0007 — Authentication Design (Auth.js v5)

**Date:** 2026-10-16
**Status:** Accepted; updated 00-03 auth closure
**Mission:** 00-03 (initial + auth closure)

## Updates in auth closure (00-03)

1. **Auth bootstrap isolation**: `src/lib/auth-bootstrap.ts` is the ONLY module that uses balance_admin (BYPASSRLS) for user/membership lookups. All other app code uses balance_app with RLS. See §"Auth bootstrap" below.

2. **Tenant switching fixed**: `switch-tenant` passes specific `tenantId` + `roleCode` via `unstable_update`. The jwt callback's "update" branch RE-VERIFIES the current tenantId (not reload first). See §"Tenant switching (fixed)" below.

3. **E2E tests**: Real HTTP route handler tests + DB-level privilege escalation tests. See §"Verification (updated)" below.

## Context

The Balance requires authentication for tenant-scoped operations. The founder directed:
- Real authentication via Auth.js
- No hard-coded admin backdoor
- Suspended/revoked cases must be handled
- Client cannot send arbitrary tenantId — must come from verified session

## Decision

### Auth.js v5 (NextAuth) with CredentialsProvider

- **Provider**: Credentials (email + password).
- **Password hashing**: bcrypt with cost factor 12.
- **Session strategy**: JWT (8-hour maxAge).
- **JWT claims**: `userId`, `tenantId`, `roleCode`, `membershipStatus`.

### Sign-in flow

1. Client POSTs email + password to `/api/v1/auth/signin`.
2. `authorize()` loads user by email (via `db` singleton, which uses `DATABASE_URL` = `balance_app`).
   - **Note**: At signin time, RLS context is not set. The `users` table RLS policy requires `app.user_id` to be set. So the signin query would return nothing.
   - **Solution**: The `db` singleton in `src/lib/db.ts` uses `DATABASE_URL` (balance_app). But for the signin lookup, we need to query `users` without RLS context. This is a chicken-and-egg problem.
   - **Resolution**: The `authorize()` function uses a dedicated admin PrismaClient for the user lookup. After authentication, all subsequent queries use `balance_app` with proper RLS context.
   - **Actually**: Looking at the code, `db` singleton uses `DATABASE_URL`. For signin, we need to query `users` by email without knowing the user_id yet. The RLS policy `user_self_read_balance_app` requires `id = current_setting('app.user_id')`. Without `app.user_id` set, the query returns nothing.
   - **Final approach**: `authorize()` uses a dedicated admin client (`DIRECT_URL`) for the user lookup. This is the auth bootstrap — after signin, the session carries `userId` which is used to set `app.user_id` in `withAuthenticatedTenant`.

3. Password verified via `bcrypt.compare`.
4. User status checked (`active` only).
5. Active membership loaded (first active membership).
6. JWT issued with `userId`, `tenantId`, `roleCode`, `membershipStatus`.

### Session refresh (revocation enforcement)

- On every session access, `jwt` callback can be triggered with `trigger === "update"`.
- The `withAuthenticatedTenant` helper also re-verifies membership in the DB.
- This catches revocation within the session's lifetime (not just at signin).

### Switch-tenant flow

1. Client POSTs `tenantId` to `/api/v1/auth/switch-tenant`.
2. Server VERIFIES the user has an active membership in the requested tenant (using admin client).
3. If verified, triggers `unstable_update({})` which refreshes the JWT.
4. The `jwt` callback reloads the membership from DB, picking up the new tenantId.
5. If not verified, returns 403.

**Security**: The client CANNOT switch to a tenant they're not a member of. The `tenantId` in the request is verified against the DB, not trusted.

### No hard-coded admin backdoor

- All users must authenticate via CredentialsProvider.
- No bypass accounts. No master passwords.
- User creation is an admin operation (via `balance_admin` role or a dedicated signup flow).

## Alternatives considered

### OAuth/OIDC providers (Google, GitHub)
- **Rejected for 00-03**: The Balance is for government use; external identity providers may not be appropriate. Credentials provider is the minimum viable auth. OIDC can be added in future missions if needed.

### Magic links (email-based)
- **Rejected**: Requires email infrastructure (SMTP). Out of scope for 00-03.

### WebAuthn (passkeys)
- **Considered**: Strong security, but adds complexity. Defer to a later mission.

### Custom JWT implementation
- **Rejected**: Founder directive: "use suitable ready-made libraries before developing new alternatives." Auth.js v5 is the maintained standard.

## Consequences

- **Positive**: Real authentication. No backdoors. Revocation enforced. Client cannot forge tenantId.
- **Negative**: Credentials provider requires careful password handling. JWT revocation is eventual (within session lifetime), mitigated by DB re-verification in `withAuthenticatedTenant`.
- **Future impact**: Adding OIDC in future missions is additive (new provider in the `providers` array). The JWT claims structure stays the same.

## Verification (planned for 00-03)

1. Login with correct credentials → succeeds.
2. Login with wrong password → fails (401).
3. Login with suspended user → fails (401).
4. Authenticated request sets correct tenant context.
5. Client sends different tenantId via switch-tenant → rejected if no membership.
6. Revoked membership → `withAuthenticatedTenant` throws.
7. Suspended user's session → `withAuthenticatedTenant` throws.

## Auth bootstrap (auth closure)

**Problem identified by founder:** `authorize()` used `db.user.findUnique()` (balance_app), but RLS on `users` requires `app.user_id` to be set. At signin time, we don't know the user yet. Same for `loadActiveMembership()`.

**Solution:** `src/lib/auth-bootstrap.ts` — a dedicated PrismaClient connected as balance_admin (BYPASSRLS), used ONLY for:
- `findUserByEmail(email)` — user lookup at signin
- `loadFirstActiveMembership(userId)` — initial membership for signin
- `loadMembershipForTenant(userId, tenantId)` — specific membership for switch-tenant
- `verifyUserActive(userId)` — re-check on session refresh

**Security:**
- This client is a singleton (one connection pool).
- It's used ONLY in auth-bootstrap.ts + auth.ts.
- All other app code uses `db` (balance_app) with RLS enforced.
- Queries are read-only (SELECT); no writes via this client.
- balance_admin has BYPASSRLS but is NEVER used for general queries.

**Why not a separate `balance_auth` role?**
- Considered: a role with SELECT on users + memberships only, no RLS.
- Rejected for 00-03: adds operational complexity (third role to manage).
- balance_admin (BYPASSRLS) is sufficient because:
  - It's already created for migrations.
  - The bootstrap queries are read-only + isolated to one module.
  - A future mission may introduce balance_auth if audit shows misuse.

## Tenant switching (fixed)

**Problem identified by founder:** `unstable_update({})` triggered the jwt callback's "update" branch, which reloaded the FIRST active membership by createdAt. So switching to Tenant B would still leave the session on Tenant A.

**Solution:**
1. `switch-tenant` calls `loadMembershipForTenant(userId, requestedTenantId)` to get the SPECIFIC membership.
2. `unstable_update({ tenantId, roleCode, membershipStatus })` passes the specific values.
3. The jwt callback's "update" branch:
   - RE-VERIFIES the user is still active (`verifyUserActive`).
   - RE-VERIFIES the CURRENT tenantId (not first) is still active (`loadMembershipForTenant`).
   - If revoked → clears tenant context.
   - If still active → keeps the tenantId, updates roleCode.

**This ensures:**
- Switching to Tenant B actually sets the session to Tenant B.
- The roleCode comes from Tenant B's membership, not Tenant A's.
- Revocation is caught on the next session refresh.
- The client cannot forge a tenantId (must have active membership).

## Verification (updated for auth closure)

### E2E HTTP tests (auth-e2e.integration.test.ts)
1. POST /signin with correct credentials → 200
2. POST /signin with wrong password → 401
3. POST /signin with suspended user → 401
4. GET /me without session → 401
5. switch-tenant: admin has analyst role in Tenant B (not admin)
6. switch-tenant: admin has admin role in Tenant A
7. switch-tenant: analyst cannot switch to Tenant B (no membership)
8. switch-tenant: revoked user has no active membership
9. withAuthenticatedTenant uses session's Tenant B, not first Tenant A

### DB-level privilege escalation tests
10. balance_app cannot INSERT membership (privilege escalation blocked)
11. balance_app cannot UPDATE users.status
12. balance_app cannot UPDATE users.email
13. balance_app CAN UPDATE users.name (non-sensitive)
14. balance_app cannot UPDATE memberships
15. balance_app cannot DELETE memberships
