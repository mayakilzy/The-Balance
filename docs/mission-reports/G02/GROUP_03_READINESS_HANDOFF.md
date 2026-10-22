# GROUP 03 Readiness Handoff

**From:** GROUP 02 (State Observatory) — Final SHA: `b5fb96503ab4a11bc0204c6cf6a020b1c2d2cbd3`
**To:** GROUP 03 (Targeted Reform) — **NOT YET AUTHORIZED**
**Date:** 2026-10-18

## Authorization Status

> **GROUP 03 IMPLEMENTATION REMAINS UNAUTHORIZED** until separately released by the owner.

This document is a **documentation-only handoff**. It describes what GROUP 03 will pick up when authorized. It does NOT authorize GROUP 03 implementation. No GROUP 03 code, schema changes, migrations, or tests are to be written until the owner explicitly releases GROUP 03.

## GROUP 02 Status

GROUP 02 is **OWNER APPROVED — FINAL PASS**. All six missions (02-00 through 02-05) are approved. G02-L21 is closed. G02-L25 and G02-L26 are documented limitations with deliberate design choices.

For full details, see:
- `GROUP_02_FINAL_REVIEW.md` — comprehensive completion summary
- `GROUP_02_ACCEPTANCE_MATRIX.md` — per-mission/per-criterion acceptance grid
- `GROUP_02_KNOWN_LIMITATIONS.md` — closed, documented, and deferred limitations

## GROUP 02 Deliverables Available for GROUP 03

### Services (all in `src/lib/state-observatory/`)

| Service | File | Contract |
|---------|------|----------|
| Indicator Registry | `indicator-registry-service.ts` | `defineIndicator`, `listIndicators`, `retireIndicator` |
| Observation | `observation-service.ts` | `ingestObservation`, `correctObservation`, `listObservations`, `getCurrentObservation` |
| Variance | `variance-service.ts` | `computeVariance`, `listVariance` |
| Alert | `alert-service.ts` | `evaluateAndRaise`, `markReviewed`, `documentDecision`, `verifyExecution`, `closeAlert` |
| Provenance Validator | `provenance-validator.ts` | `validateObservationProvenance` (pure function, 11 rules) |
| Evidence Country Validator | `evidence-country-validator.ts` | `verifyEvidenceCountryScope` |
| Evidence Independence | `evidence-independence-service.ts` | `analyzeIndependence` (per-observation) |
| Aggregate Independence | `aggregate-independence-service.ts` | `analyzeAggregateIndependence` (national claim support) |
| Observatory Query | `observatory-query-service.ts` | 4-layer snapshot (indicator → observation → variance → alert) |
| Temporal Trend | `temporal-trend-service.ts` | `analyzeTemporalTrend` (lookback, ≥2 data points) |
| Early Warning | `early-warning-service.ts` | `assessEarlyWarning` (uncalibrated, descriptive) |
| Institutional View | `institutional-view-service.ts` | `getInstitutionalView` (per-institution, cross-tenant isolated) |
| Sector View | `sector-view-service.ts` | `getSectorView` (counts only; observability not computed) |
| Permissioned View | `permissioned-view-service.ts` | `getPermissionedView` (3 tiers: public/research/government) |
| Threshold Evaluator | `threshold-evaluator.ts` | `evaluateThresholds` (pure function, no eval/Function/vm) |

### Data Models (in `prisma/schema.prisma`)

- 22+ G00 models (Tenant, User, Membership, Evidence, Strategy, StrategyVersion, Task, etc.)
- 8 G01 models (Objective, CountryPackConfig, Program, Project, BudgetLine, Dependency, RiskRegister, Assumption)
- 5 G02 models (IndicatorDefinition, ObservationPeriod, Observation, VarianceRecord, Alert)
- 21 migrations (16 G00 + 4 G01 + 1 G02: `20261018000021_g02_observatory_bootstrap`)

### Permissions (in `src/lib/permissions.ts`)

- All GROUP 00 + GROUP 01 permissions
- 8 GROUP 02 permissions:
  - `observatory:indicator:read`, `observatory:indicator:write`
  - `observatory:observation:read`, `observatory:observation:ingest`
  - `observatory:variance:read`
  - `observatory:alert:read`, `observatory:alert:review`, `observatory:alert:act`

### Audit Infrastructure (inherited from GROUP 01)

