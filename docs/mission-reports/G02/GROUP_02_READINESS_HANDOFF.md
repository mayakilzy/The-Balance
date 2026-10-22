# GROUP 02 — State Observatory Readiness Handoff

**From:** Mission 02-00 (State Observatory Bootstrap — Vertical Slice)
**To:** Mission 02-01+ (State Observatory Continued)
**Date:** 2026-10-18
**Status:** 02-00 LOCAL IMPLEMENTATION COMPLETE — PENDING OWNER PUSH APPROVAL + CI VERIFICATION

## GROUP 02 Mission 02-00 Status

Mission 02-00 is **LOCALLY COMPLETE** — all code is written, unit tests pass, typecheck and lint pass.
Final acceptance is **PENDING** owner approval to push and CI/Recovery verification on the published SHA.

## GROUP 02 — What 02-00 Delivered

### 5 New Tables (RLS ENABLE + FORCE on all)
| Table | Purpose | Key Constraint |
|-------|---------|----------------|
| `indicator_definitions` | KPI definitions linked to approved StrategyVersion | Unique (tenantId, code) |
| `observation_periods` | Temporal periods (yearly/quarterly/monthly) | Unique (tenantId, periodType, periodValue) |
| `observations` | Actual measurements (append-only corrections) | F1: partial unique index with COALESCE(geo_ref_id, ''); F3: chain integrity trigger |
| `variance_records` | Planned vs actual computations (deterministic) | F4: plannedValueSourceKind/SourceId nullable |
| `alerts` | Human-actionable alerts (lifecycle separated from execution) | F6: executionVerifiedAction separate field |

### 4 Implemented Services (no NotImplementedError)
| Service | File | Key Methods |
|---------|------|-------------|
| IndicatorRegistryService | `indicator-registry-service.ts` | defineIndicator, listIndicators, retireIndicator |
| ObservationService | `observation-service.ts` | ingestObservation, correctObservation (F2 atomic), listObservations, getCurrentObservation |
| VarianceService | `variance-service.ts` | computeVariance (R2 + F4), listVariance |
| AlertService | `alert-service.ts` | evaluateAndRaise (R3+E5), markReviewed, documentDecision (R5), updateExecutionStatus, verifyExecution (F6), closeAlert |

### 1 Pure Function
| Function | File | Purpose |
|----------|------|---------|
| evaluateThresholds | `threshold-evaluator.ts` | Pure deterministic evaluation of structured alert thresholds (NO eval/Function/vm) |

### 8 New Permissions
Added to `src/lib/permissions.ts`:
- `observatory:indicator:read`, `observatory:indicator:write`
- `observatory:observation:read`, `observatory:observation:ingest`
- `observatory:variance:read`
- `observatory:alert:read`, `observatory:alert:review`, `observatory:alert:act`

Role distribution:
- `admin`: all 8
- `analyst`: 6 (no alert:review, no alert:act)
- `reviewer`: 6 (no indicator:write, no observation:ingest; has alert:review, alert:act)
- `observer`: 4 (read-only across indicator, observation, variance, alert)

## Contracts Available for 02-01+

### Data Models (in `prisma/schema.prisma`)
- `IndicatorDefinition` — KPI definition with temporal targets, structured thresholds
- `ObservationPeriod` — temporal period for measurements
- `Observation` — actual measurement with append-only correction chain
- `VarianceRecord` — planned vs actual computation snapshot (pinned observation + planned value)
- `Alert` — human-actionable alert with lifecycle separated from execution verification

### Service Contracts (in `src/lib/state-observatory/`)
- `IndicatorRegistryService.defineIndicator(session, input) → IndicatorDefinition`
- `ObservationService.ingestObservation(session, input) → Observation`
- `ObservationService.correctObservation(session, observationId, correction) → Observation`
- `VarianceService.computeVariance(session, { strategyVersionId, observationPeriodId, indicatorId? }) → VarianceRecord[]`
- `AlertService.evaluateAndRaise(session, varianceRecordId) → Alert | null`
- `AlertService.markReviewed(session, alertId, notes) → Alert`
- `AlertService.documentDecision(session, alertId, decisionDescription) → Alert`
- `AlertService.verifyExecution(session, alertId, { verifiedAction, evidenceSource, notes? }) → Alert`
- `AlertService.closeAlert(session, alertId, reason) → Alert`

## Known Limitations for 02-01+ to Address

See `02-00_KNOWN_LIMITATIONS.md` for the complete list (11 limitations).

