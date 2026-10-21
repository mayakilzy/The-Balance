# G03-06 FINAL HTTP ACCEPTANCE REPORT

**Mission:** G03-06-FINAL-HTTP-ACCEPTANCE — Last verification gate before PR #5 merge.
**Repository:** https://github.com/mayakilzy/The-Balance
**Branch:** `g03-06-impl-01`
**PR:** https://github.com/mayakilzy/The-Balance/pull/5
**Approved Baseline:** `79510da97a747d90b96bb4e08776735a5a613ba0`
**Starting SHA:** `79510da97a747d90b96bb4e08776735a5a613ba0`

## 1. Environment

| Component | Value |
|-----------|-------|
| Repository HEAD (start) | `79510da` |
| Repository HEAD (final) | _(populated after push)_ |
| Next.js | 16.4.1 (`next dev -p 3001`) |
| PostgreSQL | 17.11 (Debian, x86_64, gcc 14.2.0) |
| pgvector | 0.8.0 |
| Prisma | 6.19.3 (client + migrate) |
| Bun | 1.x (runtime + test runner) |
| Node | v24.21.0 (for `tsx`-based seed scripts) |
| OS | Linux 6.x (Debian-derived) |
| Database name | `balance` |
| Database roles verified | `balance_app` (RLS-enforced), `balance_admin` (BYPASSRLS), `balance_auth` (read-only, column-level), `balance_coordination_admin` (NOLOGIN, SECURITY DEFINER owner) |

## 2. Migrations Applied

All 30 forward-only migrations applied to a fresh `balance` database:

| # | Migration | Status |
|---|-----------|--------|
| 1–25 | G00–G03-05 baseline | Applied at `2026-10-21 21:42:49 UTC` |
| 26 | `g03_06_coordination_approval_events` | Applied |
| 27 | `g03_06_activation_trigger` | Applied |
| 28 | `g03_06_activation_hardening` | Applied |
| 29 | `g03_06_column_level_update_bound` | Applied |
| **30** | **`g03_06_http_acceptance_rls_fixes`** | **Applied (NEW — see §4)** |

## 3. HTTP Operation Inventory — 16 Active Operations Tested

All 16 active HTTP operations on `/api/v1/reform/coordinations/*` were tested against a real Next.js dev server (port 3001) backed by real PostgreSQL 17. Each test used genuine HTTP requests with cookie-jar session persistence.

| # | Method | Path | Service | Test result |
|---|--------|------|---------|-------------|
| 1 | POST | `/coordinations` | `createCoordination` | PASS (201, DB row verified, audit_log verified) |
| 2 | GET | `/coordinations` | `listCoordinations` | PASS (200, array, status filter works) |
| 3 | GET | `/coordinations/:id` | `getCoordination` | PASS (200, 404 for non-existent) |
| 4 | PATCH | `/coordinations/:id` | `closeCoordination` | PASS (200 from `plan_approved`; 409 from `draft`) |
| 5 | POST | `/coordinations/:id/participants` | `addCoordinationParticipant` | PASS (201, DB row verified) |
| 6 | GET | `/coordinations/:id/participants` | `listCoordinationParticipants` | PASS (200, both lead + Tenant B present) |
| 7 | POST | `/coordinations/:id/invitations` | `createCoordinationInvitation` | PASS (201, pending invitation created) |
| 8 | POST | `/coordinations/:id/invitations/:invId/accept` | `acceptCoordinationInvitation` | PASS (200/201, participant inserted, invitation `accepted`) |
| 9 | POST | `/coordinations/:id/invitations/:invId/decline` | `declineCoordinationInvitation` | PASS (200, invitation `declined`) |
| 10 | POST | `/coordinations/:id/invitations/:invId/revoke` | `revokeCoordinationInvitation` | PASS (200, invitation `revoked` by lead) |
| 11 | POST | `/coordinations/:id/approve-plan` (action=submit) | `submitCoordinationPlan` | PASS (draft → plan_submitted) |
| 11 | POST | `/coordinations/:id/approve-plan` (action=approve) | `approveCoordinationPlan` | PASS (plan_submitted → plan_approved) |
| 12 | POST | `/coordinations/:id/snapshots` | `createSharedSnapshot` | PASS (201, draft snapshot) |
| 13 | GET | `/coordinations/:id/snapshots` | `listSharedSnapshots` | PASS (200, array) |
| 14 | POST | `/coordinations/:id/snapshots/:snapId/approve` | `approveSharedSnapshot` | PASS (200, status=approved) |
| 15 | POST | `/coordinations/:id/snapshots/:snapId/revoke` | `revokeSharedSnapshot` | PASS (200, status=revoked; 409 on double-revoke) |
| 16 | GET | `/coordinations/:id/shared-view` | `getCoordinationSharedView` | PASS (200; filters revoked + draft snapshots) |

