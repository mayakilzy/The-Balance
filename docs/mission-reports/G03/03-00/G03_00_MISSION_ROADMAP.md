# G03-00 — Mission Roadmap

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Mission roadmap (DESIGN ONLY — no code)
> **Date:** 2026-10-18
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner + reviewer approval
> **Companion to:** `G03_00_ARCHITECTURE_PROPOSAL.md` §16

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

### 1.1 Decomposition Principle

Missions are decomposed to be:
1. **Small enough** to review in a single pass by the technical reviewer (ChatGPT)
2. **Large enough** to deliver meaningful functionality (no "one table per mission")
3. **Sequential** — each mission builds on the previous (no parallel missions in G03)
4. **Schema-isolated** — only ONE mission (03-01) touches the schema; all others have schema diff = 0

### 1.2 Mission Count Rationale

7 missions (1 design + 1 schema + 5 service) is the right granularity:
- **03-00** (this mission): Architecture design — sets the foundation
- **03-01**: Schema bootstrap — single migration, 7 tables, 9 permissions, triggers, RLS
- **03-02**: Proposal + Alternative services — the core CRUD + lifecycle
- **03-03**: Comparison + Advisor services — deterministic comparison + LLM advisory
- **03-04**: Approval workflow — atomic approval + evidence snapshot + denied audit
- **03-05**: Action + Update tracking — implementation progress + append-only updates
- **03-06**: Verification + Feedback loop — F6 verification + descriptive feedback to observatory

This mirrors G02's pattern (6 missions: 1 bootstrap + 5 service). G03 adds one more service mission because the reform loop has more phases than the observatory loop.

### 1.3 Estimated Effort

| Mission | Estimated tests added | Estimated code lines | Estimated duration |
|---------|-----------------------|---------------------|-------------------|
| 03-00 | 0 (docs only) | ~3000 (7 design docs) | Design |
| 03-01 | ~25 (15 unit + 10 integration) | ~400 (migration) + ~100 (permissions) + ~200 (seed) | Schema |
| 03-02 | ~45 (25 unit + 20 integration) | ~800 (2 services + contracts + routes) | Service |
| 03-03 | ~35 (20 unit + 15 integration) | ~600 (2 services + routes) | Service |
| 03-04 | ~25 (15 unit + 10 integration) | ~500 (1 service + routes + sentinel tests) | Service |
| 03-05 | ~35 (20 unit + 15 integration) | ~700 (2 services + routes) | Service |
| 03-06 | ~25 (15 unit + 10 integration) | ~600 (2 services + routes + sentinel tests) | Service |
| **TOTAL** | **~190 new tests** | **~6800 LOC** | 7 missions |

**Target at end of G03**: ~1007 tests passed | 10 skipped | 0 failed (up from 817 at end of G02).

---

## 2. Mission Sequence

```
03-00 (DESIGN)  ──→  03-01 (SCHEMA)  ──→  03-02 (PROPOSAL+ALTERNATIVE)
                                                  │
                                                  ▼
                                          03-03 (COMPARISON+ADVISOR)
                                                  │
                                                  ▼
                                          03-04 (APPROVAL)
                                                  │
                                                  ▼
                                          03-05 (ACTION+UPDATES)
                                                  │
                                                  ▼
                                          03-06 (VERIFICATION+FEEDBACK)
```

Each arrow is a hard dependency:
- 03-01 requires 03-00 to be approved (architecture must be frozen first)
- 03-02 requires 03-01 to be approved (tables must exist before services can be written)
- 03-03 requires 03-02 (alternatives must exist before they can be compared)
- 03-04 requires 03-02 + 03-03 (approval references alternatives; may use advisor-drafted rationale)
- 03-05 requires 03-04 (actions are created from approved proposals)
- 03-06 requires 03-05 (verification + feedback apply to completed actions)

---

## 3. Mission 03-00 — Architecture & Scope Foundation (THIS MISSION)

### 3.1 Goal

Establish the architectural foundation for GROUP 03: domain model, workflow, contracts, security policy, mission roadmap, and open decisions. No code, no migrations — design documents only.

### 3.2 Scope

- Read all G00/G01/G02 authoritative documents
- Analyze existing service contracts, schemas, ADRs
- Design G03 architecture (7 tables, 9 permissions, 11 services)
- Produce 7 design documents in `docs/mission-reports/G03/03-00/`
- Identify open decisions requiring owner approval

### 3.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `docs/mission-reports/G03/03-00/G03_00_ARCHITECTURE_PROPOSAL.md` | Design | Architecture overview |
| `docs/mission-reports/G03/03-00/G03_00_DOMAIN_MODEL.md` | Design | Table schemas + RLS + triggers |
| `docs/mission-reports/G03/03-00/G03_00_WORKFLOW_AND_APPROVALS.md` | Design | Lifecycle + state machines |
| `docs/mission-reports/G03/03-00/G03_00_INTEGRATION_CONTRACTS.md` | Design | Service signatures + Zod schemas |
| `docs/mission-reports/G03/03-00/G03_00_SECURITY_AND_EVIDENCE_POLICY.md` | Design | Security + evidence + LLM |
| `docs/mission-reports/G03/03-00/G03_00_MISSION_ROADMAP.md` | Design | Mission decomposition |
| `docs/mission-reports/G03/03-00/G03_00_OPEN_DECISIONS.md` | Design | Decisions for owner |

