# G03-00 — Workflow & Approvals

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Workflow specification (DESIGN ONLY — no code)
> **Date:** 2026-10-18
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner + reviewer approval
> **Companion to:** `G03_00_ARCHITECTURE_PROPOSAL.md` §5

---

## 1. Overview

This document specifies the **lifecycle workflows** for GROUP 03 entities: how proposals are drafted, reviewed, approved, implemented, verified, and fed back to the observatory. Every transition is **human-initiated**, **permission-gated**, and **audit-logged**.

### 1.1 Design Principles

1. **Human-sovereign**: Every state transition requires an authenticated human actor with the appropriate permission. No automatic transitions.
2. **Permission-gated**: Each transition checks the current DB role (not stale JWT) via `requirePermissionWithCurrentRole`.
3. **Atomic with audit**: Every transition that changes state writes an atomic audit log entry (`writeAuditTx`) inside the same transaction.
4. **Evidence-preserving**: Approval captures evidence snapshots (immutable); progress updates use live evidence links (mutable context).
5. **Append-only history**: Action updates, approval records, and feedback loops cannot be mutated or deleted — history is sovereign.
6. **Separation of duties**: Drafting (analyst), approval (reviewer), verification (reviewer) are separated by permission, not just convention.

### 1.2 Actors and Roles

| Role | Drafts | Approves | Implements | Verifies | Comments |
|------|:------:|:-------:|:----------:|:--------:|:--------:|
| admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| reviewer | — | ✓ | — | ✓ | ✓ |
| analyst | ✓ | — | ✓ | — | ✓ |
| observer | — | — | — | — | — |

