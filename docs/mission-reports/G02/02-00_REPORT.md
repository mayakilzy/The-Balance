# Mission 02-00 Report — G02 State Observatory Bootstrap (Vertical Slice)

```text
MISSION_ID = 02-00
TARGET_GROUP = GROUP 02 (State Observatory)
BASE_COMMIT = 51409a09fccdae807b329c750df0632c8f39d664
FINAL_COMMIT = 6672460e79e0e18745f1c492555bd68b33e5549b (on main)
WORKTREE = clean (mission-02-00 branch merged to main)
```

## DELIVERED

### Schema & Migrations
- `prisma/schema.prisma` — 5 new models (IndicatorDefinition, ObservationPeriod, Observation, VarianceRecord, Alert) + reverse relations on 6 G00/G01 models (Tenant, Objective, Program, StrategyVersion, Source, Evidence).
- `prisma/migrations/20261018000021_g02_observatory_bootstrap/migration.sql` — CREATE TABLE for all 5 tables + FK constraints + ownership/grants + RLS ENABLE+FORCE + RLS policies (balance_app + balance_admin) + F1 partial unique index with COALESCE + F3 chain integrity trigger (branching check gated on TG_OP + supersedesId change).

### Source Code (`src/lib/state-observatory/`)
- `contracts.ts` — Zod schemas for AlertThresholdRule, PeriodMilestone, DefineIndicatorInput, IngestObservationInput (with superRefine for originType→sourceId/derivationMethod), CorrectionInput, UpdateExecutionStatusInput (F6: verifiedAction + evidenceSource required when verified), VerifyExecutionInput. Plus type re-exports from Prisma.
- `threshold-evaluator.ts` — Pure deterministic function for evaluating structured alert thresholds. NO eval(), NO new Function(), NO vm. Explicit switch on metric/operator. Max 2 rules with and/or logic. severityMax helper.
- `indicator-registry-service.ts` — defineIndicator + listIndicators + retireIndicator. Validates strategyVersionId is approved in tenant, objectiveId/programId belong to tenant, E6 sourceRef prefix check (synthetic:demolandia-).
- `observation-service.ts` — ingestObservation + correctObservation (F2 atomic order: SELECT FOR UPDATE → UPDATE old isCurrent=false → INSERT new → UPDATE old supersededById=new.id → writeAuditTx) + listObservations + getCurrentObservation. E3 cross-country geoRefId rejection for institutional level.
- `variance-service.ts` — computeVariance (R2: periodMilestone first → defaultTargetValue → none) + listVariance. F4: plannedValueSourceKind/SourceId nullable when plannedValueType="none". attributionLevel="descriptive" always.
- `alert-service.ts` — evaluateAndRaise (R3+E5: returns null when alertThresholds=[]) + markReviewed + documentDecision (R5: documents decision, does NOT change executionStatus) + updateExecutionStatus + verifyExecution (F6: requires verifiedAction + evidenceSource; does NOT change lifecycleStage) + closeAlert (does NOT require executionStatus=verified).
- `index.ts` — barrel exports.

### Permissions (`src/lib/permissions.ts`)
8 new permissions added across 4 roles:
- `observatory:indicator:read` (observer, analyst, reviewer, admin)
- `observatory:indicator:write` (analyst, admin)
- `observatory:observation:read` (observer, analyst, reviewer, admin)
- `observatory:observation:ingest` (analyst, admin)
- `observatory:variance:read` (observer, analyst, reviewer, admin)
- `observatory:alert:read` (observer, analyst, reviewer, admin)
- `observatory:alert:review` (reviewer, admin)
- `observatory:alert:act` (reviewer, admin)

### Tests
- `tests/unit/state-observatory/contracts.test.ts` — 36 Zod schema validation tests.
- `tests/unit/state-observatory/threshold-evaluator.test.ts` — 23 pure function tests + U-18 code audit.
- `tests/unit/state-observatory/indicator-registry-service.test.ts` — 10 unit tests.
- `tests/unit/state-observatory/observation-service.test.ts` — 14 unit tests (F2 transaction order + E3).
- `tests/unit/state-observatory/variance-service.test.ts` — 14 unit tests (R2 + F4 + direction logic).
- `tests/unit/state-observatory/alert-service.test.ts` — 16 unit tests (R5 + F6 + lifecycle).
- `tests/integration/g02-t2-slice.integration.test.ts` — 14 integration tests with 60+ DB-level assertions (I-01..I-14).

### Documentation
- `docs/mission-reports/G02/02-00_REPORT.md` — this file.
- `docs/mission-reports/G02/02-00_KNOWN_LIMITATIONS.md` — 11 known limitations.
- `docs/mission-reports/G02/GROUP_02_READINESS_HANDOFF.md` — updated to reflect 02-00 completion.

## TEST_COMMANDS

```
bun run lint && bun run typecheck && bun run test
```

### Actual CI runtime output (CI #141 on 6672460)

```
✓ lint: PASS (0 errors, 3 pre-existing G00 warnings)
✓ typecheck: PASS
✓ test: 679 passed | 10 skipped | 0 failed
✓ Playwright: 5 passed | 2 flaky (passed on retry) | 0 failed
```

