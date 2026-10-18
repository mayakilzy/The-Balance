# G03-00 — Mission Roadmap (Revised)

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Mission roadmap (DESIGN ONLY — no code)
> **Date:** 2026-10-18 (revision 2 — post owner review)
> **Author:** GLM (implementation agent)
> **Status:** REVISED per owner directive — re-awaiting final approval
> **Companion to:** `G03_00_OPEN_DECISIONS.md` (revised), `G03_00_THREAT_MODEL.md` (new)

---

## 1. Overview

This document specifies the **mission decomposition** for GROUP 03 — the sequence of executable missions that build the Targeted Reform pipeline. Each mission has:

- A clear functional goal
- A scoped, isolable boundary
- Expected files/modules
- Entry/exit contracts
- Verifiable acceptance criteria + tests
- Dependencies + constraints
- Clear completion evidence

### 1.1 Decomposition Principle (Revised per Owner Directive)

Missions are decomposed to be:
1. **Small enough** to review in a single pass by the technical reviewer (ChatGPT)
2. **Large enough** to deliver meaningful functionality (no "one table per mission")
3. **Sequential** — each mission builds on the previous (no parallel missions in G03)
4. **Schema-isolated** — only ONE mission (03-01) touches the schema; all others have schema diff = 0
5. **Vertical slice early** (NEW per owner directive) — a working end-to-end reform flow is validated EARLY, then expanded incrementally

### 1.2 Owner Directive on Vertical Slice

> "أفضّل أن يقدّم GROUP 03 في مرحلة مبكرة مساراً رأسياً صغيراً يعمل فعلياً: رصد مشكلة ← إعداد مقترح ← مراجعة بشرية ← اعتماد ← تسجيل إجراء ← التحقق من تنفيذه. ثم نتوسع في البدائل المتعددة والتنسيق المؤسسي والتحليل الاستشاري. وبهذه الطريقة نتحقق من صلاحية العقود مبكراً، بدلاً من اكتشاف مشكلات التكامل في نهاية المجموعة."

This is a fundamental shift in decomposition strategy. The original roadmap built capabilities breadth-first (each mission was a complete layer: all proposals, then all alternatives, then all approvals). The revised roadmap builds capabilities depth-first for a single-tenant flow, then expands to multi-alternative, multi-institution, and LLM-advisory.

### 1.3 Mission Count (Revised)

**9 missions** (was 7 in rev 1):
- 03-00: Architecture design (this mission)
- 03-01: Schema bootstrap (single migration, 11 tables, 13 permissions, triggers, RLS)
- 03-02: Vertical Slice — minimum viable single-tenant reform (proposal + simple approval + action + verification + feedback)
- 03-03: Reform Alternatives (multiple options per proposal + selection)
- 03-04: Reform Comparison + Advisor (deterministic comparison + LLM advisory)
- 03-05: Enhanced Approval Workflow (evidence snapshots + denied audit + supersession)
- 03-06: Multi-Institution Coordination (4 coordination tables + 2-level approval + shared snapshots)
- 03-07: Coordination Vertical Slice (end-to-end coordination flow)
- 03-08: Polish + Closure (hardening, sentinel regression tests, G03 closure documents)

### 1.4 Number of Tables/Services/Tests — Estimates, Not Goals

Per owner directive:

> "لكننا لا نحتاج إلى تجميد 7 جداول و11 خدمة و30 واجهة API ونحو 190 اختباراً لمجرد أنها أصبحت مكتوبة في وثائق التصميم. هذه أرقام تقديرية، ويجب أن تتبع الوظائف المطلوبة، لا العكس."

The numbers below are **estimates derived from the design**. They will be adjusted as the design evolves in implementation. They are NOT commitments.

| Resource | Estimate (revised) | Note |
|----------|-------------------|------|
| Tables | 11 (7 core + 4 coordination) | D1 + D6 |
| Services | 12 (11 core + 1 coordination) | May consolidate or split during implementation |
| API routes | ~35 | Estimated from service count |
| New tests | ~210 (was ~190) | Adjusted for +2 missions + coordination tests |
| Missions | 9 (was 7) | +1 coordination, +1 vertical slice |

---

## 2. Mission Sequence (Revised)

```
03-00 (DESIGN)
  │
  ▼
03-01 (SCHEMA — 11 tables, 13 permissions, RLS, triggers, threats T1-T10 mitigations)
  │
  ▼
03-02 (VERTICAL SLICE — minimum viable single-tenant reform flow)
  │  alert → proposal (single alternative) → approval → action → verification → feedback
  │
  ▼
03-03 (REFORM ALTERNATIVES — multiple options + selection)
  │
  ▼
03-04 (COMPARISON + ADVISOR — deterministic comparison + LLM advisory)
  │
  ▼
03-05 (ENHANCED APPROVAL — evidence snapshots + denied audit + supersession)
  │
  ▼
03-06 (COORDINATION — multi-institution coordination services)
  │
  ▼
03-07 (COORDINATION VERTICAL SLICE — end-to-end coordination flow)
  │
  ▼
03-08 (POLISH + CLOSURE — hardening + sentinel tests + G03 closure docs)
```

---

## 3. Mission 03-00 — Architecture & Scope Foundation (THIS MISSION — REVISED)

### 3.1 Goal