**Notes**:
- `admin` has all permissions (full control, still audited).
- `reviewer` can approve + verify but cannot draft (separation of duties).
- `analyst` can draft + implement but cannot approve or verify (separation of duties).
- `observer` is read-only on proposals + actions (no alternatives, no verifications — consistent with G01's `gap`/`program` exclusion for observers).

---

## 2. End-to-End Workflow

### 2.1 The Complete Reform Loop

```
Phase 1: DRAFTING (analyst)
─────────────────────────────
   [Alert OR VarianceRecord OR Human Initiative]
                     │
                     ▼
   createReformProposal()  ──→  ReformProposal (status: draft)
                     │
                     ▼
   addReformAlternative() (×N)  ──→  ReformAlternative[] (status: draft)
                     │
                     ▼
   submitForReview()  ──→  ReformProposal (status: under_review)
                                 + Event: reform.proposal_submitted
                                 + Audit: reform.proposal_submitted

Phase 2: REVIEW & APPROVAL (reviewer)
──────────────────────────────────────
                     │
                     ▼
   selectAlternative()  ──→  ReformAlternative (status: selected)
                     │                                (only one selected per proposal)
                     ▼
   approveReformProposal()  ──→  ReformApproval (created, immutable)
                     │           ReformProposal (status: approved)
                     │           + Event: reform.proposal_approved
                     │           + Audit: reform.proposal_approved (atomic with approval)
                     │           + Evidence snapshot captured
                     │
                     ├──[rejected]──→  ReformProposal (status: rejected)
                     │                   + Event: reform.proposal_rejected
                     │                   + Audit: reform.proposal_rejected
                     │
                     └──[needs revision]──→  ReformProposal (status: draft)
                                              + Event: reform.proposal_returned_to_draft

Phase 3: IMPLEMENTATION (analyst)
────────────────────────────────
                     │
                     ▼
   createReformAction()  ──→  ReformAction (status: planned)
                     │           + Event: reform.action_created
                     │
                     ▼
   startReformAction()  ──→  ReformAction (status: in_progress)
                     │           + Event: reform.action_started
                     │
                     ▼
   addReformActionUpdate() (×N)  ──→  ReformActionUpdate[] (append-only)
                     │                   updateType: progress|blocker|milestone|evidence|note
                     │
                     ├──[blocked]──→  ReformAction (status: blocked)
                     │                   + Event: reform.action_blocked
                     │
                     ├──[unblocked]──→  ReformAction (status: in_progress)
                     │
                     ├──[cancelled]──→  ReformAction (status: cancelled)
                     │                   + Event: reform.action_cancelled
                     │
                     └──[completed]──→  ReformAction (status: completed)
                                         + Event: reform.action_completed

Phase 4: VERIFICATION (reviewer)
────────────────────────────────
                     │
                     ▼
   verifyReformAction()  ──→  ReformVerification (verificationStatus: verified|disputed)
                     │           + Event: reform.action_verified / reform.action_disputed
                     │           + Audit: reform.action_verified (atomic)
                     │           + F6: verifiedAction + evidenceSource required for "verified"

Phase 5: FEEDBACK LOOP (analyst)
──────────────────────────────
                     │
                     ▼
   createReformFeedbackLoop()  ──→  ReformFeedbackLoop (immutable)
                     │                   comparisonType: before_after|parallel|none
                     │                   attributionLevel: "descriptive" (always)
                     │                   + Event: reform.feedback_created
                     │                   + New Observation created via ingestObservation (append-only)
                     │                   + Optional: new VarianceRecord via computeVariance (descriptive)

Phase 6: OBSERVATORY CLOSURE (reviewer)
──────────────────────────────────────
                     │
                     ▼
   closeOriginatingAlert()  ──→  Alert.lifecycleStage: closed
                     │           Alert.executionStatus: verified|disputed
                     │           (uses G02 verifyExecution + closeAlert contracts)
                     │
                     ▼
   [Loop complete — new observations feed future variance/alert cycles]
```

### 2.2 Parallel Paths and Exceptions

The workflow is **not strictly linear**. Common variations:

#### 2.2.1 Multiple Alternatives, One Selected

A proposal can have 2-5 alternatives. Only ONE can be `selected` (partial unique index). Selecting one does NOT automatically withdraw others — the analyst may explicitly withdraw them or leave them as `draft` for historical comparison.

#### 2.2.2 Proposal Rejection and Re-submission

If a reviewer rejects a proposal:
- Status: `under_review → rejected`
- The proposal stays in history (audit trail)
- A new proposal can be created from the same originating alert (no prevention)
- The new proposal's `metadata.previousProposalId` may reference the rejected one (optional)

#### 2.2.3 Proposal Supersession (after approval)

If an approved proposal is later found insufficient:
- A new proposal is created with the same originating alert
- The old proposal's status moves to `superseded` (via `supersedeReformProposal()`)
- The old proposal's `supersededById` points to the new one
- The old approval stays immutable — a new approval is created for the new proposal

#### 2.2.4 Action Blocked and Resumed

An action can be blocked (e.g., funding delayed):
- `in_progress → blocked` (with a `blocker` action update)
- `blocked → in_progress` (with a `note` action update explaining unblock)
- The action stays in `blocked` state until manually resumed — no auto-resume

#### 2.2.5 Action Cancellation

An action can be cancelled (e.g., political decision):
- `planned → cancelled` or `in_progress → cancelled`
- `cancelledBy` + `cancellationReason` required
- The originating alert is NOT automatically closed — the reviewer decides separately

#### 2.2.6 Disputed Verification

If a reviewer disputes the verification:
- `ReformVerification.verificationStatus = "disputed"`
- `disputeReason` + `disputeEvidenceSource` required
- The action's status stays `completed` (verification is independent from lifecycle)
- The originating alert's `executionStatus = "disputed"`
- A new action may be created to address the dispute

---

## 3. State Machines (Detailed)

### 3.1 ReformProposal State Machine

```
                  createReformProposal()
                          │
                          ▼
                    ┌─────────┐
                    │  draft  │
                    └────┬────┘
                         │ submitForReview()
                         │   (analyst, reform:proposal:write)
                         │   → audit: reform.proposal_submitted
                         ▼
                 ┌─────────────────┐
                 │  under_review   │
                 └────┬───────┬────┘
                      │       │
            approve() │       │ reject()
       (reviewer,     │       │ (reviewer,
   reform:proposal:   │       │  reform:proposal:approve)
        approve)      │       │  → audit: reform.proposal_rejected
         → audit:     │       │
  reform.proposal_    │       │
       approved       │       │
                      ▼       ▼
              ┌─────────┐  ┌──────────┐
              │ approved│  │ rejected │
              └────┬────┘  └──────────┘
                   │
       supersede() │ (auto when new proposal approved for same alert)
                   │   (reviewer, reform:proposal:approve)
                   │   → audit: reform.proposal_superseded
                   ▼
              ┌────────────┐
              │ superseded │
              └────────────┘

    [Any state] ──[archive]──→ archivedAt set (soft delete, audit preserved)
```

**Transition rules** (enforced by service layer + DB constraints):

| From | To | Triggered by | Permission | Audit action |
|------|----|----|------|------|
| (none) | draft | `createReformProposal()` | `reform:proposal:write` | `reform.proposal_created` |
| draft | under_review | `submitForReview()` | `reform:proposal:write` | `reform.proposal_submitted` |
| under_review | approved | `approveReformProposal()` | `reform:proposal:approve` | `reform.proposal_approved` |
| under_review | rejected | `rejectReformProposal()` | `reform:proposal:approve` | `reform.proposal_rejected` |
| under_review | draft | `returnForRevision()` | `reform:proposal:approve` | `reform.proposal_returned_to_draft` |
| approved | superseded | `supersedeReformProposal()` (auto on new approval for same alert) | `reform:proposal:approve` | `reform.proposal_superseded` |

**Forbidden transitions** (rejected by service + DB):
- `approved → draft` (cannot un-approve — create a new version or supersede)
- `rejected → under_review` (cannot re-review a rejection — create a new proposal)
- `superseded → any` (terminal state)

### 3.2 ReformAlternative State Machine

```
            addReformAlternative()
                     │
                     ▼
              ┌─────────┐
              │  draft  │
              └────┬────┘
                   │
       selectAlternative() ─── (only ONE selected per proposal, partial unique index)
        (reviewer, reform:proposal:approve)
                   │
                   ▼
              ┌─────────┐
              │ selected│
              └─────────┘

       withdrawAlternative() ──→ withdrawn
        (analyst or reviewer)
```

**Transition rules**:

| From | To | Triggered by | Permission |
|------|----|----|------|
| (none) | draft | `addReformAlternative()` | `reform:alternative:write` |
| draft | selected | `selectAlternative()` | `reform:proposal:approve` |
| draft | withdrawn | `withdrawAlternative()` | `reform:alternative:write` or `reform:proposal:approve` |
| selected | withdrawn | `withdrawAlternative()` | `reform:proposal:approve` (only reviewer can withdraw a selected alternative) |

**Critical**: Once an alternative is `selected` AND the proposal is `approved`, the alternative's status cannot change (it's part of the immutable approval record).

