# GROUP 02 — Mission 02-02 Known Limitations
**Mission:** 02-02 — Evidence Independence & Observatory Views
**Date:** 2026-10-18

## Limitations Resolved by 02-02 (pending CI verification)

### G02-L12: Aggregate FULL Unreachable per-Geo — RESOLVED by 02-02
- **Affected component:** `analyzeIndependence()` per-geo analysis (02-01)
- **Original problem:** F1 constraint allows only 1 `isCurrent=true` observation per (indicator, period, geo), so per-geo analysis could never reach FULL (≥2 independent sources).
- **Resolution (02-02):** New `analyzeAggregateIndependence()` service distinguishes:
  - Geographic coverage (distinct geoRefIds) — reported separately
  - Source diversity (distinct sources, dedup by independenceGroup)
  - Evidence strength (verified/disputed/refuted/contradictory counts)
  - National claim support (national-level sources + verified evidence linked via direct OR related evidence)
- **FULL path:** 1 national observation + ≥2 independent verified evidence linked via `Observation.evidenceId` (direct) OR `Evidence.relatedEvidenceId` (transitive). This respects F1 while enabling scientifically defensible FULL.
- **B4 enforcement:** Subnational geographic spread NEVER produces FULL. If FULL is unreachable, returns PARTIAL with `limitationReason`.
- **Status:** RESOLVED by Mission 02-02 (pending CI verification).

### G02-L13: Country-Scope Warning Not Surfaced — RESOLVED by 02-02
- **Affected component:** `verifyEvidenceCountryScope()` integration (02-01)
- **Original problem:** When `evidence.metadata.countryId` was missing, the "unknown" warning was logged internally but NOT attached to `observation.qualityNotes.provenanceWarnings`.
- **Resolution (02-02):** B14 — the warning string is now appended to `provenanceWarnings` array in `ingestObservation`.
- **Status:** RESOLVED by Mission 02-02 (pending CI verification).

### G02-L14: Source/Evidence SourceId Mismatch Only Warned — DOCUMENTED by 02-02
- **Affected component:** `validateObservationProvenance()` Rule 11 (02-01)
- **Original problem:** The mismatch warning was generic ("provenance inconsistency") without explaining that this is acceptable.
- **Resolution (02-02):** B15 — warning now explains: "this is acceptable when evidence cites a different primary source (e.g., meta-analysis). Both sources are preserved for review."
- **Status:** DOCUMENTED by Mission 02-02 (pending CI verification).

## New Limitations Introduced by 02-02

### G02-L15: FULL Requires National-Level Observation + Independent Verified Evidence
- **Affected component:** `analyzeAggregateIndependence()` FULL classification
- **Description:** FULL observability mode requires either:
  - (a) ≥2 national-level observations from independent sources [FORBIDDEN by F1], OR
  - (b) 1 national-level observation + ≥2 independent verified evidence linked via direct `evidenceId` OR `Evidence.relatedEvidenceId`
- **Impact:** Path (b) is the only way to reach FULL in the current schema. If no national observation exists, or if <2 independent verified evidence are linked, the analysis returns PARTIAL with `limitationReason`.
- **Status:** Documented design tension — NOT a defect. This is honest engineering per B7.

### G02-L16: Aggregate Coverage Ratio Unknown
- **Affected component:** `analyzeAggregateIndependence()` coverage reporting
- **Description:** `coverageRatio` is always `null` because 02-02 does not look up `CountryPackConfig` to determine `totalExpectedGeoRefIds`. This was intentionally deferred to avoid scope creep.
- **Mitigation:** `distinctGeoRefIds` is still reported (raw count). A future mission can add `CountryPackConfig` lookup to compute the ratio.
- **Status:** Minor — does not affect correctness, only completeness of coverage reporting.

### G02-L17: Snapshot Does Not Include Subnational Observations
- **Affected component:** `getObservatorySnapshot()` currentObservation field
- **Description:** The snapshot's `observedFacts.currentObservation` fetches only the `geoLevel="national"` current observation. Subnational observations are not included in the snapshot per indicator.
- **Mitigation:** The aggregate independence analysis (included in the snapshot) does cover all geos. A future mission can add a `subnationalObservations` array to the snapshot if needed.
- **Status:** Documented limitation — the snapshot is national-focused by design in 02-02.

## Carried Forward from 02-00/02-01 (unchanged)

- G02-L01: Sub-Year Granularity Limited
- G02-L02: alertThresholds Limited to 2 Rules
- G02-L03: No Browser UI
- G02-L04: No Real Data Integration
- G02-L05: No External Integrations
- G02-L06: No LLM Calls
- G02-L09: Variance Computation National-Only
- G02-L10: Integration Tests Skip Locally (Run + Pass in CI)
- G02-L11: No Idempotency on Variance Computation