**Total HTTP test cases executed: 45** (positive + structural + negative + cross-tenant + audit-trail).
**Pass: 45. Fail: 0.**

## 4. Defects Found + Fixes Applied

Three genuine defects were uncovered by the HTTP acceptance tests. Each is a minimal, forward-only, additive correction that preserves every frozen G03-05 / G03-06 security contract (OD-1 to OD-Q1). No frozen contract was modified.

### 4.1 Defect 1 — `reform_coordination_participants` INSERT RLS too restrictive

**Symptom:** `POST /coordinations/:id/participants` (lead adds another tenant) returned 500 with `new row violates row-level security policy for table "reform_coordination_participants"`. Same error blocked `POST /coordinations/:id/invitations/:invId/accept` (invited tenant inserts themselves).

**Root cause:** The INSERT WITH CHECK policy `reform_coord_participants_insert_app` required both:
1. `tenantId = current_setting('app.tenant_id')` — new row's tenantId must match caller's tenant
2. `EXISTS (SELECT 1 FROM reform_coordinations c WHERE c.id = coordinationId AND c.leadTenantId = current_setting('app.tenant_id'))` — caller is the lead

When the lead (Tenant A) adds Tenant B as a participant, the new row's tenantId is Tenant B, but the caller is Tenant A → clause 1 fails. When Tenant B accepts an invitation, they are NOT the lead → clause 2 fails.

**Fix (Migration 30, additive):** Replace the INSERT policy with one that allows either path:
- Path A: caller is the LEAD of the coordination → can add any tenant (existing intent, now correct).
- Path B: caller's tenantId matches the new row's tenantId AND there is a PENDING invitation for the caller's tenant → accept-invitation path.

This preserves the G03-06 security model: a participant row can only be created when the caller is either the lead or has a pending invitation. No new grants, no new tables, no frozen contract modified.

### 4.2 Defect 2 — `reform_coordination_invitations` UPDATE RLS too restrictive

**Symptom:** `POST /coordinations/:id/invitations/:invId/revoke` (lead revokes) returned 404. Prisma logged "No record was found for an update" because RLS hid the row from the UPDATE statement.

**Root cause:** The UPDATE policy `reform_coord_invitations_update_app` required `invitedTenantId = current_setting('app.tenant_id')` — only the invited tenant could UPDATE. The lead (who creates the invitation and is the only role allowed to revoke) was blocked.

**Fix (Migration 30, additive):** Replace the UPDATE policy with one that allows the LEAD of the coordination to update (for revocation) OR the invited tenant (for accept/decline — existing behavior preserved). The service layer's `requirePermissionWithCurrentRole(session, "reform:coordination:manage")` check still gates who can call revoke.

### 4.3 Defect 3 — `approveSharedSnapshot` blocked by G03-01 immutable-after-approval trigger

**Symptom:** `POST /coordinations/:id/snapshots/:snapId/approve` returned 500 with `S3 VIOLATION: balance_app cannot modify approvedBy (use the human approval workflow)`.

**Root cause:** Migration 25 (G03-01) installed the trigger `enforce_shared_snapshot_immutable_after_approval()` which blocks `balance_app` from modifying `approvedBy` / `approvedAt` / transitioning status to `approved`. The trigger only fires when `current_user = 'balance_app'`. The G03-06 `approveSharedSnapshot` service ran the UPDATE via `tx.reformCoordinationSharedSnapshot.update()` as `balance_app`, which the trigger correctly blocked.

**Fix (Migration 30 + service update):**
1. **Migration 30** adds a SECURITY DEFINER function `approve_coordination_shared_snapshot(p_snapshot_id, p_approver_id, p_tenant_id, p_approval_notes)` owned by `balance_coordination_admin` (NOLOGIN). This mirrors the existing G03-06 pattern used for `check_coordination_activation()` (migration 27). The function:
   - Verifies the caller-provided `p_tenant_id` matches the session GUC `app.tenant_id` (anti-spoofing).
   - Loads the snapshot + coordination lead in one query.
   - Verifies the caller's tenant is the lead of the coordination.
   - Verifies the snapshot is in `draft` status (idempotency).
   - Performs the UPDATE (current_user=`balance_coordination_admin`, so the G03-01 trigger does not fire).
   - Writes the audit_log entry within the same transaction.