### 3.4 Acceptance Criteria

- [ ] All 7 documents produced
- [ ] Architecture honors all 14 inherited invariants
- [ ] 10 new G03 invariants proposed
- [ ] Domain model specifies 7 tables with fields, indexes, RLS, triggers
- [ ] Workflow specifies all state transitions
- [ ] Contracts specify all service signatures + Zod schemas
- [ ] Security policy covers RLS, RBAC, audit, evidence, LLM, F6, attribution, publication
- [ ] Mission roadmap decomposes G03 into 7 missions (1 design + 1 schema + 5 service)
- [ ] Open decisions documented with rationale + trade-offs
- [ ] No code changes (schema diff = 0, src/ diff = 0)
- [ ] No migrations created
- [ ] No permissions changed
- [ ] CI passes (no regressions — docs-only commit)
- [ ] Recovery passes (no schema changes)

### 3.5 Definition of Done

1. All 7 documents written + committed
2. `bun run lint` passes
3. `bunx tsc --noEmit` passes (no TypeScript changes)
4. CI workflow passes (Lint + Typecheck + Test + Integration — same as 817 tests)
5. Recovery workflow passes (Fresh Install + Backup/Restore drill)
6. Owner reviews + ChatGPT reviews + issues FINAL PASS / PENDING / FAIL
7. Mission report published (this set of documents IS the mission report)
8. **Owner approves the architecture before 03-01 begins**

### 3.6 Dependencies

- None (this is the first G03 mission)
- Builds on approved G00 + G01 + G02 state (HEAD = `bc052b6`)

### 3.7 Completion Evidence

- Final SHA: (to be filled after commit)
- CI run: (to be filled after push)
- Recovery run: (to be filled after push)
- Test count: 817 passed | 10 skipped | 0 failed (unchanged — docs only)

---

## 4. Mission 03-01 — Schema Bootstrap

### 4.1 Goal

Create the database foundation for GROUP 03: 1 migration with 7 new tables, 9 new permissions, RLS policies, cross-tenant triggers, F6 trigger, attribution trigger, supersession trigger. Plus seed extension for Demolandia.

### 4.2 Scope

- Create `prisma/migrations/20261018000022_g03_reform_bootstrap/migration.sql`
- Update `prisma/schema.prisma` with 7 new models
- Update `src/lib/permissions.ts` with 9 new permissions
- Extend `prisma/seed-ontology.ts` with sample reform data (additive, idempotent)
- NO service code (src/lib/reform/ not created yet)
- NO API routes (src/app/api/v1/reform/ not created yet)

### 4.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `prisma/schema.prisma` | Modified (additive) | Add 7 new models |
| `prisma/migrations/20261018000022_g03_reform_bootstrap/migration.sql` | New | CREATE TABLE + RLS + triggers |
| `prisma/migrations/20261018000022_g03_reform_bootstrap/migration_lock.toml` | New | Migration lock |
| `src/lib/permissions.ts` | Modified (additive) | Add 9 new permissions to all 4 roles |
| `prisma/seed-ontology.ts` | Modified (additive) | Add sample reform proposals/alternatives/actions |
| `tests/unit/reform/contracts.test.ts` | New | Zod schema unit tests |
| `tests/integration/g03-01-schema.integration.test.ts` | New | Migration + RLS verification |
| `tests/integration/g03-01-rls.integration.test.ts` | New | Cross-tenant isolation tests |
| `tests/integration/g03-01-cross-tenant-trigger.integration.test.ts` | New | Trigger enforcement tests |
| `tests/integration/g03-01-append-only.integration.test.ts` | New | Append-only enforcement tests |
| `tests/integration/g03-01-f6-trigger.integration.test.ts` | New | F6 trigger tests |
| `tests/integration/g03-01-attribution-trigger.integration.test.ts` | New | Attribution trigger tests |
| `tests/integration/g03-01-permissions.integration.test.ts` | New | Permission matrix tests |
| `docs/mission-reports/G03/03-01_REPORT.md` | New | Mission report |

### 4.4 Entry Contracts

- 03-00 approved (architecture frozen)
- HEAD on `main` branch
- Working tree clean

### 4.5 Exit Contracts

- Migration applies cleanly on fresh PostgreSQL 16 + pgvector
- All 7 tables have RLS ENABLE + FORCE
- All 9 new permissions registered in `permissions.ts`
- Seed creates 2-3 sample proposals per Demolandia tenant (idempotent)
- `bun run lint` passes
- `bunx tsc --noEmit` passes
- All existing 817 tests still pass (no regressions)
- ~25 new tests pass (15 unit + 10 integration)
- CI workflow passes (Lint + Typecheck + Test + Integration)
- Recovery workflow passes (Fresh Install + Backup/Restore drill — verifies G03 tables survive backup/restore)

### 4.6 Acceptance Criteria

