# GROUP 01 — Acceptance Matrix

| Mission | Acceptance Criteria | Evidence | Status |
|---------|-------------------|----------|--------|
| 01-00 | G01 bootstrap + 8 new tables + RLS + seed | Migration 0017, seed-ontology.ts | PASS |
| 01-01 | State Baseline with FULL/PARTIAL/LOW observability | baseline-service.ts, g01-baseline tests | PASS |
| 01-02 | Gap Analysis (measurable/partial/unknown) | gap-analysis-service.ts, g01-gap-analysis tests | PASS |
| 01-03 | Strategy Composer (≥2 alternatives, compositionBatchId) | strategy-composer-service.ts, g01-strategy-composer tests | PASS |
| 01-04 | Program Contracts (institutional design, KPIs, mandate gaps) | program-service.ts, g01-program-contracts tests (17 tests) | PASS |
| 01-05 | Portfolio & Dependency Graph (cycle detection, critical path) | portfolio-service.ts, g01-portfolio tests (19 tests) | PASS |
| 01-06 | Budget Estimates (conditional ranges, Decimal, ISO 4217) | budget-service.ts, g01-budget tests (37 tests) | PASS |
| 01-07 | Implementation Roadmap (topological layering, temporal validation) | roadmap-service.ts, g01-roadmap tests (27 tests) | PASS |
| 01-08 | Scenario Comparison (neutral tradeoffs, evidence strength) | comparison-service.ts, g01-comparison tests (27 tests) | PASS |
| 01-09 | Development Advisor (conditional recommendations, abstention) | advisor-service.ts, g01-advisor tests (34 tests) | PASS |
| 01-10 | Human Approval + T1 Integration (atomic audit, 3-layer evidence) | approval-service.ts, g01-t1-integration tests | PENDING_REVIEW |

## T1 Acceptance

| Step | Description | Status |
|------|-------------|--------|
| T1.1 | Country Pack loaded | PASS (seeded) |
| T1.2 | Evidence + Sources in Evidence Fabric | PASS (seeded) |
| T1.3 | National Objectives defined | PASS (seeded) |
| T1.4 | State Baseline computed | PASS |
| T1.5 | Gap Analysis run | PASS |
| T1.6 | Strategy Composer ≥2 alternatives | PASS |
| T1.7 | Portfolio & Dependency Graph | PASS |
| T1.8 | Budget estimates (conditional ranges) | PASS |
| T1.9 | Scenario Comparison | PASS |
| T1.10 | Unauthorized approval → REJECTED + audit_log | PASS |
| T1.11 | Authorized approval → approved + audit + event | PASS |
| T1.12 | Approved version immutable | PASS |
| T1.13 | Handover: new user can view approved strategy | PASS |

## T1 Negative Tests

| Test | Description | Status |
|------|-------------|--------|
| T1.N1 | AI recommendation does NOT auto-approve | PASS |
| T1.N2 | Cross-tenant isolation (RLS) | PASS |
| T1.N3 | Insufficient evidence → "unknown" | PASS |
| T1.N4 | Contradictory evidence → both sides shown | PASS |
| T1.N5 | Revoked membership → denied | PASS |

## Audit Independence (§13 Correction B)

| Check | Status |
|-------|--------|
| audit_log and events are DIFFERENT tables | PASS |
| audit_log row exists for approved attempt (status="ok") | PASS |
| audit_log row exists for denied attempt (status="denied") | PASS |
| events row exists for approved attempt | PASS |
| audit_log actor matches events actor | PASS |
| Atomic: audit_log written inside approval transaction | PASS |
