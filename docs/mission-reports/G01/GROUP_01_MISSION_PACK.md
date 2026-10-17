# GROUP 01 — State Builder Mission Pack

**Status:** Draft for founder review — **not yet approved for implementation.**
**Date:** 2026-10-17
**Base SHA:** `dcbb8961dd588bb9e66a9076bc4e62625482a56f` (GROUP 00 final)
**Authoring principle:** Progressive Mission Authoring — this pack is written only after GROUP 00 acceptance, per Roadmap §1.

---

## 0. How to Read This Document

This is a **mission pack**, not a spec. Each mission is executable: it has dependencies, scope, a contract, security boundaries, real-vs-simulated status, tests, and acceptance evidence. The founder must approve this pack before any G01 code is written.

**Guard rails (from Roadmap §14):**
- Do not create a separate codebase — G01 extends the existing repository
- Do not rebuild GROUP 00 contracts (auth, RLS, Evidence Fabric, Strategy Contracts, Task Runtime, Capability Registry)
- Do not turn the agricultural demo fixture into real Syria data
- Do not replace government authority with LLM-held keys
- Do not treat a mock A2A test as proof of real integration
- Do not claim G01 proves economic impact — it proves engineering + scientific logic only

**Terminology convention (per founder directive):**
- **Foundation-validated** — built and tested in GROUP 00, ready for G01 to build on, but not production-hardened for government deployment
- **Live** — backed by a real provider/adapter with real data, clearly labeled
- **Simulated** — Stub/Mock output, honestly disclosed via `simulated: true`
- **Deferred** — out of G01 scope, documented for future groups

---

## 1. Group Purpose and Value

**The value (from Roadmap §4):** A country with a baseline and goals can obtain multi-sector draft strategies that are reviewable and approvable.

**The inputs:** Country Pack, Evidence Cases, Indicators, Constraints, Human Goals.

**The outputs:** National Vision, Strategy Version, Reform Portfolio, Program/Project Plans, Risk Register, Assumptions, Evidence Dossier, Decision Brief.

**The rule (Blueprint §7):** The Strategy Builder produces *drafts*. Human approval alone makes a strategy active. No AI recommendation becomes `Approved` on its own. Without authorization, the result remains a draft.

---

## 2. T1 Acceptance Test (The Gate)

G01 is accepted only when T1 passes end-to-end with verifiable evidence.

### T1 Scenario

A fictional or properly-sourced Country Pack → multiple strategy alternatives → evidence and uncertainty → dependencies and conditional costs → authorized human approval → active versioned Strategy.

### T1 Steps (must all pass)

| Step | Action | Expected Result | Evidence |
|------|--------|-----------------|----------|
| T1.1 | Load a Country Pack (fictional "Demolandia" extended, or a properly-sourced real country with documented provenance) | Country Pack stored with institutions, sectors, admin units, legal mandates | API response + DB row |
| T1.2 | Ingest evidence cases (economic, social, institutional — with sources, dates, uncertainty) | Evidence stored in Evidence Fabric with `verification_status` and `support_stance` | Evidence list API + vector search returns relevant results |
| T1.3 | Define human goals (e.g., "reduce unemployment to 10% in 5 years") | Goals stored as Objective records linked to the country | Objective API returns goals |
| T1.4 | Compute State Baseline (indicators per sector, with gaps and observability mode) | Baseline report with `FULL/PARTIAL/LOW` observability per dimension; "unknown" where data is insufficient | Baseline API returns structured report |
| T1.5 | Run Gap Analysis (baseline vs goals, per sector) | Gap report identifying which sectors have insufficient capacity/data to reach goals | Gap Analysis API returns structured gaps |
| T1.6 | Strategy Composer generates **multiple** alternatives (at least 2, ideally 3) | Each alternative has: objectives, programs, dependencies, conditional costs, assumptions, counter-evidence, uncertainty | Strategy alternatives API returns array with `simulated: true` flag |
| T1.7 | Portfolio & Dependency Graph links programs across sectors | Graph shows which programs depend on others; circular dependencies rejected | Portfolio API returns dependency graph |
| T1.8 | Budget estimates are conditional (ranges, not point estimates) | Each program has cost range with assumptions; no fake precision | Budget API returns `{min, max, assumptions}` |
| T1.9 | Scenario Comparison shows trade-offs between alternatives | Comparison table: cost, risk, timeline, evidence strength, affected sectors | Comparison API returns diff-able structure |
| T1.10 | **Unauthorized** user attempts to approve → REJECTED | 403 Forbidden; audit log records denied attempt | Security test + audit_log row |
| T1.11 | **Authorized** user approves one alternative → Strategy Version becomes `active` | Version status transitions `proposed → approved → active`; audit log records approval | Strategy version API + audit_log row |
| T1.12 | Attempt to modify the approved version in place → REJECTED | Immutability trigger blocks; must create new version with `supersedes_version` | DB trigger test |
| T1.13 | Government handover: new authorized user can view the active strategy + decision history + evidence snapshots | Full provenance visible; no data from other tenants leaks | Handover view API |