- [ ] Migration `20261018000022_g03_reform_bootstrap` applies cleanly
- [ ] All 7 tables created with correct columns + types
- [ ] RLS ENABLE + FORCE on all 7 tables
- [ ] `balance_app` policy: tenant-scoped USING + WITH CHECK
- [ ] `balance_admin` policy: USING (true) WITH CHECK (true)
- [ ] `GRANT SELECT, INSERT, UPDATE, DELETE` on 4 tables (proposals, alternatives, actions, verifications)
- [ ] `GRANT SELECT, INSERT` only on 3 append-only tables (approvals, action_updates, feedback_loops)
- [ ] `REVOKE UPDATE, DELETE` on 3 append-only tables from `balance_app`
- [ ] Partial unique index on `reform_alternatives(tenantId, proposalId) WHERE status = 'selected'`
- [ ] Cross-tenant triggers on all 6 child tables (alternatives, approvals, actions, action_updates, verifications, feedback_loops)
- [ ] F6 trigger on `reform_verifications`
- [ ] Attribution trigger on `reform_feedback_loops`
- [ ] Supersession trigger on `reform_proposals`
- [ ] 9 new permissions in `permissions.ts` (correct roles per matrix)
- [ ] Seed creates sample data per tenant (idempotent re-run)
- [ ] 15 unit tests pass (Zod schema validation)
- [ ] 10 integration tests pass (RLS, triggers, permissions, append-only, F6, attribution)
- [ ] Existing 817 tests still pass (no regressions)
- [ ] CI #?? passes (next CI run number)
- [ ] Recovery #?? passes (next Recovery run number)

### 4.7 Dependencies

- 03-00 approved (architecture frozen)
- All open decisions resolved by owner (especially D1, D4, D6, D8)

### 4.8 Risks

| Risk | Mitigation |
|------|-----------|
| Migration fails on existing DB | Migration is additive — no breaking changes; tested in CI fresh-install + recovery drill |
| RLS policy misconfiguration | Sentinel integration test verifies tenant B cannot see tenant A's rows |
| Trigger syntax error | Migration tested in CI on real PostgreSQL 16 |
| Permission assignment wrong role | Integration test verifies per-role permission matrix |
| Seed non-idempotent | Seed uses upserts keyed on `(tenantId, title)` — idempotent re-run tested |

### 4.9 Definition of Done

1. Migration + schema + permissions + seed committed
2. Unit tests pass locally (`AUTH_SECRET=... bun run test`)
3. Typecheck passes (`bunx tsc --noEmit`)
4. Lint passes (`bun run lint`)
5. Pushed to `main`
6. CI workflow passes
7. Recovery workflow passes
8. Owner + ChatGPT review → FINAL PASS
9. Mission report published (`docs/mission-reports/G03/03-01_REPORT.md`)

---

## 5. Mission 03-02 — Reform Proposal + Alternative Services

### 5.1 Goal

Implement the core CRUD + lifecycle services for ReformProposal and ReformAlternative. This is the foundation that all subsequent missions build on.

### 5.2 Scope

- Create `src/lib/reform/contracts.ts` (Zod schemas + types + error re-exports)
- Create `src/lib/reform/reform-proposal-service.ts` (7 functions)
- Create `src/lib/reform/reform-alternative-service.ts` (4 functions)
- Create `src/lib/reform/index.ts` (barrel)
- Create API routes under `src/app/api/v1/reform/proposals/` and `alternatives/`
- NO schema changes (schema diff = 0)
- NO approval, action, verification, or feedback services (those are later missions)

### 5.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/contracts.ts` | New | Zod schemas + types + error re-exports |
| `src/lib/reform/reform-proposal-service.ts` | New | 7 proposal functions |
| `src/lib/reform/reform-alternative-service.ts` | New | 4 alternative functions |
| `src/lib/reform/index.ts` | New | Barrel exports |
| `src/app/api/v1/reform/proposals/route.ts` | New | POST + GET (list) |
| `src/app/api/v1/reform/proposals/[id]/route.ts` | New | GET (single) |
| `src/app/api/v1/reform/proposals/[id]/submit/route.ts` | New | POST (submit for review) |
| `src/app/api/v1/reform/proposals/[id]/reject/route.ts` | New | POST (reject) |
| `src/app/api/v1/reform/proposals/[id]/return/route.ts` | New | POST (return for revision) |
| `src/app/api/v1/reform/proposals/[id]/archive/route.ts` | New | POST (archive) |
| `src/app/api/v1/reform/proposals/[id]/alternatives/route.ts` | New | POST + GET |
| `src/app/api/v1/reform/alternatives/[id]/select/route.ts` | New | POST (select) |
| `src/app/api/v1/reform/alternatives/[id]/withdraw/route.ts` | New | POST (withdraw) |
| `tests/unit/reform/reform-proposal-service.test.ts` | New | Unit tests |
| `tests/unit/reform/reform-alternative-service.test.ts` | New | Unit tests |
| `tests/integration/g03-02-proposal.integration.test.ts` | New | Integration tests |
| `tests/integration/g03-02-alternative.integration.test.ts` | New | Integration tests |
| `tests/integration/g03-02-rbac-negative.integration.test.ts` | New | RBAC negative tests |
| `docs/mission-reports/G03/03-02_REPORT.md` | New | Mission report |

### 5.4 Service Functions (03-02 Scope)

**Reform Proposal Service**:
- `createReformProposal(session, input)` → `{ proposalId }`
- `getReformProposal(session, proposalId)` → `ReformProposal | null`
- `listReformProposals(session, filters)` → `{ proposals[], nextCursor }`
- `submitForReview(session, input)` → `{ proposalId, status }`
- `rejectReformProposal(session, input)` → `{ proposalId, status }`
- `returnForRevision(session, input)` → `{ proposalId, status }`
- `archiveReformProposal(session, proposalId)` → `{ proposalId, archivedAt }`