- `writeAudit(entry)` — best-effort, global db client, swallows errors
- `writeAuditTx(tx, entry)` — ATOMIC, transaction-scoped, throws on failure
- Both available for GROUP 03 to use for sovereign audit trails

## GROUP 03 Prerequisites

GROUP 03 (Targeted Reform) is expected to:
1. Consume `VarianceRecord` and `Alert` as signals for targeted reform requests
2. Generate reform proposals in response to alerts (with human approval required)
3. Track reform implementation progress against the originating alert
4. Close the loop: alert → reform proposal → approval → implementation → verification
5. **NOT automatically create reform proposals** — the human remains sovereign

## Contracts Ready for GROUP 03

### Signal Sources (read-only consumption)

- **VarianceRecord** — planned vs actual snapshot, attributionLevel="descriptive" (no causal claims)
- **Alert** — human-actionable alert with lifecycle (detected → notified → reviewed → decision_documented → closed) and execution verification (not_applicable → pending → verified → disputed)
- **Observation** — actual measurements with append-only correction chains
- **ObservatorySnapshot** — 4-layer cascade (indicator → observation → variance → alert)
- **TemporalTrend** — past data analysis (no future prediction)
- **EarlyWarning** — descriptive signals (none/watch/advisory/insufficient_data), uncalibrated

### Sovereign Audit (read-write, atomic)

- **AuditLog** — append-only, atomic via `writeAuditTx`
- **DomainEvent** — for approved actions

### Approval Infrastructure (inherited)

- `approveStrategyVersionWithAuditSafe` — pattern for atomic approval + audit
- `withAuthenticatedTenant` — RLS-enforced tenant context wrapper
- `PermissionDeniedError` — preserved through audit layer

## Known Limitations for GROUP 03 to Address

### High Priority (Carried from GROUP 02)

1. **G02-L25: Publication Approval Gap** — No publication approval mechanism exists. GROUP 03 may need to design one if reform proposals are to be published.
2. **G02-L26: Government Projection Limited to Public Evidence** — If GROUP 03 exposes reform data to government viewers, the same conservative clearance policy applies until a granular clearance model is approved.
3. **G02-L22: Institutional Early Warning Not Computed** — If GROUP 03 needs institutional-scope reform signals, this must be implemented first.
4. **G02-L23: No Hierarchical Institution Aggregation** — If GROUP 03 needs parent/child institution rollup, this must be implemented first.
5. **G02-L24: Sector View Observability Not Computed** — If GROUP 03 needs sector-scope reform signals, this must be implemented first.

### Carried from GROUP 01 and 02-00

6. **Simulated Intelligence (StubProvider)** — GROUP 03 may want to use LLM-assisted reform proposal drafting. The StubProvider pattern is the integration point.
7. **No Real Data Integration** — Demolandia only. GROUP 03 may need real data to validate reform proposals.
8. **Browser UI** — GROUP 02 has no browser UI. GROUP 03 may want to add one for reform proposal review.
9. **Audit Failure Injection Test** — structural verification only; forced failure injection of `writeAuditTx` was NOT implemented.
10. **Sub-Year Granularity** — yearly/quarterly/monthly only. GROUP 03 may need finer granularity for fast-moving reforms.
11. **alertThresholds Limited to 2 Rules per Indicator** — may need extension for complex reform triggers.
12. **No Real Country Data** — Demolandia only.

## Conditions for Starting GROUP 03

1. **Owner explicitly authorizes GROUP 03 implementation** — this is the gate. The owner has stated: "GROUP 03 IMPLEMENTATION REMAINS UNAUTHORIZED until separately released by the owner."
2. GROUP 02 = APPROVED — DONE (this handoff documents that).
3. The owner defines GROUP 03 scope based on this handoff document.
4. All GROUP 02 limitations (G02-L21 closed; G02-L22/L23/L24 deferred; G02-L25/L26 documented) are accepted by the owner.
5. The architectural invariants (attributionLevel="descriptive" always; StrategyVersion read-only FK; append-only observations; etc.) are preserved.

## GROUP 03 Scope (Expected — Not Frozen)