### 3.3 ReformAction State Machine

```
         createReformAction()
                 │
                 ▼
          ┌──────────┐
          │ planned  │
          └────┬─────┘
               │ startReformAction()
               │   (analyst, reform:action:write)
               │   → audit: reform.action_started
               ▼
       ┌──────────────┐
       │ in_progress  │◄────────┐
       └──────┬───────┘         │
              │                 │ unblockReformAction()
              │                 │   (analyst, reform:action:write)
              │                 │
              ├──[blocked]──→ blocked
              │   (analyst, reform:action:write)
              │   → audit: reform.action_blocked
              │
              ├──[cancelled]──→ cancelled (terminal)
              │   (reviewer, reform:action:write)
              │   → audit: reform.action_cancelled
              │
              └──[completed]──→ completed (terminal for lifecycle, not for verification)
                  (analyst, reform:action:write)
                  → audit: reform.action_completed
```

**Transition rules**:

| From | To | Triggered by | Permission | Audit action |
|------|----|----|------|------|
| (none) | planned | `createReformAction()` | `reform:action:write` | `reform.action_created` |
| planned | in_progress | `startReformAction()` | `reform:action:write` | `reform.action_started` |
| in_progress | blocked | `blockReformAction()` | `reform:action:write` | `reform.action_blocked` |
| blocked | in_progress | `unblockReformAction()` | `reform:action:write` | `reform.action_unblocked` |
| planned/in_progress | cancelled | `cancelReformAction()` | `reform:action:write` (with cancellation reason) | `reform.action_cancelled` |
| in_progress | completed | `completeReformAction()` | `reform:action:write` | `reform.action_completed` |

**Forbidden transitions**:
- `completed → any` (terminal — a completed action cannot be re-opened; create a new action if needed)
- `cancelled → any` (terminal)
- `planned → completed` (must pass through `in_progress` first)

### 3.4 ReformVerification State Machine

```
       createReformVerification()
                 │
                 ▼
          ┌──────────┐
          │ pending  │
          └────┬─────┘
               │
               ├──[verified]──→ verified (F6 required: verifiedAction + evidenceSource)
               │   (reviewer, reform:action:verify)
               │   → audit: reform.action_verified
               │
               └──[disputed]──→ disputed (required: disputeReason + disputeEvidenceSource)
                   (reviewer, reform:action:verify)
                   → audit: reform.action_disputed

       [verified ↔ disputed] allowed (re-verification after dispute resolution)
```

**Transition rules**:

| From | To | Triggered by | Permission | Required fields | Audit action |
|------|----|----|------|------|------|
| (none) | pending | `createReformVerification()` | `reform:action:verify` | (none) | `reform.verification_created` |
| pending | verified | `verifyReformAction(status="verified")` | `reform:action:verify` | `verifiedAction`, `evidenceSource` (F6) | `reform.action_verified` |
| pending | disputed | `verifyReformAction(status="disputed")` | `reform:action:verify` | `disputeReason`, `disputeEvidenceSource` | `reform.action_disputed` |
| disputed | verified | `verifyReformAction(status="verified")` | `reform:action:verify` | `verifiedAction`, `evidenceSource` (F6) | `reform.action_verified` |
| verified | disputed | `verifyReformAction(status="disputed")` | `reform:action:verify` | `disputeReason`, `disputeEvidenceSource` | `reform.action_disputed` |