**Reform Alternative Service**:
- `addReformAlternative(session, input)` → `{ alternativeId }`
- `listReformAlternatives(session, proposalId)` → `ReformAlternative[]`
- `selectAlternative(session, input)` → `{ alternativeId, status }`
- `withdrawAlternative(session, input)` → `{ alternativeId, status }`

### 5.5 Entry Contracts

- 03-01 approved (schema exists)
- 9 permissions registered
- HEAD on `main` branch
- Working tree clean

### 5.6 Exit Contracts

- All 11 service functions implemented
- All 11 API routes implemented
- Zod schemas validate all inputs
- `withAuthenticatedTenant` wraps every service
- `requirePermissionWithCurrentRole` checks every privileged operation
- `writeAuditTx` writes atomic audit for every state transition
- Cross-tenant references validated in service layer
- 25 unit tests pass (Zod schemas + service logic with mocked Prisma)
- 20 integration tests pass (real PostgreSQL 16, real RLS, real audit)
- Existing 842 tests still pass (no regressions)
- CI + Recovery pass

### 5.7 Acceptance Criteria

- [ ] All 11 service functions implemented per INTEGRATION_CONTRACTS.md §4
- [ ] All 11 API routes implemented per INTEGRATION_CONTRACTS.md §5.1
- [ ] Zod schemas reject invalid inputs (unit test coverage)
- [ ] Cross-tenant references blocked (integration test)
- [ ] Permission denied for unauthorized roles (integration test)
- [ ] Atomic audit log on every state transition (integration test)
- [ ] Lifecycle transitions validated (integration test — e.g., cannot approve from `draft` state)
- [ ] Partial unique index on selected alternatives enforced (integration test — concurrent selection)
- [ ] Pagination works on list endpoints (integration test)
- [ ] 25 unit tests pass
- [ ] 20 integration tests pass
- [ ] Existing tests still pass (no regressions)
- [ ] CI + Recovery pass

### 5.8 Dependencies

- 03-01 approved

### 5.9 Definition of Done

1. All service + route files committed
2. Unit + integration tests pass locally
3. Typecheck + Lint pass
4. Pushed to `main`
5. CI + Recovery pass
6. Owner + ChatGPT review → FINAL PASS
7. Mission report published

---

## 6. Mission 03-03 — Reform Comparison + Advisor Services

### 6.1 Goal

Implement the deterministic comparison service and the LLM-assisted advisor service. Both are advisory — neither makes decisions.

### 6.2 Scope

- Create `src/lib/reform/reform-comparison-service.ts` (deterministic, no LLM)
- Create `src/lib/reform/reform-advisor-service.ts` (LLM-assisted, advisory only)
- Create API routes for comparison + 4 advisor endpoints
- NO schema changes

### 6.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/reform-comparison-service.ts` | New | `compareReformAlternatives()` |
| `src/lib/reform/reform-advisor-service.ts` | New | 4 advisor functions |
| `src/app/api/v1/reform/proposals/[id]/comparison/route.ts` | New | GET comparison |
| `src/app/api/v1/reform/advisor/draft-problem-statement/route.ts` | New | POST advisor |
| `src/app/api/v1/reform/advisor/draft-alternatives/route.ts` | New | POST advisor |
| `src/app/api/v1/reform/advisor/draft-comparison/route.ts` | New | POST advisor |
| `src/app/api/v1/reform/advisor/draft-anticipated-outcomes/route.ts` | New | POST advisor |
| `tests/unit/reform/reform-comparison-service.test.ts` | New | Unit tests |
| `tests/unit/reform/reform-advisor-service.test.ts` | New | Unit tests (mock LLM provider) |
| `tests/integration/g03-03-comparison.integration.test.ts` | New | Integration tests |
| `tests/integration/g03-03-advisor.integration.test.ts` | New | Integration tests |
| `docs/mission-reports/G03/03-03_REPORT.md` | New | Mission report |

### 6.4 Service Functions (03-03 Scope)

**Reform Comparison Service**:
- `compareReformAlternatives(session, proposalId)` → `AlternativeComparison`
  - Returns descriptive comparison matrix (cost, risk, feasibility, assumption count, outcome count)
  - **No ranking, no recommendation** — the human selects

**Reform Advisor Service** (all advisory only):
- `draftProblemStatement(session, input)` → `AdvisorDraftResult`
- `draftReformAlternatives(session, input)` → `AdvisorDraftResult[]`
- `draftComparisonSummary(session, proposalId)` → `AdvisorDraftResult`
- `draftAnticipatedOutcomes(session, input)` → `AdvisorDraftResult`

### 6.5 Entry Contracts

- 03-02 approved (proposals + alternatives exist)

### 6.6 Exit Contracts

- 5 service functions implemented
- 5 API routes implemented
- Comparison service is deterministic (no LLM, no random)
- Advisor service uses `getLLMProvider()` (StubProvider returns `simulated: true`)
- Causal language rejected in advisor output (Zod + service check)
- 20 unit tests pass
- 15 integration tests pass
- Existing tests still pass
- CI + Recovery pass

### 6.7 Acceptance Criteria