Establish the architectural foundation for GROUP 03: domain model, workflow, contracts, security policy, threat model, mission roadmap, and open decisions. No code, no migrations — design documents only.

### 3.2 Scope (Revised)

- Read all G00/G01/G02 authoritative documents
- **Study the Institution-Tenant relationship** (per owner directive — was missed in rev 1)
- Analyze existing service contracts, schemas, ADRs
- Design G03 architecture (11 tables, 13 permissions, 12 services)
- Produce 8 design documents (was 7 — added THREAT_MODEL.md)
- Identify open decisions requiring owner approval
- **Per-limitation G02 dependency assessment** (D8 revised)

### 3.3 Deliverables

| File | Type | Purpose |
|------|------|---------|
| `G03_00_ARCHITECTURE_PROPOSAL.md` | Design (revised) | Architecture overview |
| `G03_00_DOMAIN_MODEL.md` | Design (revised) | Table schemas + RLS + triggers |
| `G03_00_WORKFLOW_AND_APPROVALS.md` | Design (revised) | Lifecycle + state machines |
| `G03_00_INTEGRATION_CONTRACTS.md` | Design (revised) | Service signatures + Zod schemas |
| `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` | Design (revised) | Security + evidence + LLM + threats |
| `G03_00_MISSION_ROADMAP.md` | Design (revised — this file) | Mission decomposition |
| `G03_00_OPEN_DECISIONS.md` | Design (revised) | Decisions for owner |
| `G03_00_THREAT_MODEL.md` | Design (NEW) | Threat model for coordination |

### 3.4 Acceptance Criteria

- [ ] All 8 documents produced (was 7)
- [ ] Architecture honors all 14 inherited invariants
- [ ] 10 new G3 invariants proposed (unchanged)
- [ ] Threat model identifies and mitigates 10 coordination threats (NEW)
- [ ] Domain model specifies 11 tables (was 7) — 7 core + 4 coordination
- [ ] Workflow specifies 4 distinct lifecycle states (was 3) — separates verification from measurement
- [ ] Contracts specify all service signatures + Zod schemas (expanded for coordination + D3 hypothesis schema)
- [ ] Security policy covers RLS (coordination-aware), RBAC (13 permissions), audit, evidence, LLM, F6, attribution, publication, **threat model**
- [ ] Mission roadmap decomposes G03 into 9 missions (was 7) — includes vertical slice
- [ ] Open decisions documented with rationale + trade-offs (D1-D9, with D6 elevated + D9 new)
- [ ] No code changes (schema diff = 0, src/ diff = 0)
- [ ] No migrations created
- [ ] No permissions changed
- [ ] CI passes (no regressions — docs-only commit)
- [ ] Recovery passes (no schema changes)

### 3.5 Completion Evidence (to be filled after commit)

- Final SHA: (after commit)
- CI run: (after push)
- Recovery run: (after push)
- Test count: 817 passed | 10 skipped | 0 failed (unchanged — docs only)

---

## 4. Mission 03-01 — Schema Bootstrap (Revised)

### 4.1 Goal

Create the database foundation for GROUP 03: 1 migration with **11 new tables** (was 7), **13 new permissions** (was 9), RLS policies including **coordination-aware RLS via SECURITY DEFINER helper**, cross-tenant triggers, F6 trigger, attribution trigger, supersession trigger, **coordination-specific triggers**. Plus seed extension for Demolandia.

### 4.2 Scope

- Create `prisma/migrations/20261018000022_g03_reform_bootstrap/migration.sql`
- Update `prisma/schema.prisma` with 11 new models
- Update `src/lib/permissions.ts` with 13 new permissions
- Extend `prisma/seed-ontology.ts` with sample reform data (including 1 coordination example)
- **Create SECURITY DEFINER helper function** `is_coordination_participant(text)`
- NO service code (src/lib/reform/ not created yet)
- NO API routes (src/app/api/v1/reform/ not created yet)

### 4.3 Tables Created (11)

| Table | Source decision |
|-------|-----------------|
| `reform_proposals` | D1 (core) |
| `reform_alternatives` | D1 (core) |
| `reform_approvals` | D1 (core) |
| `reform_actions` | D1 (core) |
| `reform_action_updates` | D1 (core — append-only) |
| `reform_verifications` | D1 (core — F6) |
| `reform_feedback_loops` | D1 (core — attribution trigger) |
| `reform_coordinations` | D6 (NEW) |
| `reform_coordination_participants` | D6 (NEW) |
| `reform_coordination_invitations` | D6 (NEW) |
| `reform_coordination_shared_snapshots` | D6 (NEW) |
| `reform_coordination_shared_snapshot_revocations` | D6 (NEW — for revocation without UPDATE) |

Wait — that's 12 tables, not 11. Let me recount:

Core: 7 (proposals, alternatives, approvals, actions, action_updates, verifications, feedback_loops)
Coordination: 5 (coordinations, participants, invitations, shared_snapshots, snapshot_revocations)

**Total: 12 tables**. (Updated from 11 — the revocations table was added during threat model refinement.)

### 4.4 Permissions Created (13)