**Critical**: The F6 enforcement is triple-layered:
1. **Zod schema** (`VerifyReformActionInputSchema.superRefine`) — rejects at API boundary
2. **DB trigger** (`enforce_reform_verification_f6`) — rejects at DB level
3. **Service layer** — explicit check before UPDATE

### 3.5 ReformActionUpdate (Append-Only — No State Machine)

`ReformActionUpdate` has no lifecycle — it is append-only. The only allowed operations are:
- `INSERT` (create a new update)
- `SELECT` (read updates)

`UPDATE` and `DELETE` are blocked by RLS for `balance_app` (see `G03_00_DOMAIN_MODEL.md` §3.2).

### 3.6 ReformApproval and ReformFeedbackLoop (Immutable — No State Machine)

Both are one-shot, immutable records. They are created in a single atomic operation and never updated or deleted. To "change" an approval, create a new proposal that supersedes the old one.

---

## 4. Approval Workflow (Detailed)

### 4.1 The Approval Operation

The approval is the most security-critical operation in G03. It must be:
- **Atomic**: The proposal status change, the ReformApproval record creation, the evidence snapshot capture, the domain event, and the audit log entry must ALL succeed or ALL fail in a single transaction.
- **Permission-gated**: Only `reviewer` and `admin` can approve (via `reform:proposal:approve`).
- **Evidence-snapshotting**: The approval record captures the evidence state at approval time (immutable).
- **Denied-attempt auditable**: If a user without permission attempts approval, the denial is audited (best-effort, outside the failed transaction).

### 4.2 Approval Sequence (Service-Level)

```typescript
export async function approveReformProposal(
  session: Session,
  proposalId: string,
  alternativeId: string,
  input: ApproveReformProposalInput
): Promise<{ approvalId: string; proposalStatus: string }> {
  // 1. Validate input via Zod
  const validated = ApproveReformProposalInputSchema.parse(input);

  // 2. Wrap in authenticated tenant context
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId, roleCode }) => {
    // 3. Check permission against CURRENT DB role
    await requirePermissionWithCurrentRole(session, "reform:proposal:approve");

    // 4. Verify proposal exists in tenant scope + is in under_review state
    const proposal = await tx.reformProposal.findFirst({
      where: { id: proposalId, tenantId },
      include: { alternatives: true },
    });
    if (!proposal) throw new NotFoundError("Reform proposal not found in tenant scope");
    if (proposal.status !== "under_review") {
      throw new ConflictError(`Cannot approve proposal with status: ${proposal.status}`);
    }

    // 5. Verify the selected alternative belongs to this proposal + tenant
    const alternative = await tx.reformAlternative.findFirst({
      where: { id: alternativeId, proposalId, tenantId },
    });
    if (!alternative) throw new NotFoundError("Reform alternative not found in tenant scope");

    // 6. Mark the alternative as selected (partial unique index ensures only one)
    await tx.reformAlternative.update({
      where: { id: alternativeId },
      data: { status: "selected", selectedAt: new Date(), selectedBy: userId },
    });

    // 7. Capture evidence snapshot (same pattern as G00 Decision)
    const supportingSnapshots = await captureEvidenceSnapshots(
      tx, tenantId, validated.supportingEvidenceIds ?? []
    );
    const counterSnapshots = await captureEvidenceSnapshots(
      tx, tenantId, validated.counterEvidenceIds ?? []
    );

    // 8. Create the immutable ReformApproval record
    const approval = await tx.reformApproval.create({
      data: {
        tenantId,
        proposalId,
        alternativeId,
        approvedBy: userId,
        approvalNotes: validated.approvalNotes,
        supportingEvidence: supportingSnapshots,
        counterEvidence: counterSnapshots,
        rationale: validated.rationale,
      },
    });

    // 9. Update proposal status to approved
    await tx.reformProposal.update({
      where: { id: proposalId },
      data: {
        status: "approved",
        approvedAt: new Date(),
      },
    });

    // 10. Supersede any previously approved proposal for the same originating alert
    if (proposal.originatingAlertId) {
      await tx.reformProposal.updateMany({
        where: {
          tenantId,
          originatingAlertId: proposal.originatingAlertId,
          status: "approved",
          id: { not: proposalId },
        },
        data: {
          status: "superseded",
          supersededAt: new Date(),
          supersededById: proposalId,
        },
      });
    }

    // 11. Record domain event (append-only)
    await tx.event.create({
      data: {
        tenantId,
        eventType: "reform.proposal_approved",
        actor: userId,
        entityType: "reform_proposal",
        entityId: proposalId,
        metadata: {
          proposalId, alternativeId, approvalId: approval.id,
          rationale: validated.rationale.slice(0, 200),
        },
      },
    });

    // 12. ATOMIC audit log (compliance-grade — throws on failure, rolls back the whole tx)
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.proposal_approved",
      status: "ok",
      details: {
        proposalId, alternativeId, approvalId: approval.id,
        approvedBy: userId,
        rationale: validated.rationale.slice(0, 200),
      },
    });

    return { approvalId: approval.id, proposalStatus: "approved" };
  });
}
```

