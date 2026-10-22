# GROUP 01 — State Builder Mission Pack

**Status:** APPROVED WITH CHANGES (founder decision 2026-10-17). Nine corrections applied — see §13 (Approval Record).
**Date:** 2026-10-17 (original draft) / 2026-10-17 (corrections applied)
**Base SHA:** `dcbb8961dd588bb9e66a9076bc4e62625482a56f` (GROUP 00 final)
**Authoring principle:** Progressive Mission Authoring — this pack is written only after GROUP 00 acceptance, per Roadmap §1.
**Founder decision:** `GROUP_01_MISSION_PACK = APPROVED WITH CHANGES`. Implementation may begin with `01-00` once the corrections in §13 are confirmed PASS by the founder.

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

**The rule (Blueprint §7):** The Strategy Builder produces *drafts*. Human approval alone transitions a `StrategyVersion` from `draft` to `approved` (per G00 `approveStrategyVersion()`); the approved version IS the "active" strategy — the previously-approved version of the same strategy is auto-`superseded`. No AI recommendation becomes `approved` on its own. Without authorization, the result remains a `draft`. (See §13 Correction 1 — no new lifecycle states are introduced; G00 states `draft → approved → superseded` are reused as-is.)

---

## 2. T1 Acceptance Test (The Gate)

G01 is accepted only when T1 passes end-to-end with verifiable evidence.

### T1 Scenario

A fictional or properly-sourced Country Pack → multiple strategy alternatives (grouped by `compositionBatchId`) → evidence and uncertainty → dependencies and conditional costs → authorized human approval → approved `StrategyVersion` (which is the "active" strategy per G00 contracts).

### T1 Steps (must all pass)

| Step | Action | Expected Result | Evidence |
|------|--------|-----------------|----------|
| T1.1 | Load a Country Pack (fictional "Demolandia" extended, or a properly-sourced real country with documented provenance) | Country Pack stored with institutions, sectors, admin units, legal mandates | API response + DB row |
| T1.2 | Ingest evidence cases (economic, social, institutional — with sources, dates, uncertainty) | Evidence stored in Evidence Fabric with `verification_status` and `support_stance` | Evidence list API + vector search returns relevant results |
| T1.3 | Define human goals (e.g., "reduce unemployment to 10% in 5 years") | Goals stored as Objective records linked to the country | Objective API returns goals |
| T1.4 | Compute State Baseline (indicators per sector, with gaps and observability mode) | Baseline report with `FULL/PARTIAL/LOW` observability per dimension; "unknown" where data is insufficient | Baseline API returns structured report |
| T1.5 | Run Gap Analysis (baseline vs goals, per sector) | Gap report identifying which sectors have insufficient capacity/data to reach goals | Gap Analysis API returns structured gaps |
| T1.6 | Strategy Composer generates **multiple** alternatives (at least 2, ideally 3); each alternative is a separate `Strategy` row sharing the same `compositionBatchId` (see §13 Correction 2) | Each alternative has: objectives, programs, dependencies, conditional costs, assumptions, counter-evidence, uncertainty; `simulated: true` stored in `strategy_versions.metadata` (see §13 Correction 3) | Strategy alternatives API returns array with `simulated: true` flag |
| T1.7 | Portfolio & Dependency Graph links programs across sectors | Graph shows which programs depend on others; circular dependencies rejected | Portfolio API returns dependency graph |
| T1.8 | Budget estimates are conditional (ranges, not point estimates) | Each program has cost range with assumptions; no fake precision | Budget API returns `{min, max, assumptions}` |
| T1.9 | Scenario Comparison shows trade-offs between alternatives | Comparison table: cost, risk, timeline, evidence strength, affected sectors | Comparison API returns diff-able structure |
| T1.10 | **Unauthorized** user (lacking `strategy:approve`) attempts to approve → REJECTED with 403 | Three independent evidence layers (see §13 Correction B): (a) `requirePermissionWithCurrentRole()` throws `PermissionDeniedError`; (b) `writeAudit({ action: "strategy.approve", status: "denied", errorCode: "PERMISSION_DENIED" })` writes an **independent** `audit_log` row; (c) domain event `strategy.approval_denied` recorded in `events` table | Security test + **`audit_log` row** (NOT only an `events` row — the `audit_log` table is the sovereign audit trail; `events` is the domain timeline) |
| T1.11 | **Authorized** user (with `strategy:approve`) approves one alternative → `StrategyVersion` becomes `approved` (which IS the "active" version) | Version status transitions `draft → approved` per G00 `approveStrategyVersion()`; previous approved version of the same strategy auto-`superseded`; **three** evidence layers: (a) `requirePermissionWithCurrentRole()` passes; (b) `writeAudit({ action: "strategy.version_approved", actor: userId, status: "ok", details: { strategyVersionId, versionNumber } })` writes **independent** `audit_log` row; (c) domain event `strategy.version_approved` in `events` table | Strategy version API + `audit_log` row (independent from `events` table) |
| T1.12 | Attempt to modify the approved version in place (including its `metadata` column) → REJECTED | G00 `approveStrategyVersion()` rejects re-approval of an already-approved version ("Version is already approved — approved versions are immutable"); the `metadata` column added in migration 0017 is protected by the same immutability contract — no UPDATE on approved `strategy_versions` rows; to change an approved strategy → call `createStrategyVersion()` (creates a new `draft` version) then approve the new version (previous auto-supersedes) | DB trigger test + service-level test asserting `metadata` is immutable post-approval |
| T1.13 | Government handover: new authorized user can view the active strategy + decision history + evidence snapshots | Full provenance visible; no data from other tenants leaks | Handover view API |