- [ ] Comparison service returns descriptive matrix (no ranking, no recommendation)
- [ ] Advisor service carries `simulated: true` when StubProvider active
- [ ] Advisor output rejects causal language (Zod + service check)
- [ ] Advisor output is always a draft (never authoritative)
- [ ] Advisor never calls `approve`, `select`, `verify`, or any state transition
- [ ] 20 unit tests pass
- [ ] 15 integration tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 6.8 Dependencies

- 03-02 approved

### 6.9 Definition of Done

1. Service + route files committed
2. Unit + integration tests pass
3. Typecheck + Lint pass
4. Pushed to `main`
5. CI + Recovery pass
6. Owner + ChatGPT review → FINAL PASS
7. Mission report published

---

## 7. Mission 03-04 — Reform Approval Workflow

### 7.1 Goal

Implement the atomic approval workflow with evidence snapshot, denied-attempt audit, and supersession. This is the most security-critical mission in G03.

### 7.2 Scope

- Create `src/lib/reform/reform-approval-service.ts`
- Implement `approveReformProposal()` (atomic, with evidence snapshot)
- Implement `approveReformProposalWithAuditSafe()` (wrapper with denied-attempt audit)
- Implement `getReformApproval()` (read approval with snapshot)
- Create API route for approval
- Add sentinel regression tests for atomicity + F6 + evidence completeness
- NO schema changes

### 7.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/reform-approval-service.ts` | New | 3 approval functions |
| `src/app/api/v1/reform/proposals/[id]/approve/route.ts` | New | POST approval |
| `src/app/api/v1/reform/proposals/[id]/snapshot/route.ts` | New | GET proposal snapshot (includes approval) |
| `tests/unit/reform/reform-approval-service.test.ts` | New | Unit tests |
| `tests/integration/g03-04-approval.integration.test.ts` | New | Integration tests (atomicity, evidence snapshot) |
| `tests/integration/g03-04-denied-audit.integration.test.ts` | New | Denied-attempt audit tests |
| `tests/integration/g03-04-supersession.integration.test.ts` | New | Supersession tests |
| `tests/integration/g03-04-f6-sentinel.integration.test.ts` | New | Sentinel regression tests |
| `docs/mission-reports/G03/03-04_REPORT.md` | New | Mission report |

### 7.4 Service Functions (03-04 Scope)

- `approveReformProposal(session, proposalId, alternativeId, input)` → `{ approvalId, proposalStatus }`
- `approveReformProposalWithAuditSafe(session, proposalId, alternativeId, input)` → same + denied-attempt audit
- `getReformApproval(session, proposalId)` → `ReformApproval | null`

### 7.5 Entry Contracts

- 03-02 + 03-03 approved

### 7.6 Exit Contracts

- Approval is atomic (proposal status + approval record + evidence snapshot + event + audit in one transaction)
- Denied attempts audited (best-effort, outside failed transaction)
- Evidence snapshot captured at approval time (immutable post-approval)
- Evidence completeness check (no partial snapshots)
- Supersession works (old approved proposal → superseded when new one approved for same alert)
- 15 unit tests pass
- 10 integration tests pass (including sentinel regression tests)
- Existing tests still pass
- CI + Recovery pass

### 7.7 Acceptance Criteria

- [ ] Approval is atomic (integration test verifies all-or-nothing)
- [ ] Evidence snapshot captured (integration test verifies snapshot content)
- [ ] Evidence completeness check (integration test — missing evidence ID → rejection)
- [ ] Denied attempts audited with `status: "denied"` (integration test)
- [ ] Original `PermissionDeniedError` re-thrown (not masked by audit failure)
- [ ] Supersession works (integration test — old proposal → superseded)
- [ ] Only ONE approval per proposal (unique constraint)
- [ ] Only ONE selected alternative per proposal (partial unique index)
- [ ] F6 trigger not applicable here (F6 is for verification, not approval) — but sentinel test verifies F6 trigger still works
- [ ] 15 unit tests pass
- [ ] 10 integration tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 7.8 Dependencies

- 03-02 + 03-03 approved

### 7.9 Definition of Done

1. Service + route files committed
2. Unit + integration + sentinel tests pass
3. Typecheck + Lint pass
4. Pushed to `main`
5. CI + Recovery pass
6. Owner + ChatGPT review → FINAL PASS
7. Mission report published

---

## 8. Mission 03-05 — Reform Action + Update Tracking

### 8.1 Goal

Implement the implementation tracking: ReformAction lifecycle + append-only ReformActionUpdate. This is where reforms become actionable work.

### 8.2 Scope

- Create `src/lib/reform/reform-action-service.ts` (7 functions)
- Create `src/lib/reform/reform-action-update-service.ts` (2 functions)
- Create API routes for actions + updates
- NO schema changes

