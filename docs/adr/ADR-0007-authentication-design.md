# ADR-0007 — Authentication Design (Auth.js v5)

**Date:** 2026-10-16
**Status:** Accepted
**Mission:** 00-03

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