### 4.3 Denied-Attempt Audit (Wrapper)

Mirrors G01's `approveStrategyVersionWithAuditSafe` pattern:

```typescript
export async function approveReformProposalWithAuditSafe(
  session: Session,
  proposalId: string,
  alternativeId: string,
  input: ApproveReformProposalInput
): Promise<{ approvalId: string; proposalStatus: string }> {
  try {
    return await approveReformProposal(session, proposalId, alternativeId, input);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      // Denied attempt — primary transaction rolled back.
      // Write a best-effort denied audit entry.
      try {
        try {
          await withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
            await writeAuditTx(tx, {
              tenantId, actor: userId,
              action: "reform.proposal_approved",
              status: "denied",
              errorCode: "PERMISSION_DENIED",
              details: { proposalId, alternativeId, permission: err.permission },
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
            details: { proposalId, alternativeId, permission: err.permission },
          });
        }
      } catch {
        // Both audit paths failed. The denial is still enforced.
        // Re-throw the original PermissionDeniedError below.
      }
    }
    throw err; // Always re-throw the original error
  }
}
```

### 4.4 Evidence Snapshot Helper

```typescript
async function captureEvidenceSnapshots(
  tx: Prisma.TransactionClient,
  tenantId: string,
  evidenceIds: string[]
): Promise<EvidenceSnapshot[]> {
  if (evidenceIds.length === 0) return [];

  // Verify ALL requested IDs exist in tenant scope (no partial snapshots)
  const evidence = await tx.evidence.findMany({
    where: { id: { in: evidenceIds }, tenantId },
    include: { source: { select: { code: true } } },
  });

  if (evidence.length !== evidenceIds.length) {
    const found = new Set(evidence.map(e => e.id));
    const missing = evidenceIds.filter(id => !found.has(id));
    throw new Error(
      `Evidence completeness violation: ${missing.length} of ${evidenceIds.length} ` +
      `evidence IDs not found in tenant scope. Missing: ${missing.join(", ")}. ` +
      "Approval rejected — no partial snapshots allowed."
    );
  }

  return evidence.map(e => ({
    evidenceId: e.id,
    claim: e.claim,
    type: e.type,
    verificationStatus: e.verificationStatus,
    sourceCode: e.source?.code ?? null,
  }));
}
```

This helper mirrors G00's `createDecision` evidence completeness check (ADR-0010 §"Evidence snapshot at decision time").

---

## 5. Verification Workflow (F6 Pattern)

### 5.1 The Verification Operation

Verification follows the F6 pattern from G02 Alert: the verifier describes the **specific action verified** (not a policy outcome) and provides **evidence for that action**.

### 5.2 Verification Sequence

```typescript
export async function verifyReformAction(
  session: Session,
  actionId: string,
  input: VerifyReformActionInput
): Promise<{ verificationId: string; verificationStatus: string }> {
  // 1. Validate input via Zod (includes F6 superRefine)
  const validated = VerifyReformActionInputSchema.parse(input);

  // 2. Wrap in authenticated tenant context
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // 3. Check permission (reviewer + admin only)
    await requirePermissionWithCurrentRole(session, "reform:action:verify");

    // 4. Verify action exists in tenant scope + is completed
    const action = await tx.reformAction.findFirst({
      where: { id: actionId, tenantId },
    });
    if (!action) throw new NotFoundError("Reform action not found in tenant scope");
    if (action.status !== "completed") {
      throw new ConflictError(
        `Cannot verify action with status: ${action.status}. Action must be completed first.`
      );
    }

    // 5. Upsert verification (one per action — unique constraint)
    const verification = await tx.reformVerification.upsert({
      where: { tenantId_actionId: { tenantId, actionId } },
      create: {
        tenantId, actionId,
        verificationStatus: validated.verificationStatus,
        verifiedAction: validated.verifiedAction,
        evidenceSource: validated.evidenceSource,
        disputeReason: validated.disputeReason,
        disputeEvidenceSource: validated.disputeEvidenceSource,
        verifiedBy: userId,
        verifiedAt: new Date(),
        notes: validated.notes,
      },
      update: {
        verificationStatus: validated.verificationStatus,
        verifiedAction: validated.verifiedAction,
        evidenceSource: validated.evidenceSource,
        disputeReason: validated.disputeReason,
        disputeEvidenceSource: validated.disputeEvidenceSource,
        verifiedBy: userId,
        verifiedAt: new Date(),
        notes: validated.notes,
      },
    });

    // 6. Record domain event
    const eventType = validated.verificationStatus === "verified"
      ? "reform.action_verified" : "reform.action_disputed";
    await tx.event.create({
      data: {
        tenantId,
        eventType,
        actor: userId,
        entityType: "reform_action",
        entityId: actionId,
        metadata: {
          actionId, verificationId: verification.id,
          verificationStatus: validated.verificationStatus,
        },
      },
    });

    // 7. ATOMIC audit log
    await writeAuditTx(tx, {
      tenantId, actor: userId,
      action: eventType,
      status: "ok",
      details: {
        actionId, verificationId: verification.id,
        verificationStatus: validated.verificationStatus,
        verifiedAction: validated.verifiedAction?.slice(0, 200),
      },
    });

    return { verificationId: verification.id, verificationStatus: verification.verificationStatus };
  });
}
```