### T1 Negative Tests (must also pass)

- T1.N1: AI-generated recommendation does NOT auto-approve — it stays as `proposed`
- T1.N2: Cross-tenant: Tenant B cannot see Tenant A's strategies (RLS)
- T1.N3: Insufficient evidence → system says "unknown" and does not fabricate
- T1.N4: Contradictory evidence → both sides shown, no silent selection
- T1.N5: Task crash mid-composition → lease expires → reclaim → composition resumes without duplicate output

### T1 Live vs Simulated Inventory

| Component | Status in T1 | Honesty Mechanism |
|-----------|--------------|-------------------|
| Country Pack | Fictional (Demolandia extended) or properly sourced | `fictional: true` flag or source citations |
| Evidence | Fictional or properly sourced | `source_kind` + `verification_status` fields |
| Strategy Composer | **Simulated** (StubProvider LLM) | `simulated: true` in every API response + UI notice |
| Budget estimates | Deterministic ranges from a simple model | `model_version` + `assumptions` fields |
| Scenario Comparison | Deterministic diff | No prediction claims |
| Human approval | **Live** (real user, real RBAC check) | Audit log + auth session |

**T1 does NOT prove:** economic forecasting accuracy, real-world policy impact, or that the simulated strategies are sound for a real country. It proves the engineering pipeline + scientific honesty + human sovereignty work end-to-end.

---

## 3. Mission Inventory

G01 is decomposed into 11 missions. Each is independently deliverable and testable, but they build on each other in order.

| Mission | Title | Dependencies | Key Deliverable |
|---------|-------|--------------|-----------------|
| 01-00 | G01 Bootstrap + Country Pack Extension | G00 complete | Extended schema + Demolandia v2 fixture |
| 01-01 | State Baseline & Observability Modes | 01-00 | Baseline report engine |
| 01-02 | Gap Analysis Engine | 01-01 | Gap report (baseline vs goals) |
| 01-03 | National Strategy Composer (Multi-Alternative) | 01-02 | Strategy draft generator (≥2 alternatives) |
| 01-04 | Institutional Design & Program Contracts | 01-03 | Program + ownership + mandate contracts |
| 01-05 | Portfolio & Dependency Graph | 01-04 | Cross-sector dependency graph + cycle detection |
| 01-06 | Budget & Financing Estimates (Conditional) | 01-05 | Cost ranges with assumptions |
| 01-07 | Implementation Roadmap & Timeline | 01-06 | Phased timeline with milestones |
| 01-08 | Scenario Comparison Engine | 01-06 | Trade-off comparison between alternatives |
| 01-09 | Development Advisor v1 (Conditional Recommendations) | 01-08 | Advisor that produces *conditional* recommendations |
| 01-10 | Human Approval Workflow + T1 Integration Test | 01-09 | Approval gate + full T1 E2E |

---

## 4. Mission Details

### Mission 01-00 — G01 Bootstrap + Country Pack Extension

**Dependencies:** GROUP 00 complete (SHA `dcbb896`)
**Scope:** Extend the Prisma schema with G01 domain models. Seed an extended Demolandia fixture. Do NOT modify any G00 table.

**New models (migration 0017):**
- `Objective` — a human-defined goal (e.g., "reduce unemployment to 10%")
- `Program` — a reform program within a strategy version
- `Project` — a specific project within a program
- `BudgetLine` — a cost estimate line item (with min/max/assumptions)
- `Dependency` — a directed edge between programs (A depends on B)
- `RiskRegister` — risks associated with a strategy version
- `Assumption` — assumptions underpinning a strategy version
- `CountryPackConfig` — extended country metadata (sectors, observability mode per dimension)

**Contract:**
```typescript
// src/lib/state-builder/objective-service.ts
createObjective(session, { countryId, title, description, targetMetric, targetValue, horizon })
listObjectives(session, { countryId })

// src/lib/state-builder/country-pack-service.ts
getCountryPack(session, { countryId }) → { country, institutions, sectors, adminUnits, legalMandates, observability }
```

