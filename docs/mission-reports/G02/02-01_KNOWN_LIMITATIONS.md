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

### G02-L12: Per-Geo Independence Analysis Cannot Reach FULL Mode
- **Affected component:** `analyzeIndependence()` per-geo analysis
- **Description:** The F1 constraint (`observations_one_current_idx`) from 02-00 allows only ONE `isCurrent=true` observation per (indicator, period, geoLevel, geoRefId). Since each observation has exactly one `sourceId`, a per-geo analysis can never have ≥2 independent sources in the same geo tuple. Therefore FULL mode (≥2 independent sources + ≥1 verified evidence) is unreachable in per-geo analysis.
- **Workaround:** FULL mode IS reachable in unit tests (which mock multiple observations bypassing F1). For real data, FULL requires either:
  - A future "aggregate" analyzer that spans multiple geos for the same indicator+period
  - OR a schema change to allow multiple observations per geo (would require reopening F1)
- **Status:** Documented limitation. Future mission may add aggregate analyzer.

### G02-L13: Country Scope Warning Not Surfaced in qualityNotes
- **Affected component:** `verifyEvidenceCountryScope()` integration
- **Description:** When `evidence.metadata.countryId` is missing, the country scope check returns `level="unknown"` (warning). However, this warning is currently only logged internally — it is NOT attached to `observation.qualityNotes.provenanceWarnings` (which only contains warnings from `validateObservationProvenance()`).
- **Impact:** Callers cannot see the "country scope unknown" warning in the observation's metadata.
- **Mitigation:** The warning IS visible in audit_log details. A future hardening pass could surface it in `qualityNotes`.
- **Status:** Minor — does not affect correctness, only observability.

### G02-L14: Source/Evidence SourceId Mismatch Only Warned (Not Rejected)
- **Affected component:** `validateObservationProvenance()` Rule 11
- **Description:** When `observation.sourceId` ≠ `evidence.sourceId`, the validator emits a WARNING (not an error). This is intentional — evidence may legitimately cite a different primary source than the observation's direct source (e.g., evidence from a meta-analysis).
- **Impact:** Provenance inconsistency is flagged but not blocked.
- **Status:** Intentional design decision (A2 — warnings for non-blocking issues).

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
