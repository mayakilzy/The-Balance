# GROUP 02 — Known Limitations
**Mission:** 02-00 — State Observatory Bootstrap (Vertical Slice)
**Final SHA:** _pending push — local only_
**Date:** 2026-10-18

This document lists known limitations of GROUP 02 / Mission 02-00.
All limitations are honest and explicit — none are hidden gaps.

## Limitations Carried Forward from GROUP 01

All 11 known limitations from GROUP 01 still apply (see
`docs/mission-reports/G01/GROUP_01_KNOWN_LIMITATIONS.md`). GROUP 02 does
not auto-correct any of them.

## GROUP 02 — Mission 02-00 Specific Limitations

### G02-L01: Sub-Year Granularity Limited to yearly/quarterly/monthly
- **Affected component:** `ObservationPeriod.periodType`
- **Description:** `periodType` accepts only `"yearly" | "quarterly" | "monthly"`.
  Finer granularity (weekly, daily, hourly) is not supported in 02-00.
- **Why deferred:** The Blueprint mentions "frequency" per indicator but
  does not mandate sub-monthly granularity for state-level observatory
  data. Quarterly/monthly covers the typical reporting cadence for
  national indicators (inflation, unemployment, GDP, etc.).
- **Mitigation:** Indicators needing finer granularity can be added in a
  later mission by extending the `periodType` enum.
- **Status:** Partial fix for GROUP 01 Known Limitation #5.