| Permission | Source decision |
|-----------|-----------------|
| `reform:proposal:read`, `:write`, `:approve` | D1 (core) |
| `reform:alternative:read`, `:write` | D1 (core) |
| `reform:action:read`, `:write`, `:verify` | D1 (core) |
| `reform:verification:read` | D1 (core) |
| `reform:coordination:read` | D6 (NEW) |
| `reform:coordination:manage` | D6 (NEW) |
| `reform:coordination:approve` | D6 (NEW) |
| `reform:coordination:share` | D6 (NEW) |

### 4.5 RLS Policies (Coordination-Aware)

- Standard tenant-isolation RLS on 7 core tables + `coordination_participants` + `coordination_invitations` + `coordination_shared_snapshots` + `coordination_shared_snapshot_revocations`
- **Coordination-aware RLS** on `reform_coordinations` via `is_coordination_participant()` SECURITY DEFINER helper (visible to lead OR active participant)
- Append-only enforcement on `reform_action_updates`, `reform_approvals`, `reform_feedback_loops`, `reform_coordination_shared_snapshots`, `reform_coordination_shared_snapshot_revocations`

### 4.6 Triggers

- Cross-tenant triggers on all child tables (core + coordination)
- F6 trigger on `reform_verifications`
- Attribution trigger on `reform_feedback_loops`
- Supersession trigger on `reform_proposals`
- **Coordination activation trigger**: when all linked proposals are `approved`, set `reform_coordinations.status = 'active'`

### 4.7 Acceptance Criteria

- [ ] Migration applies cleanly on fresh PostgreSQL 16 + pgvector
- [ ] All 12 tables created with correct columns + types
- [ ] RLS ENABLE + FORCE on all 12 tables
- [ ] `is_coordination_participant()` SECURITY DEFINER function created and EXECUTE granted to `balance_app`
- [ ] Coordination-aware RLS policy on `reform_coordinations` works (lead + participants can SELECT; only lead can modify)
- [ ] All 13 new permissions registered in `permissions.ts`
- [ ] Seed creates sample data per tenant + 1 coordination example (idempotent)
- [ ] ~30 new tests pass (was ~25 — added coordination RLS tests)
- [ ] Existing 817 tests still pass (no regressions)
- [ ] CI + Recovery pass

### 4.8 Dependencies

- 03-00 approved (architecture frozen)
- All required open decisions resolved (D1, D3, D4, D5, D6, D9)

---

## 5. Mission 03-02 — Vertical Slice: Minimum Viable Single-Tenant Reform (NEW — Owner Directive)

### 5.1 Goal

Per owner directive: build a **working end-to-end reform flow** early to validate the contracts before expanding capabilities. This mission delivers:

```
Alert (from G02)
  → ReformProposal (single alternative, no LLM)
  → Human Review + Approval (basic, no evidence snapshot yet)
  → ReformAction (planned → in_progress → completed)
  → ReformVerification (F6 pattern)
  → ReformFeedbackLoop (descriptive, creates new Observation)
  → Close originating Alert (via G02 contracts)
```

### 5.2 Why This Mission Exists

The owner correctly identified that building all breadth first (alternatives, comparison, advisor, enhanced approval) before testing integration risks discovering contract problems at the end of G03. This vertical slice validates:

1. The `ReformProposal` → `ReformAction` → `ReformVerification` → `ReformFeedbackLoop` chain works end-to-end
2. The integration with G02 (`ingestObservation`, `computeVariance`, `verifyExecution`, `closeAlert`) works as designed
3. The F6 trigger fires correctly
4. The attribution trigger fires correctly
5. The audit trail is complete
6. The RLS isolation is correct

### 5.3 Scope (Intentionally Minimal)

- Create `src/lib/reform/contracts.ts` (minimal Zod schemas — single alternative, no hypothesizedCauses complexity yet)
- Create `src/lib/reform/reform-proposal-service.ts` (basic CRUD: create, get, list, submit, approve, reject — no evidence snapshot, no supersession)
- Create `src/lib/reform/reform-action-service.ts` (basic CRUD: create, start, complete — no block/cancel)
- Create `src/lib/reform/reform-action-update-service.ts` (basic append-only updates)
- Create `src/lib/reform/reform-verification-service.ts` (basic verify with F6)
- Create `src/lib/reform/reform-feedback-service.ts` (basic feedback loop + close alert)
- Create `src/lib/reform/index.ts` (barrel)
- Create API routes for the above (minimal set — ~15 routes)
- **NO alternatives** (single proposal, single action)
- **NO comparison or advisor** (deferred to 03-04)
- **NO coordination** (deferred to 03-06)
- **NO evidence snapshots at approval** (deferred to 03-05)