**Security boundaries:**
- All new tables are PRIVATE (tenant-scoped, RLS-enabled)
- `Objectives` are owned by the tenant that creates them
- `CountryPackConfig` extends the existing PUBLIC `countries` table — readable by all tenants, writable only by `balance_admin`

**Real vs Simulated:** Foundation (schema + seed). No intelligence yet.

**Tests:**
- Migration applies cleanly on fresh DB
- RLS enabled on all new PRIVATE tables
- Demolandia v2 fixture seeds correctly (extended sectors, institutions, objectives)
- Cross-tenant isolation for objectives

**Acceptance evidence:** Migration 0017 applied; `fresh-install-verify.sh` passes with 18+ private tables; seed creates 5+ objectives for Demolandia.

---

### Mission 01-01 — State Baseline & Observability Modes

**Dependencies:** 01-00
**Scope:** Build the State Baseline engine that computes a structured snapshot of the country's current state per sector, using Evidence Fabric data. Implement observability modes (FULL/PARTIAL/LOW) per Blueprint §5.4.

**Contract:**
```typescript
// src/lib/state-builder/baseline-service.ts
computeBaseline(session, { countryId }) → BaselineReport
// BaselineReport = {
//   countryId, computedAt,
//   dimensions: [{ sector, indicators: [{ name, value, source, validAt, uncertainty }], observabilityMode: FULL|PARTIAL|LOW, gaps: [...] }],
//   summary: { strongSectors, weakSectors, unknownSectors }
// }
```

**Scientific rules (Blueprint §2, §5.4):**
- If evidence is insufficient for a dimension → `observabilityMode = LOW` + system says "unknown"
- No fabricated values — missing data is reported as missing, not imputed
- Every indicator value links to its evidence `source_id` + `valid_at`
- `independence_group` from Evidence Fabric prevents counting duplicate sources as independent

**Security boundaries:**
- Baseline computation runs as a Durable Task (uses G00 Task Runtime)
- Results are tenant-scoped (PRIVATE)
- The task is claimable by any worker with `baseline:compute` permission

**Real vs Simulated:** The *computation* is real (deterministic aggregation of evidence). The *evidence* may be fictional (Demolandia) or properly sourced. The baseline report honestly labels which data is fictional.

**Tests:**
- Baseline with no evidence → all dimensions `LOW`, summary says "unknown"
- Baseline with partial evidence → mixed modes, gaps reported
- Baseline with full evidence → `FULL` mode, indicators with sources
- Counter-evidence: contradictory values shown side-by-side, no silent selection
- Task crash mid-computation → reclaim → no duplicate baseline

**Acceptance evidence:** Baseline API returns structured report; observability modes enforced; "unknown" is a valid result (Blueprint §2).

---

### Mission 01-02 — Gap Analysis Engine

**Dependencies:** 01-01
**Scope:** Compare the State Baseline against human-defined Objectives. Identify which sectors have insufficient capacity, data, or trajectory to reach the goals.

**Contract:**
```typescript
// src/lib/state-builder/gap-analysis-service.ts
computeGaps(session, { countryId, objectiveIds }) → GapReport
// GapReport = {
//   gaps: [{ objectiveId, sector, currentTrajectory, requiredTrajectory, gapSize, evidenceConfidence, blockers: [...] }],
//   summary: { closableGaps, structuralGaps, unknownGaps }
// }
```

**Scientific rules:**
- Gap size is a range, not a point estimate (uncertainty propagation)
- `evidenceConfidence` is derived from the baseline's observability mode + source independence
- `blockers` are linked to evidence, not invented
- If the baseline says "unknown" for a sector → the gap is "unknown", not "large"

**Security boundaries:** Same as 01-01 (Durable Task, tenant-scoped).

**Real vs Simulated:** Computation is real. Evidence quality determines confidence.

**Tests:**
- Gap where baseline is `LOW` → gap is "unknown", not a fabricated size
- Gap where baseline is `FULL` → gap size is a range with confidence
- Multiple objectives in the same sector → aggregated gap report
- Gap report links every claim to evidence

**Acceptance evidence:** Gap Analysis API returns structured report; uncertainty propagated; "unknown" honored.

---

### Mission 01-03 — National Strategy Composer (Multi-Alternative)

**Dependencies:** 01-02
**Scope:** Generate multiple (≥2) strategy alternatives based on the baseline + gaps + objectives. This is the first mission that uses the LLM Provider abstraction.