### G02-L02: alertThresholds Limited to 2 Rules per Indicator
- **Affected component:** `IndicatorDefinition.alertThresholds` (Zod schema)
- **Description:** Each indicator supports at most 2 alert threshold rules
  (combined via `and`/`or` on the first rule's `logicalOp`).
- **Why deferred:** Keeps the deterministic evaluator minimal and
  reviewable in 02-00. Complex boolean logic (3+ rules) introduces
  combinatorial edge cases that benefit from a dedicated design pass.
- **Mitigation:** If an indicator needs more complex alerting, define
  multiple related indicators (each with up to 2 rules) and aggregate
  their alerts at the UI layer (future mission).

### G02-L03: No Browser UI for State Observatory
- **Affected component:** UI (none shipped in 02-00)
- **Description:** GROUP 02 ships API-level services only. No browser UI
  for indicator definition, observation ingestion, variance review, or
  alert lifecycle management.
- **Why deferred:** Per Known Limitation #7 from GROUP 01, browser UI is
  deferred to a dedicated UI mission. The T2-slice is fully testable at
  the service/integration level.
- **Mitigation:** All service operations are accessible via
  `src/lib/state-observatory/*` exports for future API routes and UI pages
  to consume.

### G02-L04: No Real Data Integration (Demolandia Only)
- **Affected component:** `Observation.sourceId`, real-world ingestion
- **Description:** All test data uses Demolandia (fictional country,
  `isSynthetic = true`). No real data source (World Bank, IMF, etc.) is
  integrated in 02-00.
- **Why deferred:** Real data integration requires per-source adapters,
  license verification, and update cadence management — out of scope for
  a bootstrap mission.
- **Mitigation:** The `Source` model from G00 is reused as the provenance
  anchor; real sources can be added later without schema changes. The
  `originType` field (R1) distinguishes `observed` (from a real source)
  from `derived` (computed) from `synthetic` (generated).

### G02-L05: No External Integrations (HTTP/Email/SMS)
- **Affected component:** `AlertService` lifecycle
- **Description:** When an alert is auto-raised from "detected" to
  "notified", no external channel (email, SMS, webhook) is triggered.
  Notifications stay internal to the database.
- **Why deferred:** External integrations require secrets management,
  rate limiting, and retry policies — out of scope for 02-00.
- **Mitigation:** The `Alert` lifecycle supports manual
  `markReviewed`/`documentDecision`/`verifyExecution`/`closeAlert` flows
  that can be driven by future UI/API integrations.

### G02-L06: No LLM Calls
- **Affected component:** `VarianceService`, `AlertService`
- **Description:** All computations are deterministic. No LLM is used for
  variance interpretation, alert severity assessment, or causal
  inference.
- **Why deferred:** Blueprint §1.1 forbids causal claims from correlation
  alone, and §3.2 mandates "وصف مستوى الإسناد السببي الممكن" (describe
  the level of possible causal support). In 02-00,
  `attributionLevel = "descriptive"` always — no causal inference is
  attempted, so no LLM is needed.
- **Mitigation:** Future missions may add LLM-assisted interpretation,
  but only as advisory output (never as a substitute for human review).

### G02-L07: Audit Failure Injection Not Implemented (Carried from G01 #11)
- **Affected component:** `writeAuditTx` atomicity verification
- **Description:** The atomicity of `writeAuditTx` (inside
  `withAuthenticatedTenant`) is verified structurally (the call is inside
  the transaction) and via the re-approval rejection pattern from G01.
  However, **forced failure injection of `writeAuditTx` was NOT
  implemented** — no test simulates a deliberate `audit_log` write
  failure to verify the transaction rolls back.
- **Why deferred:** Requires mocking the Prisma transaction client
  (`tx.auditLog.create` to throw), which is not set up in the current
  test infrastructure.
- **Mitigation:** The structural verification (writeAuditTx is called
  inside `withAuthenticatedTenant`, before the return) provides strong
  evidence of atomicity. A forced-failure test would be more definitive
  and should be added in a hardening mission.

### G02-L08: Counter-Evidence Country Scope Not Verified (Carried from G01 #10)
- **Affected component:** `Observation.evidenceId` cross-country scope
- **Description:** While E3 enforces that institutional `geoRefId` must
  match the tenant's country, the `evidenceId` reference is NOT verified
  for country scope. An observation could theoretically link to evidence
  from a different country.
- **Why deferred:** Evidence country scope was deferred from GROUP 01.
  This limitation is inherited, not introduced.
- **Mitigation:** Future hardening pass should add an evidence country
  check (similar to E3 for institutions).

### G02-L09: Variance Computation National-Only in 02-00
- **Affected component:** `VarianceService.computeVariance`
- **Description:** `computeVariance` queries observations with
  `geoLevel = "national"` only. Subnational variance (e.g., per
  province) is not computed in 02-00.
- **Why deferred:** Subnational variance requires subnational
  plannedValue (periodMilestones per geo), which is not yet modeled.
- **Mitigation:** The schema supports `geoLevel` and `geoRefId` on
  `Observation`, so subnational observations can be ingested today. The
  variance computation can be extended in a later mission to iterate
  over (geoLevel, geoRefId) tuples.

### G02-L10: Integration Tests Skip Locally (Run + Pass in CI)
- **Affected component:** `tests/integration/g02-t2-slice.integration.test.ts`
- **Description:** Integration tests skip locally without
  `RUN_INTEGRATION_TESTS=1`. They DO run in CI on real PostgreSQL 16 and
  PASS (verified by CI #141 on commit 6672460 — 14 integration tests with
  60+ DB-level assertions all passed).
- **Why local skip:** Local dev environment does not have PostgreSQL 16
  with pgvector installed. This is an environment limitation, not a
  deferred test gap.
- **Mitigation:** CI runs all integration tests on every push to main.
  Local developers can run them by setting `RUN_INTEGRATION_TESTS=1`
  against a local PostgreSQL 16 instance (e.g., via `docker compose up postgres`).
- **Status:** RESOLVED — integration tests are real, executable, and
  passing in CI. This entry remains to document the local-skip behavior.

### G02-L11: No Idempotency on Variance Computation
- **Affected component:** `VarianceService.computeVariance`
- **Description:** Calling `computeVariance` twice for the same
  (strategyVersionId, observationPeriodId) creates two VarianceRecord
  rows. There is no idempotency key or upsert behavior.
- **Why deferred:** VarianceRecord is conceptually append-only (each
  computation is a snapshot at a point in time). Multiple computations
  reflect evolving observations (e.g., after a correction).
- **Mitigation:** Consumers can filter by `createdAt` to get the latest
  variance record for a given (indicator, period).