### 5.3 F6 Triple Enforcement

The F6 invariant (verifiedAction + evidenceSource required for "verified" status) is enforced at three layers:

1. **Zod schema** (`VerifyReformActionInputSchema.superRefine`):
   - Rejects `verifiedAction` shorter than 5 chars
   - Rejects `evidenceSource` shorter than 5 chars
   - Rejects policy-outcome language (regex patterns)

2. **DB trigger** (`enforce_reform_verification_f6`):
   - Rejects INSERT/UPDATE when `verificationStatus = "verified"` but `verifiedAction` or `evidenceSource` is null/empty
   - Rejects INSERT/UPDATE when `verificationStatus = "disputed"` but `disputeReason` or `disputeEvidenceSource` is null/empty

3. **Service layer** (explicit check in `verifyReformAction`):
   - The Zod schema already enforces this, but the service layer also documents the requirement in error messages

**Sentinel regression test** verifies that all three layers reject F6 violations:
- `tests/integration/g03-04-f6-enforcement.integration.test.ts` (planned for 03-04)

---

## 6. Feedback Loop Workflow

### 6.1 Purpose

The feedback loop closes the cycle: it links the reform execution back to the observatory by:
1. Referencing the "before" observation (the one that triggered the originating alert)
2. Creating a NEW "after" observation (via G02 `ingestObservation` — append-only, never mutates the "before")
3. Optionally computing a NEW VarianceRecord (via G02 `computeVariance` — descriptive comparison)
4. Writing a **descriptive** summary of what was observed (human-written, never causal)

### 6.2 Feedback Loop Sequence

```typescript
export async function createReformFeedbackLoop(
  session: Session,
  actionId: string,
  input: CreateReformFeedbackLoopInput
): Promise<{ feedbackLoopId: string }> {
  const validated = CreateReformFeedbackLoopInputSchema.parse(input);

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    await requirePermissionWithCurrentRole(session, "reform:action:write");

    // 1. Verify action exists + is verified
    const action = await tx.reformAction.findFirst({
      where: { id: actionId, tenantId },
      include: { verification: true, proposal: { include: { originatingAlert: true } } },
    });
    if (!action) throw new NotFoundError("Reform action not found");
    if (!action.verification || action.verification.verificationStatus !== "verified") {
      throw new ConflictError("Cannot create feedback loop for unverified action");
    }

    // 2. Determine the "before" observation (from the originating alert's variance record)
    let beforeObservationId: string | null = null;
    if (action.proposal.originatingAlert?.varianceRecordId) {
      const variance = await tx.varianceRecord.findFirst({
        where: {
          id: action.proposal.originatingAlert.varianceRecordId,
          tenantId,
        },
        select: { observationId: true },
      });
      beforeObservationId = variance?.observationId ?? null;
    }

    // 3. Create the "after" observation (via G02 contract — append-only)
    let afterObservationId: string | null = null;
    if (validated.afterObservationInput) {
      const result = await ingestObservation(session, validated.afterObservationInput);
      afterObservationId = result.observationId;
    }

    // 4. Optionally compute a new VarianceRecord (descriptive comparison)
    let newVarianceRecordId: string | null = null;
    if (validated.computeNewVariance && afterObservationId) {
      const varianceResult = await computeVariance(session, {
        observationId: afterObservationId,
      });
      newVarianceRecordId = varianceResult.varianceRecordId;
    }

    // 5. Create the feedback loop record (immutable — RLS blocks UPDATE/DELETE)
    const feedbackLoop = await tx.reformFeedbackLoop.create({
      data: {
        tenantId, actionId,
        beforeObservationId,
        afterObservationId,
        newVarianceRecordId,
        comparisonType: validated.comparisonType,
        descriptiveSummary: validated.descriptiveSummary,
        attributionLevel: "descriptive", // hardcoded — trigger blocks any other value
        createdBy: userId,
      },
    });

    // 6. Record domain event
    await tx.event.create({
      data: {
        tenantId,
        eventType: "reform.feedback_created",
        actor: userId,
        entityType: "reform_action",
        entityId: actionId,
        metadata: {
          feedbackLoopId: feedbackLoop.id,
          comparisonType: validated.comparisonType,
          beforeObservationId, afterObservationId, newVarianceRecordId,
        },
      },
    });

    // 7. ATOMIC audit log
    await writeAuditTx(tx, {
      tenantId, actor: userId,
      action: "reform.feedback_created",
      status: "ok",
      details: {
        actionId, feedbackLoopId: feedbackLoop.id,
        comparisonType: validated.comparisonType,
      },
    });

    return { feedbackLoopId: feedbackLoop.id };
  });
}
```