### 5.4 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/contracts.ts` | New (minimal) | Zod schemas for vertical slice |
| `src/lib/reform/reform-proposal-service.ts` | New (minimal) | Basic proposal CRUD + lifecycle |
| `src/lib/reform/reform-action-service.ts` | New (minimal) | Basic action CRUD + lifecycle |
| `src/lib/reform/reform-action-update-service.ts` | New (minimal) | Append-only updates |
| `src/lib/reform/reform-verification-service.ts` | New (minimal) | F6 verification |
| `src/lib/reform/reform-feedback-service.ts` | New (minimal) | Feedback loop + alert closure |
| `src/lib/reform/index.ts` | New | Barrel |
| `src/app/api/v1/reform/proposals/route.ts` + 4 sub-routes | New | POST/GET/submit/approve/reject |
| `src/app/api/v1/reform/actions/route.ts` + 4 sub-routes | New | POST/GET/start/complete/verify |
| `src/app/api/v1/reform/actions/[id]/updates/route.ts` | New | POST + GET updates |
| `src/app/api/v1/reform/actions/[id]/feedback/route.ts` | New | POST feedback |
| `src/app/api/v1/reform/proposals/[id]/close-alert/route.ts` | New | POST close alert |
| `tests/unit/reform/*.test.ts` | New | Unit tests for each service |
| `tests/integration/g03-02-vertical-slice.integration.test.ts` | New | End-to-end integration test |
| `tests/integration/g03-02-f6-sentinel.integration.test.ts` | New | F6 trigger sentinel |
| `tests/integration/g03-02-attribution-sentinel.integration.test.ts` | New | Attribution trigger sentinel |
| `tests/integration/g03-02-append-only-sentinel.integration.test.ts` | New | Append-only RLS sentinel |
| `docs/mission-reports/G03/03-02_REPORT.md` | New | Mission report |

### 5.5 Entry Contracts

- 03-01 approved (schema exists)

### 5.6 Exit Contracts

- A single analyst can create a proposal from an alert, submit for review, get it approved by a reviewer, create an action, add progress updates, complete the action, verify it (F6), create a feedback loop (descriptive), and close the originating alert — **all via API**.
- F6 trigger fires correctly (verified by sentinel test)
- Attribution trigger fires correctly (verified by sentinel test)
- Append-only enforcement works (verified by sentinel test)
- Audit trail is complete for every state transition
- ~40 new tests pass (20 unit + 20 integration including 3 sentinel tests)
- Existing tests still pass
- CI + Recovery pass

### 5.7 Acceptance Criteria

- [ ] End-to-end flow works via API (integration test verifies the full chain)
- [ ] F6 trigger blocks `verified` status without `verifiedAction` + `evidenceSource`
- [ ] Attribution trigger blocks non-`"descriptive"` `attributionLevel`
- [ ] Append-only RLS blocks UPDATE/DELETE on `reform_action_updates`
- [ ] Cross-tenant isolation: Tenant B cannot see Tenant A's proposal
- [ ] Permission denied for unauthorized roles (analyst cannot approve, observer cannot read)
- [ ] Audit trail complete (every transition has `audit_log` entry)
- [ ] Feedback loop creates new Observation via `ingestObservation` (append-only — does NOT mutate existing)
- [ ] Close alert uses G02 `verifyExecution` + `closeAlert` contracts (not direct table writes)
- [ ] ~40 new tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 5.8 Dependencies

- 03-01 approved

### 5.9 Critical Note

This mission intentionally ships a **minimal** reform flow. Many features are deferred to later missions:
- Multiple alternatives (03-03)
- LLM-assisted drafting (03-04)
- Evidence snapshots at approval (03-05)
- Coordination (03-06, 03-07)

The goal is to **validate the contracts early**, not to ship a complete product. The owner's directive is explicitly: "نتحقق من صلاحية العقود مبكراً، بدلاً من اكتشاف مشكلات التكامل في نهاية المجموعة."

---

## 6. Mission 03-03 — Reform Alternatives (Revised)

### 6.1 Goal

Add support for **multiple alternatives per proposal** + selection. This expands the vertical slice (03-02) which supported only a single implicit alternative.

### 6.2 Scope

- Add `ReformAlternative` service (CRUD + selection + withdrawal)
- Extend `ReformProposal` to support linking to alternatives (was implicit in 03-02)
- Update approval flow to require alternative selection before approval (was: approve the proposal directly in 03-02)
- Add comparison placeholder (deterministic comparison deferred to 03-04)
- NO LLM advisor yet
- NO coordination yet

### 6.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/reform-alternative-service.ts` | New | Alternative CRUD + selection |
| `src/lib/reform/contracts.ts` | Modified (additive) | Add alternative Zod schemas |
| `src/lib/reform/reform-proposal-service.ts` | Modified (additive) | Approval now requires alternativeId |
| `src/app/api/v1/reform/proposals/[id]/alternatives/route.ts` | New | POST + GET alternatives |
| `src/app/api/v1/reform/alternatives/[id]/select/route.ts` | New | POST select |
| `src/app/api/v1/reform/alternatives/[id]/withdraw/route.ts` | New | POST withdraw |
| `tests/unit/reform/reform-alternative-service.test.ts` | New | Unit tests |
| `tests/integration/g03-03-alternative.integration.test.ts` | New | Integration tests |
| `tests/integration/g03-03-one-selected-sentinel.integration.test.ts` | New | Partial unique index sentinel |
| `docs/mission-reports/G03/03-03_REPORT.md` | New | Mission report |

### 6.4 Acceptance Criteria

- [ ] Analyst can add 2-5 alternatives to a proposal
- [ ] Reviewer can select ONE alternative (partial unique index enforces)
- [ ] Approval requires a selected alternative
- [ ] Withdrawing a selected alternative requires reviewer permission
- [ ] ~25 new tests pass (15 unit + 10 integration)
- [ ] Existing tests still pass (including 03-02 vertical slice tests)
- [ ] CI + Recovery pass

### 6.5 Dependencies