### High Priority for 02-01
1. **G02-L07**: Audit failure injection test (forced `writeAuditTx` failure → verify rollback)
2. **G02-L10**: Integration tests need full implementation (currently placeholder structure)
3. **G02-L08**: Counter-Evidence country scope verification (carried from G01 #10)

### Medium Priority for 02-02+
4. **G02-L01**: Sub-year granularity (weekly/daily)
5. **G02-L02**: alertThresholds > 2 rules per indicator
6. **G02-L09**: Subnational variance computation (per province/institution)

### Lower Priority / Deferred
7. **G02-L03**: Browser UI for State Observatory
8. **G02-L04**: Real data integration (World Bank, IMF, etc.)
9. **G02-L05**: External integrations (Email/SMS/webhooks)
10. **G02-L06**: LLM-assisted interpretation (advisory only, never replaces human review)
11. **G02-L11**: Idempotency on variance computation

## Conditions for Starting 02-01

1. **02-00 = APPROVED** (after owner's independent review of CI + Recovery + integration tests on the published SHA)
2. The T2-slice works end-to-end at the API level (ingest → compute variance → raise alert → review → decide → verify execution → close)
3. RLS + RBAC + tenant isolation verified on real PostgreSQL in CI
4. All atomic audit operations verified (writeAuditTx inside withAuthenticatedTenant)
5. No modification to GROUP 00 or GROUP 01 code (diff = 0 on `src/lib/state-builder/`)
6. 11 known limitations documented and accepted by owner

## 02-01 Scope (Expected — Not Frozen)

Based on the Six-Group Roadmap, GROUP 02 (State Observatory) is expected to:
- Implement integration tests fully (G02-L10)
- Add audit failure injection tests (G02-L07)
- Address counter-evidence country scope (G02-L08)
- Begin real data source adapters (G02-L04) — likely after 02-02
- Build the browser UI for observatory (G02-L03) — likely a dedicated UI mission

The exact 02-01 scope will be defined after owner's review of 02-00 results.

## GROUP 02 → GROUP 03 Handoff (Anticipated)

Per Roadmap §11 handoff table:
- **Observatory → Reform**: `Observation, Variance, EvidenceCase, Alert`
- **No automatic action**: GROUP 03 (Targeted Reform) reads from GROUP 02 outputs but does NOT automatically create reform proposals.

The `VarianceRecord` and `Alert` models are ready for GROUP 03 to consume as signals for targeted reform requests.

## Authoritative References (for 02-01+ implementers)

- `docs/adr/ADR-0001-stack-selection.md` (stack)
- `docs/adr/ADR-0002-llm-provider-abstraction.md` (LLM abstraction — still stub in 02-00)
- `docs/adr/ADR-0003-tenant-isolation.md` (RLS strategy)
- `docs/mission-reports/G01/GROUP_01_KNOWN_LIMITATIONS.md` (11 limitations carried forward)
- `docs/mission-reports/G02/02-00_KNOWN_LIMITATIONS.md` (11 limitations — 8 carried + 3 new)
- `docs/mission-reports/G02/02-00_REPORT.md` (mission report per Roadmap §12 template)
- `prisma/schema.prisma` (5 new G02 models + reverse relations on G00/G01)
- `prisma/migrations/20261018000021_g02_observatory_bootstrap/migration.sql` (RLS + F1 + F3)
- `src/lib/state-observatory/` (4 services + 1 pure function + contracts + barrel)

## Frozen Architectural Decisions (28 total — DO NOT REOPEN in 02-01+)

- Q1-Q15: architectural (5 tables, 4 services, R1 originType/verification split, R2 periodMilestone-first, R3 per-indicator thresholds, R4 append-only corrections, R5 lifecycle/execution separation)
- R1-R5: refinements (origin/verification separation, period-comparable targets, per-indicator thresholds, history preservation, decision/execution separation)
- E1-E8: execution (self-contained spec, atomic correction, nullable observationId, both-path T2-slice, structured thresholds, synthetic source separation, runtime test counts, HEAD verification)
- F1-F6: final fixes (NULL-safe COALESCE index, F2 correctObservation order, F3 anti-branching trigger, F4 nullable plannedValueSource, F5 inline test specs, F6 verifiedAction semantic)

All 34 decisions (Q1-Q15 + R1-R5 + E1-E8 + F1-F6) are FROZEN.

## Next Action

**AWAITING OWNER APPROVAL TO PUSH TO `main`** for CI + Recovery verification.

After push approval:
1. Owner monitors GitHub Actions (ci.yml + fresh-install-recovery.yml)
2. Owner conducts independent code review
3. Owner issues final 02-00 acceptance: PASS / PARTIAL / FAIL
4. If PASS: define Mission 02-01 scope based on this handoff document