### 8.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/reform-action-service.ts` | New | 7 action functions |
| `src/lib/reform/reform-action-update-service.ts` | New | 2 update functions |
| `src/app/api/v1/reform/actions/route.ts` | New | POST + GET |
| `src/app/api/v1/reform/actions/[id]/route.ts` | New | GET |
| `src/app/api/v1/reform/actions/[id]/start/route.ts` | New | POST |
| `src/app/api/v1/reform/actions/[id]/block/route.ts` | New | POST |
| `src/app/api/v1/reform/actions/[id]/unblock/route.ts` | New | POST |
| `src/app/api/v1/reform/actions/[id]/complete/route.ts` | New | POST |
| `src/app/api/v1/reform/actions/[id]/cancel/route.ts` | New | POST |
| `src/app/api/v1/reform/actions/[id]/updates/route.ts` | New | POST + GET |
| `tests/unit/reform/reform-action-service.test.ts` | New | Unit tests |
| `tests/unit/reform/reform-action-update-service.test.ts` | New | Unit tests |
| `tests/integration/g03-05-action.integration.test.ts` | New | Integration tests |
| `tests/integration/g03-05-action-update.integration.test.ts` | New | Integration tests (append-only) |
| `tests/integration/g03-05-append-only-sentinel.integration.test.ts` | New | Sentinel regression tests |
| `docs/mission-reports/G03/03-05_REPORT.md` | New | Mission report |

### 8.4 Service Functions (03-05 Scope)

**Reform Action Service**:
- `createReformAction(session, input)` → `{ actionId }`
- `getReformAction(session, actionId)` → `ReformAction | null`
- `listReformActions(session, filters)` → `{ actions[], nextCursor }`
- `startReformAction(session, input)` → `{ actionId, status }`
- `blockReformAction(session, input)` → `{ actionId, status }`
- `completeReformAction(session, input)` → `{ actionId, status }`
- `cancelReformAction(session, input)` → `{ actionId, status }`

**Reform Action Update Service**:
- `addReformActionUpdate(session, input)` → `{ updateId }`
- `listReformActionUpdates(session, actionId, options?)` → `{ updates[], nextCursor }`

### 8.5 Entry Contracts

- 03-04 approved (actions are created from approved proposals)

### 8.6 Exit Contracts

- 9 service functions implemented
- 9 API routes implemented
- Action lifecycle transitions validated
- Action updates are append-only (RLS blocks UPDATE/DELETE — sentinel test)
- `progressPercentage` denormalized correctly (synced from latest progress update)
- 20 unit tests pass
- 15 integration tests pass (including sentinel regression)
- Existing tests still pass
- CI + Recovery pass

### 8.7 Acceptance Criteria

- [ ] All 9 service functions implemented
- [ ] All 9 API routes implemented
- [ ] Action lifecycle transitions validated (planned → in_progress → completed)
- [ ] Blocked state works (in_progress → blocked → in_progress)
- [ ] Cancelled state is terminal (cannot transition out)
- [ ] Completed state is terminal for lifecycle (verification is separate)
- [ ] Action updates are append-only (sentinel test — UPDATE/DELETE blocked)
- [ ] `progressPercentage` synced from latest progress update
- [ ] 20 unit tests pass
- [ ] 15 integration tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 8.8 Dependencies

- 03-04 approved

### 8.9 Definition of Done

1. Service + route files committed
2. Unit + integration + sentinel tests pass
3. Typecheck + Lint pass
4. Pushed to `main`
5. CI + Recovery pass
6. Owner + ChatGPT review → FINAL PASS
7. Mission report published

---

## 9. Mission 03-06 — Reform Verification + Feedback Loop

### 9.1 Goal

Implement the F6-pattern verification and the descriptive feedback loop to the observatory. This closes the reform cycle.

### 9.2 Scope

- Create `src/lib/reform/reform-verification-service.ts` (3 functions)
- Create `src/lib/reform/reform-feedback-service.ts` (3 functions)
- Create `src/lib/reform/reform-query-service.ts` (2 functions — snapshot + dashboard)
- Create API routes for verification + feedback + dashboard
- NO schema changes

### 9.3 Expected Files

| File | Type | Purpose |
|------|------|---------|
| `src/lib/reform/reform-verification-service.ts` | New | 3 verification functions |
| `src/lib/reform/reform-feedback-service.ts` | New | 3 feedback functions |
| `src/lib/reform/reform-query-service.ts` | New | 2 query functions |
| `src/app/api/v1/reform/actions/[id]/verify/route.ts` | New | POST verification |
| `src/app/api/v1/reform/actions/[id]/verification/route.ts` | New | GET verification |
| `src/app/api/v1/reform/actions/[id]/feedback/route.ts` | New | POST + GET feedback |
| `src/app/api/v1/reform/proposals/[id]/close-alert/route.ts` | New | POST close originating alert |
| `src/app/api/v1/reform/dashboard/route.ts` | New | GET dashboard summary |
| `tests/unit/reform/reform-verification-service.test.ts` | New | Unit tests |
| `tests/unit/reform/reform-feedback-service.test.ts` | New | Unit tests |
| `tests/unit/reform/reform-query-service.test.ts` | New | Unit tests |
| `tests/integration/g03-06-verification.integration.test.ts` | New | Integration tests (F6) |
| `tests/integration/g03-06-feedback.integration.test.ts` | New | Integration tests (feedback loop) |
| `tests/integration/g03-06-attribution-sentinel.integration.test.ts` | New | Sentinel regression tests |
| `tests/integration/g03-06-dashboard.integration.test.ts` | New | Integration tests |
| `docs/mission-reports/G03/03-06_REPORT.md` | New | Mission report |
| `docs/mission-reports/G03/GROUP_03_FINAL_REVIEW.md` | New | G03 final review (after 03-06 approved) |
| `docs/mission-reports/G03/GROUP_03_ACCEPTANCE_MATRIX.md` | New | G03 acceptance matrix |
| `docs/mission-reports/G03/GROUP_03_KNOWN_LIMITATIONS.md` | New | G03 known limitations |
| `docs/mission-reports/G03/GROUP_04_READINESS_HANDOFF.md` | New | G04 readiness handoff |