### 6.3 Critical Constraints

1. **`attributionLevel = "descriptive"` is hardcoded**: The DB trigger `enforce_reform_feedback_attribution_descriptive` rejects any other value. This is invariant #1 enforced at DB level.

2. **`descriptiveSummary` is human-written**: No LLM generation. The analyst writes what was observed, not what was "caused."

3. **`beforeObservationId` is read-only**: G03 never mutates the "before" observation. It only references it.

4. **`afterObservationId` is created via `ingestObservation`**: This honors invariant #3 — observations are append-only. The "after" observation is a NEW row, not a mutation of the "before."

5. **`newVarianceRecordId` is computed via `computeVariance`**: This is descriptive comparison — it shows whether the variance changed, NOT whether the reform *caused* the change.

---

## 7. Alert Closure Workflow (Integration with G02)

### 7.1 Closing the Originating Alert

After a reform is verified (and optionally a feedback loop is created), the originating alert should be closed. This uses G02's existing contracts:

```typescript
export async function closeOriginatingAlert(
  session: Session,
  proposalId: string
): Promise<{ alertClosed: boolean }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    await requirePermissionWithCurrentRole(session, "observatory:alert:act");

    const proposal = await tx.reformProposal.findFirst({
      where: { id: proposalId, tenantId },
      include: { actions: { include: { verification: true, feedbackLoop: true } } },
    });
    if (!proposal) throw new NotFoundError("Reform proposal not found");
    if (proposal.status !== "approved") {
      throw new ConflictError("Cannot close alert for non-approved proposal");
    }

    if (!proposal.originatingAlertId) {
      return { alertClosed: false }; // No originating alert to close
    }

    // Verify all actions are verified
    const allVerified = proposal.actions.every(
      a => a.verification?.verificationStatus === "verified"
    );
    if (!allVerified) {
      throw new ConflictError(
        "Cannot close alert — not all reform actions are verified"
      );
    }

    // Use G02's verifyExecution + closeAlert contracts (NOT direct table writes)
    if (proposal.actions.length > 0) {
      const firstAction = proposal.actions[0];
      await verifyExecution(session, proposal.originatingAlertId, {
        verifiedAction: `Reform action "${firstAction.title}" verified`,
        evidenceSource: `Reform verification record: ${firstAction.verification?.id}`,
        notes: "Closed via reform feedback loop",
      });
    }

    await closeAlert(session, proposal.originatingAlertId, {
      closureReason: `Reform proposal ${proposalId} approved and verified`,
    });

    return { alertClosed: true };
  });
}
```

### 7.2 Key Constraint

This workflow uses **G02's exported service contracts** (`verifyExecution`, `closeAlert`) — it never directly writes to the `alerts` table. This honors invariant #11 — `src/lib/state-observatory/` diff = 0.

---

## 8. Concurrent Operations and Race Conditions

### 8.1 Concurrent Approval Attempts

If two reviewers try to approve the same proposal simultaneously:
- The first transaction commits, setting `status = "approved"`
- The second transaction sees `status !== "under_review"` and throws `ConflictError`
- No partial state — the unique constraint on `reform_approvals(tenantId, proposalId)` ensures only one approval record exists

### 8.2 Concurrent Alternative Selection

If two reviewers try to select different alternatives simultaneously:
- The partial unique index `reform_alternatives_one_selected_per_proposal` ensures only one alternative has `status = "selected"` per proposal
- The first transaction commits; the second transaction fails with a unique constraint violation
- The service layer catches this and throws `ConflictError`