### CI + Recovery URLs (verified by owner)

- **CI #141**: https://github.com/mayakilzy/The-Balance/actions/runs/39080612585 — SUCCESS
- **Recovery #79**: https://github.com/mayakilzy/The-Balance/actions/runs/39080612604 — SUCCESS

## LIVE_EVIDENCE

### real (verified on CI with real PostgreSQL 16)
- ✅ All 21 migrations (G00 + G01 + G02) apply successfully.
- ✅ RLS ENABLE + FORCE on all 5 new G02 tables (verified by migration's DO $$ block using pg_class).
- ✅ 10 RLS policies (2 per table — balance_app + balance_admin).
- ✅ F1 partial unique index with COALESCE(geo_ref_id, '') protects NULL geo_ref_id (verified by I-12).
- ✅ F3 chain integrity trigger enforces anti-branching + anti-cycle + scope matching (verified by I-04 concurrent correction conflict).
- ✅ F2 correctObservation atomic transaction order (verified by I-03 + I-14).
- ✅ F4 plannedValueSourceKind/SourceId nullable when plannedValueType="none" (verified by I-13).
- ✅ F6 verifyExecution requires verifiedAction + evidenceSource (verified by I-02 + I-08).
- ✅ R5 lifecycleStage and executionStatus are independent (verified by I-02 full lifecycle).
- ✅ R1 originType and verificationStatus are independent (verified by I-11).
- ✅ R2 periodMilestone-first resolution (verified by I-01 + I-13).
- ✅ R3 empty alertThresholds → no alert (verified by I-01).
- ✅ E5 no eval/Function/vm/child_process in any state-observatory module (verified by U-18 code audit).
- ✅ E6 all Demolandia sourceRef start with "synthetic:demolandia-" (validated by Zod + service).
- ✅ writeAuditTx used atomically inside withAuthenticatedTenant in all 4 services (verified by I-08 — 10 audit actions recorded).
- ✅ StrategyVersion immutability — no G02 service modifies it (verified by I-05).
- ✅ Cross-tenant RLS isolation (verified by I-06).
- ✅ Revoked membership → denied + no DB write (verified by I-07).
- ✅ Correction history preserved — no deletion (verified by I-14 — 3 versions after 2 corrections).
- ✅ `src/lib/state-builder/` diff = 0 — no GROUP 01 code modified.
- ✅ No new dependencies in package.json.

### mocked
- None — all services are implemented (no NotImplementedError, no interfaces-only per E1).

### Expected negative-test behavior (NOT defects)
- `AUDIT_WRITE_FAILED` log messages: These appear in `health.integration.test.ts` and Playwright browser tests. The health endpoint is unauthenticated, so `writeAudit()` (best-effort, non-transactional) fails because no tenant context is set. This is BY DESIGN — the G00 audit module swallows errors and continues (best-effort audit pattern). The health check itself succeeds, and the test passes. `writeAuditTx()` (transactional, used by G02 services) throws on failure — this is the atomic pattern G02 relies on.
- `prisma:error` messages with code 42501 (permission denied): These appear in `auth-e2e.integration.test.ts` negative tests that verify `balance_app` cannot INSERT/UPDATE/DELETE on privilege-escalation tables (users, memberships). The errors are EXPECTED — the tests assert that Prisma throws, proving RLS + role privileges work correctly.
- Playwright "2 flaky" tests: Two browser tests (admin login + mobile viewport screenshot) timed out on first attempt but passed on retry #1. The CI workflow has `retries: 1` in playwright.config.ts. Final result: 5 passed, 0 failed. The flakiness is a pre-existing G00 UI issue (Next.js SSR/client hydration mismatch), NOT related to 02-00.
- `Hydration failed` browser warnings: Pre-existing G00 Next.js SSR/client mismatch. Not related to 02-00 (no G02 UI shipped).

### not tested
- ❌ Browser UI for State Observatory (G02-L03 — deferred per Known Limitation #7).
- ❌ External integrations HTTP/Email/SMS (G02-L05 — out of scope).
- ❌ LLM calls (G02-L06 — Blueprint forbids causal claims; attributionLevel="descriptive" always).
- ❌ Real data integration (G02-L04 — Demolandia only).
- ❌ Forced audit failure injection (G02-L07 — requires mocking Prisma transaction client).

## SECURITY_CHECKS

- **authz**: 8 new observatory:* permissions + 19 requirePermissionWithCurrentRole calls across 4 services.
- **tenant isolation**: RLS ENABLE + FORCE on all 5 new tables; RLS policies use `current_setting('app.tenant_id', true)`; all service calls go through `withAuthenticatedTenant`. Verified by I-06 (cross-tenant isolation).
- **geo-scope isolation** (E3): institutional geoRefId verified to belong to tenant's country. Verified by I-12.
- **secrets**: no new secrets introduced.
- **unsafe inputs**: Zod schemas on every service input.
- **no-eval audit** (U-18): source code of all 7 state-observatory modules grep-audited for eval/Function/vm/child_process.
- **F1 NULL-safe uniqueness**: partial unique index uses `COALESCE(geo_ref_id, '')`. Verified by I-12.
- **F2 atomic correction**: SELECT FOR UPDATE → deactivate old → insert new → link → audit. Verified by I-03 + I-04 + I-14.
- **F3 chain integrity**: trigger forbids branching (gated on INSERT or supersedesId change), cycles, self-reference, mismatched scope. Verified by I-04.
- **F4 null safety**: plannedValueSourceKind/SourceId nullable. Verified by I-13.
- **F6 semantic safety**: verifyExecution requires verifiedAction + evidenceSource. Verified by I-02 + I-08.
- **R5 separation**: lifecycleStage and executionStatus are independent. Verified by I-02.
- **StrategyVersion immutability**: G02 services reference StrategyVersion as read-only FK; no UPDATE calls to strategy_versions table. Verified by I-05.

## CONTRACT_CHANGES

- **backward compatible**: YES — additive only.
  - New tables: indicator_definitions, observation_periods, observations, variance_records, alerts.
  - No existing G00/G01 columns modified.
  - Reverse relations added on G00/G01 models (no field changes).
- **migrations**: new migration `20261018000021_g02_observatory_bootstrap`.
- **StrategyVersion**: read-only FK reference, never modified by any G02 service.
- **G00/G01 code**: zero modifications — `src/lib/state-builder/` diff = 0 (verified by owner's independent git diff).
  - `src/lib/permissions.ts` extended (additive only — no existing permission removed).

## OPEN_DEFECTS

None.

### Pre-existing G00 issues (NOT introduced by 02-00, NOT fixed by 02-00)
1. `tests/unit/error-sanitizer.test.ts` fails locally (missing AUTH_SECRET env var) but passes in CI (AUTH_SECRET set in workflow). Root cause: G00 test imports env at module-load time; Vitest doesn't auto-load .env. Action: log as G00 known issue for future hardening.
2. Playwright "2 flaky" tests (admin login + mobile viewport screenshot) — pre-existing G00 Next.js SSR/client hydration mismatch. Not related to 02-00.
3. `AUDIT_WRITE_FAILED` log messages in health.integration.test.ts — BY DESIGN (best-effort audit pattern in G00 writeAudit). Not a defect.

## DECISION_REQUESTS

None. All 34 architectural and execution decisions (Q1-Q15 + R1-R5 + E1-E8 + F1-F6) are frozen and implemented as specified.

## ACCEPTANCE

**PASS**

### Verified on CI (real PostgreSQL 16) — 2026-10-17
1. ✅ CI #141 — SUCCESS (https://github.com/mayakilzy/The-Balance/actions/runs/39080612585)
2. ✅ Recovery #79 — SUCCESS (https://github.com/mayakilzy/The-Balance/actions/runs/39080612604)
3. ✅ Vitest: 679 passed | 10 skipped | 0 failed
4. ✅ Playwright: 5 passed | 2 flaky (passed on retry) | 0 failed
5. ✅ `src/lib/state-builder/` diff = 0 — no GROUP 01 code modified
6. ✅ All 5 G02 tables with RLS ENABLE + FORCE
7. ✅ F1 NULL-safe unique index verified
8. ✅ F3 chain integrity trigger verified (anti-branching + anti-cycle)
9. ✅ F2 atomic correction transaction verified
10. ✅ F4 nullable plannedValueSource verified
11. ✅ F6 verifyExecution semantic verified
12. ✅ R1 originType/verificationStatus separation verified
13. ✅ R2 periodMilestone-first resolution verified
14. ✅ R3 no auto-alert without thresholds verified
15. ✅ R5 lifecycle/execution independence verified
16. ✅ E5 no eval/Function/vm/child_process verified
17. ✅ E6 synthetic:demolandia- prefix enforced
18. ✅ writeAuditTx atomic for all operations verified
19. ✅ StrategyVersion immutability verified
20. ✅ Cross-tenant RLS isolation verified

### Severity-weighted assessment
- **No critical defects**.
- **No high-severity defects**.
- **No unresolved defects**.
- **All 34 frozen decisions implemented and verified**.
- **Integration tests I-01..I-14 pass on real PostgreSQL 16** with 60+ DB-level assertions.
- **Recommendation**: PASS → MISSION 02-00 APPROVED.

## NEXT_STEP

Mission 02-00 is APPROVED. Define Mission 02-01 scope based on `GROUP_02_READINESS_HANDOFF.md`.

## Honest Notes (per Roadmap §12)

- This report reflects the ACTUAL published SHA (6672460) and ACTUAL CI/Recovery results.
- The 5 commits (67d1335, f76cf24, a4a5722, 0c709d1, 6672460) were iterative — first 4 corrected CI failures on real PostgreSQL 16, 5th was this documentation sync.
- Test count (679 passed) is the actual CI runtime output, not a prediction.
- All 11 known limitations are documented in `02-00_KNOWN_LIMITATIONS.md`.
- The mission does NOT claim production readiness — Demolandia only, no real data, no UI, no external integrations, no LLM.