### 9.4 Service Functions (03-06 Scope)

**Reform Verification Service**:
- `verifyReformAction(session, actionId, input)` → `{ verificationId, verificationStatus }`
- `verifyReformActionWithAuditSafe(session, actionId, input)` → same + denied-attempt audit
- `getReformVerification(session, actionId)` → `ReformVerification | null`

**Reform Feedback Service**:
- `createReformFeedbackLoop(session, actionId, input)` → `{ feedbackLoopId }`
- `getReformFeedbackLoop(session, actionId)` → `ReformFeedbackLoop | null`
- `closeOriginatingAlert(session, proposalId)` → `{ alertClosed: boolean }`

**Reform Query Service**:
- `getReformProposalSnapshot(session, proposalId)` → `ReformProposalSnapshot | null`
- `getReformDashboardSummary(session)` → `ReformDashboardSummary`

### 9.5 Entry Contracts

- 03-05 approved (actions exist + can be completed)

### 9.6 Exit Contracts

- 8 service functions implemented
- 8 API routes implemented
- F6 enforced (triple layer: Zod + DB trigger + service)
- Attribution level always "descriptive" (DB trigger + Zod + service)
- Feedback loop creates new Observation via `ingestObservation` (append-only)
- Feedback loop optionally computes new VarianceRecord via `computeVariance` (descriptive)
- Close originating alert uses G02 contracts (`verifyExecution` + `closeAlert`)
- 15 unit tests pass
- 10 integration tests pass (including sentinel regression)
- Existing tests still pass
- CI + Recovery pass

### 9.7 Acceptance Criteria

- [ ] F6 enforced: `verifiedAction` + `evidenceSource` required for `verified` status (sentinel test)
- [ ] F6 enforced: `disputeReason` + `disputeEvidenceSource` required for `disputed` status (sentinel test)
- [ ] Policy-outcome language rejected in `verifiedAction` (Zod + service check)
- [ ] Attribution level always "descriptive" (sentinel test — DB trigger)
- [ ] Causal language rejected in `descriptiveSummary` (Zod + service check)
- [ ] Feedback loop creates new Observation via `ingestObservation` (integration test — does NOT mutate existing observation)
- [ ] Feedback loop optionally computes new VarianceRecord via `computeVariance` (integration test — descriptive)
- [ ] Close originating alert uses G02 contracts (integration test — `verifyExecution` + `closeAlert` called)
- [ ] Dashboard summary returns correct statistics (integration test)
- [ ] 15 unit tests pass
- [ ] 10 integration tests pass
- [ ] Existing tests still pass
- [ ] CI + Recovery pass

### 9.8 Dependencies

- 03-05 approved

### 9.9 Definition of Done

1. Service + route files committed
2. Unit + integration + sentinel tests pass
3. Typecheck + Lint pass
4. Pushed to `main`
5. CI + Recovery pass
6. Owner + ChatGPT review → FINAL PASS
7. Mission report published
8. **G03 closure documents published** (Final Review + Acceptance Matrix + Known Limitations + G04 Readiness Handoff)

---

## 10. Post-G03 Closure

### 10.1 GROUP 03 Final Review

After 03-06 is approved, the following closure documents are produced:

| Document | Purpose |
|----------|---------|
| `docs/mission-reports/G03/GROUP_03_FINAL_REVIEW.md` | Comprehensive completion summary |
| `docs/mission-reports/G03/GROUP_03_ACCEPTANCE_MATRIX.md` | Per-mission acceptance grid with evidence |
| `docs/mission-reports/G03/GROUP_03_KNOWN_LIMITATIONS.md` | Closed, documented, and deferred limitations |
| `docs/mission-reports/G03/GROUP_04_READINESS_HANDOFF.md` | What GROUP 04 will pick up (documentation only) |

### 10.2 Expected G03 Final State

```text
GROUP 03 = APPROVED — FINAL PASS — CLOSED

Final implementation SHA: <to be filled at G03 closure>
Final closure SHA: <to be filled at G03 closure>
CI #??: SUCCESS
Recovery #??: SUCCESS
Total Tests: ~1007 passed | 10 skipped | 0 failed

GROUP 04 = READY FOR SCOPE REVIEW
GROUP 04 IMPLEMENTATION = NOT AUTHORIZED
```

### 10.3 G03 Known Limitations (Expected)

Based on the design, the following limitations are expected to be documented at G03 closure:

| Limitation | Status | Description |
|-----------|--------|-------------|
| G03-L01: Cross-Tenant Reform Coordination | DOCUMENTED | Reforms are single-tenant; cross-ministry coordination requires future mission |
| G03-L02: No Browser UI for Reform | DEFERRED | G03 ships API-first (mirrors G02-L03); UI deferred to future mission |
| G03-L03: Publication Workflow Not Implemented | DOCUMENTED | Inherits G02-L25; no publication approval in G03 |
| G03-L04: Government Projection Limited to Public Evidence | DOCUMENTED | Inherits G02-L26; no granular clearance model |
| G03-L05: LLM Advisor Uses StubProvider | DOCUMENTED | All advisor output `simulated: true`; real LLM integration deferred |
| G03-L06: No Real Country Data | DOCUMENTED | Inherits G02-L04; Demolandia only |
| G03-L07: G02-L22/L23/L24 Still Deferred | DEFERRED | Institutional early warning, hierarchical aggregation, sector observability — all still deferred |
| G03-L08: Advisor Causal Language Rejection Is Pattern-Based | DOCUMENTED | Regex-based; not a perfect NLP classifier |
| G03-L09: No Sub-Year Granularity for Reform Timeline | DOCUMENTED | Inherits G02-L01; yearly/quarterly/monthly only |
| G03-L10: No External Integrations (Email/SMS/Webhooks) | DOCUMENTED | Inherits G02-L05; no notifications for reform state changes |

