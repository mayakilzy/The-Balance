# The Balance — Multi-Agent Worklog

---
Task ID: G03-01-ci-fix
Agent: GLM (implementation)
Task: Fix CI failure — G03-01 SQL acceptance suite failed in GitHub Actions (exit code 3).

Work Log:
- Retrieved CI failure: GitHub Actions run 39190016243 failed at step
  "G03-01 SQL acceptance suite (real PG, real migration chain)" with exit code 3
  (psql ON_ERROR_STOP abort).
- Reproduced in clean local environment: created `balance_ci_repro` database,
  applied canonical setup-roles.sql + all 25 migrations + seed, then ran the
  exact CI command. Got the precise failure:
    ERROR: insert or update on table "reform_coordinations" violates
    foreign key constraint "reform_coordinations_leadTenantId_fkey"
    DETAIL: Key (leadTenantId)=(cmveksd72000copg0lim5xiiw) is not present
    in table "tenants".
- Root cause: the SQL script hardcoded tenant cuid() values from the local
  dev environment (`cmveksd72000copg0lim5xiiw`, `cmveksd74000eopg0p1tbcda0`).
  In CI, prisma cuid() generates DIFFERENT tenant IDs (e.g.
  `cmvendrwt000coptmtva3rvy2`, `cmvendrwv000eoptmo1ks5y1t`), so every
  INSERT that used a hardcoded tenant ID failed the FK constraint.
- Fix: added two session-scoped (pg_temp) SECURITY DEFINER helper functions
  that look up tenant IDs by their stable `code` field:
    pg_temp.tenant_a_id() → SELECT id FROM tenants WHERE code = 'DML-MOP-TENANT'
    pg_temp.tenant_b_id() → SELECT id FROM tenants WHERE code = 'DML-CB-TENANT'
  Replaced all 40 hardcoded tenant ID references with dynamic function calls.
  pg_temp = session-scoped: functions auto-dropped when psql session ends,
  leaving NO permanent objects behind.
  SECURITY DEFINER: functions execute as the script owner (postgres superuser),
  bypassing RLS — so they return the correct ID even when the current role
  is `balance_app` (which may be subject to RLS on tenants).