- 03-02 approved

---

## 7. Mission 03-04 — Reform Comparison + Advisor (Unchanged from Rev 1)

### 7.1 Goal

Implement the deterministic comparison service and the LLM-assisted advisor service. Both are advisory — neither makes decisions.

### 7.2 Scope

- Create `src/lib/reform/reform-comparison-service.ts` (deterministic, no LLM)
- Create `src/lib/reform/reform-advisor-service.ts` (LLM-assisted, advisory only)
- Create API routes for comparison + 4 advisor endpoints
- NO schema changes

### 7.3 Expected Files

(Same as rev 1 — see original document)

### 7.4 Acceptance Criteria

- [ ] Comparison service returns descriptive matrix (no ranking, no recommendation)
- [ ] Advisor service carries `simulated: true` when StubProvider active
- [ ] Advisor output rejects causal language (Zod + service check — defense in depth, not guarantee)
- [ ] Advisor never calls `approve`, `select`, `verify`, or any state transition
- [ ] ~35 new tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 7.5 Dependencies

- 03-03 approved

---

## 8. Mission 03-05 — Enhanced Approval Workflow (Revised)

### 8.1 Goal

Upgrade the basic approval (from 03-02) to the **full atomic approval workflow** with:
- Evidence snapshot at approval time (immutable post-approval)
- Denied-attempt audit (best-effort, outside failed transaction)
- Supersession (auto-supersede old approved proposal when new one approved for same alert)
- Strict tenant/country/strategy verification for Program/Project links (D4 revised)

### 8.2 Scope

- Replace basic `approveReformProposal` with `approveReformProposalWithAuditSafe` (atomic + evidence snapshot + denied audit)
- Add supersession logic
- Add D4 verification (tenant + country + strategy context)
- Add `ReformApproval` service (read approval with snapshot)
- Add sentinel regression tests for atomicity + F6 + evidence completeness
- NO schema changes

### 8.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/reform-approval-service.ts` | New | 3 approval functions (atomic + safe wrapper + read) |
| `src/lib/reform/reform-proposal-service.ts` | Modified | Approval now uses safe wrapper; add supersession |
| `src/lib/reform/reform-action-service.ts` | Modified | Add D4 verification for programId/projectId links |
| `src/app/api/v1/reform/proposals/[id]/approve/route.ts` | Modified | Use safe wrapper |
| `src/app/api/v1/reform/proposals/[id]/snapshot/route.ts` | New | GET proposal snapshot (includes approval) |
| `tests/unit/reform/reform-approval-service.test.ts` | New | Unit tests |
| `tests/integration/g03-05-approval.integration.test.ts` | New | Integration tests (atomicity, evidence snapshot) |
| `tests/integration/g03-05-denied-audit.integration.test.ts` | New | Denied-attempt audit tests |
| `tests/integration/g03-05-supersession.integration.test.ts` | New | Supersession tests |
| `tests/integration/g03-05-f6-sentinel.integration.test.ts` | New | Sentinel regression tests |
| `tests/integration/g03-05-evidence-completeness.integration.test.ts` | New | No partial snapshots |
| `docs/mission-reports/G03/03-05_REPORT.md` | New | Mission report |

### 8.4 Acceptance Criteria

- [ ] Approval is atomic (proposal status + approval record + evidence snapshot + event + audit in one transaction)
- [ ] Evidence snapshot captured at approval time (immutable post-approval)
- [ ] Evidence completeness check (no partial snapshots)
- [ ] Denied attempts audited with `status: "denied"`
- [ ] Original `PermissionDeniedError` re-thrown (not masked by audit failure)
- [ ] Supersession works (old proposal → superseded when new one approved for same alert)
- [ ] D4 verification: tenant + country + strategy context checked for Program/Project links
- [ ] `allowCrossStrategyProgramLink` flag allows legitimate cross-strategy links with justification
- [ ] ~30 new tests pass (15 unit + 15 integration including sentinel)
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 8.5 Dependencies

- 03-03 + 03-04 approved

---

## 9. Mission 03-06 — Multi-Institution Coordination (NEW — D6 Implementation)

### 9.1 Goal

Implement the coordination services: create coordination, manage participants, invitations, shared snapshots, two-level approval.

### 9.2 Scope

- Create `src/lib/reform/reform-coordination-service.ts` (CRUD + invitations + shared snapshots + plan approval)
- Extend `ReformProposal` to support optional `coordinationId`
- Add coordination-specific API routes
- Add sentinel regression tests for all 10 threats (T1-T10)
- NO schema changes (tables created in 03-01)

