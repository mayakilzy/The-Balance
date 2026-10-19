# The Balance — Multi-Agent Worklog

---
Task ID: G03-01-closure
Agent: GLM (implementation)
Task: Complete G03-01 FINAL ACCEPTANCE CLOSURE per reviewer directive (sections A-E).

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