Based on the Six-Group Roadmap, GROUP 03 (Targeted Reform) will:
- Consume observatory signals (VarianceRecord, Alert) as reform triggers
- Generate reform proposals (with LLM assistance, advisory only, never replacing human review)
- Route proposals through the human approval workflow (inherited from GROUP 01)
- Track reform implementation progress
- Close the loop: alert → reform → implementation → verification
- **NOT automatically create reform proposals** — the human remains sovereign
- **NOT claim causal attribution** — `attributionLevel = "descriptive"` is the platform-wide invariant

The exact GROUP 03 scope will be defined by the owner after reviewing this handoff document.

## Architectural Invariants GROUP 03 Must Preserve

1. **`attributionLevel = "descriptive"` always** — no causal claims without evidence. Reform proposals describe variance; they do not claim to prove causation.
2. **Fail-closed for public/research publication** (G02-L25) — reform proposals are NOT automatically published. A publication approval workflow must be designed and approved before any publication.
3. **Government projection limited to `classification="public"` evidence** (G02-L26) — reform data exposed to government viewers must respect the same conservative clearance policy.
4. **No new tables/migrations/permissions without owner approval** — GROUP 03 must follow the same incremental approach as GROUP 02 (one bootstrap mission for schema, subsequent missions for services).
5. **`src/lib/state-builder/` diff = 0** — GROUP 01 code untouched.
6. **`src/lib/state-observatory/` diff = 0 unless explicitly approved** — GROUP 02 code should be extended, not modified. New services should live in a new directory (e.g., `src/lib/reform/`).
7. **StrategyVersion referenced as READ-ONLY FK** — reform proposals reference approved StrategyVersions but never modify them.
8. **Observations are append-only** — reform proposals may reference observations but never mutate them.
9. **The human remains sovereign** — no automatic reform creation, no automatic approval, no automatic execution.

## Authoritative References (for GROUP 03 implementers)

- `docs/adr/ADR-0001-stack-selection.md` (stack)
- `docs/adr/ADR-0002-llm-provider-abstraction.md` (LLM abstraction — still stub)
- `docs/adr/ADR-0003-tenant-isolation.md` (RLS strategy)
- `docs/adr/ADR-0005-rls-roles-and-policies.md` (RLS roles)
- `docs/adr/ADR-0008-rbac-abac-design.md` (RBAC/ABAC)
- `docs/adr/ADR-0012-security-hardening-design.md` (security)
- `docs/mission-reports/G01/GROUP_01_KNOWN_LIMITATIONS.md` (11 limitations)
- `docs/mission-reports/G02/GROUP_02_KNOWN_LIMITATIONS.md` (current authoritative G02 limitations)
- `docs/mission-reports/G02/GROUP_02_FINAL_REVIEW.md` (G02 completion summary)
- `docs/mission-reports/G02/GROUP_02_ACCEPTANCE_MATRIX.md` (G02 acceptance grid)
- `prisma/schema.prisma` (35+ models: G00 + G01 + G02)
- `prisma/migrations/` (21 migrations)
- `src/lib/state-observatory/` (17 modules, 5,334 lines — read-only consumption for GROUP 03)
- `src/lib/state-builder/` (GROUP 01 — read-only, diff must stay 0)
- `src/lib/permissions.ts` (RBAC permission catalog)
- `src/lib/audit.ts` (atomic audit infrastructure)
- `tests/integration/helpers/fixture-tracker.ts` (ownership-aware test cleanup — reuse for GROUP 03 integration tests)

## Frozen Architectural Decisions (100+ — DO NOT REOPEN)

All decisions from GROUP 00, GROUP 01, and GROUP 02 are FROZEN. None are reopened by GROUP 03 closure planning. Specifically:

- Q1-Q15 + R1-R5 + E1-E8 + F1-F6 (GROUP 02 architecture, refinements, execution, final fixes)
- A1-A18 (02-01 provenance validation)
- B1-B16 (02-02 evidence independence + observability snapshot)
- C1-C18 (02-03 temporal integrity + early warnings; C18 = G02-L21, now CLOSED)
- D1-D14 (02-04 institutional + sector views)
- E1-E16 (02-05 permissioned views)

## Next Action

**AWAITING OWNER AUTHORIZATION TO START GROUP 03 IMPLEMENTATION.**

Until then:
- No GROUP 03 code is to be written.
- No GROUP 03 schema changes or migrations are to be created.
- No GROUP 03 tests are to be added.
- This handoff document is the only GROUP 03 artifact.

The owner's explicit authorization is the gate. The platform is ready. The foundation is solid. The human remains sovereign.