**Contract:**
```typescript
// src/lib/state-builder/strategy-composer-service.ts
composeStrategies(session, { countryId, objectiveIds, constraints }) → StrategyAlternative[]
// StrategyAlternative = {
//   id, title, description,
//   objectives: [{ id, approach }],
//   programs: [{ title, sector, rationale, evidenceRefs }],
//   assumptions: [...],
//   counterEvidence: [...],
//   uncertainty: { summary, perSector },
//   simulated: true,  // ALWAYS true until a real LLM provider is live
//   provider: "stub" | "zai" | ...
// }
```

**Scientific rules (Blueprint §1.1, §2, §5):**
- Each alternative must cite evidence (`evidenceRefs`) — no unsourced claims
- `counterEvidence` must be populated for high-impact proposals (Blueprint §2: Counter-evidence)
- `uncertainty` is described in words + ranges, never a fake confidence percentage
- `simulated: true` is mandatory when using StubProvider — the UI must display "SIMULATED"
- If the LLM cannot generate a defensible alternative → system says so, does not fabricate

**Security boundaries:**
- Composition runs as a Durable Task (long-running, resumable)
- The LLM prompt is sanitized (no tenant data leakage to external providers without explicit config)
- Output is validated against the Strategy Contract schema before storage
- The AI output is stored as `status: proposed` — never `approved`

**Real vs Simulated:** **Simulated** in G01 (StubProvider). The `LLMProvider` interface (G00 ADR-0002) is ready for a real provider, but G01 ships with Stub. Every response carries `simulated: true`.

**Tests:**
- Composer returns ≥2 alternatives
- Each alternative has evidence refs (no unsourced claims)
- Counter-evidence is present for high-impact programs
- `simulated: true` in every response
- Task crash mid-composition → reclaim → no duplicate alternatives
- Prompt injection attempt in evidence → rejected (sanitization)
- Unauthorized user (no `strategy:compose`) → 403

**Acceptance evidence:** Strategy Composer API returns ≥2 alternatives; every alternative is honestly labeled simulated; evidence provenance preserved.

---

### Mission 01-04 — Institutional Design & Program Contracts

**Dependencies:** 01-03
**Scope:** Expand each strategy alternative's programs into full contracts: owning institution, legal mandate, required capabilities, key performance indicators.

**Contract:**
```typescript
// src/lib/state-builder/program-service.ts
expandPrograms(session, { strategyAlternativeId }) → Program[]
// Program = {
//   id, title, sector, owningInstitutionId, legalMandateRef,
//   requiredCapabilities: [...],
//   kpis: [{ name, target, frequency, sourceKind }],
//   rationale, evidenceRefs, simulated
// }
```

**Scientific rules:**
- `owningInstitutionId` must reference an existing institution in the Country Pack
- `legalMandateRef` must cite a legal basis (or flag "mandate gap")
- KPIs must have a `sourceKind` (where the measurement will come from)

**Security boundaries:** Programs are tenant-scoped. Institution assignment is validated against the Country Pack (no cross-country institution leakage).

**Real vs Simulated:** Program expansion logic is deterministic. The `rationale` text is Simulated (LLM-generated, labeled).

**Tests:**
- Program with non-existent institution → rejected
- Program without legal mandate → flagged as "mandate gap"
- KPIs are linked to measurement sources
- Cross-country institution reference → rejected

**Acceptance evidence:** Program API returns full contracts; institution + mandate validation enforced.

---

### Mission 01-05 — Portfolio & Dependency Graph

**Dependencies:** 01-04
**Scope:** Build a directed dependency graph linking programs across sectors. Detect cycles. Identify critical path.

**Contract:**
```typescript
// src/lib/state-builder/portfolio-service.ts
buildPortfolio(session, { strategyAlternativeId }) → Portfolio
// Portfolio = {
//   nodes: Program[],
//   edges: Dependency[],  // { fromProgramId, toProgramId, type: requires|enables|conflicts, rationale }
//   criticalPath: programId[],
//   cycles: []  // must be empty — cycles are rejected
// }
```

**Rules:**
- Cycles are rejected at insertion (DB trigger + service-level check)
- `conflicts` type flags mutually exclusive programs
- Critical path is computed via topological sort
- The graph is stored as an adjacency list + validated on every mutation

**Security boundaries:** Portfolio is tenant-scoped. Dependency edges cannot cross tenant boundaries.

**Real vs Simulated:** Graph algorithms are real (deterministic). Edge `rationale` is Simulated (LLM, labeled).