### 9.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/reform-coordination-service.ts` | New | Coordination CRUD + invitations + shared snapshots + plan approval |
| `src/lib/reform/contracts.ts` | Modified (additive) | Add coordination Zod schemas |
| `src/lib/reform/reform-proposal-service.ts` | Modified (additive) | Support optional coordinationId |
| `src/app/api/v1/reform/coordinations/route.ts` | New | POST + GET (list) |
| `src/app/api/v1/reform/coordinations/[id]/route.ts` | New | GET single |
| `src/app/api/v1/reform/coordinations/[id]/participants/route.ts` | New | POST + GET participants |
| `src/app/api/v1/reform/coordinations/[id]/invitations/route.ts` | New | POST invitation |
| `src/app/api/v1/reform/coordinations/[id]/invitations/[invId]/accept/route.ts` | New | POST accept |
| `src/app/api/v1/reform/coordinations/[id]/invitations/[invId]/decline/route.ts` | New | POST decline |
| `src/app/api/v1/reform/coordinations/[id]/approve-plan/route.ts` | New | POST approve plan (lead only) |
| `src/app/api/v1/reform/coordinations/[id]/snapshots/route.ts` | New | POST + GET shared snapshots |
| `src/app/api/v1/reform/coordinations/[id]/snapshots/[snapId]/approve/route.ts` | New | POST approve snapshot (reviewer) |
| `src/app/api/v1/reform/coordinations/[id]/snapshots/[snapId]/revoke/route.ts` | New | POST revoke snapshot |
| `src/app/api/v1/reform/coordinations/[id]/shared-view/route.ts` | New | GET shared view (participants only) |
| `tests/unit/reform/reform-coordination-service.test.ts` | New | Unit tests |
| `tests/integration/g03-06-coordination.integration.test.ts` | New | Integration tests |
| `tests/integration/g03-06-t1-cross-tenant-leak.integration.test.ts` | New | T1 sentinel |
| `tests/integration/g03-06-t2-membership-forgery.integration.test.ts` | New | T2 sentinel |
| `tests/integration/g03-06-t3-no-majority-override.integration.test.ts` | New | T3 sentinel |
| `tests/integration/g03-06-t4-snapshot-revocation.integration.test.ts` | New | T4 sentinel |
| `tests/integration/g03-06-t5-lead-privilege.integration.test.ts` | New | T5 sentinel |
| `tests/integration/g03-06-t6-audit-atomicity.integration.test.ts` | New | T6 sentinel |
| `tests/integration/g03-06-t7-shared-view-readonly.integration.test.ts` | New | T7 sentinel |
| `tests/integration/g03-06-t8-invitation-replay.integration.test.ts` | New | T8 sentinel |
| `tests/integration/g03-06-t9-metadata-visibility.integration.test.ts` | New | T9 sentinel |
| `tests/integration/g03-06-t10-supersession.integration.test.ts` | New | T10 sentinel |
| `docs/mission-reports/G03/03-06_REPORT.md` | New | Mission report |

### 9.4 Acceptance Criteria

- [ ] Lead can create coordination, add participants (via invitations), approve plan
- [ ] Participants can accept/decline invitations
- [ ] Participants can create ReformProposals linked to coordination
- [ ] Per-participant proposal approval (no majority override — T3 sentinel)
- [ ] Coordination `active` requires ALL linked proposals approved
- [ ] Shared snapshots require reviewer approval before visible (T4 sentinel)
- [ ] Shared snapshots can be revoked (T4 sentinel)
- [ ] Coordination lead cannot see participant private data (T1, T5 sentinel)
- [ ] Coordination lead cannot approve participant proposals (T5 sentinel)
- [ ] Coordination-aware RLS works (T1 sentinel)
- [ ] Membership forgery blocked (T2 sentinel)
- [ ] Invitation replay blocked (T8 sentinel)
- [ ] All coordination actions atomically audited (T6 sentinel)
- [ ] Shared view is read-only (T7 sentinel)
- [ ] ~50 new tests pass (20 unit + 30 integration including 10 sentinel)
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 9.5 Dependencies

- 03-05 approved

---

## 10. Mission 03-07 — Coordination Vertical Slice (NEW — Owner Directive)

### 10.1 Goal

Per owner directive: build an **end-to-end coordination flow** to validate the coordination contracts before G03 closure.

```
Alert (shared signal)
  → Lead creates Coordination + invites 2 participants
  → Participants accept invitations
  → Each participant creates own ReformProposal linked to coordination
  → Each participant's reviewer approves their proposal
  → Coordination auto-activates when all proposals approved
  → Each participant creates own ReformAction + updates
  → Each participant's reviewer verifies their action (F6)
  → Each participant creates own feedback loop
  → Lead closes coordination
  → Shared alert closed via G02 contracts
```

### 10.2 Scope

- No new services — this mission is purely **integration testing** of the coordination flow
- Add comprehensive end-to-end integration tests
- Add browser E2E test (optional — deferred per G02-L03 pattern)
- Update RUNBOOK.md with coordination operational guidance
- NO schema changes

### 10.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `tests/integration/g03-07-coordination-e2e.integration.test.ts` | New | End-to-end coordination flow |
| `tests/integration/g03-07-multi-tenant-coordination.integration.test.ts` | New | Cross-tenant coordination (Tenant A lead + Tenant B participant) |
| `tests/integration/g03-07-intra-tenant-coordination.integration.test.ts` | New | Intra-tenant coordination (single tenant, multiple institutions) |
| `tests/browser/reform-coordination.spec.ts` | New (optional) | Browser E2E (deferred if Playwright issues) |
| `docs/RUNBOOK.md` | Modified (additive) | Add coordination operational section |
| `docs/mission-reports/G03/03-07_REPORT.md` | New | Mission report |

### 10.4 Acceptance Criteria

