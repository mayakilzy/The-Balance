# GROUP 02 — Mission 02-01 Known Limitations
**Mission:** 02-01 — Validated Evidence & Data Ingestion
**Date:** 2026-10-18

## Limitations Resolved by 02-01 (pending CI verification)

### G02-L07: Audit Failure Injection — RESOLVED (pending CI)
- **Affected component:** `writeAuditTx` atomicity verification
- **Resolution:** H-01 + H-02 integration tests use real PostgreSQL REVOKE/GRANT on `audit_log` to inject forced audit failure, then verify:
  - H-01: `ingestObservation` throws → NO observation row created (rollback worked)
  - H-02: `correctObservation` throws → original observation unchanged (no partial state)
- **Cleanup guarantee:** GRANT restored in `finally` block.
- **Status:** RESOLVED (pending CI verification on real PostgreSQL 16).

### G02-L08: Counter-Evidence Country Scope — RESOLVED (pending CI)
- **Affected component:** `Observation.evidenceId` cross-country scope
- **Resolution:** `verifyEvidenceCountryScope()` pure function + integration into `ingestObservation`. Uses `Evidence.metadata.countryId` (no schema change).
- **Behavior:**
  - Explicit mismatch → REJECTION (A6) — verified by H-09
  - Missing countryId → WARNING (A5) — verified by H-10
  - Cross-tenant evidence → REJECTION (A15) — verified by H-11 (RLS + explicit check)
- **Status:** RESOLVED (pending CI verification).

## New Limitations Introduced by 02-01

### G02-L12: Per-Geo Independence Analysis Cannot Reach FULL Mode — RESOLVED by 02-02
- **Affected component:** `analyzeIndependence()` per-geo analysis
- **Original problem:** The F1 constraint from 02-00 allows only ONE `isCurrent=true` observation per (indicator, period, geoLevel, geoRefId). Per-geo analysis could never reach FULL.
- **Resolution (02-02):** New `analyzeAggregateIndependence()` service distinguishes geographic coverage from source independence. FULL reachable via 1 national observation + ≥2 independent verified evidence linked via direct `evidenceId` OR `Evidence.relatedEvidenceId`.
- **Status:** RESOLVED by Mission 02-02 (CI #146 verified on 1a983bd — H-01..H-05 pass on real PostgreSQL 16).

### G02-L13: Country Scope Warning Not Surfaced in qualityNotes — RESOLVED by 02-02
- **Affected component:** `verifyEvidenceCountryScope()` integration
- **Original problem:** The "unknown" country-scope warning was not attached to `observation.qualityNotes.provenanceWarnings`.
- **Resolution (02-02):** B14 — the warning string is now appended to `provenanceWarnings` in `ingestObservation`.
- **Status:** RESOLVED by Mission 02-02 (CI #146 verified on 1a983bd — H-01..H-05 pass on real PostgreSQL 16).

### G02-L14: Source/Evidence SourceId Mismatch Only Warned — DOCUMENTED by 02-02
- **Affected component:** `validateObservationProvenance()` Rule 11
- **Original problem:** The mismatch warning was generic ("provenance inconsistency") without explaining acceptability.
- **Resolution (02-02):** B15 — warning now explains: "acceptable when evidence cites a different primary source (e.g., meta-analysis). Both sources preserved for review."
- **Status:** DOCUMENTED by Mission 02-02 (CI #146 verified on 1a983bd — H-11 passes on real PostgreSQL 16).

## Carried Forward from 02-00 (unchanged)

All other G02-L01 through G02-L11 limitations remain (except L07 + L08 which are resolved by 02-01):
- G02-L01: Sub-Year Granularity Limited
- G02-L02: alertThresholds Limited to 2 Rules
- G02-L03: No Browser UI
- G02-L04: No Real Data Integration
- G02-L05: No External Integrations
- G02-L06: No LLM Calls
- G02-L09: Variance Computation National-Only
- G02-L10: Integration Tests Skip Locally (Run + Pass in CI) — RESOLVED status
- G02-L11: No Idempotency on Variance Computation