### T1 Negative Tests (must also pass)

- T1.N1: AI-generated recommendation does NOT auto-approve — it stays as `StrategyVersion.status: draft` (per G00 lifecycle: `draft → approved → superseded`; **no `proposed` or `active` states exist** in G00 contracts — see §13 Correction 1)
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
**Scope:** Extend the Prisma schema with G01 domain models. Seed an extended Demolandia fixture. Do NOT modify any G00 table's existing columns or RLS policies — only **add** new tables and **extend** `strategies` and `strategy_versions` with nullable columns (clean additive migration).

**New models (migration 0017):**
- `Objective` — a human-defined goal (e.g., "reduce unemployment to 10%"). **PRIVATE** (tenant-scoped — a tenant's goals are never visible to other tenants).
- `Program` — a reform program within a strategy version. **PRIVATE**.
- `Project` — a specific project within a program. **PRIVATE**.
- `BudgetLine` — a cost estimate line item (with min/max/assumptions). **PRIVATE**.
- `Dependency` — a directed edge between programs (A depends on B). **PRIVATE**.
- `RiskRegister` — risks associated with a strategy version. **PRIVATE**.
- `Assumption` — assumptions underpinning a strategy version. **PRIVATE**.
- `CountryPackConfig` — per-tenant planning configuration for a country (sector definitions used by this tenant, observability mode per dimension, planning assumptions). **PRIVATE** (tenant-scoped) — see §13 Correction A.

**Schema extensions to existing G00 tables (additive, no breaking changes):**
- `strategies` — add `compositionBatchId String?` (nullable; groups alternatives from the same composer run; indexed with `(tenantId, compositionBatchId)` for tenant-scoped lookup; RLS applies via the existing `strategies` policy — no policy weakening).
- `strategy_versions` — add `metadata Json @default("{}")` (nullable-default; stores `{ simulated, provider, composedAt, compositionBatchId, modelVersion }` and similar provenance; **immutability**: the existing G00 trigger/service that blocks UPDATE on approved versions protects this column too — no extra trigger needed, the service-level check in `approveStrategyVersion()` already rejects any re-approval, and approved versions are never UPDATEd).

**Contract:**
```typescript
// src/lib/state-builder/objective-service.ts
createObjective(session, { countryId, title, description, targetMetric, targetValue, horizon })
listObjectives(session, { countryId })  // tenant-scoped — only this tenant's objectives

// src/lib/state-builder/country-pack-service.ts
// Returns PUBLIC country reference data + this tenant's PRIVATE CountryPackConfig
getCountryPack(session, { countryId }) → {
  // PUBLIC (from G00 tables — read by all tenants)
  country: { id, iso3, displayName },
  institutions: Institution[],      // from G00 PUBLIC institutions table
  adminUnits: StateHierarchy[],    // from G00 PUBLIC state_hierarchy table
  legalMandates: RoleReference[],  // from G00 PUBLIC role_references (legal basis catalog)
  // PRIVATE (tenant-scoped — this tenant's planning view of the country)
  countryPackConfig: CountryPackConfig,  // sectors this tenant tracks, observability mode per dimension
  objectives: Objective[],               // this tenant's goals for this country
}
```

**Security boundaries (per §13 Correction A — Country Pack Data Boundaries):**

The fundamental rule: **PUBLIC reference data describes the country; PRIVATE planning data describes a tenant's view of the country.** A tenant's goals, planning assumptions, observability assessments, and strategy drafts must NEVER leak to another tenant.

| Data category | Scope | Tables | RLS | Who can read | Who can write |
|---------------|-------|--------|-----|--------------|---------------|
| **Country reference data** (geography, institutions, legal mandates catalog) | PUBLIC | G00 `countries`, `state_hierarchy`, `institutions`, `role_references`, `source_registry`, `public_knowledge` | Not applicable (PUBLIC) | All authenticated users (any tenant) | `balance_admin` only (via G00 contracts) |
| **Tenant planning data** (objectives, CountryPackConfig, programs, projects, budgets, dependencies, risks, assumptions, strategies, versions, decisions) | PRIVATE | New G01 tables + G00 `strategies`, `strategy_versions`, `decisions`, etc. | ENABLE + FORCE | Only users with active membership in THIS tenant | Users with active membership + appropriate RBAC permission |

- All 8 new G01 tables are **PRIVATE** with ENABLE + FORCE RLS, exactly like G00's 14 PRIVATE tables.
- `CountryPackConfig` is **PRIVATE**, NOT PUBLIC. The original draft said it "extends the PUBLIC `countries` table — readable by all tenants"; this is **corrected**: `CountryPackConfig` is a tenant-scoped planning overlay on top of PUBLIC country reference data. Two tenants operating on the same country (e.g., two different government bodies in Demolandia) each have their own `CountryPackConfig` row — they share the country's geography and institutions, but NOT their planning assumptions, sector priorities, or observability assessments.
- `Objectives` are PRIVATE and owned by the tenant that creates them — never visible to other tenants.
- The `compositionBatchId` on `strategies` is tenant-scoped: a tenant can only query alternatives by `compositionBatchId` within its own RLS-filtered rows. Cross-tenant access to the same `compositionBatchId` value is prevented by RLS (the value is meaningless across tenants because RLS blocks the rows).

**Real vs Simulated:** Foundation (schema + seed). No intelligence yet. The Demolandia v2 fixture is honestly labeled `fictional: true` in seed metadata.

**Tests:**
- Migration 0017 applies cleanly on a fresh DB (no modification to G00 migrations 0001–0016)
- RLS enabled + forced on all 8 new PRIVATE tables
- `strategies.compositionBatchId` and `strategy_versions.metadata` columns added without breaking existing G00 tests (the 237 G00 tests must still pass unchanged)
- Demolandia v2 fixture seeds correctly (extended sectors, institutions, objectives, CountryPackConfig for the Demolandia tenant)
- Cross-tenant isolation for `Objectives`: Tenant B cannot read Tenant A's objectives (RLS test)
- Cross-tenant isolation for `CountryPackConfig`: Tenant B cannot read Tenant A's `CountryPackConfig` for the same country (RLS test — this is the key test for Correction A)
- Immutability: `strategy_versions.metadata` cannot be UPDATEd after the version is `approved` (service-level test asserting `approveStrategyVersion()` rejects re-approval, and a direct DB UPDATE attempt on an approved version's `metadata` is blocked)
- `compositionBatchId` grouping: composer-created alternatives share the same `compositionBatchId` within a tenant; querying by `compositionBatchId` returns only this tenant's alternatives

**Acceptance evidence:** Migration 0017 applied; `fresh-install-verify.sh` passes with 22+ private tables (14 G00 + 8 G01); seed creates 5+ objectives for Demolandia; cross-tenant `CountryPackConfig` isolation test passes (the critical Correction A test); G00's 237 tests still pass unchanged (no regression).

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
- The AI output is stored as `StrategyVersion.status: draft` (per G00 lifecycle — never `proposed` or `approved`; `proposed` is not a valid G00 state)

**Real vs Simulated:** **Simulated** in G01 (StubProvider). The `LLMProvider` interface (G00 ADR-0002) is ready for a real provider, but G01 ships with Stub. Every response carries `simulated: true`.

**Tests:**
- Composer returns ≥2 alternatives
- Each alternative has evidence refs (no unsourced claims)
- Counter-evidence is present for high-impact programs
- `simulated: true` in every response
- Task crash mid-composition → reclaim → no duplicate alternatives
- Prompt injection attempt in evidence → rejected (sanitization)
- Unauthorized user (no `strategy:write`) → 403 — the composer reuses the existing `strategy:write` permission (see §13 Correction 4); no new `strategy:compose` permission is introduced

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
**Scope:** Wire the full T1 journey end-to-end. The approval gate itself reuses G00's `approveStrategyVersion()` — no parallel approval system is built. The new work is: (a) the T1 E2E orchestration, (b) adding the `writeAudit()` call alongside the existing domain event in the approval path (per §13 Correction B), and (c) the Playwright E2E test.

**Contract (reuse G00 `approveStrategyVersion()` — see §13 Correction 6):**

G00's `src/lib/strategy-service.ts` already provides:
```typescript
approveStrategyVersion(session, versionId, approvalNotes?) → { versionId, status, approvedBy }
// Per G00 implementation:
//   1. requirePermissionWithCurrentRole(session, "strategy:approve")  ← Authorization
//   2. findFirst({ where: { id: versionId, tenantId } })              ← cross-tenant block
//   3. if (version.status === "approved") throw                       ← immutability
//   4. tx.strategyVersion.update → status: "approved", approvedBy, approvedAt
//   5. tx.strategyVersion.updateMany → supersede previous approved versions
//   6. tx.strategy.update → status: "approved"
//   7. tx.event.create({ eventType: "strategy.version_approved" })    ← Domain Event
```

**The single G01 addition to the approval path** (per §13 Correction B): insert a `writeAudit()` call between step 6 and step 7 above, so the approval produces BOTH:
- a domain event in the `events` table (G00 behavior — the domain timeline), AND
- an independent row in the `audit_log` table (G01 addition — the sovereign audit trail).

The `audit_log` row is the **compliance-grade** evidence; the `events` row is the **domain timeline**. They serve different purposes and must not be conflated. The `audit_log` is append-only (REVOKE UPDATE/DELETE from `balance_app` per G00 migration 0003), independent of the `events` table, and survives even if the `events` table is truncated for operational reasons.

```typescript
// The G01 wrapper in src/lib/state-builder/approval-service.ts:
export async function approveStrategyVersionWithAudit(
  session: Session,
  versionId: string,
  approvalNotes?: string
) {
  // (Authorization + immutability + domain event are handled by G00's approveStrategyVersion)
  const result = await approveStrategyVersion(session, versionId, approvalNotes);

  // G01 addition: independent audit_log row (per §13 Correction B)
  await writeAudit({
    tenantId: session.user.tenantId,
    actor: session.user.id,
    action: "strategy.version_approved",
    status: "ok",
    details: {
      strategyVersionId: result.versionId,
      approvedBy: result.approvedBy,
      approvalNotes: approvalNotes?.slice(0, 200),
    },
  });

  return result;
}

// For denied attempts (T1.10), the wrapper catches PermissionDeniedError
// and writes an audit_log row with status: "denied" BEFORE re-throwing:
export async function approveStrategyVersionWithAuditSafe(
  session: Session,
  versionId: string,
  approvalNotes?: string
) {
  try {
    return await approveStrategyVersionWithAudit(session, versionId, approvalNotes);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      await writeAudit({
        tenantId: session.user.tenantId,
        actor: session.user.id,
        action: "strategy.version_approved",
        status: "denied",
        errorCode: "PERMISSION_DENIED",
        details: { strategyVersionId: versionId, permission: err.permission },
      });
    }
    throw err;
  }
}
```

**Human sovereignty rules (Blueprint §1.1, §2):**
- Only a human with `strategy:approve` (held by `reviewer` + `admin` per G00 RBAC) can transition a version to `approved` — enforced by G00's `requirePermissionWithCurrentRole()` which checks the CURRENT DB role (not the stale JWT).
- The AI recommendation (from 01-09 Development Advisor) is stored as `Evidence` with `support_stance: "neutral"` — it is NOT the decision. The decision is the human's `approveStrategyVersion()` call.
- The approval produces **three** independent evidence layers (per §13 Correction B):
  1. **Authorization enforcement** — `requirePermissionWithCurrentRole()` throws `PermissionDeniedError` if the user lacks `strategy:approve` or their membership is revoked/suspended.
  2. **Domain Event** — `tx.event.create({ eventType: "strategy.version_approved", actor, entityId: versionId })` records the domain timeline entry. This is G00 behavior, unchanged.
  3. **Audit Log** — `writeAudit({ action: "strategy.version_approved", actor, status: "ok"|"denied" })` writes an **independent** row in the `audit_log` table. This is the G01 addition (Correction B). The `audit_log` is append-only (DB-enforced), independent from `events`, and is the compliance-grade sovereign audit trail.
- Once approved, the version (including its `metadata` column from migration 0017) is immutable — G00's `approveStrategyVersion()` rejects re-approval, and no UPDATE path exists for approved versions.
- To change an approved strategy → call G00's `createStrategyVersion()` (creates a new `draft` version), then approve the new version; the previously-approved version auto-transitions to `superseded`.

**Security boundaries:**
- `strategy:approve` permission required (held by `reviewer` + `admin` only, per G00 `permissions.ts` — separation of duties: `analyst` has `strategy:write` but NOT `strategy:approve`, so an analyst can compose but cannot approve their own composition).
- Approval is a single-action (no batch approval in G01).
- Cross-tenant approval → rejected by G00's `findFirst({ where: { id: versionId, tenantId } })` (returns null → throws "Strategy version not found in tenant scope"). RLS provides a second layer of defense.
- The `audit_log` row is written inside the same `withAuthenticatedTenant` transaction as the approval, so it is atomic — if the approval rolls back, the audit_log row rolls back too (no orphan audit entries for failed transactions). For denied attempts (where the transaction is rolled back), the audit_log write happens in a separate best-effort call AFTER the rollback, so the denial is still recorded even though the primary transaction failed.

**Real vs Simulated:** The approval workflow is **Live** — it uses real Auth.js sessions, real RBAC checks (current DB role), real RLS enforcement, real immutability, and real audit logging. No simulation. This is the one component in G01 that is unambiguously Live (not Simulated).

**T1 Integration Test (Playwright + API):**
- Full journey: login → load country pack → ingest evidence → define goals → compute baseline → gap analysis → compose strategies (≥2 alternatives, same `compositionBatchId`) → expand programs → build portfolio → estimate budgets → build roadmap → compare scenarios → get advisory → **unauthorized approval fails (T1.10)** → **authorized approval succeeds (T1.11)** → verify approved version (T1.11) → verify immutability (T1.12) → verify audit trail (T1.10 + T1.11) → verify handover (T1.13)
- Screenshots at each step
- API responses captured as evidence
- `simulated: true` flags verified throughout (in `strategy_versions.metadata` for composer output, in API responses for advisor output)
- **Audit trail verification (per §13 Correction B):**
  - After T1.10 (denied): assert an `audit_log` row exists with `action: "strategy.version_approved"`, `status: "denied"`, `actor: <unauthorized user id>`. Assert an `events` row also exists with `eventType: "strategy.approval_denied"`. Assert these are in DIFFERENT tables (not the same row).
  - After T1.11 (approved): assert an `audit_log` row exists with `action: "strategy.version_approved"`, `status: "ok"`, `actor: <authorized user id>`, `details.strategyVersionId: <version id>`. Assert an `events` row also exists with `eventType: "strategy.version_approved"`. Assert the `audit_log` row's `actor` matches the `events` row's `actor` (consistency check across the two tables).

**Tests:**
- T1.1 through T1.13 (from §2 above) — all 13 positive steps
- T1.N1 through T1.N5 (negative tests)
- Full Playwright E2E for the journey (`tests/browser/t1-state-builder.spec.ts`)
- **Audit log independence test (new, per Correction B):** verify that `audit_log` and `events` are independent tables — an `audit_log` row exists for both approved and denied attempts, and the `events` table is NOT the only record of the approval.
- **Authorization enforcement test:** verify that a user whose membership is revoked mid-session (JWT still valid but DB role revoked) is denied by `requirePermissionWithCurrentRole()` (which checks the CURRENT DB role, not the stale JWT — this is G00's defense against revoked-but-not-expired sessions).

**Acceptance evidence:**
- T1 Playwright test passes in CI
- All 13 positive steps + 5 negative tests pass
- `audit_log` table shows approval with actor identity, timestamp, and versionId (T1.11)
- `audit_log` table shows denied attempt with actor identity, timestamp, errorCode (T1.10)
- `events` table shows domain timeline entries for both (T1.10, T1.11) — but this is NOT claimed as the audit evidence; the `audit_log` is
- Approved version is immutable (including its `metadata` column)
- Cross-tenant isolation holds (T1.N2)
- `simulated: true` is present in every LLM-dependent response (T1.6, advisory in T1.10 step)
- No AI recommendation appears as `approved` (T1.N1 — composer output stays `draft`)
- Three-layer evidence (Authorization + Domain Event + Audit Log) is verified for both the approved and denied paths

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
- **ADR-0008:** RBAC/ABAC — new permissions: `baseline:read`, `baseline:compute`, `gap:read`, `program:read`, `portfolio:read`, `budget:read`. The composer reuses existing `strategy:write`; the advisor reuses existing `strategy:read`; the approver reuses existing `strategy:approve`. No `strategy:compose` or `advisor:invoke` permissions are introduced (see §13 Corrections 4 & 5).
- **ADR-0009:** Evidence Fabric — G01 strategies cite evidence via `evidence_id` refs
- **ADR-0010:** Strategy Contracts — G01 uses the existing `Strategy → StrategyVersion → Decision` model
- **ADR-0011:** Capability Registry — Development Advisor registers as a Capability
- **ADR-0012:** Security Hardening — all G01 routes use `buildApiErrorResponse` + `sanitizeForLog`

---

## 6. New Permissions (RBAC Extension)

Per §13 Corrections 4 & 5: the composer reuses the existing `strategy:write` permission (already held by `analyst` + `admin` per G00 `permissions.ts`), and the advisor reuses the existing `strategy:read` permission (already held by all four roles). No `strategy:compose` or `advisor:invoke` permissions are introduced — they would have been redundant with existing G00 permissions and would have violated ADR-0008's principle of a small, explicit permission catalog.

| Permission | Who has it? | Used for | New or existing? |
|------------|--------------|----------|------------------|
| `baseline:read` | admin, analyst, reviewer | View State Baseline reports | **New** (G01) |
| `baseline:compute` | admin, analyst | Trigger baseline computation task | **New** (G01) |
| `gap:read` | admin, analyst, reviewer | View Gap Analysis reports | **New** (G01) |
| `strategy:write` | admin, analyst | Create strategies + versions + decisions; **also used by Strategy Composer** (01-03) to create draft alternatives | **Existing** (G00) — reused by composer per Correction 4 |
| `strategy:read` | admin, analyst, reviewer, observer | Read strategies + versions + decisions; **also used by Development Advisor** (01-09) which is read-only | **Existing** (G00) — reused by advisor per Correction 5 |
| `strategy:approve` | admin, reviewer | Approve a strategy version (human gate) | **Existing** (G00) — reused by 01-10 per Correction 6 |
| `program:read` | all roles | View program contracts | **New** (G01) |
| `portfolio:read` | all roles | View dependency graph | **New** (G01) |
| `budget:read` | admin, analyst, reviewer | View budget estimates | **New** (G01) |

**Separation of duties (per §13 Correction 4):** `strategy:write` (held by `analyst` + `admin`) lets a user **compose** draft strategies, but does NOT let them **approve** — `strategy:approve` is held only by `reviewer` + `admin`. So:
- An `analyst` can compose but cannot approve their own composition (no `strategy:approve`).
- A `reviewer` can approve but cannot compose (no `strategy:write`) — they review and approve what an analyst composed.
- An `admin` can do both (holds both permissions) — but the system enforces that approval is a distinct human action (a separate API call, a separate audit_log row); the composer cannot self-approve in a single automated step.

This achieves the same separation-of-duties goal as the original draft's `strategy:compose` vs `strategy:approve` split, but without introducing a redundant permission.

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

## 13. Approval Record — Founder Decision & Correction Compliance

### 13.1 Founder Decision

```
DECISION DATE: 2026-10-17
FOUNDER: Ayman (mayakilzy)
DECISION: GROUP_01_MISSION_PACK = APPROVED WITH CHANGES
IMPLEMENTATION MAY BEGIN: NO — until the corrections below are confirmed PASS
FIRST MISSION: 01-00 (G01 Bootstrap + Country Pack Extension)
REVIEWING AGENT: GLM (Z.ai) — primary development agent for GROUP 01
```

The founder approved the mission pack's architecture and scope, but identified nine (9) corrections required before implementation begins. Seven (7) corrections were proposed by the reviewing agent (GLM) and accepted; two (2) additional corrections (A and B) were added by the founder.

### 13.2 Correction Compliance Table

| # | Correction | Source | Status | Evidence in this document |
|---|------------|--------|--------|---------------------------|
| 1 | Use G00's existing Strategy/StrategyVersion lifecycle (`draft → approved → superseded`). No new states (`proposed`, `active`, `amended`, `retired`). The approved version IS the "active" version. | GLM review | ✅ APPLIED | §1 (rule restated); T1.11 (transition `draft → approved`); T1.12 (immutability via `approveStrategyVersion()`); T1.N1 (composer output stays `draft`); Mission 01-03 Security boundaries (`status: draft`); Mission 01-10 (transitions use G00 function) |
| 2 | Adopt `compositionBatchId` as a simple mechanism to group alternatives, with tenant isolation guaranteed (no cross-tenant access to the same batch). | GLM review | ✅ APPLIED | T1.6 (alternatives share `compositionBatchId`); Mission 01-00 Schema extensions (`strategies.compositionBatchId String?` indexed with `(tenantId, compositionBatchId)`); Mission 01-00 Security boundaries (RLS blocks cross-tenant access to the same `compositionBatchId`); Mission 01-00 Tests (grouping test) |
| 3 | Extend `strategy_versions` with `metadata` for simulation/provider/composition provenance, while preserving immutability of approved versions (the `metadata` column is protected by the same no-UPDATE contract as the rest of the approved row). | GLM review | ✅ APPLIED | Mission 01-00 Schema extensions (`strategy_versions.metadata Json @default("{}")`); Mission 01-00 Tests (immutability test for `metadata` post-approval); T1.12 (immutability covers `metadata`); Mission 01-10 (metadata immutability asserted) |
| 4 | Delete `strategy:compose`; use the existing `strategy:write` for the composer. | GLM review | ✅ APPLIED | Mission 01-03 Tests (unauthorized → 403 on `strategy:write`); §5 ADR-0008 reference (composer uses `strategy:write`); §6 Permissions table (`strategy:write` reused, no `strategy:compose` row); §6 Separation of duties (analyst can compose but not approve) |
| 5 | Delete `advisor:invoke`; use the existing `strategy:read` for the advisor (read-only). | GLM review | ✅ APPLIED | Mission 01-09 Security boundaries (`requiredPermission: "strategy:read"` — unchanged); §5 ADR-0008 reference (advisor uses `strategy:read`); §6 Permissions table (`strategy:read` reused, no `advisor:invoke` row) |
| 6 | Reuse G00's `approveStrategyVersion()` instead of building a parallel approval system. | GLM review | ✅ APPLIED | Mission 01-10 Contract (G00 function signature + 7-step behavior documented); Mission 01-10 wrapper (`approveStrategyVersionWithAudit` calls G00 function then adds audit); Mission 01-10 Human sovereignty rules (G00 function enforces authz + immutability) |
| 7 | Fix T1.11 and T1.12 to match G00's actual lifecycle (no `proposed → approved → active`; instead `draft → approved` with previous auto-superseded). | GLM review | ✅ APPLIED | T1.11 (transition `draft → approved`); T1.12 (immutability via `approveStrategyVersion()`, change via `createStrategyVersion()`); T1.N1 (stays `draft`, no `proposed` state); Mission 01-03 Security boundaries (`status: draft`) |
| A | **Country Pack Data Boundaries.** Clearly separate PUBLIC reference data (country geography, institutions, legal mandates catalog) from PRIVATE tenant planning data (objectives, CountryPackConfig, programs, etc.). A tenant's goals/plans/assumptions must NEVER be visible to other tenants. `CountryPackConfig` is PRIVATE, not PUBLIC. | Founder directive | ✅ APPLIED | Mission 01-00 New models (all 8 models marked PRIVATE explicitly; `CountryPackConfig` corrected to PRIVATE); Mission 01-00 Security boundaries (full PUBLIC/PRIVATE table with RLS + read/write permissions); Mission 01-00 Tests (cross-tenant `CountryPackConfig` isolation test — the critical Correction A test); Mission 01-00 Contract (`getCountryPack` returns PUBLIC reference + PRIVATE planning separately) |
| B | **Human Approval Evidence.** Distinguish between (1) Authorization enforcement (`requirePermissionWithCurrentRole`), (2) Domain Events (`events` table — the domain timeline), (3) Audit Log (`audit_log` table — the sovereign append-only compliance trail). T1 must prove that only an authorized user can approve, that the approver's identity + timestamp + approved version are recorded, and that an unauthorized attempt is rejected AND auditable. Do not claim an independent Audit exists if the only implementation is a Domain Event. | Founder directive | ✅ APPLIED | T1.10 (three-layer evidence for denied: authz throws + `writeAudit` denied row + domain event); T1.11 (three-layer evidence for approved: authz passes + `writeAudit` ok row + domain event); Mission 01-10 Contract (G00 7-step + G01 audit addition); Mission 01-10 Human sovereignty rules (three independent evidence layers enumerated); Mission 01-10 Tests (audit log independence test + authorization enforcement test for revoked membership); Mission 01-10 Acceptance evidence (`audit_log` AND `events` verified separately) |

### 13.3 T1 Contract Compliance Confirmation

The reviewing agent confirms that T1 (§2) is now fully aligned with G00 contracts:

| T1 step | G00 contract used | Alignment |
|---------|-------------------|-----------|
| T1.1 (Country Pack) | G00 PUBLIC `countries` + `institutions` + `state_hierarchy`; G01 PRIVATE `CountryPackConfig` (Correction A) | ✅ Aligned |
| T1.2 (Evidence) | G00 `createEvidence()` + `searchEvidence()` (Evidence Fabric, ADR-0009) | ✅ Aligned |
| T1.3 (Objectives) | G01 new `Objective` table (PRIVATE, RLS) | ✅ Aligned |
| T1.4 (Baseline) | G01 `baseline-service.ts` using G00 Task Runtime + Evidence Fabric | ✅ Aligned |
| T1.5 (Gap Analysis) | G01 `gap-analysis-service.ts` using baseline + objectives | ✅ Aligned |
| T1.6 (Composer) | G01 `strategy-composer-service.ts` using G00 `LLMProvider` (Stub) + `strategy:write` (Correction 4) + `compositionBatchId` (Correction 2) + `metadata.simulated` (Correction 3) | ✅ Aligned |
| T1.7 (Portfolio) | G01 `portfolio-service.ts` (cycle detection, critical path) | ✅ Aligned |
| T1.8 (Budget) | G01 `budget-service.ts` (ranges, not points) | ✅ Aligned |
| T1.9 (Comparison) | G01 `comparison-service.ts` (read-only matrix) | ✅ Aligned |
| T1.10 (Denied approval) | G00 `requirePermissionWithCurrentRole()` + G01 `writeAudit({status:"denied"})` (Correction B) + G00 `events` table | ✅ Aligned |
| T1.11 (Approved) | G00 `approveStrategyVersion()` (Corrections 1, 6, 7) + G01 `writeAudit({status:"ok"})` (Correction B) + G00 `events` table | ✅ Aligned |
| T1.12 (Immutability) | G00 `approveStrategyVersion()` rejects re-approval + no UPDATE path on approved `strategy_versions` (including `metadata` — Correction 3) | ✅ Aligned |
| T1.13 (Handover) | G00 RLS + G00 `getDecisionDetail()` (evidence snapshots) | ✅ Aligned |
| T1.N1 (No auto-approve) | Composer writes `status: draft` (Correction 1, 7) — never `approved` | ✅ Aligned |
| T1.N2 (Cross-tenant RLS) | G00 RLS on all 14 PRIVATE tables + G01 RLS on 8 new PRIVATE tables (Correction A) | ✅ Aligned |
| T1.N3 (Unknown) | Blueprint §2 — system says "unknown", does not fabricate | ✅ Aligned |
| T1.N4 (Counter-evidence) | G00 `evidence.type: "counter"` + Mission 01-03 `counterEvidence` field | ✅ Aligned |
| T1.N5 (Task crash + reclaim) | G00 Task Runtime fencing + `reclaimStaleTasks()` (ADR-0011) | ✅ Aligned |

### 13.4 What Was NOT Changed (Respecting Binding Decisions)

Per the founder's directive, the following were NOT modified:
- No G00 source code was modified (`src/lib/*.ts` untouched)
- No G00 migration was modified (migrations 0001–0016 untouched)
- No G00 ADR was reopened (ADR-0001 through ADR-0012 untouched)
- No RLS policy was weakened (existing policies on 14 PRIVATE tables unchanged)
- No Master Blueprint v2.0 or Six-Group Roadmap v1.0 content was modified
- No `simulated: true` honesty mechanism was removed
- No AI auto-approval was introduced
- No new operational complexity (no Kubernetes, no microservices, no new engines)

### 13.5 Implementation Authorization

```
IMPLEMENTATION MAY BEGIN: NO — until the founder confirms this correction compliance table is PASS.
EXPECTED FOUNDER RESPONSE: "Corrections confirmed PASS. Implementation may begin with 01-00."
```

Once the founder confirms PASS, the reviewing agent will:
1. Append a worklog entry to `/home/z/my-project/worklog.md` recording the founder's confirmation.
2. Begin Mission 01-00 (G01 Bootstrap + Country Pack Extension) per the contract in §4.
3. Report each mission's completion per the Roadmap §12 mission report template.

---

*This mission pack is based on the Master Blueprint v2.0, the Six-Group Roadmap v1.0, and the GROUP 00 final deliverables. It preserves all G00 contracts and applies the "Small in Code, Large in Capability" principle. The nine corrections in §13 were applied on 2026-10-17 by the reviewing agent (GLM) per the founder's APPROVED WITH CHANGES decision.*
