# GROUP 01 — Acceptance Matrix

**Final SHA:** `4aa7de238f01a318c040c3775785788664ee7baf`
**CI:** https://github.com/mayakilzy/The-Balance/actions/runs/39053060987
**Recovery:** https://github.com/mayakilzy/The-Balance/actions/runs/39053060971

## Mission Acceptance

| Mission | Title | Status | Approved SHA |
|---------|-------|--------|-------------|
| 01-00 | G01 Bootstrap + Country Pack | APPROVED | `a6b162e` |
| 01-01 | State Baseline | APPROVED | `6d981e7` |
| 01-02 | Gap Analysis | APPROVED | `dd1fff1` |
| 01-03 | Strategy Composer | APPROVED | `0927d11` |
| 01-04 | Institutional Program Contracts | APPROVED | `84942cc` |
| 01-05 | Portfolio & Dependency Graph | APPROVED | `72999e5` |
| 01-06 | Budget & Financing Estimates | APPROVED | `7dd3653` |
| 01-07 | Implementation Roadmap & Timeline | APPROVED | `a7d113a` |
| 01-08 | Scenario Comparison Engine | APPROVED | `110ed14` |
| 01-09 | Development Advisor v1 | APPROVED | `bc61940` |
| 01-10 | Human Approval Workflow + T1 Integration | PENDING_REVIEW | `4aa7de2` |

## T1 Positive Tests (API/Service-Level)

| Step | Description | Status | Evidence |
|------|-------------|--------|----------|
| T1.1 | Country Pack loaded | PASS | Demolandia seeded (iso3="DML") |
| T1.2 | Evidence + Sources in Evidence Fabric | PASS | 4+ evidence items with verificationStatus |
| T1.3 | National Objectives defined | PASS | 3 objectives (agriculture, inflation, education) |
| T1.4 | State Baseline computed | PASS | FULL/PARTIAL/LOW observability modes |
| T1.5 | Gap Analysis run | PASS | Gaps with measurable/partial/unknown |
| T1.6 | Strategy Composer ≥2 alternatives | PASS | compositionBatchId shared, simulated: true |
| T1.7 | Portfolio & Dependency Graph | PASS | Nodes + edges, cycles=[] |
| T1.8 | Budget estimates (conditional ranges) | PASS | min/max, simulated: true |
| T1.9 | Scenario Comparison | PASS | Neutral tradeoffs, no winner |
| T1.10 | Unauthorized approval → REJECTED + audit_log | PASS | audit_log status="denied", errorCode="PERMISSION_DENIED" |
| T1.11 | Authorized approval → approved + audit + event | PASS | Atomic audit_log + events, different tables |
| T1.12 | Approved version immutable | PASS | Re-approval rejected + supersession |
| T1.13 | Handover: new user can view approved strategy | PASS | Programs + audit trail visible to new reviewer |

## T1 Negative Tests

| Test | Description | Status |
|------|-------------|--------|
| T1.N1 | AI recommendation does NOT auto-approve | PASS |
| T1.N2 | Cross-tenant isolation (RLS) | PASS |
| T1.N3 | Insufficient evidence → "unknown" | PASS |
| T1.N4 | Contradictory evidence → both sides shown | PASS |
| T1.N5 | Revoked membership → denied | PASS |

## FIX Tests (01-10-FINAL-CLOSURE)

| Test | Description | Status |
|------|-------------|--------|
| FIX-1 | Contiguous T1 chain (same version: compose→roadmap→advisor→approval) | PASS |
| FIX-1b | Atomic rollback (re-approval rejected, no partial state) | PASS |
| FIX-2 | PermissionDeniedError always re-thrown (not audit error) | PASS |
| FIX-2b | Suspended membership → denied + authorization error preserved | PASS |

## Audit Independence (§13 Correction B)

| Check | Status |
|-------|--------|
| audit_log and events are DIFFERENT tables | PASS |
| audit_log row exists for approved attempt (status="ok") | PASS |
| audit_log row exists for denied attempt (status="denied") | PASS |
| events row exists for approved attempt | PASS |
| audit_log actor matches events actor | PASS |
| Atomic: audit_log written inside approval transaction (writeAuditTx) | PASS |
| Denied audit: uses withAuthenticatedTenant (RLS context) | PASS |
| Denied error: PermissionDeniedError always preserved | PASS |

## Browser E2E

| Test | Description | Status |
|------|-------------|--------|
| Browser-1 | Analyst login + navigation + screenshots | PASS |
| Browser-2 | Admin login + navigation + screenshots | PASS |
| Browser-3 | Unauthenticated redirect to login | PASS |
| Full T1 Journey via Browser UI | NOT IMPLEMENTED | GROUP 01 has no UI pages for State Builder steps |

## Test Suite Summary

| Metric | Count |
|--------|-------|
| Total test files | 32 (31 passed + 1 skipped) |
| Total tests | 542 (532 passed + 10 skipped + 0 failed) |
| G01-specific test files | 11 (baseline, gap-analysis, strategy-composer, program-contracts, portfolio, budget, roadmap, comparison, advisor, t1-integration, browser) |
| Migrations | 20 (16 G00 + 4 G01) |
