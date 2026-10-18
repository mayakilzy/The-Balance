# G03-00 — Architecture Proposal

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Architecture proposal (DESIGN ONLY — no code, no migrations, no permissions changes)
> **Date:** 2026-10-18 (revision 2 — post owner review)
> **Author:** GLM (implementation agent)
> **Status:** REVISED per owner directive — re-awaiting final approval
> **Builds on:** GROUP 00 (Foundation), GROUP 01 (State Builder), GROUP 02 (State Observatory)

> ⚠️ **REVISION NOTE (2026-10-18 rev 2)**: This document is the original rev 1 architecture proposal.
> The substantive revisions after owner review are captured in three companion documents:
> - `G03_00_OPEN_DECISIONS.md` (fully revised) — D1-D9 with owner directives
> - `G03_00_THREAT_MODEL.md` (NEW) — 10 threats for multi-institution coordination
> - `G03_00_MISSION_ROADMAP.md` (fully revised) — 9 missions with vertical slice
>
> **Key changes from rev 1**:
> - Multi-institution coordination (D6) elevated from DEFERRED to CORE — adds 5 coordination tables + 4 permissions
> - Mission count: 7 → 9 (added 03-02 vertical slice, 03-06 coordination, 03-07 coordination vertical slice, 03-08 polish)
> - Table count: 7 → 12 (7 core + 5 coordination)
> - Permission count: 9 → 13 (added `reform:coordination:*`)
> - Lifecycle states (D5): 3 → 4 (separated execution verification from outcome measurement)
> - Hypothesis schema (D3): expanded with `confidenceBasis`, `contradictingEvidenceIds`, `reviewStatus`
>
> The content below reflects rev 1 thinking and is preserved for context. For the authoritative
> revised decisions, see the three companion documents above. A full content update of this
> document will be done in mission 03-01 if the owner requires it before approval.

---

## 1. Executive Summary

### 1.1 What GROUP 03 Is

GROUP 03 — **Targeted Reform** — closes the loop between *observing* a problem (GROUP 02) and *acting* on it (using the planning infrastructure of GROUP 01). It is **not** an automatic reform generator. It is a structured, evidence-respecting, human-sovereign pipeline that:

1. Consumes **descriptive signals** from the State Observatory (VarianceRecord, Alert, EarlyWarning, TemporalTrend).
2. Helps analysts **frame problems** and **draft reform proposals** with multiple alternatives, costs (as ranges), risks, assumptions, and expected outcomes (descriptive, never causal).
3. Routes proposals through a **human approval workflow** that inherits the atomic, audited pattern proven in GROUP 01 (`approveStrategyVersionWithAuditSafe`).
4. Converts approved proposals into **trackable reform actions** with append-only progress updates and evidence attachments.
5. Verifies execution using the same pattern as Alert F6 — `verifiedAction` + `evidenceSource` — describing the **specific action verified**, never a policy outcome.
6. Feeds results back to the observatory as **new observations** (descriptive comparison "before vs after") with **no causal attribution**.

### 1.2 What GROUP 03 Is Not

- ❌ **Not automatic reform creation.** The human drafts, the human approves, the human verifies. The LLM (when integrated) is advisory only.
- ❌ **Not a causal engine.** `attributionLevel = "descriptive"` is the platform-wide invariant. We describe variance; we never claim "this reform caused this change."
- ❌ **Not a replacement for GROUP 01 or GROUP 02.** `src/lib/state-builder/` diff stays 0. `src/lib/state-observatory/` diff stays 0 unless explicitly approved. All new code lives in `src/lib/reform/`.
- ❌ **Not a public publication system.** G02-L25 (fail-closed publication) applies. Any public-facing projection requires a publication approval workflow that does not yet exist.
- ❌ **Not a cross-tenant coordination mechanism.** Each tenant's reforms are isolated by RLS. Cross-ministry reforms require an explicit coordination model that this proposal flags as an open decision.

### 1.3 The Reform Loop (Conceptual)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ GROUP 02 — State Observatory (READ-ONLY consumption)                    │
│                                                                          │
│  VarianceRecord  →  Alert  →  EarlyWarning  →  TemporalTrend            │
│  (descriptive)      (lifecycle)  (uncalibrated)  (lookback)             │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ signal (no causal claim)
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ GROUP 03 — Targeted Reform                                              │
│                                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                 │
│  │ ReformProposal│→ │ ReformAltern.│ → │ ReformApproval│                 │
│  │ (draft)      │   │ (compare)    │   │ (atomic, audited)              │
│  └──────────────┘   └──────────────┘   └──────┬───────┘                 │
│                                                 │ approved               │
│                                                 ▼                        │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                 │
│  │ ReformAction │←──│ ReformAction │ ← │ (planned)    │                 │
│  │              │   │ Update       │   │              │                 │
│  │ (in_progress)│   │ (append-only)│   │              │                 │
│  └──────┬───────┘   └──────────────┘   └──────────────┘                 │
│         │                                                                │
│         ▼                                                                │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                 │
│  │ ReformVerif. │ → │ FeedbackLoop │ → │ Alert.closed │                 │
│  │ (F6 pattern) │   │ (descriptive)│   │ (verified)   │                 │
│  └──────────────┘   └──────────────┘   └──────────────┘                 │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ new observations (append-only)
                               ▼
                  back to GROUP 02 (no mutation of history)