- Added fail-fast verification block at the top: if either helper returns NULL
  (seed didn't run), the script aborts immediately with a clear message.
- Verified fix on BOTH databases:
    balance_g03_test (original local): 25/25 PASS, exit 0
    balance_ci_repro (fresh CI repro):  25/25 PASS, exit 0
- Verified rerunnability: ran script twice on CI-repro — both 25/25 PASS.
- Verified safe execution (directive D item 4):
    0 leftover `fa-` fixtures after run (cleanup effective)
    All 14 triggers `tgenabled = O` (enabled — none left disabled)
    current_user = postgres (no leftover role from SET ROLE)
- Verified no regressions:
    Integration tests: 14/14 PASS
    Unit tests: 291/291 PASS
    Lint: 0 errors
    Typecheck: PASS
    Seed idempotency: PROVEN (2 runs, 0 duplicates, 0 overwrites)

Stage Summary:
- CI failure root cause: hardcoded tenant cuid() values that only exist in
  the local dev environment, not in CI's freshly-seeded database.
- Fix: dynamic tenant ID lookup via pg_temp SECURITY DEFINER helper functions.
- Files modified: scripts/g03-security-validation/g03_01_final_acceptance_rev2.sql
                  scripts/g03-security-validation/g03_01_final_acceptance_rev2_results.txt
                  scripts/g03-security-validation/g03_01_integration_results.txt
- No security protections weakened.
- No migrations rewritten.
- No DEFINER functions activated.
- No 03-02 work started.

Work Log:
- A. Migration 0025: extended `enforce_shared_snapshot_immutable_after_approval()`
  trigger to independently protect 5 fields/conditions:
  - `approvedBy` (approval metadata — who approved)
  - `approvedAt` (approval metadata — when approved)
  - status transition INTO 'approved' (human approval workflow gate)
  - `ownerTenantId` (snapshot ownership is immutable identity)
  - `coordinationId` (coordination association is immutable identity)
  Forward-only, smallest correction. No new tables, no policy changes, no
  privilege grants/revokes. DEFINER functions remain DORMANT.
- A. Rewrote SA-03 into 6 INDEPENDENT sub-tests (SA-03a..SA-03f). Each
  modifies ONE field only, asserts (i) denial raised and (ii) persisted
  data UNCHANGED. Eliminates the previous bundled-test ambiguity.
- B. Extended `prisma/seed-ontology.ts` with idempotent G03 reform entities:
  - 1 proposal → 1 alternative → 1 approval (append-only) → 1 action →
    1 action update (append-only) → 1 verification → 1 feedback loop
  - 1 multi-institution coordination: Tenant A leads + Tenant B participates
  - 1 approved shared snapshot + 1 revoked snapshot (with revocation record)
  Pattern: append-only tables use `findFirst + create` (no upsert —
  `prevent_historical_update` trigger blocks UPDATE for ALL roles
  unconditionally per migration 0024).
- B. Proved idempotency: ran `bunx tsx prisma/seed-ontology.ts` twice.
  All G03 entities showed "already exists" on the second run.
  Row counts after 2 runs: 12 entities × count=1 (snapshots=2: 1 approved
  + 1 revoked — INTENTIONAL). NO duplicates, NO overwrites.
- C. Wrote `tests/integration/g03-01-security.integration.test.ts` (14 tests,
  reproducible against PostgreSQL 16 + real production migration chain):
  - I-01..I-02: coordination membership (positive + negative)
  - I-03..I-04: authority-field protection (canApproveCommitments +
    verifiedInstitutionId — D15 institutional authority separation)
  - I-05..I-06: snapshot revocation (non-owner invisible + owner audit)
  - I-07..I-08: append-only enforcement (DELETE + UPDATE blocked)
  - I-09..I-10: cross-tenant FK integrity (tenantId match required)
  - I-11..I-12: approval metadata protection (approvedBy + status transition)
  - I-13: DEFINER functions DORMANT (EFFECTIVE direct call denied)
  - I-14: INVOKER functions EFFECTIVE (direct call succeeds)
- D. Added CI step "G03-01 SQL acceptance suite (real PG, real migration chain)"
  in `.github/workflows/ci.yml`. Runs `g03_01_final_acceptance_rev2.sql`
  against the real PostgreSQL 16 service after migrations + seed have
  completed. `ON_ERROR_STOP=1` — fails with nonzero exit on any incorrect
  behavior.
- D. Validated test quality (directive D):
  - Tests FAIL with nonzero exit when behavior is incorrect (verified
    by temporarily breaking the trigger — 4 SQL tests failed with exit
    code 3, 2 integration tests failed).
  - Tests verify rejected operations AND unchanged persisted data (every
    negative test has both `raised=TRUE` AND `value unchanged` assertions).
  - EXECUTE privilege checked via EFFECTIVE direct calls (FN-04 attempts
    `PERFORM remove_coordination_participant(...)` and asserts raise;
    FN-05 attempts `SELECT is_snapshot_revoked(...)` and asserts success).
  - Migration state checked via `finished_at IS NOT NULL` (PM-01/PM-02),
    not just migration-name presence.
  - Tests rerunnable without leaving fixtures behind (verified by running
    integration test twice — 14/14 pass both times).
- E. Final delivery captured in:
  - `scripts/g03-security-validation/g03_01_final_acceptance_rev2.sql`
    (25 tests, replaces `g03_01_final_acceptance.sql`)
  - `scripts/g03-security-validation/g03_01_final_acceptance_rev2_results.txt`
  - `scripts/g03-security-validation/g03_01_seed_idempotency.txt`
  - `scripts/g03-security-validation/g03_01_integration_results.txt`
  - `tests/integration/g03-01-security.integration.test.ts`
  - `prisma/migrations/20261019000025_g03_01_approval_metadata_protection/`
  - `prisma/seed-ontology.ts` (extended)
  - `.github/workflows/ci.yml` (added G03-01 SQL acceptance step)

Stage Summary:
- G03-01 SQL acceptance suite: 25/25 PASS (exit code 0)
- G03-01 integration test suite: 14/14 PASS (rerunnable — verified twice)
- G03-01 seed idempotency: PROVEN (2 runs, 0 duplicates, 0 overwrites)
- Migration 0025: applied, verified, registered in `_prisma_migrations`
- Trigger function protects 5 fields independently (TRIG-01 PASS)
- DEFINER functions remain DORMANT (FN-01, FN-04 PASS)
- All 24 prior migrations remain unchanged (forward-only)
- 291 unit tests pass (no regressions)
- G01 integration test failures are PRE-EXISTING (verified via git stash —
  same 6 fail with or without my changes; root cause is `audit_log RLS
  policy` issue in test env, unrelated to G03-01)

Constraints honored:
- DEFINER functions remain DORMANT (REVOKE not reversed)
- No `app.service_context` / `app.migration_mode` as authorization controls
- No rewriting of applied migrations 0022/0023/0024 (0025 is forward-only addition)
- G00/G01/G02 frozen (no changes to their files)
- No 03-02 services or API routes added
- Forward-only migration policy preserved

---
Task ID: G03-01-final-pass
Agent: GLM (implementation)
Task: Acknowledge FINAL PASS decision and freeze G03-01 baseline.

Work Log:
- Received owner FINAL PASS decision for G03-01.
- Confirmed accepted implementation SHA: 79c33e7e557ee819ba13043b89a2b99efc940acc
- Verified G03 migration chain (0022-0025) all applied with finished_at NOT NULL.
- Verified FINAL PASS evidence is recorded:
    SQL acceptance: 25/25 PASS
    G03 integration: 14/14 PASS
    GitHub CI: SUCCESS (run 39191487553)
    Fresh Install + Recovery: SUCCESS (run 39191487533)
- Frozen baseline established. G03-01 will not be reopened without
  evidence of a material defect.

Stage Summary:
- G03-01 = FINAL PASS — CLOSED
- Retained implementation dependencies (per reviewer directive):
    * C2 authenticated tenant-context trust boundary
    * Safe activation of privileged administrative operations
    * Atomic audit for institutional decisions
    * Production deployment controls
    * Isolation of privileged test cleanup to disposable databases
- Critical SECURITY DEFINER functions remain DORMANT (preserve until
  verified service layer exists in 03-02+).
- Privileged SQL acceptance script (uses ALTER TABLE DISABLE TRIGGER
  + SECURITY DEFINER helpers) must remain restricted to disposable
  test databases — NEVER run on production data.
- G03-02 = NOT AUTHORIZED YET. Awaiting separate owner authorization.