**Tests:**
- Cycle insertion → rejected with clear error
- Critical path computed correctly for a known graph
- Conflict edges flagged
- Cross-tenant dependency → rejected by RLS

**Acceptance evidence:** Portfolio API returns graph; cycle detection enforced; critical path computed.

---

### Mission 01-06 — Budget & Financing Estimates (Conditional)

**Dependencies:** 01-05
**Scope:** Attach cost estimates to each program. Estimates are **conditional ranges**, not point estimates. Document assumptions explicitly.

**Contract:**
```typescript
// src/lib/state-builder/budget-service.ts
estimateBudgets(session, { strategyAlternativeId }) → BudgetEstimate[]
// BudgetEstimate = {
//   programId,
//   costRange: { min, max, currency, horizonYears },
//   assumptions: [...],
//   financingSources: [{ type, description, confidence }],
//   modelVersion: "v1-deterministic",
//   simulated: true
// }
```

**Scientific rules (Blueprint §1.1):**
- No fake precision — estimates are ranges with stated assumptions
- `confidence` on financing sources is descriptive ("high/medium/low" + rationale), never a fake percentage
- If data is insufficient for a range → system says "insufficient data for estimate"
- `modelVersion` is tracked for reproducibility (Blueprint §2: Reproducibility)

**Security boundaries:** Budgets are tenant-scoped. No external financial system integration (deferred to production hardening).

**Real vs Simulated:** The cost model is a simple deterministic estimator (v1). It is honestly labeled `simulated: true` because it does not use real market data. The *structure* is real; the *numbers* are illustrative.

**Tests:**
- Budget with insufficient data → "insufficient data" response, no fabrication
- Cost range is always `{min, max}` — never a single point
- Assumptions are non-empty for every estimate
- `modelVersion` is recorded for reproducibility

**Acceptance evidence:** Budget API returns ranges with assumptions; no fake precision; insufficient data honored.

---

### Mission 01-07 — Implementation Roadmap & Timeline

**Dependencies:** 01-06
**Scope:** Generate a phased implementation timeline with milestones, sequencing programs according to the dependency graph.

**Contract:**
```typescript
// src/lib/state-builder/roadmap-service.ts
buildRoadmap(session, { strategyAlternativeId }) → ImplementationRoadmap
// ImplementationRoadmap = {
//   phases: [{ name, startYear, endYear, programs: [...], milestones: [...], assumptions: [...] }],
//   totalHorizon: number,
//   sequencingRationale: string,  // why this order
//   simulated: true
// }
```

**Rules:**
- Phasing respects the dependency graph (no program starts before its dependencies)
- Milestones are measurable (linked to KPIs from 01-04)
- `sequencingRationale` explains the ordering in plain language

**Real vs Simulated:** Sequencing algorithm is real (topological sort + heuristics). Rationale text is Simulated.

**Tests:**
- Roadmap respects dependencies (no early starts)
- Milestones link to KPIs
- Phasing covers the full horizon
- Total horizon matches the objective horizon

**Acceptance evidence:** Roadmap API returns phased plan; dependency order respected.

---

### Mission 01-08 — Scenario Comparison Engine

**Dependencies:** 01-06 (needs multiple alternatives with budgets)
**Scope:** Compare ≥2 strategy alternatives side-by-side: cost, risk, timeline, evidence strength, affected sectors.

**Contract:**
```typescript
// src/lib/state-builder/comparison-service.ts
compareScenarios(session, { alternativeIds: [id1, id2, ...] }) → ScenarioComparison
// ScenarioComparison = {
//   alternatives: [...],
//   matrix: {
//     totalCost: [{ altId, min, max }],
//     timeline: [{ altId, horizonYears }],
//     riskProfile: [{ altId, highRisks, mitigations }],
//     evidenceStrength: [{ altId, strongClaims, weakClaims, unsupportedClaims }],
//     sectorCoverage: [{ altId, sectorsAddressed }]
//   },
//   tradeoffs: string,  // plain-language summary
//   simulated: true
// }
```

**Scientific rules:**
- `evidenceStrength` counts claims by evidence quality (from Evidence Fabric `verification_status`)
- `unsupportedClaims` must be ≥0 and visible — no hiding weak alternatives
- `tradeoffs` is descriptive, not prescriptive (no "this is the best" — that's the human's job)

**Security boundaries:** Comparison is read-only. No strategy is modified.

**Real vs Simulated:** Comparison logic is real (deterministic). `tradeoffs` text is Simulated.

