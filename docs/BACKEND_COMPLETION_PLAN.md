# THE BALANCE — Backend Completion Plan

**Date:** 2026-10-22
**Author:** GLM (implementation agent)
**Owner:** Ayman
**Status:** Functional assessment — awaiting owner review before implementation
**Code repo HEAD:** `456c923` (main, post-G03-06 merge)
**Docs bridge:** `mayakilzy/repo-info/The-Balance-Doc`

---

## 1. Completed Capabilities

### G00 — Foundation ✅ COMPLETE
- 33 migrations, 48 Prisma models, 4 DB roles (balance_app, balance_admin, balance_auth, balance_snapshot_approver)
- Auth.js v5 (credentials, JWT, tenant switching, current-role authorization)
- RLS on all private tables, audit_log append-only, column-level grants
- Evidence fabric (4 evidence types, pgvector embeddings, source independence)
- Task orchestrator (durable, resumable)
- Capability registry + invocation
- CI + Fresh Install + Recovery (both green)
- **API routes:** 12 (auth, evidence, tasks, capabilities, countries, meta, health, metrics)

### G01 — State Builder ✅ SERVICES COMPLETE, ⚠️ NO API ROUTES
- **12 services** all implemented + unit/integration tested:
  - country-pack-service, baseline-service, gap-analysis-service
  - strategy-composer-service, program-service, objective-service
  - portfolio-service, budget-service, comparison-service, roadmap-service
  - advisor-service (deterministic v1), approval-service
- **Integration tests:** T1.1–T1.13 + 5 negative tests (g01-t1-integration.integration.test.ts)
- **Honesty:** All outputs labeled `simulated: true` when StubProvider is used
- **GAP:** Zero HTTP API routes. Services are callable only from tests, not from the frontend.

### G02 — State Observatory ✅ SERVICES COMPLETE, ⚠️ NO API ROUTES
- **17 services** all implemented + unit tested:
  - observatory-query-service (aggregate snapshot)
  - indicator-registry-service, observation-service, variance-service
  - alert-service (evaluateAndRaise, markReviewed, documentDecision, verifyExecution, closeAlert)
  - early-warning-service, threshold-evaluator, temporal-trend-service
  - evidence-independence-service, aggregate-independence-service
  - institutional-view-service, sector-view-service, permissioned-view-service
  - provenance-validator, evidence-country-validator
- **Integration tests:** T2-slice (I-01 to I-14) — full alert lifecycle + corrections + RLS
- **GAP:** Zero HTTP API routes. Observatory is backend-only.

### G03 — Targeted Reform ✅ COMPLETE (with API routes)
- **16 services** + **35 HTTP routes**:
  - Reform proposals (create, submit, approve, reject, close-alert, snapshot, comparison)
  - Reform alternatives (add, select, withdraw)
  - Reform actions (start, complete, verify, updates, feedback)
  - Reform advisor (draft problem, alternatives, comparison, outcomes — Stub LLM)
  - Reform coordination (G03-06: 16 routes, multi-institution, shared snapshots, privileged approval via balance_snapshot_approver)
- **Tests:** 51 HTTP acceptance tests + concurrency + security + SQL acceptance
- **Honesty:** Advisor outputs labeled as simulated, no causal claims

### Development Advisor ✅ EXISTS (Stub)
- G01 advisor-service: deterministic v1, conditional recommendations, no auto-approval
- G03 reform-advisor-service: Stub LLM, draft generation, advisor receipts (HMAC-signed)
- Both are Stub/deterministic — ready for real LLM provider swap when available

---

## 2. Missing or Partial Capabilities