### 8.3 Concurrent Action Updates

Multiple users can add action updates simultaneously — `reform_action_updates` is append-only with no conflicts. The denormalized `ReformAction.progressPercentage` is updated by the service layer (not directly by users), and PostgreSQL's row-level locking handles concurrent updates safely.

### 8.4 Concurrent Verification Attempts

The unique constraint `@@unique([tenantId, actionId])` on `reform_verifications` ensures only one verification record per action. The `upsert` operation handles concurrent attempts safely (the first one creates, the second one updates if it arrives after).

---

## 9. Audit Trail Summary

### 9.1 Three-Layer Audit Pattern

Every state transition writes to three layers (mirrors G01's `approveStrategyVersionWithAuditSafe` per ADR-0010 §13 Correction B):

| Layer | Table | Purpose | Atomicity |
|-------|-------|---------|------------|
| 1. Authorization | (in-memory check) | `requirePermissionWithCurrentRole` enforces RBAC | Throws `PermissionDeniedError` on failure |
| 2. Domain Event | `events` (G00) | Generic domain timeline | Atomic with primary operation (same transaction) |
| 3. Audit Log | `audit_log` (G00) | Sovereign audit trail, compliance-grade | Atomic via `writeAuditTx` (same transaction) |

### 9.2 Audit Actions Catalog

| Action verb | Triggered by | Status |
|-------------|---------------|--------|
| `reform.proposal_created` | `createReformProposal()` | ok |
| `reform.proposal_submitted` | `submitForReview()` | ok |
| `reform.proposal_approved` | `approveReformProposal()` | ok / denied (on permission failure) |
| `reform.proposal_rejected` | `rejectReformProposal()` | ok |
| `reform.proposal_returned_to_draft` | `returnForRevision()` | ok |
| `reform.proposal_superseded` | `supersedeReformProposal()` | ok |
| `reform.alternative_added` | `addReformAlternative()` | ok |
| `reform.alternative_selected` | `selectAlternative()` | ok |
| `reform.alternative_withdrawn` | `withdrawAlternative()` | ok |
| `reform.action_created` | `createReformAction()` | ok |
| `reform.action_started` | `startReformAction()` | ok |
| `reform.action_blocked` | `blockReformAction()` | ok |
| `reform.action_unblocked` | `unblockReformAction()` | ok |
| `reform.action_completed` | `completeReformAction()` | ok |
| `reform.action_cancelled` | `cancelReformAction()` | ok |
| `reform.action_update_added` | `addReformActionUpdate()` | ok |
| `reform.verification_created` | `createReformVerification()` | ok |
| `reform.action_verified` | `verifyReformAction(status="verified")` | ok |
| `reform.action_disputed` | `verifyReformAction(status="disputed")` | ok |
| `reform.feedback_created` | `createReformFeedbackLoop()` | ok |

### 9.3 Denied-Attempt Auditing

Denied permission attempts are audited via the wrapper pattern (see §4.3). The denied audit entry has:
- `action`: same as the attempted action (e.g., `reform.proposal_approved`)
- `status`: `"denied"`
- `errorCode`: `"PERMISSION_DENIED"`
- `details.permission`: the missing permission string

---

## 10. Workflow Validation Checklist

| Requirement | How verified |
|-------------|--------------|
| Every transition requires an authenticated human | Service layer checks `session.user` + `withAuthenticatedTenant` |
| Every transition checks CURRENT DB role | `requirePermissionWithCurrentRole` (not stale JWT) |
| Every transition writes atomic audit log | `writeAuditTx` inside `withAuthenticatedTenant` transaction |
| Denied attempts are audited | Wrapper pattern (`*WithAuditSafe`) |
| Evidence snapshots are immutable post-approval | RLS blocks UPDATE/DELETE on `reform_approvals` for `balance_app` |
| Action updates are append-only | RLS blocks UPDATE/DELETE on `reform_action_updates` for `balance_app` |
| F6 is enforced (verifiedAction + evidenceSource) | Zod + DB trigger + service layer (triple enforcement) |
| Attribution level is always "descriptive" | DB trigger on `reform_feedback_loops` + Zod hardcoded literal |
| Cross-tenant references are blocked | RLS + DB triggers (`enforce_*_same_tenant`) |
| Supersession is atomic | Single transaction: update old proposal + create new approval |
| Concurrent approval attempts are safe | Unique constraint on `reform_approvals(tenantId, proposalId)` |
| Only one selected alternative per proposal | Partial unique index |

---

*End of G03-00 Workflow & Approvals. Companion documents: DOMAIN_MODEL.md, INTEGRATION_CONTRACTS.md, SECURITY_AND_EVIDENCE_POLICY.md.*