**Tests:**
- Comparison with 2 alternatives → matrix populated for both
- `unsupportedClaims` is accurate (verified against Evidence Fabric)
- `tradeoffs` does not recommend a winner
- Comparison of alternatives from different tenants → rejected (RLS)

**Acceptance evidence:** Comparison API returns matrix; evidence strength honest; no prescriptive recommendation.

---

### Mission 01-09 — Development Advisor v1 (Conditional Recommendations)

**Dependencies:** 01-08
**Scope:** The Development Advisor (Blueprint §3.5) produces *conditional* recommendations. It does NOT approve, decide, or override human judgment.

**Contract:**
```typescript
// src/lib/state-builder/advisor-service.ts
advise(session, { countryId, objectiveIds, comparisonId }) → AdvisoryReport
// AdvisoryReport = {
//   recommendation: string,  // "Conditional recommendation: ..."
//   conditions: [...],  // what must be true for this to hold
//   risks: [...],
//   counterEvidence: [...],
//   assumptions: [...],
//   alternativeViewpoints: [...],  // dissenting perspectives
//   uncertaintySummary: string,
//   simulated: true,
//   disclaimer: "This is a conditional recommendation. Human approval required."
// }
```

**Scientific rules (Blueprint §3.5, §1.1):**
- Recommendations are **conditional** — they state what must be true
- `counterEvidence` and `alternativeViewpoints` are mandatory (Blueprint §2: Counter-evidence)
- No claim of certainty — `uncertaintySummary` is in words, not a percentage
- The `disclaimer` is always present and non-removable
- The advisor CANNOT change a strategy status — it only produces a report

**Security boundaries:**
- The advisor runs as a Capability (registered in G00 Capability Registry)
- `requiredPermission: "strategy:read"` (it only reads + advises, never writes)
- The output is stored as an `Evidence`-like object with `support_stance: "neutral"` — it does not become policy

**Real vs Simulated:** **Simulated** (StubProvider). The advisor uses the LLM Provider abstraction; when a real provider is integrated, the same contract applies.

**Tests:**
- Advisory report has non-empty `conditions`
- `counterEvidence` and `alternativeViewpoints` are present
- `disclaimer` is always in the output
- Advisor attempt to change strategy status → rejected (no such API exists)
- Unauthorized user → 403

**Acceptance evidence:** Advisor API returns conditional recommendation; disclaimer present; no sovereign action possible.

---

### Mission 01-10 — Human Approval Workflow + T1 Integration Test

**Dependencies:** 01-00 through 01-09
**Scope:** Wire the full T1 journey end-to-end. Build the approval gate. Run the T1 acceptance test.

**Contract:**
```typescript
// src/lib/state-builder/approval-service.ts
requestApproval(session, { strategyVersionId }) → ApprovalRequest
approveStrategy(session, { strategyVersionId, approvalRequestId }) → ApprovedVersion
// Transitions: proposed → approved → active
// REJECTED if:
//   - user lacks "strategy:approve" permission
//   - version is not in "proposed" status
//   - approval request is stale/expired
// Audit log records: actor, action, strategyVersionId, timestamp, decision
```

**Human sovereignty rules (Blueprint §1.1, §2):**
- Only a human with `strategy:approve` can transition a version to `approved`
- The AI recommendation (from 01-09) is stored as evidence, not as the decision
- The approval is logged in the append-only audit log with the actor's identity
- Once approved, the version is immutable (G00 Strategy Contract trigger)
- To change an approved strategy → create a new version with `supersedes_version`

**Security boundaries:**
- `strategy:approve` permission required (not `strategy:write` — separation of duties)
- Approval is a single-action (no batch approval in G01)
- The approval request expires after 72 hours (configurable)
- Cross-tenant approval → rejected (RLS + service-level check)

**Real vs Simulated:** The approval workflow is **Live** — it uses real Auth.js sessions, real RBAC checks, and real audit logging. No simulation.

**T1 Integration Test (Playwright + API):**
- Full journey: login → load country pack → ingest evidence → define goals → compute baseline → gap analysis → compose strategies → expand programs → build portfolio → estimate budgets → build roadmap → compare scenarios → get advisory → **unauthorized approval fails** → **authorized approval succeeds** → verify active version → verify immutability → verify audit trail
- Screenshots at each step
- API responses captured as evidence
- `simulated: true` flags verified throughout

**Tests:**
- T1.1 through T1.13 (from §2 above)
- T1.N1 through T1.N5 (negative tests)
- Full Playwright E2E for the journey
- Audit log contains every privileged action