- [ ] End-to-end coordination flow works (integration test verifies full chain)
- [ ] Cross-tenant coordination: Tenant A (lead) + Tenant B (participant) + Tenant C (observer, not invited)
- [ ] Intra-tenant coordination: single tenant with multiple institutionId participants
- [ ] All 10 threats remain mitigated (sentinel tests pass after integration)
- [ ] ~20 new integration tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 10.5 Dependencies

- 03-06 approved

---

## 11. Mission 03-08 — Polish + Closure (NEW)

### 11.1 Goal

Final hardening, additional sentinel regression tests, performance optimization, documentation, and G03 closure.

### 11.2 Scope

- Add any missing sentinel regression tests identified during 03-02 through 03-07
- Performance optimization (indexes, query patterns)
- Documentation review and consistency check
- G03 closure documents:
  - `GROUP_03_FINAL_REVIEW.md`
  - `GROUP_03_ACCEPTANCE_MATRIX.md`
  - `GROUP_03_KNOWN_LIMITATIONS.md`
  - `GROUP_04_READINESS_HANDOFF.md`
- Update `docs/handoffs/THE_BALANCE_GROUP_04_MASTER_HANDOFF_<date>.md`
- NO schema changes

### 11.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `tests/integration/g03-08-comprehensive-sentinel.integration.test.ts` | New | All sentinel tests in one comprehensive suite |
| `tests/integration/g03-08-performance.integration.test.ts` | New | Performance baseline tests |
| `docs/mission-reports/G03/GROUP_03_FINAL_REVIEW.md` | New | G03 final review |
| `docs/mission-reports/G03/GROUP_03_ACCEPTANCE_MATRIX.md` | New | G03 acceptance matrix |
| `docs/mission-reports/G03/GROUP_03_KNOWN_LIMITATIONS.md` | New | G03 known limitations |
| `docs/mission-reports/G03/GROUP_04_READINESS_HANDOFF.md` | New | G04 readiness handoff |
| `docs/handoffs/THE_BALANCE_GROUP_04_MASTER_HANDOFF_<date>.md` | New | G04 master handoff |
| `docs/mission-reports/G03/03-08_REPORT.md` | New | Mission report |

### 11.4 Acceptance Criteria

- [ ] All sentinel tests pass in one comprehensive suite
- [ ] Performance baseline established (no regressions from G02)
- [ ] All G03 closure documents produced
- [ ] G04 readiness handoff documents the next group's scope (expected, not frozen)
- [ ] ~15 new tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass
- [ ] Owner + ChatGPT issue FINAL PASS for G03

### 11.5 Dependencies

- 03-07 approved

---

## 12. Post-G03 Closure

### 12.1 Expected G03 Final State

```text
GROUP 03 = APPROVED — FINAL PASS — CLOSED

Final implementation SHA: <to be filled at G03 closure>
Final closure SHA: <to be filled at G03 closure>
CI #??: SUCCESS
Recovery #??: SUCCESS
Total Tests: ~1027 passed | 10 skipped | 0 failed (estimated — was 817 at end of G02)

GROUP 04 = READY FOR SCOPE REVIEW
GROUP 04 IMPLEMENTATION = NOT AUTHORIZED
```

### 12.2 Expected G03 Known Limitations

| Limitation | Status | Description |
|-----------|--------|-------------|
| G03-L01: Cross-Tenant Coordination (Cross-Country) | DOCUMENTED | Scenarios A (intra-tenant) + B (cross-tenant same-country) supported; Scenario C (cross-country) deferred |
| G03-L02: No Browser UI for Reform | DEFERRED | G03 ships API-first (mirrors G02-L03); UI deferred to future mission |
| G03-L03: Publication Workflow Not Implemented | DOCUMENTED | Inherits G02-L25; no publication approval in G03 |
| G03-L04: Government Projection Limited to Public Evidence | DOCUMENTED | Inherits G02-L26; no granular clearance model |
| G03-L05: LLM Advisor Uses StubProvider | DOCUMENTED | All advisor output `simulated: true`; real LLM integration deferred |
| G03-L06: No Real Country Data | DOCUMENTED | Inherits G02-L04; Demolandia only |
| G03-L07: G02-L22/L23/L24 Still Deferred | DEFERRED | Per D8 dependency assessment |
| G03-L08: Advisor Causal Language Rejection Is Pattern-Based | DOCUMENTED | Regex-based; not NLP classifier (defense in depth, not guarantee) |
| G03-L09: No Sub-Year Granularity for Reform Timeline | DOCUMENTED | Inherits G02-L01; yearly/quarterly/monthly only |
| G03-L10: No External Integrations (Email/SMS/Webhooks) | DOCUMENTED | Inherits G02-L05; no notifications for reform state changes |
| G03-L11: Cross-Country Coordination | DEFERRED | Scenario C (cross-tenant cross-country) requires cross-country consent beyond G03's scope |

---

## 13. Estimated Timeline (Revised)

> **Note**: Estimates, not commitments. Actual duration depends on review cycles, iteration on feedback, and CI/Recovery timing.