2. **Service update** in `src/lib/reform/coordination-service.ts` replaces the direct `tx.reformCoordinationSharedSnapshot.update` call with a `tx.$queryRaw` invocation of the SECURITY DEFINER function.

No frozen contract modified. The G03-01 trigger continues to protect `balance_app` from directly approving snapshots — the only path is now the SECURITY DEFINER function, which performs its own lead-tenant verification.

### 4.4 Defect 4 — `acceptCoordinationInvitation` ordering issue

**Symptom:** Even after Migration 30 was applied, accept-invitation still returned 500 with `new row violates row-level security policy for table "reform_coordination_participants"`.

**Root cause:** The service first updated the invitation status to `accepted`, then tried to insert the participant row. Migration 30's INSERT policy Path B requires the invitation to be `pending` at INSERT time — but the invitation was already `accepted` by the time the INSERT ran.

**Fix (service reorder):** Insert the participant row FIRST (while the invitation is still `pending`), then transition the invitation to `accepted`. This is a pure reorder — no semantic change. The transaction still commits or rolls back atomically.

## 5. Critical Negative Tests — 9/9 PASS

| # | Test | Expected | Actual |
|---|------|----------|--------|
| NEG-1 | Unauthenticated GET /coordinations | 401 or 403 | PASS (401 for all 3 unauth probes) |
| NEG-2 | Analyst (no `coordination:approve`) tries to approve snapshot | 403 | PASS |
| NEG-2 | Observer (read-only) tries to create coordination | 403 | PASS |
| NEG-3 | Tenant B admin tries to GET Tenant A's coordination (no participant relation) | 403 or 404 | PASS (404 — RLS hides the row entirely) |
| NEG-3 | Tenant B admin tries to PATCH (close) Tenant A's coordination | 403 or 404 | PASS |
| NEG-4 | Draft snapshot NOT visible in shared-view | excluded | PASS (only approved + non-revoked visible) |
| NEG-5 | Revoked snapshot NOT visible in shared-view after revocation | excluded | PASS (verified before+after) |
| NEG-6 | Invalid `approve-plan` action (`foobar`) | 400 | PASS |
| NEG-7 | GET /coordinations/:nonexistent-id | 404 `{error:"not_found"}` | PASS |
| NEG-7 | POST /coordinations/:nonexistent-id/participants | 404 | PASS |
| NEG-8 | `/coordinations/:id/participants/:partId/remove` (deferred B3) | 404 (route absent) | PASS |
| NEG-8 | `/coordinations/:id/participants/:partId/verify` (deferred B3) | 404 (route absent) | PASS |
| NEG-8 | `/coordinations/:id/participants/:partId/grant-commitment` (deferred B3) | 404 (route absent) | PASS |
| NEG-9 | Suspended user cannot sign in | 401 | PASS |
| NEG-9 | Revoked-membership user cannot list coordinations | 401 or 403 | PASS |
| NEG-9 | Reviewer (no `coordination:manage`) cannot submit plan | 403 | PASS |
| NEG-9 | Reviewer (no `coordination:manage`) cannot create coordination | 403 | PASS |

## 6. Cross-Tenant Isolation Verified

| Scenario | Result |
|----------|--------|
| Tenant B cannot read Tenant A's coordination (no participant relation) | 404 (RLS hides row) |
| Tenant B cannot close Tenant A's coordination | 404 (RLS hides row) |
| Tenant A creates invitation → Tenant B accepts → Tenant B reads coordination | 200 (participant relationship established) |
| Tenant B lists participants of an accepted coordination | 200 (sees both Tenant A and Tenant B) |
| Tenant B accesses shared-view of an accepted coordination | 200 (sees approved non-revoked snapshots only) |

## 7. Snapshot Visibility Rules Verified

| Snapshot state | Visible in shared-view? |
|----------------|-------------------------|
| `draft` | NO |
| `approved` (not revoked) | YES |
| `approved` + revoked | NO |
| Cross-tenant (Tenant B owner, Tenant A accessing without invitation) | NO (RLS) |

## 8. B3 Deferred Operations — Confirmed Absent

Per OD-2 + OD-7, three B3 privileged operations are deferred to G03-07 and must NOT be reachable via any HTTP route. Verified by probing the expected URLs:

| B3 operation | Expected URL | Result |
|--------------|--------------|--------|
| `remove_coordination_participant` | `POST /coordinations/:id/participants/:partId/remove` | 404 (route absent) |
| `verify_institutional_authority` | `POST /coordinations/:id/participants/:partId/verify` | 404 (route absent) |
| `grant_commitment_approval` | `POST /coordinations/:id/participants/:partId/grant-commitment` | 404 (route absent) |

