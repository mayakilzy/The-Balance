# GROUP 02 — Known Limitations

**Final SHA:** `b5fb96503ab4a11bc0204c6cf6a020b1c2d2cbd3`
**CI #167:** https://github.com/mayakilzy/The-Balance/actions/runs/39120570514
**Recovery #105:** https://github.com/mayakilzy/The-Balance/actions/runs/39120570511

This document is the authoritative GROUP 02 limitations register. It supersedes the per-mission `02-0X_KNOWN_LIMITATIONS.md` files for any item whose status has changed since the mission was first approved. The per-mission files are preserved as historical records; this document is the current state.

## Status Legend

| Status | Meaning |
|--------|---------|
| **CLOSED** | Resolved and verified by owner on the final SHA. |
| **DOCUMENTED** | Deliberate design choice, not a defect. Will not be "fixed" without owner approval. |
| **DEFERRED** | Known gap deferred to a future mission (GROUP 03 or later). |

## Closed Items

### G02-L21: Test Cleanup Isolation — CLOSED

- **Originally identified in:** Mission 02-03
- **Originally carried forward in:** 02-04, 02-05
- **Final closure SHA:** `b5fb96503ab4a11bc0204c6cf6a020b1c2d2cbd3`
- **Closure evidence:**
  - CI #167: https://github.com/mayakilzy/The-Balance/actions/runs/39120570514 — SUCCESS
  - Recovery #105: https://github.com/mayakilzy/The-Balance/actions/runs/39120570511 — SUCCESS
  - 7 sentinel regression tests PASS on real PostgreSQL 16
- **Resolution narrative:**
  The FixtureTracker now enforces strict ownership semantics:
  - `trackOwned(record)` only tracks when `createdByThisSuite=true` — pre-existing records are never registered for deletion.
  - `cleanup(client)` uses `deleteMany({ where: { id } })` which is idempotent (returns `count=0` for missing records, no throw).
  - Real DB errors are surfaced (no text-based suppression that could swallow errors whose message contains "not found").
  - Tracking state is RETAINED after failure — caller can retry or inspect `trackedCount` to know there are pending records.
- **Sentinel regression tests** (`tests/integration/g02-l21-sentinel.integration.test.ts`):
  1. Pre-existing ObservationPeriod + Observation survive `trackOwned` + `cleanup`; newly-created period IS deleted.
  2. Two trackers do not interfere (sequential).
  3. `trackOwned` with `createdByThisSuite=false` is a no-op.
  4. `FixtureTracker.cleanup` is idempotent (calling twice does not error).
  5. **FINAL-1:** Cleanup surfaces real DB errors (broken PrismaClient → ECONNREFUSED) and retains tracking state after failure.
  6. **FINAL-2:** Parallel cleanup of independent trackers (Promise.all on disjoint ID sets) does not cross-delete records; shared period SURVIVES.
  7. **FINAL-2b:** Parallel cleanup with accidental overlap (both trackers track the same record) is safe — the second `deleteMany` returns `count=0` (idempotent).
- **Owner's closure principle:** "The record that the test did not create must remain as it is after the test runs and cleans up."

## Documented Limitations (Deliberate Design Choices)

### G02-L25: Publication Approval Gap — DOCUMENTED

- **Affected component:** Public and Research tiers of `permissioned-view-service.ts`
- **Description:** No publication approval mechanism exists in the schema. `Evidence.classification="public"` is a default value, not publication consent. Public and Research tiers return `publication_unavailable` (fail-closed).
- **Why deliberate:** Publishing observatory data to the public or to external researchers requires a trustworthy consent workflow — not just a classification field. Without such a workflow, any "publication" would be premature and potentially harmful.
- **Impact:**
  - Public tier (`getPermissionedView` with no session) → `publication_unavailable`
  - Research tier (observer role) → `publication_unavailable`
  - Government tier (admin/analyst/reviewer) → returns data, but only with public-classified evidence (see G02-L26)
- **Mitigation:** Future mission (after GROUP 03 or as a standalone hardening pass) must design and implement a publication approval workflow. Until then, no claim of operational public publication is made.
- **Status:** DOCUMENTED — deliberate fail-closed design. **No claim of operational public publication.**

### G02-L26: Government Projection Limited to Public Evidence — DOCUMENTED

- **Affected component:** `permissioned-view-service.ts` government tier
- **Description:** The new permissioned projection includes only `classification="public"` evidence for ALL government viewers (including admin). No classified/restricted clearance policy exists.
- **Why deliberate:** A granular clearance policy (e.g., "user X has clearance for classification=restricted in sector Y") requires explicit owner approval and a per-user clearance model that does not exist in the schema. Without it, the conservative choice is to expose only public-classified evidence in the new government projection.
- **Impact:**
  - Government viewers see a conservative subset of evidence.
  - The existing Observatory Snapshot (02-02) still shows all evidence for authorized users — the new projection is **additive**, not replacing.
  - No regression: existing observatory snapshot behavior is unchanged.
- **Mitigation:** Future mission may add a clearance model with explicit owner approval. Until then, the conservative security design stands.
- **Status:** DOCUMENTED — conservative security design. **No claim of operational classified/restricted clearance.**