### G01 State Builder — API Surface ⚠️ CRITICAL GAP
- **What exists:** 12 services + integration tests proving end-to-end T1 journey works
- **What's missing:** HTTP routes exposing these services to the frontend
- **Required routes (~12):**
  - `GET /api/v1/strategies` (list strategy versions)
  - `POST /api/v1/strategies/compose` (compose alternatives)
  - `POST /api/v1/strategies/:id/approve` (human approval)
  - `GET /api/v1/baseline` (compute/retrieve baseline)
  - `GET /api/v1/gaps` (gap analysis)
  - `GET /api/v1/objectives` + `POST` (CRUD)
  - `GET /api/v1/programs` + `POST` (CRUD)
  - `GET /api/v1/portfolio` (dependency graph)
  - `POST /api/v1/budget/estimate` (budget estimates)
  - `GET /api/v1/comparison` (scenario comparison)
  - `GET /api/v1/roadmap` (implementation roadmap)
- **Effort:** ~12 route files, thin wrappers over existing services. Each route is ~30-50 lines (auth + Zod validation + call service + error mapping).

### G02 State Observatory — API Surface ⚠️ CRITICAL GAP
- **What exists:** 17 services + integration tests proving T2 alert lifecycle works
- **What's missing:** HTTP routes exposing observatory to the frontend
- **Required routes (~8):**
  - `GET /api/v1/observatory/snapshot` (aggregate snapshot — reuses observatory-query-service)
  - `GET /api/v1/alerts` + `GET /api/v1/alerts/:id` (list + detail — reuses alert-service)
  - `POST /api/v1/alerts/:id/review` (markReviewed)
  - `POST /api/v1/alerts/:id/decision` (documentDecision)
  - `POST /api/v1/alerts/:id/verify` (verifyExecution)
  - `POST /api/v1/alerts/:id/close` (closeAlert)
  - `GET /api/v1/indicators` (list indicator definitions)
  - `POST /api/v1/observations` (ingest observation)
- **Effort:** ~8 route files, thin wrappers.

### G04 — Strategic Continuity ⚠️ PARTIAL (models only)
- **What exists:** `Decision` + `DecisionEvent` models (proposed → reviewed → approved → implemented → reversed), `Strategy` supersession chain
- **What's missing:** Services, API routes, handover dossier, historical replay
- **Required for MVP:** Decision lifecycle service + 4 routes (create, list, approve, reverse)
- **Deferred:** Handover dossier, 7-year replay, government transition workflow — these are G05 integration scope, not needed for the product-first delivery

### Cross-Module Integration ⚠️ PARTIAL
- **What exists:** G03 reform proposals can link to alerts via `originatingAlertId` (schema supports it)
- **What's missing:** No seed data linking alerts → proposals → actions → coordinations in a single demoable chain
- **Required:** Seed update + 1-2 integration tests proving the full chain

### Real LLM Provider ⚠️ STUB ONLY
- **What exists:** StubProvider (deterministic, labeled `simulated: true`)
- **What's missing:** Real LLM integration (ZAI/OpenAI/Anthropic)
- **Decision needed:** Is real LLM required for the stable backend baseline, or can we ship with Stub and swap later? Per owner's principle ("عندئذ ننقل جهدنا بالكامل إلى التصميم"), Stub is sufficient for the stable baseline. Real LLM is a post-UI integration.

---

## 3. Proposed Implementation Order

### Delivery 1: G01 State Builder API (~12 routes)
**Why first:** State Builder is the entry point — without strategy versions, the Observatory has nothing to observe, and Reform has nothing to link to.
**Work:** 12 thin route files wrapping existing tested services.
**Acceptance:** T1 journey can be driven entirely via HTTP (compose → approve → list).

### Delivery 2: G02 Observatory API (~8 routes)
**Why second:** Observatory depends on approved StrategyVersions from G01.
**Work:** 8 thin route files wrapping existing tested services.
**Acceptance:** T2 journey can be driven entirely via HTTP (observe → alert → review → close).

### Delivery 3: G04 Continuity MVP (1 service + 4 routes)
**Why third:** Decisions link reform outcomes back to strategy versions — closes the loop.
**Work:** Decision lifecycle service (create, approve, reverse, list) + 4 routes.
**Acceptance:** A reform proposal approval can be linked to a Decision record.