```

### 1.4 Key Architectural Decisions (Summary)

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | New directory `src/lib/reform/` for all G03 services | Per G02 readiness handoff §"Architectural Invariants" — extends, not modifies, G01/G02 |
| A2 | 7 new PRIVATE tables in a single bootstrap migration (03-01) | Follows GROUP 02 pattern (one schema mission, then service missions) |
| A3 | 9 new permissions following `reform:*:*` pattern | Consistent with `observatory:*:*` and G01 permissions |
| A4 | ReformProposal references `Alert` and `VarianceRecord` as **nullable originating signals** | Reforms can be initiated from signals OR by human initiative |
| A5 | ReformProposal references `StrategyVersion` as **READ-ONLY FK** (never modified) | Honors invariant #2 — StrategyVersion immutability |
| A6 | ReformAction **optionally** links to G01 `Program`/`Project` (nullable FK) | Reuse existing planning when relevant; standalone reform when not |
| A7 | Evidence snapshot at approval time (same pattern as G00 Decision) | Preserves what was known when approved, even if evidence later changes |
| A8 | `verifyExecution` follows F6 pattern: `verifiedAction` + `evidenceSource` required | Consistent with Alert F6; describes action verified, not policy outcome |
| A9 | LLM-assisted drafting via `StubProvider` (advisory only, `simulated: true`) | Honors ADR-0002 + ADR-0010 §"Simulated model output disclaimer" |
| A10 | All G03 services use `withAuthenticatedTenant` + `requirePermissionWithCurrentRole` | Inherits the proven RLS + RBAC pattern from G01/G02 |

---

## 2. Architectural Context

### 2.1 Where GROUP 03 Sits in the Stack

```
src/
├── app/                         # Next.js App Router (UI + API routes)
│   ├── api/v1/                  # Existing REST API (G00-G02)
│   │   ├── reform/              # NEW: G03 REST endpoints (03-02 onward)
│   │   │   ├── proposals/        # ReformProposal CRUD + lifecycle
│   │   │   ├── alternatives/    # ReformAlternative management
│   │   │   ├── approvals/        # Atomic approval endpoints
│   │   │   ├── actions/          # ReformAction + updates
│   │   │   └── verifications/   # Verification + feedback loop
│   │   └── ... (existing G00-G02 routes unchanged)
│   └── reform/                  # NEW: G03 UI page (deferred — see §11)
│
├── lib/
│   ├── state-builder/           # G01 services — READ-ONLY (diff = 0)
│   ├── state-observatory/       # G02 services — READ-ONLY (diff = 0)
│   ├── reform/                  # NEW: G03 services
│   │   ├── contracts.ts         # Zod schemas + shared types
│   │   ├── reform-proposal-service.ts
│   │   ├── reform-alternative-service.ts
│   │   ├── reform-comparison-service.ts
│   │   ├── reform-advisor-service.ts          # LLM-assisted (advisory only)
│   │   ├── reform-approval-service.ts          # Atomic approval + audit
│   │   ├── reform-action-service.ts            # Implementation tracking
│   │   ├── reform-action-update-service.ts     # Append-only progress
│   │   ├── reform-verification-service.ts      # F6-pattern verification
│   │   ├── reform-feedback-service.ts          # Loop closure to observatory
│   │   ├── reform-query-service.ts             # Cross-entity snapshot
│   │   └── index.ts                            # Barrel exports
│   │
│   ├── audit.ts                 # writeAudit / writeAuditTx (REUSED)
│   ├── strategy-service.ts      # G00 strategy/decision services (REUSED as reference)
│   ├── balance-master.ts        # Durable task orchestrator (REUSED for async reform tasks)
│   ├── llm/                     # LLM provider abstraction (StubProvider for now)
│   ├── permissions.ts           # Extended with 9 new reform:* permissions
│   ├── security/tenant-context.ts  # withAuthenticatedTenant (REUSED)
│   └── ...
```

### 2.2 What GROUP 03 Reuses (No Duplication)

| Component | Source | How G03 uses it |
|-----------|--------|------------------|
| `withAuthenticatedTenant(session, fn)` | `src/lib/security/tenant-context.ts` | Wraps every G03 service — sets `app.tenant_id` + `app.user_id`, verifies current membership, returns `{ tx, userId, tenantId, roleCode }` |
| `requirePermissionWithCurrentRole(session, perm)` | `src/lib/permissions.ts` | Permission gate for every G03 privileged operation — checks CURRENT DB role, not stale JWT |
| `writeAuditTx(tx, entry)` | `src/lib/audit.ts` | Atomic audit log writes inside the same transaction as the primary operation (compliance-grade) |
| `writeAudit(entry)` | `src/lib/audit.ts` | Best-effort audit for non-atomic operations (e.g., logging denied attempts) |
| `approveStrategyVersionWithAuditSafe` pattern | `src/lib/state-builder/approval-service.ts` | **Reference pattern** for G03 approval: try → execute in transaction → catch `PermissionDeniedError` → write denied audit → re-throw |
| `Decision` model + `supportingEvidence`/`counterEvidence` JSONB snapshots | `prisma/schema.prisma` (G00) | **Reference pattern** for ReformApproval evidence snapshots |
| `Alert` lifecycle + executionStatus separation (R5/F6) | `prisma/schema.prisma` (G02) | **Reference pattern** for ReformVerification — same `verifiedAction` + `evidenceSource` requirement |
| Durable Task runtime (`Task`, `TaskEvent`, fencing tokens) | `prisma/schema.prisma` (G00) + `src/lib/task-service.ts` + `balance-master.ts` | Async reform tasks (e.g., LLM-assisted alternative drafting) use the existing Task table — no new async runtime needed |
| `Capability` + `CapabilityInvocation` | `prisma/schema.prisma` (G00) | Register G03 capabilities (e.g., `reform.draft_alternatives`, `reform.compare`) for inventory + observability |
| `FixtureTracker` | `tests/integration/helpers/fixture-tracker.ts` | Reused for G03 integration tests — ownership-aware cleanup, sentinel regression patterns |
| LLM Provider abstraction (`getLLMProvider`, `StubProvider`) | `src/lib/llm/` | Reform advisor uses the abstraction; StubProvider keeps G03 deterministic until a real LLM is authorized |

### 2.3 What GROUP 03 Builds New

| Component | Location | Purpose |
|-----------|----------|---------|
| 7 new PRIVATE tables | `prisma/schema.prisma` + migration `20261018000022_g03_reform_bootstrap` | ReformProposal, ReformAlternative, ReformApproval, ReformAction, ReformActionUpdate, ReformVerification, ReformFeedbackLoop |
| 9 new permissions | `src/lib/permissions.ts` | `reform:proposal:{read,write,approve}`, `reform:alternative:{read,write}`, `reform:action:{read,write,verify}`, `reform:verification:read` |
| `src/lib/reform/contracts.ts` | New | Zod schemas mirroring the G02 pattern (input validation, lifecycle enums, error types) |
| 11 service modules | `src/lib/reform/*.ts` | See §2.2 directory layout |
| 5 new API route groups | `src/app/api/v1/reform/` | REST endpoints for proposal/alternative/approval/action/verification |
| 1 UI page (deferred) | `src/app/reform/page.tsx` | Optional mission — G03 may follow G02's pattern of API-first (G02-L03) |

---

## 3. Architectural Invariants (Preserved from G00/G01/G02)

These invariants are **inherited** and must not change without owner approval. GROUP 03 design honors each one explicitly.

### 3.1 The 14 Frozen Invariants

| # | Invariant | How GROUP 03 honors it |
|---|-----------|------------------------|
| 1 | `attributionLevel = "descriptive"` always — no causal claims without evidence | ReformProposal describes the variance problem; expected outcomes are framed as "anticipated changes" with explicit assumptions, never as guaranteed causal links. ReformVerification describes "actions verified" + "observations made," never "this reform caused this outcome." |
| 2 | StrategyVersion referenced as READ-ONLY FK — never modified by observatory or reform services | `ReformProposal.strategyVersionId` and `ReformAction.programId`/`projectId` are read-only references to approved G01 entities. G03 never calls `strategy.update` or `program.update`. |
| 3 | Observations are append-only with correction chains (R4) — no in-place mutation | ReformFeedbackLoop creates **new** Observation rows (via the G02 `ingestObservation` contract) — never modifies existing ones. |
| 4 | `isCurrent` uniqueness via partial unique index with `COALESCE(geo_ref_id, '')` (F1) | N/A — G03 does not introduce new observations directly; uses G02's `ingestObservation` contract which already honors F1. |
| 5 | Chain integrity via DB trigger — no branching, no cycles, no self-reference (F3) | N/A — same as #4. |
| 6 | `VarianceRecord.observationId` is NULLABLE — null when unknown (F4) | ReformProposal.originatingVarianceRecordId is nullable (reforms can be human-initiated without a variance signal). |
| 7 | Alert separates `lifecycleStage` from `executionStatus` (R5/F6) | ReformVerification follows the same separation: verification status is independent from reform action status. |
| 8 | `verifyExecution` requires `verifiedAction` + `evidenceSource` (F6) | ReformVerification.verifiedAction + ReformVerification.evidenceSource are REQUIRED for `verificationStatus = "verified"`. Same Zod `superRefine` pattern as G02. |
| 9 | No new tables/migrations/permissions in service missions — bootstrap first, then services | G03 follows GROUP 02's pattern: 03-01 bootstrap (1 migration, 7 tables, 9 permissions), then 03-02 through 03-06 are service-only missions with diff=0 on schema. |
| 10 | `src/lib/state-builder/` diff = 0 — GROUP 01 code untouched | G03 imports from `state-builder` are read-only function calls (e.g., `getProgram`, `getProject`). No modifications. |
| 11 | `src/lib/state-observatory/` diff = 0 unless explicitly approved | G3 imports from `state-observatory` are read-only function calls (e.g., `listVariance`, `getAlert`, `ingestObservation` for feedback). No modifications. |
| 12 | Fail-closed for public/research publication (G02-L25) | ReformProposal has NO `publication_status` field in 03-00. Publication is a future mission requiring explicit owner approval. Until then, reforms are tenant-private. |
| 13 | Government projection limited to `classification="public"` evidence (G02-L26) | If G03 later exposes reform data to government viewers, the same conservative clearance applies. No new clearance model in 03-00. |
| 14 | The human remains sovereign — no automatic reform creation, approval, or execution | Every state transition in the reform lifecycle requires an authenticated human actor with the appropriate permission. The LLM advisor (when integrated) only drafts; it never approves, executes, or verifies. |

### 3.2 New Invariants Introduced by GROUP 03

These are **proposed** invariants for G03, consistent with the existing pattern. They become frozen only after owner approval.

| # | Proposed Invariant | Rationale |
|---|-------------------|-----------|
| G3-I1 | ReformProposal.originatingAlertId is **nullable** but, when set, must reference an Alert in the same tenant | Reforms can be signal-initiated OR human-initiated; cross-tenant alert references are blocked by RLS + service check |
| G3-I2 | ReformProposal can have **multiple alternatives**, each with its own cost range, risk level, assumptions | Mirrors G01's Strategy Composer pattern (multiple alternatives per batch) |
| G3-I3 | Only ONE alternative per proposal can be `selected = true` at a time | Prevents conflicting approved alternatives; enforced by partial unique index |
| G3-I4 | ReformApproval is **atomic with evidence snapshot** (same as G00 Decision) | Snapshot `{ evidenceId, claim, verificationStatus, sourceCode }` at approval time — immutable post-approval |
| G3-I5 | ReformActionUpdate is **append-only** — no UPDATE, no DELETE (RLS blocks both) | Same pattern as DecisionEvent, TaskEvent — progress history is sovereign |
| G3-I6 | ReformVerification.verificationStatus = "verified" requires `verifiedAction` (≥1 char) + `evidenceSource` (≥1 char) | F6 pattern from G02 — describes specific action, not policy outcome |
| G3-I7 | ReformFeedbackLoop is **descriptive only** — `comparisonType` ∈ {before_after, parallel, none}, never "causal" | Honors invariant #1 — no causal claims |
| G3-I8 | All G03 tables are PRIVATE (tenant-scoped) with RLS ENABLE + FORCE | Same pattern as all G01/G02 private tables |
| G3-I9 | LLM-assisted advisor output carries `simulated: true` when StubProvider is active | Honors ADR-0010 §"Simulated model output disclaimer" + ADR-0002 |
| G3-I10 | No G03 service calls `evidence.update`, `observation.update`, `alert.update` on entities it does not own | G03 may create new Evidence (for reform-specific evidence) and new Observations (via G02 contract) but never mutates G00/G02 history |

---

## 4. Layered Architecture

### 4.1 Three-Tier Service Pattern

GROUP 03 follows the same three-tier pattern proven in G01 and G02:

```
┌─────────────────────────────────────────────────────────────┐
│ Tier 3: API Routes (src/app/api/v1/reform/*)                │
│   - HTTP layer, request validation, response shaping       │
│   - Calls Tier 2 services via session                       │
│   - Rate-limited (extends G00's rate limiter)                │
└────────────────────────┬────────────────────────────────────┘
                         │ session: Session
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Tier 2: Domain Services (src/lib/reform/*-service.ts)        │
│   - Business logic, lifecycle transitions                   │
│   - withAuthenticatedTenant + requirePermissionWithCurrentRole│
│   - Atomic audit via writeAuditTx                           │
│   - Calls Tier 1 contracts for pure validation             │
└────────────────────────┬────────────────────────────────────┘
                         │ tx: Prisma.TransactionClient
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Tier 1: Pure Contracts (src/lib/reform/contracts.ts)         │
│   - Zod schemas (input validation)                          │
│   - Pure functions (thresholds, comparators)               │
│   - No DB access, no side effects                          │
│   - Unit-testable in isolation                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Service Composition

Each G03 service follows this template (mirrors G02 services):

```typescript
export async function createReformProposal(
  session: Session,
  input: CreateReformProposalInput
): Promise<{ proposalId: string }> {
  // 1. Validate input via Zod (Tier 1)
  const validated = CreateReformProposalInputSchema.parse(input);

  // 2. Wrap in authenticated tenant context (sets RLS)
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId, roleCode }) => {
    // 3. Check permission against CURRENT DB role
    await requirePermissionWithCurrentRole(session, "reform:proposal:write");

    // 4. Validate cross-tenant references (originatingAlertId, strategyVersionId)
    if (validated.originatingAlertId) {
      const alert = await tx.alert.findFirst({
        where: { id: validated.originatingAlertId, tenantId },
      });
      if (!alert) throw new NotFoundError("Originating alert not found in tenant scope");
    }

    // 5. Execute the primary operation
    const proposal = await tx.reformProposal.create({
      data: { ...validated, tenantId, createdBy: userId },
    });

    // 6. Record domain event (append-only)
    await tx.event.create({
      data: {
        tenantId,
        eventType: "reform.proposal_created",
        actor: userId,
        entityType: "reform_proposal",
        entityId: proposal.id,
        metadata: { title: validated.title },
      },
    });

    // 7. Atomic audit log (compliance-grade)
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.proposal_created",
      status: "ok",
      details: { proposalId: proposal.id, title: validated.title.slice(0, 200) },
    });

    return { proposalId: proposal.id };
  });
}
```

### 4.3 Error Handling Pattern

G03 inherits G02's three error classes:

| Error | When thrown | HTTP status |
|-------|-------------|-------------|
| `PermissionDeniedError` | Permission check fails (from `requirePermissionWithCurrentRole`) | 403 |
| `NotFoundError` | Entity not found in tenant scope | 404 |
| `ConflictError` | Lifecycle transition invalid (e.g., approving already-approved proposal) | 409 |

All other errors are sanitized by `error-sanitizer.ts` (G00) — strips file paths, SQL fragments, env var names, stack traces.

---

## 5. Reform Lifecycle (Conceptual)

### 5.1 High-Level State Machine

```
[Signal: Alert/VarianceRecord]  OR  [Human Initiative]
                    │
                    ▼
        ┌──────────────────────┐
        │ ReformProposal       │
        │ status = "draft"     │
        └──────────┬───────────┘
                   │ analyst adds alternatives
                   ▼
        ┌──────────────────────┐
        │ ReformAlternative[]  │
        │ status = "draft"     │
        └──────────┬───────────┘
                   │ reviewer selects ONE alternative
                   ▼
        ┌──────────────────────┐
        │ ReformProposal       │
        │ status = "under_review"│
        └──────────┬───────────┘
                   │ reviewer approves (atomic + audit + evidence snapshot)
                   ▼
        ┌──────────────────────┐
        │ ReformApproval       │
        │ status = "approved"  │
        │ evidenceSnapshot = {...}│
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ ReformAction         │
        │ status = "planned"  │
        └──────────┬───────────┘
                   │ owner starts work
                   ▼
        ┌──────────────────────┐
        │ ReformAction         │
        │ status = "in_progress"│
        │ ReformActionUpdate[]  │ (append-only)
        └──────────┬───────────┘
                   │ owner completes
                   ▼
        ┌──────────────────────┐
        │ ReformAction         │
        │ status = "completed"│
        └──────────┬───────────┘
                   │ reviewer verifies (F6 pattern)
                   ▼
        ┌──────────────────────┐
        │ ReformVerification   │
        │ status = "verified" │
        │ verifiedAction = "..."│
        │ evidenceSource = "..."│
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ ReformFeedbackLoop   │
        │ comparisonType =     │
        │ "before_after"       │
        │ (descriptive only)   │
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ Alert.lifecycleStage │
        │ = "closed"           │
        │ Alert.executionStatus│
        │ = "verified"         │
        └──────────────────────┘
```

### 5.2 Lifecycle Stage Definitions

| Entity | Field | Values | Transition rules |
|--------|-------|--------|------------------|
| ReformProposal | `status` | `draft` → `under_review` → `approved` / `rejected` / `superseded` | `draft → under_review` (analyst submits), `under_review → approved` (reviewer approves), `under_review → rejected` (reviewer rejects), `approved → superseded` (new proposal supersedes) |
| ReformAlternative | `status` | `draft` → `selected` / `withdrawn` | Only ONE `selected` per proposal (partial unique index) |
| ReformApproval | (created on approval) | one-shot — atomic with proposal.status = "approved" | No lifecycle; immutable once created |
| ReformAction | `status` | `planned` → `in_progress` → `completed` / `blocked` / `cancelled` | `planned → in_progress` (owner starts), `in_progress → completed` (owner finishes), `in_progress → blocked` (owner reports blocker), `blocked → in_progress` (owner unblocks), `planned/in_progress → cancelled` (reviewer cancels) |
| ReformActionUpdate | (append-only) | n/a | RLS blocks UPDATE + DELETE — no lifecycle, only INSERT |
| ReformVerification | `verificationStatus` | `pending` → `verified` / `disputed` | `pending → verified` requires verifiedAction + evidenceSource (F6), `pending → disputed` requires disputeReason + evidenceSource |
| ReformFeedbackLoop | (created on verification) | one-shot — descriptive only | No lifecycle; immutable |

### 5.3 Rejection and Supersession Paths

- **Rejection**: `under_review → rejected` — the proposal is closed. A new proposal can be created from the same originating alert (no prevention), but the rejected one stays in history for audit.
- **Supersession**: `approved → superseded` — when a NEW proposal is approved for the same originating alert, the previous approved proposal is automatically superseded (mirrors G01's `approveStrategyVersion` pattern). Both stay in history.

---

## 6. Integration with Existing Groups

### 6.1 GROUP 03 → GROUP 01 (State Builder) Integration

| Direction | What G03 reads from G01 | How |
|-----------|------------------------|-----|
| Read | `Program` (for linking ReformAction to existing programs) | `tx.program.findFirst({ where: { id, tenantId } })` |
| Read | `Project` (for linking ReformAction to existing projects) | `tx.project.findFirst({ where: { id, tenantId } })` |
| Read | `BudgetLine` (for cost estimation reference) | `tx.budgetLine.findMany({ where: { programId, tenantId } })` |
| Read | `Objective` (for linking reform to strategic objectives) | `tx.objective.findFirst({ where: { id, tenantId } })` |
| Read | `RiskRegister` + `Assumption` (pattern reference for G03 risk/assumption fields) | Pattern only — G03 has its own risk/assumption fields on ReformAlternative |

**Critical constraint**: G03 never calls `program.update`, `project.update`, `objective.update`, or any G01 write operation. G01 entities are READ-ONLY references.

### 6.2 GROUP 03 → GROUP 02 (State Observatory) Integration

| Direction | What G03 reads from G02 | How |
|-----------|------------------------|-----|
| Read | `VarianceRecord` (originating signal) | `tx.varianceRecord.findFirst({ where: { id, tenantId } })` |
| Read | `Alert` (originating signal) | `tx.alert.findFirst({ where: { id, tenantId } })` |
| Read | `Observation` (current state, for comparison) | `tx.observation.findFirst({ where: { id, tenantId, isCurrent: true } })` |
| Read | `ObservatorySnapshot` (4-layer cascade) | Calls `getObservatorySnapshot(session, { ... })` from `state-observatory` barrel |
| Read | `EarlyWarning` + `TemporalTrend` | Calls `assessEarlyWarning` + `analyzeTemporalTrend` from `state-observatory` barrel |

| Direction | What G03 writes back to G02 | How |
|-----------|----------------------------|-----|
| Write (new) | New `Observation` rows (post-reform measurements) | Calls `ingestObservation(session, { ... })` from `state-observatory` — append-only, never mutates existing |
| Write (new) | New `VarianceRecord` (post-reform variance, descriptive comparison) | Calls `computeVariance(session, { ... })` — same deterministic computation |
| Update | `Alert.lifecycleStage` → "closed" + `executionStatus` → "verified"/"disputed" | Calls `verifyExecution(session, alertId, { verifiedAction, evidenceSource, notes })` + `closeAlert(session, alertId, { closureReason })` from `state-observatory` — uses G02's existing contracts, NOT direct table writes |

**Critical constraint**: G03 never directly writes to G02 tables. All G02 mutations go through the G02 service contracts (`ingestObservation`, `computeVariance`, `verifyExecution`, `closeAlert`). This honors invariant #11 — `state-observatory/` diff = 0.

### 6.3 GROUP 03 → GROUP 00 (Foundation) Integration

| G00 component | How G03 uses it |
|---------------|-----------------|
| `withAuthenticatedTenant`, `setTenantContext`, `clearTenantContext` | Direct reuse — every G03 service |
| `requirePermissionWithCurrentRole`, `hasPermission`, `PermissionDeniedError` | Direct reuse — every privileged operation |
| `writeAudit`, `writeAuditTx` | Direct reuse — every state transition |
| `Evidence` + `EvidenceEmbedding` | G03 may create new Evidence rows (for reform-specific evidence) via `tx.evidence.create` within the tenant scope. **Pattern**: same as G01/G02 evidence creation. |
| `Source` | G03 may reference existing Source rows. No new Source creation in 03-00 (deferred). |
| `Task` + `TaskEvent` | G03 may create async tasks (e.g., LLM-assisted alternative drafting) via the existing `task-service.ts`. No new task table. |
| `Capability` + `CapabilityInvocation` | G03 may register capabilities (e.g., `reform.draft_alternatives`) in the existing registry. No new capability table. |
| `Event` (generic timeline) | G03 records `reform.*` events in the existing `events` table. No new event table. |
| `Decision` + `DecisionEvent` | **Reference pattern only** — G03 has its own `ReformApproval` (mirrors Decision's evidence snapshot pattern) but does NOT reuse the Decision table directly. Rationale: Decisions are tied to StrategyVersion; reform approvals are tied to ReformProposal — semantically distinct. |

---

## 7. Domain Model Overview (Summary)

> Full detail in `G03_00_DOMAIN_MODEL.md`. This section is a summary.

### 7.1 New Tables (7 — all PRIVATE, RLS ENABLE + FORCE)

| Table | Purpose | Key fields | Owning mission |
|-------|---------|------------|----------------|
| `reform_proposals` | Top-level reform container | `tenantId, originatingAlertId?, originatingVarianceRecordId?, strategyVersionId?, title, problemStatement, status, createdBy` | 03-01 |
| `reform_alternatives` | Multiple options per proposal | `proposalId, title, description, costEstimateMin, costEstimateMax, costCurrency, riskLevel, feasibilityScore, assumptions Json, risks Json, status` | 03-01 |
| `reform_approvals` | Atomic approval + evidence snapshot | `proposalId, alternativeId, approvedBy, approvedAt, approvalNotes, evidenceSnapshot Json` | 03-01 |
| `reform_actions` | Implementation tracking | `proposalId, alternativeId, programId?, projectId?, assignedTo, status, startDate, dueDate, completedDate?` | 03-01 |
| `reform_action_updates` | Append-only progress log | `actionId, updateType, actor, notes, progressPercentage?, evidenceIds Json` | 03-01 |
| `reform_verifications` | F6-pattern verification | `actionId, verificationStatus, verifiedAction?, evidenceSource?, verifiedBy, verifiedAt, disputeReason?` | 03-01 |
| `reform_feedback_loops` | Descriptive before/after link | `actionId, beforeObservationId?, afterObservationId?, comparisonType, descriptiveSummary, createdBy` | 03-01 |

### 7.2 New Permissions (9)

| Permission | Roles | Purpose |
|-----------|-------|---------|
| `reform:proposal:read` | admin, analyst, reviewer, observer | Read reform proposals |
| `reform:proposal:write` | admin, analyst | Draft/edit reform proposals |
| `reform:proposal:approve` | admin, reviewer | Approve/reject reform proposals (atomic) |
| `reform:alternative:read` | admin, analyst, reviewer | Read alternatives |
| `reform:alternative:write` | admin, analyst | Draft/edit alternatives |
| `reform:action:read` | admin, analyst, reviewer, observer | Read reform actions |
| `reform:action:write` | admin, analyst | Create/update reform actions + progress updates |
| `reform:action:verify` | admin, reviewer | Verify execution (F6 pattern) |
| `reform:verification:read` | admin, analyst, reviewer | Read verification records |

### 7.3 Permission Matrix (per role)

| Role | proposal:read | proposal:write | proposal:approve | alternative:read | alternative:write | action:read | action:write | action:verify | verification:read |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| reviewer | ✓ | — | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| analyst | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| observer | ✓ | — | — | — | — | ✓ | — | — | — |

**Rationale**: Mirrors the G01/G02 permission philosophy:
- `observer` is read-only on the highest-level entity (proposal, action) but cannot see alternatives or verifications (consistent with G01's `gap`/`program` exclusion for observers).
- `analyst` can draft (proposal:write, alternative:write, action:write) but cannot approve or verify (separation of duties).
- `reviewer` can approve and verify but cannot draft (separation of duties in the other direction).
- `admin` has all permissions (full control, but still audited).

---

## 8. Cross-Cutting Concerns

### 8.1 Multi-Tenancy

- All 7 new tables have `tenantId String` as the first non-id field.
- RLS policy (same as G01/G02): `USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (...)` for `balance_app`; `USING (true) WITH CHECK (true)` for `balance_admin`.
- Cross-tenant references blocked by:
  - RLS (tenant B cannot see tenant A's rows)
  - Service-layer check (G03 services validate `originatingAlertId`, `strategyVersionId`, `programId`, `projectId` belong to the same tenant)

### 8.2 Audit Trail

Every G03 state transition writes to:
1. **`events` table** (G00 — generic domain timeline) — `reform.proposal_created`, `reform.proposal_approved`, `reform.action_started`, etc.
2. **`audit_log` table** (G00 — sovereign audit trail, atomic) — `writeAuditTx` inside the same transaction as the primary operation.
3. **Entity-specific event tables** (G03 — append-only) — `reform_action_updates` for progress history.

This three-layer pattern mirrors G01's `approveStrategyVersionWithAuditSafe` (per ADR-0010 §13 Correction B):
- Layer 1: Authorization enforcement (`requirePermissionWithCurrentRole`)
- Layer 2: Domain Event (`events` table — domain timeline)
- Layer 3: Audit Log (`audit_log` — sovereign, atomic via `writeAuditTx`)

### 8.3 Evidence Handling

- G03 may create new `Evidence` rows for reform-specific evidence (e.g., a memo about a reform decision, a photo of completed infrastructure).
- Evidence creation follows the G00 pattern: `tx.evidence.create({ data: { tenantId, claim, type, sourceId, classification: "public" } })`.
- **Critical**: G03 never mutates existing Evidence rows. Evidence is append-only (with the existing `relatedEvidenceId` for corrections/links).
- `ReformApproval.evidenceSnapshot` captures `{ evidenceId, claim, type, verificationStatus, sourceCode }` at approval time — same JSONB snapshot pattern as G00 Decision.
- `ReformActionUpdate.evidenceIds` references current evidence (live link, not snapshot — because updates are progress reports, not sovereign decisions).

### 8.4 LLM Integration (Advisory Only)

- The `reform-advisor-service.ts` uses the LLM provider abstraction (`getLLMProvider()`).
- When `StubProvider` is active (current state), all advisor output carries `simulated: true`.
- Advisor capabilities (all advisory, never authoritative):
  - `draftProblemStatement(alert, varianceRecord)` → returns draft text for analyst to review/edit
  - `draftAlternatives(proposal)` → returns 2-3 draft alternatives (analyst selects/edits)
  - `compareAlternatives(alternatives[])` → returns descriptive comparison (no ranking, no recommendation)
  - `draftExpectedOutcomes(proposal, alternative)` → returns anticipated outcomes with explicit assumptions
- **Critical**: The advisor NEVER:
  - Approves proposals
  - Selects an alternative
  - Verifies execution
  - Makes causal claims
  - Overrides human decisions

### 8.5 Observability + Metrics

- All G03 services use `childLogger({ module: "reform" })` (extends G00's `observability.ts`).
- New metrics (extends G00's `metrics.ts`):
  - `reform_proposals_created_total{tenant_id, status}`
  - `reform_proposals_approved_total{tenant_id}`
  - `reform_actions_in_progress{tenant_id}`
  - `reform_verifications_verified_total{tenant_id}`
  - `reform_advisor_invocations_total{tenant_id, simulated}`
- All metrics are exposed via `GET /api/v1/_metrics` (requires `audit:read` permission, same as G00).

### 8.6 Error Handling

- G03 inherits G02's three error classes: `PermissionDeniedError`, `NotFoundError`, `ConflictError`.
- All other errors are sanitized by `error-sanitizer.ts` (G00) — strips file paths, SQL fragments, env var names, stack traces, truncates to 300 chars.
- Denied permission attempts are audited (same pattern as `approveStrategyVersionWithAuditSafe`):
  ```typescript
  try {
    return await approveReformProposal(session, proposalId, alternativeId, notes);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      // Best-effort denied-attempt audit (outside the failed transaction)
      try {
        await withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
          await writeAuditTx(tx, {
            tenantId, actor: userId,
            action: "reform.proposal_approved",
            status: "denied",
            errorCode: "PERMISSION_DENIED",
            details: { proposalId, permission: err.permission },
          });
        });
      } catch {
        // Fall back to global writeAudit (best-effort)
        await writeAudit({
          tenantId: session.user?.tenantId,
          actor: session.user?.id,
          action: "reform.proposal_approved",
          status: "denied",
          errorCode: "PERMISSION_DENIED",
          details: { proposalId, permission: err.permission },
        });
      }
    }
    throw err; // Always re-throw the original error
  }
  ```

---

## 9. Testing Strategy

### 9.1 Test Pyramid

| Layer | Tool | Location | Gating |
|-------|------|----------|--------|
| Unit (Tier 1) | Vitest | `tests/unit/reform/` | Always runs |
| Integration (Tier 2 + 3) | Vitest + real PostgreSQL 16 | `tests/integration/g03-*.integration.test.ts` | `RUN_INTEGRATION_TESTS=1` |
| Browser E2E | Playwright | `tests/browser/reform-*.spec.ts` | Deferred (G02-L03 pattern — API-first) |
| HTTP E2E | Vitest HTTP layer | `tests/e2e/reform-*.e2e.test.ts` | `RUN_E2E_TESTS=1` |

### 9.2 Test Coverage Targets

| Mission | New tests | Cumulative |
|---------|-----------|------------|
| 03-01 (Bootstrap) | ~15 unit + ~10 integration (RLS, schema, permissions) | 817 + 25 = 842 |
| 03-02 (Proposal + Alternative) | ~25 unit + ~20 integration | 842 + 45 = 887 |
| 03-03 (Comparison + Advisor) | ~20 unit + ~15 integration | 887 + 35 = 922 |
| 03-04 (Approval) | ~15 unit + ~10 integration (atomicity, evidence snapshots, denied audit) | 922 + 25 = 947 |
| 03-05 (Action + Updates) | ~20 unit + ~15 integration (append-only, lifecycle transitions) | 947 + 35 = 982 |
| 03-06 (Verification + Feedback) | ~15 unit + ~10 integration (F6 pattern, feedback loop) | 982 + 25 = 1007 |

**Target at end of G03**: ~1007 tests passed, 10 skipped (existing), 0 failed.

### 9.3 Sentinel Regression Tests (G02-L21 pattern)

G03 will add sentinel regression tests for:
- `reform_action_updates` append-only enforcement (RLS blocks UPDATE/DELETE for `balance_app`)
- `reform_approval` atomicity (audit failure → rollback, no orphaned approval)
- `reform_verification` F6 enforcement (`verifiedAction` + `evidenceSource` required for `verified` status)
- Cross-tenant isolation (Tenant B cannot see Tenant A's reform proposals)

These follow the `g02-l21-sentinel.integration.test.ts` pattern and live in `tests/integration/g03-*-sentinel.integration.test.ts`.

### 9.4 FixtureTracker Reuse

G03 integration tests reuse `FixtureTracker` from `tests/integration/helpers/fixture-tracker.ts`:
- `trackOwned(record)` for G03-created fixtures (cleaned up after test)
- `trackOwned(record, false)` for pre-existing fixtures (preserved after test)
- Ownership-aware cleanup (G02-L21 closure pattern)

---

## 10. Recovery Strategy

### 10.1 Fresh Install Verification (extends G00's 00-10)

`scripts/fresh-install-verify.sh` is extended to verify:
- Migration `20261018000022_g03_reform_bootstrap` applies cleanly on fresh DB
- All 7 new tables have RLS ENABLE + FORCE
- All 9 new permissions are registered
- Seed data creates 2-3 sample reform proposals per tenant (Demolandia)
- `verify-restored-db.sh` passes with 29 private tables (22 G00-G02 + 7 G03)

### 10.2 Backup/Restore Drill (extends G00's 00-10)

`scripts/backup-restore-test.sh` is extended to verify:
- Backup includes all 7 G03 tables
- Restore preserves all G03 rows
- RLS policies are intact post-restore
- Audit trail is complete post-restore

### 10.3 CI Workflow (extends G00's ci.yml)

CI pipeline adds:
- `tests/unit/reform/` runs in the unit test stage
- `tests/integration/g03-*.integration.test.ts` runs in the integration stage (gated by `RUN_INTEGRATION_TESTS=1`)
- New sentinel regression tests run on every push

---

## 11. UI Strategy (Deferred)

### 11.1 API-First Approach (Mirrors G02)

G03 follows G02's API-first pattern (G02-L03):
- All functionality is exposed via REST API under `/api/v1/reform/*`
- No browser UI in 03-00 through 03-06 (unless owner explicitly requests it)
- This avoids the G02-L03 gap (no browser UI for observatory) by deferring UI to a dedicated mission

### 11.2 Future UI Mission (03-07 or later)

When authorized, a future mission would add:
- `/reform` page — list of reform proposals (filtered by status, originating alert)
- `/reform/[id]` page — proposal detail with alternatives, approval, actions, verifications
- `/reform/[id]/action/[actionId]` page — action detail with progress updates
- All UI pages follow the Arabic-first RTL pattern from G00

### 11.3 Why Defer UI

1. **Consistency with G02** — G02 shipped without UI (G02-L03), and the owner accepted it. G03 follows the same discipline.
2. **Faster iteration** — API-first lets the reviewer (ChatGPT) verify behavior without UI dependencies.
3. **Separation of concerns** — Domain logic and lifecycle are stable before UI is built on top.
4. **Reduced risk** — UI changes are easier to revert than schema or service changes.

---

## 12. Performance Considerations

### 12.1 Expected Query Patterns

| Query | Frequency | Indexes |
|-------|-----------|---------|
| List proposals by tenant + status | High | `@@index([tenantId, status])` |
| Get proposal with alternatives + approval | Medium | PK + `@@index([proposalId])` on alternatives/approval |
| List actions by proposal + status | High | `@@index([tenantId, proposalId, status])` |
| List action updates by action + date | High | `@@index([actionId, at])` |
| Find open alerts linked to proposals | Medium | `@@index([tenantId, originatingAlertId])` |
| Cross-tenant count (admin only) | Low | N/A — admin uses BYPASSRLS |

### 12.2 Pagination

All list endpoints support `?cursor=&limit=` pagination (default limit 50, max 200). Mirrors G02's `listObservations` / `listVariance` pattern.

### 12.3 N+1 Prevention

- Service methods that return lists always support `?include=alternatives,actions,verifications` (optional, defaults to summary only).
- When `include` is specified, the service uses `tx.reformProposal.findMany({ include: { alternatives: true, actions: true } })` — single query, no N+1.

### 12.4 Expected Row Counts (Demolandia)

- 2 tenants × 5 reform proposals = 10 proposals
- 10 proposals × 2-3 alternatives = 20-30 alternatives
- 10 proposals × 1 approval = 10 approvals
- 10 proposals × 1-2 actions = 10-20 actions
- 20 actions × 3-5 updates = 60-100 action updates
- 20 actions × 1 verification = 20 verifications
- 20 actions × 1 feedback loop = 20 feedback loops

Total: ~190 rows across 7 tables — well within PostgreSQL's comfort zone. No performance concerns expected at this scale.

---

## 13. Migration Strategy

### 13.1 Single Bootstrap Migration (03-01)

```
prisma/migrations/20261018000022_g03_reform_bootstrap/
├── migration.sql    # CREATE TABLE + RLS + indexes + triggers
└── migration_lock.toml
```

Contents (high-level):
1. `CREATE TABLE reform_proposals (...)` — 7 tables
2. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on all 7
3. `CREATE POLICY ... FOR balance_app USING (...) WITH CHECK (...)` on all 7
4. `CREATE POLICY ... FOR balance_admin USING (true) WITH CHECK (true)` on all 7
5. `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL 7 TABLES TO balance_app`
6. `REVOKE UPDATE, DELETE ON reform_action_updates FROM balance_app` (append-only)
7. `REVOKE UPDATE, DELETE ON reform_approvals FROM balance_app` (immutable post-approval)
8. `REVOKE UPDATE, DELETE ON reform_feedback_loops FROM balance_app` (immutable)
9. `CREATE UNIQUE INDEX reform_alternatives_one_selected_per_proposal ON reform_alternatives (proposalId) WHERE status = 'selected'`
10. `CREATE TRIGGER enforce_reform_proposal_same_tenant ...` (cross-tenant prevention, same pattern as G01/G02)
11. `CREATE TRIGGER enforce_reform_action_same_tenant ...`
12. `CREATE TRIGGER enforce_reform_verification_f6 ...` (DB-level F6 enforcement: verifiedAction + evidenceSource required when verificationStatus = 'verified')
13. Update `src/lib/permissions.ts` with 9 new permissions

### 13.2 No Schema Changes in Service Missions

Missions 03-02 through 03-06 have **schema diff = 0**. They only add:
- `src/lib/reform/*.ts` service files
- `src/app/api/v1/reform/*/route.ts` API routes
- `tests/unit/reform/*.test.ts` + `tests/integration/g03-*.test.ts` test files
- `docs/mission-reports/G03/03-0X_*.md` mission reports

This honors invariant #9 — bootstrap first, then services.

### 13.3 Seed Extension (03-01)

`prisma/seed-ontology.ts` is extended (additive only) to create:
- 2-3 sample reform proposals per Demolandia tenant
- Each proposal has 2-3 alternatives
- One alternative per proposal is `selected`
- One proposal per tenant is `approved` (with evidence snapshot)
- One action per approved proposal is `in_progress` with 2-3 progress updates
- Idempotent re-run (check by `(tenantId, title)` before insert)

---

## 14. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| R-G3-01: LLM advisor produces causal claims | Medium | High (invariant violation) | Zod schema on advisor output rejects "causes"/"leads to" patterns; advisor prompt explicitly forbids causal language; reviewer must approve before storage |
| R-G3-02: Cross-tenant reform references | Low | High (data leak) | RLS + service-layer check (double enforcement); sentinel regression test |
| R-G3-03: ReformApproval not atomic with audit | Low | Critical (compliance violation) | Use `writeAuditTx` inside the same `withAuthenticatedTenant` transaction; sentinel regression test |
| R-G3-04: ReformActionUpdate mutated/deleted | Medium | High (history loss) | RLS blocks UPDATE/DELETE for `balance_app`; sentinel regression test |
| R-G3-05: F6 enforcement bypassed | Low | High (invariant violation) | DB trigger + Zod superRefine + sentinel regression test (triple enforcement) |
| R-G3-06: Cross-ministry reform coordination | High | Medium (functional gap) | Documented as open decision — G03 ships single-tenant only; cross-tenant coordination deferred to future mission |
| R-G3-07: G02-L25 (publication) blocks public reform visibility | High | Medium (functional gap) | Documented — G03 has no publication workflow in 03-00; future mission required |
| R-G3-08: StubProvider produces unrealistic reform drafts | Medium | Low (UX) | All advisor output carries `simulated: true`; analyst reviews/edits before saving |
| R-G3-09: Schema migration fails on existing DB | Low | High (deployment blocker) | Migration is additive (no breaking changes); tested in CI fresh-install + recovery drill |
| R-G3-10: Test count regression | Low | Medium (quality gate) | Each mission has explicit test count targets; CI fails if count drops |

---

## 15. Open Decisions Requiring Owner Approval

> Full detail in `G03_00_OPEN_DECISIONS.md`. Summary:

| # | Decision | Recommended option | Alternatives |
|---|----------|-------------------|--------------|
| D1 | Independent reform tables vs. reuse G01 Program/Project | **Independent tables** (clean separation) | Extend G01 tables (rejected — violates G01 immutability) |
| D2 | System-initiated "opportunity detection" (advisory only, no auto-create) | **Yes, advisory only** — analyst sees opportunities, drafts manually | No system suggestions (rejected — limits value) |
| D3 | Distinguishing problem detection vs. cause analysis | **Separate fields**: `problemStatement` (descriptive) + `hypothesizedCauses[]` (with confidence level) | Single field (rejected — conflates observation with hypothesis) |
| D4 | Relationship between ReformAction and G01 Program/Project | **Optional nullable FK** — ReformAction may link to Program/Project when relevant | Required FK (rejected — not all reforms fit existing programs) |
| D5 | Definition of "approved", "implemented", "verified" | **Three distinct states**: approval (human sign-off), in_progress→completed (implementation), verified (F6-pattern verification) | Conflate (rejected — loses audit trail granularity) |
| D6 | Cross-ministry reforms | **Deferred** — G03 ships single-tenant only; cross-tenant coordination requires future mission | Cross-tenant shared proposals (rejected for 03-00 — adds complexity) |
| D7 | Duplicate proposal prevention | **Soft check** — warn if `(tenantId, originatingAlertId)` already has an active proposal; allow override | Hard block (rejected — limits legitimate re-proposal after rejection) |
| D8 | Which G02 limitations to address now vs. defer | **Address**: none (defer all to keep 03-00 focused). **Defer**: G02-L22, L23, L24, L25, L26 to future missions | Address some in G03 (rejected — scope creep) |

---

## 16. Mission Roadmap (Summary)

> Full detail in `G03_00_MISSION_ROADMAP.md`. Summary:

| Mission | Title | Type | Schema diff | New tests | Dependencies |
|---------|-------|------|-------------|-----------|--------------|
| **03-00** | Architecture & Scope Foundation | Design | 0 (docs only) | 0 | None (this mission) |
| **03-01** | Schema Bootstrap | Schema | +1 migration, +7 tables, +9 permissions | ~25 | 03-00 approved |
| **03-02** | Reform Proposal + Alternative Services | Code | 0 | ~45 | 03-01 approved |
| **03-03** | Reform Comparison + Advisor Services | Code | 0 | ~35 | 03-02 approved |
| **03-04** | Reform Approval Workflow | Code | 0 | ~25 | 03-02, 03-03 approved |
| **03-05** | Reform Action + Update Tracking | Code | 0 | ~35 | 03-04 approved |
| **03-06** | Reform Verification + Feedback Loop | Code | 0 | ~25 | 03-05 approved |

**Total**: 7 missions (1 design + 1 schema + 5 service). Estimated ~190 new tests. Each mission ends with: code → tests → CI → recovery → reviewer approval → FINAL PASS.

---

## 17. References

### 17.1 Authoritative Documents Read

- `docs/handoffs/THE_BALANCE_GROUP_03_MASTER_HANDOFF_2026-10-18.md`
- `docs/mission-reports/G02/GROUP_03_READINESS_HANDOFF.md`
- `docs/mission-reports/G02/GROUP_02_KNOWN_LIMITATIONS.md`
- `docs/adr/ADR-0010-strategy-contracts-design.md`
- `docs/adr/ADR-0013-g01-domain-model.md`
- `docs/adr/ADR-0017-institutional-design.md`
- `docs/adr/ADR-0012-security-hardening-design.md`
- `prisma/schema.prisma` (994 lines — all 35+ models)
- `src/lib/permissions.ts` (RBAC catalog)
- `src/lib/audit.ts` (audit infrastructure)
- `src/lib/strategy-service.ts` (approval pattern reference)
- `src/lib/state-builder/approval-service.ts` (atomic approval + denied audit pattern)
- `src/lib/state-observatory/contracts.ts` (Zod + lifecycle enum pattern)
- `src/lib/state-observatory/index.ts` (barrel export pattern)
- `src/lib/security/tenant-context.ts` (RLS wrapper pattern)
- `src/lib/balance-master.ts` (durable task orchestrator)

### 17.2 Companion Documents in This Mission

1. `G03_00_DOMAIN_MODEL.md` — full table schemas, fields, indexes, RLS policies, triggers
2. `G03_00_WORKFLOW_AND_APPROVALS.md` — lifecycle transitions, state machines, approval workflow
3. `G03_00_INTEGRATION_CONTRACTS.md` — service signatures, Zod schemas, API contracts
4. `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` — RLS, audit, evidence snapshots, LLM boundaries
5. `G03_00_MISSION_ROADMAP.md` — 03-01 through 03-06 detailed mission specs
6. `G03_00_OPEN_DECISIONS.md` — D1-D8 with full rationale + trade-offs

### 17.3 Inherited Invariants (must not change)

- 14 architectural invariants from G00/G01/G02 (see §3.1)
- 9 new proposed G03 invariants (see §3.2) — become frozen only after owner approval

---

## 18. Conclusion

GROUP 03 — Targeted Reform — closes the strategic loop of THE BALANCE platform: from observing variance (G02) to acting on it (using G01's planning infrastructure) to verifying results (back to G02). The architecture proposed here is **additive** (no breaking changes to G00/G01/G02), **conservative** (human-sovereign, no causal claims, fail-closed publication), and **consistent** with the proven patterns of the existing groups.

The 7-mission roadmap (1 design + 1 schema + 5 service) delivers a complete reform pipeline with ~190 new tests, honoring all 14 inherited invariants and introducing 10 new G03-specific invariants for the same level of architectural rigor.

**The platform is ready. The foundation is solid. The human remains sovereign.**

---

*End of G03-00 Architecture Proposal. Awaiting owner + reviewer approval before proceeding to 03-01.*