## Deferred Limitations (Future Mission)

### G02-L22: Institutional Early Warning Not Computed — DEFERRED

- **Affected component:** `institutional-view-service.ts`
- **Description:** Institutional early warning is always `"not_computed"` in 02-04. The existing `assessEarlyWarning` service (02-03) supports national scope only.
- **Mitigation in place:** National early warning is labeled with `geoScope: "national"` to prevent conflation with institutional scope.
- **Deferred to:** Future mission (likely GROUP 03 or a hardening pass).
- **Status:** DEFERRED

### G02-L23: No Hierarchical Institution Aggregation — DEFERRED

- **Affected component:** `institutional-view-service.ts`
- **Description:** Parent/child institution measurements are NOT auto-merged (D5). The `includeDescendants` flag is not implemented in 02-04. Each institution's view contains only its own direct measurements.
- **Mitigation in place:** Each institution's view is self-contained; no incorrect aggregation occurs.
- **Deferred to:** Future mission.
- **Status:** DEFERRED

### G02-L24: Sector View Observability Not Computed — DEFERRED

- **Affected component:** `sector-view-service.ts`
- **Description:** `aggregateObservability.status = "not_computed"` in sector view (D7). Real observability requires per-indicator `analyzeAggregateIndependence` which is not invoked in the sector view path.
- **Mitigation in place:** Sector view returns counts only (programs, institutions, indicators) — no false observability claims.
- **Deferred to:** Future mission.
- **Status:** DEFERRED

## Carried-Forward Limitations (From GROUP 01 and 02-00)

The following limitations are NOT closed by GROUP 02. They are preserved here for visibility. The authoritative source remains `docs/mission-reports/G01/GROUP_01_KNOWN_LIMITATIONS.md` and `docs/mission-reports/G02/02-00_KNOWN_LIMITATIONS.md`.

### From GROUP 01 (still apply)

1. **Simulated Intelligence (StubProvider)** — All LLM-dependent services use StubProvider. GROUP 02 added no LLM-dependent services, so this limitation is unchanged.
2. **Evidence Support Assessment** — `supportAssessment = "not-assessed"`. GROUP 02 did not add a claim-support verification model.
3. **Counter-Evidence Provenance** — improved in 02-02 (B5: counter-evidence excluded from supporting count) but the underlying claim-support model remains "not-assessed".
4. **Budget Estimates (No Real Market Data)** — unchanged.
5. **Timeline / Scheduling** — unchanged.
6. **Development Advisor Abstention** — unchanged.
7. **Browser E2E Test Coverage** — unchanged. GROUP 02 has no browser UI.
8. **No Real Country Data** — unchanged. Demolandia only.
9. **Single-Tenant Testing** — improved: 02-04 added explicit cross-tenant negative tests (V-15).
10. **Counter-Evidence Country Scope** — RESOLVED in 02-01 (G02-L08).
11. **Audit Failure Injection Not Implemented** — unchanged.

### From 02-00 (still apply)

- **G02-L01**: Sub-Year Granularity Limited to yearly/quarterly/monthly.
- **G02-L02**: `alertThresholds` Limited to 2 Rules per Indicator.
- **G02-L03**: Browser UI for State Observatory — not implemented.
- **G02-L04**: Real data integration (World Bank, IMF, etc.) — not implemented.
- **G02-L05**: External integrations (Email/SMS/webhooks) — not implemented.
- **G02-L06**: LLM-assisted interpretation — not implemented (advisory only, never replaces human review).
- **G02-L07**: Audit failure injection test (forced `writeAuditTx` failure → verify rollback) — not implemented.
- **G02-L09**: Subnational variance computation (per province/institution) — not implemented.
- **G02-L10**: Integration tests — RESOLVED (all 9 G02 integration test files now run in CI).
- **G02-L11**: Idempotency on variance computation — not implemented.

## Architectural Invariants (NOT Limitations)

The following are deliberate architectural choices that are NOT limitations — they are invariants that must not change without owner approval:

1. `attributionLevel = "descriptive"` always — no causal claims without evidence.
2. StrategyVersion referenced as READ-ONLY FK — never modified by observatory services.
3. Observations are append-only with correction chains (R4) — no in-place mutation.
4. isCurrent uniqueness via partial unique index with `COALESCE(geo_ref_id, '')` (F1).
5. Chain integrity via DB trigger — no branching, no cycles, no self-reference (F3).
6. VarianceRecord.observationId is NULLABLE — null when unknown (F4).
7. Alert separates `lifecycleStage` from `executionStatus` (R5/F6).
8. `verifyExecution` requires `verifiedAction` + `evidenceSource` (F6).
9. No new tables/migrations/permissions in 02-01 through 02-05.
10. `src/lib/state-builder/` diff = 0 — GROUP 01 code untouched.

## No Claim of Causal Attribution

The platform makes **no claim of causal attribution**. All variance records, alerts, and observability snapshots use `attributionLevel = "descriptive"`. Correlation between planned and actual values is reported; causation is never claimed. This is an architectural invariant, not a limitation — it reflects the honest epistemic stance of the platform.