| Mission | Estimated review cycles | Estimated elapsed |
|---------|------------------------|-------------------|
| 03-00 | 2-3 (design review + revision) | 2 sessions (we're here now) |
| 03-01 | 1-2 (schema review) | 1 session |
| 03-02 | 2 (vertical slice — critical validation) | 1-2 sessions |
| 03-03 | 1-2 (alternatives — incremental) | 1 session |
| 03-04 | 1-2 (advisory services) | 1 session |
| 03-05 | 2-3 (atomic approval — critical) | 1-2 sessions |
| 03-06 | 2-3 (coordination — most complex) | 2 sessions |
| 03-07 | 2 (vertical slice for coordination) | 1 session |
| 03-08 | 1 (closure) | 1 session |
| Closure | 1 (final review) | 1 session |

**Total estimated**: 11-15 sessions for the full GROUP 03 (was 8-14 in rev 1).

---

## 14. Risk Register (Updated)

| Risk | Affects mission | Likelihood | Impact | Mitigation |
|------|----------------|------------|--------|------------|
| R-G3-01: LLM advisor produces causal claims | 03-04 | Medium | High | Zod + service check + reviewer judgment (defense in depth, not guarantee) |
| R-G3-02: Cross-tenant reform references | 03-01, 03-02 | Low | High | RLS + cross-tenant triggers + service check (triple enforcement) |
| R-G3-03: ReformApproval not atomic with audit | 03-05 | Low | Critical | `writeAuditTx` inside transaction; sentinel test |
| R-G3-04: ReformActionUpdate mutated/deleted | 03-01, 03-02 | Medium | High | RLS blocks UPDATE/DELETE; sentinel test |
| R-G3-05: F6 enforcement bypassed | 03-01, 03-02 | Low | High | DB trigger + Zod + service check (triple enforcement); sentinel test |
| R-G3-06: Coordination shared view leaks private data | 03-06 | Medium | Critical | Explicit shared snapshots (no live links); reviewer approval; sentinel test (T1) |
| R-G3-07: Majority override of dissenting participant | 03-06 | Low | Critical | Two-level approval (coordination plan + per-participant); T3 sentinel test |
| R-G3-08: Coordination lead privilege escalation | 03-06 | Low | High | Policy immutable post-creation; RLS blocks cross-tenant proposal access; T5 sentinel test |
| R-G3-09: StubProvider produces unrealistic drafts | 03-04 | Medium | Low | `simulated: true` flag; analyst reviews/edits |
| R-G3-10: Schema migration fails on existing DB | 03-01 | Low | High | Migration is additive; tested in CI fresh-install + recovery drill |
| R-G3-11: Vertical slice reveals contract problems | 03-02 | Medium | Medium | **This is the point of 03-02** — early discovery is better than late discovery |
| R-G3-12: Coordination complexity delays G03 | 03-06, 03-07 | Medium | Medium | Phased implementation; coordination is additive to core reform |

---

## 15. Mission Dependencies Graph (Revised)

```
03-00 (DESIGN — REVISED)
  │
  ▼
03-01 (SCHEMA — 12 tables, 13 permissions, coordination-aware RLS)
  │
  ▼
03-02 (VERTICAL SLICE — minimum viable single-tenant reform) ← NEW
  │
  ├──→ 03-03 (ALTERNATIVES — multiple options + selection)
  │       │
  │       └──→ 03-04 (COMPARISON + ADVISOR) ←─┐
  │                 │                          │
  │                 └──→ 03-05 (ENHANCED APPROVAL) ←─┘
  │                         │
  │                         ▼
  │                    03-06 (COORDINATION SERVICES)
  │                         │
  │                         ▼
  │                    03-07 (COORDINATION VERTICAL SLICE) ← NEW
  │                         │
  │                         ▼
  └──→ 03-08 (POLISH + CLOSURE) ← NEW
            │
            ▼
       G03 CLOSURE (FINAL_REVIEW + ACCEPTANCE_MATRIX + KNOWN_LIMITATIONS + G04_READINESS_HANDOFF)
```

**Critical path**: 03-00 → 03-01 → 03-02 → 03-03 → 03-04 → 03-05 → 03-06 → 03-07 → 03-08 (9 sequential missions)

---

## 16. Conclusion

GROUP 03 is decomposed into **9 missions** (was 7 in rev 1), totaling an estimated **~210 new tests** and **~7500 LOC**. The revision adds:
- **Vertical slice early** (03-02) — per owner directive, validates contracts before expanding
- **Coordination as core** (03-06, 03-07) — per owner directive, multi-institution reform is a first-class capability
- **Polish + closure mission** (03-08) — explicit closure phase

Each mission has:
- A clear functional goal
- A scoped boundary (no scope creep)
- Explicit entry/exit contracts
- Verifiable acceptance criteria
- Hard dependencies on previous missions
- A Definition of Done aligned with the project's 9-step process

The decomposition honors the owner's directives:
- Multi-institution coordination is core (D6 elevated)
- Vertical slice validates contracts early
- Numbers are estimates, not goals
- G02 limitations are assessed per-limitation, not blanket-deferred
- Epistemic separation between problem/cause and verification/measurement

**Ready for owner + reviewer final approval.**

---

*End of G03-00 Mission Roadmap (Revised). Companion documents: ARCHITECTURE_PROPOSAL.md (revised), DOMAIN_MODEL.md (revised), WORKFLOW_AND_APPROVALS.md (revised), INTEGRATION_CONTRACTS.md (revised), SECURITY_AND_EVIDENCE_POLICY.md (revised), OPEN_DECISIONS.md (revised), THREAT_MODEL.md (new).*