---

## 11. Risk Register (Cross-Mission)

| Risk | Affects mission | Likelihood | Impact | Mitigation |
|------|----------------|------------|--------|------------|
| R-G3-01: LLM advisor produces causal claims | 03-03 | Medium | High | Zod + service check + reviewer judgment |
| R-G3-02: Cross-tenant reform references | 03-01, 03-02 | Low | High | RLS + cross-tenant triggers + service check (triple enforcement) |
| R-G3-03: ReformApproval not atomic with audit | 03-04 | Low | Critical | `writeAuditTx` inside `withAuthenticatedTenant` transaction; sentinel test |
| R-G3-04: ReformActionUpdate mutated/deleted | 03-01, 03-05 | Medium | High | RLS blocks UPDATE/DELETE; sentinel test |
| R-G3-05: F6 enforcement bypassed | 03-01, 03-06 | Low | High | DB trigger + Zod + service check (triple enforcement); sentinel test |
| R-G3-06: Cross-ministry reform coordination gap | All | High | Medium | Documented as G03-L01; cross-tenant coordination deferred to future mission |
| R-G3-07: G02-L25 blocks public reform visibility | All | High | Medium | Documented; G03 has no publication workflow; future mission required |
| R-G3-08: StubProvider produces unrealistic drafts | 03-03 | Medium | Low | `simulated: true` flag; analyst reviews/edits before saving |
| R-G3-09: Schema migration fails on existing DB | 03-01 | Low | High | Migration is additive; tested in CI fresh-install + recovery drill |
| R-G3-10: Test count regression | All | Low | Medium | Each mission has explicit test count targets; CI fails if count drops |

---

## 12. Mission Dependencies Graph

```
03-00 (DESIGN)
  │
  ▼
03-01 (SCHEMA)
  │
  ▼
03-02 (PROPOSAL + ALTERNATIVE)
  │
  ├──→ 03-03 (COMPARISON + ADVISOR)  ←─┐
  │       │                            │
  │       └──→ 03-04 (APPROVAL) ←──────┘
  │                 │
  │                 ▼
  │            03-05 (ACTION + UPDATES)
  │                 │
  │                 ▼
  │            03-06 (VERIFICATION + FEEDBACK)
  │                 │
  │                 ▼
  └──→ G03 CLOSURE (FINAL_REVIEW + ACCEPTANCE_MATRIX + KNOWN_LIMITATIONS + G04_READINESS_HANDOFF)
```

**Critical path**: 03-00 → 03-01 → 03-02 → 03-04 → 03-05 → 03-06 (6 sequential missions)

**Parallel opportunity**: 03-03 (Comparison + Advisor) could theoretically run in parallel with 03-04 (Approval) since they don't depend on each other. However, G03 follows strict sequential execution to keep review manageable. Parallel execution is not planned.

---

## 13. Estimated Timeline

> **Note**: This is a planning estimate, not a commitment. Actual duration depends on review cycles, iteration on feedback, and CI/Recovery timing.

| Mission | Estimated review cycles | Estimated elapsed |
|---------|------------------------|-------------------|
| 03-00 | 1-2 (design review) | 1 session |
| 03-01 | 1-2 (schema review) | 1 session |
| 03-02 | 2-3 (CRUD + lifecycle) | 1-2 sessions |
| 03-03 | 1-2 (advisory services) | 1 session |
| 03-04 | 2-3 (atomic approval — critical) | 1-2 sessions |
| 03-05 | 2 (lifecycle + append-only) | 1-2 sessions |
| 03-06 | 2-3 (F6 + feedback loop) | 1-2 sessions |
| Closure | 1 (final review) | 1 session |

**Total estimated**: 8-14 sessions for the full GROUP 03.

---

## 14. Conclusion

GROUP 03 is decomposed into **7 missions** (1 design + 1 schema + 5 service), totaling an estimated **~190 new tests** and **~6800 LOC**. Each mission has:

- A clear functional goal
- A scoped boundary (no scope creep)
- Explicit entry/exit contracts
- Verifiable acceptance criteria
- Hard dependencies on previous missions
- A Definition of Done aligned with the project's 9-step process

The decomposition honors the GROUP 02 pattern (bootstrap + service missions) while extending it to cover the reform loop's additional phases (approval, implementation, verification, feedback).

**Ready for owner + reviewer approval.**

---

*End of G03-00 Mission Roadmap. Companion documents: ARCHITECTURE_PROPOSAL.md, DOMAIN_MODEL.md, WORKFLOW_AND_APPROVALS.md, INTEGRATION_CONTRACTS.md, SECURITY_AND_EVIDENCE_POLICY.md, OPEN_DECISIONS.md.*