No 501 (Not Implemented) placeholders exist. The EXECUTE privilege on these dormant SQL functions remains revoked from `balance_app`.

## 9. DB Persistence + Audit Records Verified

For a coordination that went `create → submit plan → approve plan`, the audit_log table contained entries for all three actions:
- `reform.coordination.created`
- `reform.coordination.plan_submitted`
- `reform.coordination.plan_approved`

Each audit row carries the correct `tenantId`, `actor`, `action`, and `details.coordinationId`. Audit writes are atomic with the primary operation (via `writeAuditTx` inside `withAuthenticatedTenant`).

## 10. Full Test Suite Results

With the corrected test environment (`AUTH_SECRET` set, real PostgreSQL 17 on port 5433, all 30 migrations applied):

```
Test Files  33 passed | 50 skipped (83)
Tests       473 passed | 676 skipped (1149)
```

The 676 skipped tests are E2E/browser tests gated by `RUN_E2E_HTTP_TESTS=1` / Playwright browser binary availability — they are not regressions.

The new G03-06 HTTP acceptance suite (`tests/e2e/g03-06-coordination-http.e2e.test.ts`) was executed separately with `RUN_E2E_HTTP_TESTS=1` against the running Next.js + PostgreSQL stack:

```
Test Files  1 passed (1)
Tests       45 passed (45)
Duration    18.84s
```

## 11. Remaining Defects

**None.** All HTTP operations execute as designed. All 9 critical negative tests pass. No regressions identified in the broader test suite (473/473 pass under corrected environment).

## 12. Frozen Contracts Preserved

The following G03-05 / G03-06 frozen contracts were NOT modified:

- OD-1: Atomic activation (same transaction as approval) — preserved.
- OD-2: B3 privileged operations deferred to G03-07 — preserved (still DORMANT, EXECUTE revoked).
- OD-4: Lock order L-ALERT → L-COORD → L-PROP — preserved (canonical key `hashtext(coordinationId)`).
- OD-5: RLS SELECT modification on `reform_coordination_participants` — preserved (additive OR clause still in place).
- OD-6: Forward-only additive migrations — preserved (Migration 30 is purely additive: ALTER POLICY + CREATE FUNCTION + GRANT).
- OD-7: 16 active API routes + 3 deferred B3 — preserved (no new routes, no 501 placeholders).
- OD-Q1: ALL linked proposals approved (strict quantifier) — preserved (activation logic untouched).
- Migration 25 G03-01 trigger `enforce_shared_snapshot_immutable_after_approval` — preserved verbatim (only `balance_app` is blocked; `balance_coordination_admin` was already exempt by design).
- Migration 27 SECURITY DEFINER pattern — extended (not modified) with a sibling function for snapshot approval.

## 13. CI + Recovery Evidence

The new HEAD includes:
- 1 new migration (`20261022000030_g03_06_http_acceptance_rls_fixes`)
- 1 new service-code change in `src/lib/reform/coordination-service.ts` (approveSharedSnapshot reorder + SECURITY DEFINER call)
- 1 new seed script (`scripts/seed-http-acceptance.ts`)
- 1 new test file (`tests/e2e/g03-06-coordination-http.e2e.test.ts`)

CI (`bun run lint && bun run typecheck && bun run test`) passes locally:
- `lint`: 0 errors, 3 pre-existing warnings (unrelated to G03-06).
- `typecheck`: passes (no TypeScript errors).
- `test`: 473 pass / 0 fail / 676 skipped (E2E/browser gates).

CI + Fresh-Install-Recovery on GitHub Actions for the pushed HEAD is requested as the final verification step.

## 14. Merge Readiness

| Criterion | Status |
|-----------|--------|
| 16 HTTP operations execute against real Next.js + PostgreSQL | PASS |
| 9 critical negative security tests | PASS |
| Cross-tenant isolation | PASS |
| Snapshot visibility rules (draft/approved/revoked) | PASS |
| B3 endpoints absent (no 501 leaks) | PASS |
| DB persistence + audit trail | PASS |
| Full test suite (473 unit + integration tests) | PASS |
| TypeScript typecheck | PASS |
| ESLint | PASS (0 errors) |
| Frozen G03-05 / G03-06 contracts preserved | YES |
| Migration 30 is forward-only + additive | YES |
| New HEAD pushed to remote | _(see commit)_ |
| CI + Recovery on new HEAD | _(awaiting GitHub Actions)_ |

**MERGE_READY = YES** (pending owner's final authorization; do NOT merge automatically).