### Delivery 4: Cross-module seed + integration tests
**Why fourth:** Once all APIs exist, prove the full chain works end-to-end.
**Work:** Seed update (alert → proposal → action → coordination → decision) + 3-5 integration tests.
**Acceptance:** Full government scenario demoable via HTTP.

### Delivery 5: Hard validation + stable baseline tag
**Why last:** Only after all capabilities are wired and tested.
**Work:** Run demanding integrated scenarios (concurrency, failure recovery, cross-tenant, persistence). Fix defects found. Tag stable baseline.
**Acceptance:** CI green, Recovery green, all integration tests pass, stable baseline tagged.

---

## 4. Approximate Delivery Count

**5 major functional deliveries** — each is a coherent, testable unit:
1. G01 API (12 routes)
2. G02 API (8 routes)
3. G04 Continuity MVP (1 service + 4 routes)
4. Cross-module integration (seed + tests)
5. Hard validation + stable baseline

**Total new route files:** ~24 thin wrappers
**Total new services:** 1 (decision-service)
**Total new migrations:** 0 (all models exist)
**Total new tests:** ~15-20 integration tests covering the full chain

---

## 5. Required Integrated Acceptance Scenarios

### Scenario 1: National Strategy Creation + Approval
- Admin creates objectives → computes baseline → runs gap analysis → composes 2 strategy alternatives → approves one → StrategyVersion becomes `approved` → audit logged → immutable.

### Scenario 2: Observatory Measurement + Contradictory Evidence
- Approved strategy → ingest 2 observations (one supporting, one contradicting) → variance detected → alert raised → reviewer documents decision → alert closed → both evidence sides preserved.

### Scenario 3: Alert → Reform Workflow
- Alert from Scenario 2 → analyst creates reform proposal linked to alert → drafts alternatives via advisor → admin approves → reform action created → started → progress updates → completed → verified (F6) → feedback loop.

### Scenario 4: Multi-Institution Coordination
- Tenant A (Ministry of Planning) creates coordination → invites Tenant B (Central Bank) → Tenant B accepts → shared snapshot created → approved via privileged connection → coordination plan submitted → approved → coordination `active`.

### Scenario 5: Government Transition + Continuity
- Approved strategy → Decision record created (proposed → approved → implemented) → new strategy version supersedes old → old version preserved (immutable) → Decision reversed → audit trail complete.

### Scenario 6: Failure Recovery + Data Persistence
- Mid-transaction failure → rollback → no partial writes → audit log consistent → task resumable → no data loss.

### Scenario 7: Concurrent Operations + Authorization
- Two concurrent approvals on same coordination → L-COORD lock serializes → one succeeds, one gets conflict → no deadlock → audit correct.

### Scenario 8: Cross-Tenant Isolation
- Tenant A cannot see Tenant B's strategies, observations, alerts, proposals, coordinations (unless participant) → RLS enforced at HTTP level.

---

## 6. What This Plan Does NOT Include

- **No UI design or frontend work** — deferred to Phase 4 per owner's decision.
- **No new architecture** — all routes are thin wrappers over existing services.
- **No real LLM integration** — Stub is sufficient for stable baseline; swap later.
- **No G04 full implementation** — only Decision lifecycle MVP; handover/replay deferred to G05.
- **No new security missions** — G03-06 trust boundary is closed; existing contracts preserved.
- **No excessive documentation** — this is the only planning document; implementation proceeds directly.

---

## 7. Development Policy (Adopted)

- One major functional delivery at a time.
- No endless PRE/FIX/CLOSURE mission chains.
- No UI design or frontend redesign.
- Ordinary defects fixed within development.
- Prioritize demonstrable government functionality.
- Maintain necessary security and engineering quality proportionately.

---

**Do not begin large-scale implementation until this functional assessment is reviewed.**
