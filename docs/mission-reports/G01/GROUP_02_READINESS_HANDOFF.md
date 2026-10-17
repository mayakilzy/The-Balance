# GROUP 02 Readiness Handoff

**From:** GROUP 01 (State Builder) — Final SHA: `4aa7de238f01a318c040c3775785788664ee7baf`
**To:** GROUP 02 (State Observatory)

## GROUP 01 Status

GROUP 01 is PENDING_REVIEW. All 11 missions (01-00 through 01-10) have been implemented, tested, and reviewed through multiple FIX cycles. The final decision is the human reviewer's.

## GROUP 01 Deliverables Available for GROUP 02

### Services (all in `src/lib/state-builder/`)
| Service | File | Contract |
|---------|------|----------|
| Baseline Service | baseline-service.ts | `computeBaseline(session, { countryId }) → { taskId, report }` |
| Gap Analysis Service | gap-analysis-service.ts | `computeGaps(session, { countryId, objectiveIds }) → { taskId, report }` |
| Strategy Composer | strategy-composer-service.ts | `composeStrategies(session, { countryId, objectiveIds }) → ComposeResult` |
| Program Service | program-service.ts | `expandPrograms(session, { strategyAlternativeId }) → ExpandProgramsResult` |
| Portfolio Service | portfolio-service.ts | `buildPortfolio(session, { strategyAlternativeId }) → Portfolio` |
| Budget Service | budget-service.ts | `estimateBudgets(session, { strategyAlternativeId }) → BudgetResult` |
| Roadmap Service | roadmap-service.ts | `buildRoadmap(session, { strategyAlternativeId }) → ImplementationRoadmap` |
| Comparison Service | comparison-service.ts | `compareScenarios(session, { alternativeIds }) → ScenarioComparison` |
| Advisor Service | advisor-service.ts | `advise(session, { countryId, objectiveIds, alternativeIds }) → AdvisoryReport` |
| Approval Service | approval-service.ts | `approveStrategyVersionWithAuditSafe(session, versionId, notes?) → { versionId, status, approvedBy }` |

### Data Models (all in `prisma/schema.prisma`)
- 22+ G00 models (Tenant, User, Membership, Evidence, Strategy, StrategyVersion, Task, etc.)
- 8 G01 models (Objective, CountryPackConfig, Program, Project, BudgetLine, Dependency, RiskRegister, Assumption)
- 20 migrations (16 G00 + 4 G01)

### Permissions (in `src/lib/permissions.ts`)
- `baseline:read`, `baseline:compute`
- `gap:read`
- `program:read`
- `budget:read`, `budget:compute`
- `roadmap:read`
- `comparison:read`
- `strategy:read`, `strategy:write`, `strategy:approve`
- Observer excluded from: gap, program, budget, roadmap, comparison (read-only observer sees only baseline + strategy)

### Audit Infrastructure (in `src/lib/audit.ts`)
- `writeAudit(entry)` — best-effort, global db client, swallows errors
- `writeAuditTx(tx, entry)` — ATOMIC, transaction-scoped, throws on failure (01-10 addition)

### Approval Infrastructure (in `src/lib/strategy-service.ts` + `src/lib/state-builder/approval-service.ts`)
- `approveStrategyVersion(session, versionId, notes?)` — G00 + 01-10 atomic audit
- `approveStrategyVersionWithAuditSafe(session, versionId, notes?)` — G01 wrapper with denied-attempt audit

## GROUP 02 Prerequisites

GROUP 02 (State Observatory) is expected to:
1. Monitor real-world execution of approved strategies
2. Compare planned vs actual performance
3. Track KPI progress against targets
4. Surface deviations and alert decision-makers
5. Integrate real data feeds (statistics, administrative data, surveys)

## Contracts Ready for GROUP 02

- **StrategyVersion** (approved, immutable): the "active" strategy that GROUP 02 monitors
- **Program** (with KPIs): the programs whose execution GROUP 02 tracks
- **BudgetLine** (with cost ranges): the budgets whose utilization GROUP 02 monitors
- **ImplementationRoadmap** (with phases + milestones): the timeline GROUP 02 compares against actuals
- **AuditLog** (append-only, atomic): the sovereign audit trail that GROUP 02 can reference for accountability
- **Evidence** (with verificationStatus): the evidence fabric that GROUP 02 can extend with execution evidence

## Known Limitations for GROUP 02 to Address

1. **No real data integration** — GROUP 01 uses StubProvider + fictional Demolandia. GROUP 02 must integrate real data feeds.
2. **No execution tracking** — GROUP 01 produces plans; GROUP 02 must track execution.
3. **No KPI measurement** — GROUP 01 defines KPIs; GROUP 02 must measure them against real data.
4. **No deviation alerting** — GROUP 01 produces roadmaps; GROUP 02 must detect when execution deviates.
5. **Counter-evidence country scope** — not fully verified (see Known Limitations #10).
6. **Evidence support assessment** — `supportAssessment = "not-assessed"` — GROUP 02 or a future hardening pass should add a claim-support verification model.
7. **Browser UI for full T1 journey** — not implemented in GROUP 01. GROUP 02 or a dedicated UI group should build it.
8. **Audit failure injection test** — structural verification only; a forced-failure test would be more definitive.

## Conditions for Starting GROUP 02

1. GROUP 01 = APPROVED (pending review)
2. The T1 journey works end-to-end at the API level (baseline → advisory → human approval)
3. The approval workflow is atomic (audit_log + domain event in the same transaction)
4. All 532+ tests pass with 0 failures
5. RLS + RBAC + tenant isolation verified
6. The `approveStrategyVersion` function includes atomic `writeAuditTx` (01-10 modification)
7. The `approval-service.ts` wrapper logs denied attempts to audit_log and preserves the original PermissionDeniedError

## GROUP 02 Scope (Expected)

Based on the Six-Group Roadmap, GROUP 02 (State Observatory) will:
- Build a real-time monitoring layer over the approved strategies
- Ingest execution data (KPI measurements, budget utilization, milestone completion)
- Compare planned vs actual (deviation analysis)
- Alert decision-makers when execution deviates from the plan
- Extend the Evidence Fabric with execution evidence
- Integrate with real data sources (official statistics, administrative data, surveys)

The platform is ready. The foundation is solid. The human remains sovereign.