**Acceptance evidence:**
- T1 Playwright test passes in CI
- All 13 positive steps + 5 negative tests pass
- Audit log shows approval with actor identity
- Approved version is immutable
- Cross-tenant isolation holds
- `simulated: true` is present in every LLM-dependent response
- No AI recommendation appears as `approved`

---

## 5. Architecture Decisions for G01

### New ADRs to create during G01

| ADR | Mission | Decision |
|-----|---------|----------|
| ADR-0013 | 01-00 | G01 domain model: Objectives, Programs, Projects, BudgetLines, Dependencies |
| ADR-0014 | 01-01 | State Baseline observability modes (FULL/PARTIAL/LOW) |
| ADR-0015 | 01-03 | Strategy Composer multi-alternative generation + LLM integration |
| ADR-0016 | 01-05 | Portfolio dependency graph: adjacency list + cycle detection |
| ADR-0017 | 01-06 | Conditional budget estimation (ranges, not point estimates) |
| ADR-0018 | 01-09 | Development Advisor v1: conditional recommendations, no sovereign action |
| ADR-0019 | 01-10 | Human approval workflow: separation of duties + immutability |

### Binding ADRs from G00 (must not be violated)

All 12 G00 ADRs remain binding. Key constraints:
- **ADR-0002:** LLM Provider Abstraction — G01 uses `LLMProvider` interface, ships with Stub
- **ADR-0003:** RLS for tenant isolation — all new G01 tables are PRIVATE with RLS
- **ADR-0008:** RBAC/ABAC — new permissions: `strategy:compose`, `strategy:approve`, `baseline:read`
- **ADR-0009:** Evidence Fabric — G01 strategies cite evidence via `evidence_id` refs
- **ADR-0010:** Strategy Contracts — G01 uses the existing `Strategy → StrategyVersion → Decision` model
- **ADR-0011:** Capability Registry — Development Advisor registers as a Capability
- **ADR-0012:** Security Hardening — all G01 routes use `buildApiErrorResponse` + `sanitizeForLog`

---

## 6. New Permissions (RBAC Extension)

| Permission | Who has it? | Used for |
|------------|--------------|----------|
| `baseline:read` | admin, analyst, reviewer | View State Baseline reports |
| `baseline:compute` | admin, analyst | Trigger baseline computation task |
| `gap:read` | admin, analyst, reviewer | View Gap Analysis reports |
| `strategy:compose` | admin, analyst | Run Strategy Composer (generates drafts) |
| `strategy:approve` | admin, reviewer | Approve a strategy version (human gate) |
| `program:read` | all roles | View program contracts |
| `portfolio:read` | all roles | View dependency graph |
| `budget:read` | admin, analyst, reviewer | View budget estimates |
| `advisor:invoke` | admin, analyst, reviewer | Invoke Development Advisor |

**Separation of duties:** `strategy:compose` (draft) and `strategy:approve` (finalize) are separate permissions. The same user MAY hold both (admin), but the system enforces that approval is a distinct human action — the composer cannot self-approve.

---

## 7. Real vs Simulated — Final Inventory for G01

| Capability | Status | Honesty Mechanism |
|------------|--------|-------------------|
| State Baseline computation | **Real** (deterministic) | N/A — computation is real |
| Gap Analysis | **Real** (deterministic) | N/A |
| Strategy Composer (LLM) | **Simulated** (StubProvider) | `simulated: true` in every response + UI notice |
| Program expansion (rationale text) | **Simulated** | `simulated: true` |
| Portfolio graph (algorithms) | **Real** | N/A |
| Budget estimates (model) | **Simulated** (deterministic v1) | `modelVersion` + `simulated: true` |
| Roadmap sequencing | **Real** (topological sort) | N/A |
| Scenario Comparison (matrix) | **Real** (deterministic) | N/A |
| Comparison tradeoffs (text) | **Simulated** | `simulated: true` |
| Development Advisor (LLM) | **Simulated** (StubProvider) | `simulated: true` + disclaimer |
| Human Approval | **Live** (real auth + RBAC + audit) | Audit log + auth session |

**G01 does NOT ship a live LLM.** The `LLMProvider` interface is ready for one (ADR-0002), but G01's T1 acceptance is met with Stub. A live provider is a G01+ or G05 concern.

---

## 8. What G01 Does NOT Do

Per Roadmap §4 ("غير داخلها") and Blueprint §1.1:

1. **No comprehensive economic forecasting model** — budget estimates are conditional ranges, not predictions
2. **No full sectoral implementation for every ministry** — G01 builds the *contract* for programs, not sector-specific engines
3. **No live LLM provider** — Stub is used; real provider is a separate, explicitly-labeled step
4. **No AI auto-approval** — human sovereignty is absolute
5. **No real government data ingestion** — Demolandia (fictional) or properly-sourced public data only
6. **No external financial system integration** — budgets are illustrative
7. **No claim of real-world policy impact** — G01 proves engineering + scientific honesty, not development success
8. **No rebuild of G00 contracts** — auth, RLS, Evidence Fabric, Strategy, Tasks, Capabilities are used as-is

---

## 9. CI and Testing Strategy

### New CI steps (added to `ci.yml`)
- Migration 0017+ applies cleanly
- G01 integration tests (new files in `tests/integration/`)
- T1 Playwright E2E (new file in `tests/browser/`)
- `simulated: true` flag assertion in every LLM-dependent test

### Test file inventory (planned)
| File | Tests (est.) | Type |
|------|--------------|------|
| `tests/integration/baseline.integration.test.ts` | 12 | Integration |
| `tests/integration/gap-analysis.integration.test.ts` | 10 | Integration |
| `tests/integration/strategy-composer.integration.test.ts` | 14 | Integration |
| `tests/integration/portfolio.integration.test.ts` | 11 | Integration |
| `tests/integration/budget.integration.test.ts` | 9 | Integration |
| `tests/integration/comparison.integration.test.ts` | 8 | Integration |
| `tests/integration/advisor.integration.test.ts` | 10 | Integration |
| `tests/integration/approval.integration.test.ts` | 13 | Integration |
| `tests/integration/t1-journey.integration.test.ts` | 18 | Integration (T1) |
| `tests/browser/t1-state-builder.spec.ts` | 1 (long) | Playwright E2E |

**Estimated total:** ~116 new tests, bringing the project to ~350 tests.

### Acceptance per mission
Each mission ends with:
- SHA + CI run link
- Test count + pass/fail
- `simulated` vs `live` inventory for that mission
- Security check (authz negative tests, tenant isolation, no secrets)
- Worklog entry

---

## 10. Mission Sequencing and Gates

```
01-00 (Bootstrap) ──────────────────────────────► GATE: migration + seed pass
   │
01-01 (Baseline) ───────────────────────────────► GATE: "unknown" honored, observability modes
   │
01-02 (Gap Analysis) ───────────────────────────► GATE: uncertainty propagated
   │
01-03 (Strategy Composer) ──────────────────────► GATE: ≥2 alternatives, simulated:true
   │
01-04 (Institutional Design) ───────────────────► GATE: institution + mandate validation
   │
01-05 (Portfolio Graph) ────────────────────────► GATE: cycle detection, critical path
   │
01-06 (Budget Estimates) ───────────────────────► GATE: ranges not points, assumptions present
   │
01-07 (Implementation Roadmap) ─────────────────► GATE: dependency order respected
   │
01-08 (Scenario Comparison) ────────────────────► GATE: no prescriptive recommendation
   │
01-09 (Development Advisor v1) ─────────────────► GATE: conditional rec, disclaimer, no sovereign action
   │
01-10 (Human Approval + T1) ────────────────────► GATE: T1 passes end-to-end
```

**No mission starts until the previous mission's gate is passed.** The founder may review at any gate.

---

## 11. Founder Review Checklist

Before approving G01 implementation, the founder should verify:

- [ ] The 11 missions cover all G01 components from Roadmap §4
- [ ] T1 acceptance test is explicit and falsifiable
- [ ] Real vs Simulated is clearly separated (§7)
- [ ] Human sovereignty is absolute (§8, point 4)
- [ ] No G00 contract is rebuilt (§8, point 8)
- [ ] New permissions follow separation of duties (§6)
- [ ] "Foundation-validated" terminology is used (not "production-ready")
- [ ] No live LLM is claimed (§7)
- [ ] Scientific honesty rules are embedded (Blueprint §2 throughout)
- [ ] CI + testing strategy is concrete (§9)

---

## 12. Approval Block

**Founder decision required:**

```
GROUP_01_MISSION_PACK = APPROVED / APPROVED WITH CHANGES / REJECTED
Implementation may begin: YES / NO
First mission to execute: 01-00
```

**Do not begin implementation before approval.**

---

*This mission pack is based on the Master Blueprint v2.0, the Six-Group Roadmap v1.0, and the GROUP 00 final deliverables. It preserves all G00 contracts and applies the "Small in Code, Large in Capability" principle.*
