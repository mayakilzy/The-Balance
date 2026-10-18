# G03-00 — Workflow & Approvals (REV 5 — Final)

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Workflow specification (DESIGN ONLY — no code)
> **Date:** 2026-10-18 (revision 5 — final, post blocker closure)
> **Author:** GLM (implementation agent)
> **Status:** REV 5 — all blockers (B1-B4) closed; awaiting owner FINAL PASS
> **Companion to:** `G03_00_BLOCKER_CLOSURE_REV5.md` (authoritative for B1-B4)

> ✅ **REV 5 STATUS**: This document is fully consistent with REV 5.
> All REV 1-4 workflow contracts have been superseded.
> For B1/B2/B3/B4 closure details, see `G03_00_BLOCKER_CLOSURE_REV5.md`.
> For full state machine details, see `G03_00_DOMAIN_MODEL.md` §1.3 (enums).

---

## 1. Design Principles (REV 5)

1. **Human-sovereign**: Every state transition requires an authenticated human actor with the appropriate permission. No automatic transitions.
2. **Permission-gated**: Each transition checks the current DB role (not stale JWT) via `requirePermissionWithCurrentRole`.
3. **Atomic with audit**: Every transition that changes state writes an atomic audit log entry (`writeAuditTx`) inside the same transaction.
4. **Evidence-preserving**: Approval captures evidence snapshots (immutable); progress updates use live evidence links (mutable context).
5. **Append-only history**: Action updates, approval records, and feedback loops cannot be mutated or deleted — history is sovereign.
6. **Separation of duties**: Drafting (analyst), approval (reviewer), verification (reviewer) are separated by permission, not just convention.

---

## 2. The Four Distinct Lifecycle States (D5 — Owner Directive)

Per owner directive: "افصل دائماً: Human approval. Implementation completion. Execution verification. Descriptive outcome measurement."

| State | Entity | Field | What it certifies |
|-------|--------|-------|-------------------|
| 1. **Human approval** | `ReformApproval` | (created) | A reviewer has authorized the reform |
| 2. **Implementation completion** | `ReformAction` | `status = completed` | The action has been executed (work done) |
| 3. **Execution verification** | `ReformVerification` | `verificationStatus = verified` | A reviewer has verified the specific action was executed (F6 pattern) |
| 4. **Descriptive outcome measurement** | `ReformFeedbackLoop` | (created) | A new observation has been taken post-reform, and a descriptive comparison is recorded |

### 2.1 Critical Separation: Verification vs. Measurement

- **Verification (state 3)** is about the **action**: was the memo issued? was the infrastructure completed? was the regulation published? This is F6 — `verifiedAction` + `evidenceSource` required.
- **Measurement (state 4)** is about the **outcome**: did the indicator change after the reform? This is **descriptive only** — `attributionLevel = "descriptive"`. The system never claims the reform *caused* the change.

### 2.2 Why This Separation Matters

A reform can be:
- **Approved + Implemented + Verified + Measured**: full lifecycle.
- **Approved + Implemented + Verified + NOT Measured**: the action was verified, but no post-reform observation has been taken yet.
- **Approved + Implemented + NOT Verified + Measured**: the action was completed but not verified (process gap), yet observations continued.
- **Approved + NOT Implemented**: the reform was approved but never executed.
- **Approved + Implemented + Verified + Measured + Disputed**: the verification was disputed.

The four states are **independent**. The system tracks each separately, and the audit trail preserves the full history.

---

## 3. End-to-End Reform Workflow (Single-Tenant)

```
[Signal: Alert/VarianceRecord]  OR  [Human Initiative]
                    │
                    ▼
        ┌──────────────────────┐
        │ ReformProposal       │  (status: draft)
        │ problemStatement     │  (descriptive, no causal claims)
        │ hypothesizedCauses[] │  (D3 — with confidenceBasis, 
        │                      │   contradictingEvidenceIds, reviewStatus)
        └──────────┬───────────┘
                   │ analyst adds alternatives
                   ▼
        ┌──────────────────────┐
        │ ReformAlternative[]  │  (status: draft)
        │ costRange (min/max)  │  (no fake precision)
        │ riskLevel             │
        │ anticipatedOutcomes[] │  (attributionLevel="descriptive" hardcoded)
        └──────────┬───────────┘
                   │ reviewer selects ONE alternative
                   ▼
        ┌──────────────────────┐
        │ ReformProposal       │  (status: under_review)
        └──────────┬───────────┘
                   │ reviewer approves (atomic + audit + evidence snapshot)
                   ▼
        ┌──────────────────────┐  STATE 1: Human approval
        │ ReformApproval       │  (immutable, evidence snapshot captured)
        │ supportingEvidence[] │  (snapshots at approval time)
        │ counterEvidence[]    │
        │ rationale (required) │
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ ReformAction         │  (status: planned)
        │ programId? (D4)      │  (optional, must match strategy context)
        │ projectId? (D4)      │  (cross-strategy links forbidden by default)
        └──────────┬───────────┘
                   │ owner starts work
                   ▼
        ┌──────────────────────┐
        │ ReformAction         │  (status: in_progress)
        │ ReformActionUpdate[] │  (append-only — RLS blocks UPDATE/DELETE)
        │   updateType:        │
        │     progress|blocker │
        │     |milestone|      │
        │     evidence|note    │
        └──────────┬───────────┘
                   │ owner completes
                   ▼
        ┌──────────────────────┐  STATE 2: Implementation completion
        │ ReformAction         │  (status: completed)
        └──────────┬───────────┘
                   │ reviewer verifies (F6 pattern)
                   ▼
        ┌──────────────────────┐  STATE 3: Execution verification
        │ ReformVerification   │  (verificationStatus: verified)
        │ verifiedAction       │  (specific action — NOT policy outcome)
        │ evidenceSource       │  (F6 required fields)
        │                      │  (DB trigger + Zod + service = triple enforcement)
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐  STATE 4: Descriptive outcome measurement
        │ ReformFeedbackLoop   │  (immutable, attributionLevel="descriptive" always)
        │ comparisonType:      │  (before_after | parallel | none — never "causal")
        │   before_after       │
        │ descriptiveSummary   │  (human-written, no causal language)
        │ beforeObservationId  │  (read-only — never mutates)
        │ afterObservationId   │  (NEW observation via ingestObservation — append-only)
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ Alert.lifecycleStage │  (closed — via G02 verifyExecution + closeAlert)
        │ Alert.executionStatus│  (verified — via G02 contracts, NOT direct table writes)
        └──────────────────────┘
```

---

## 4. Coordination Workflow (Multi-Institution — D6)

### 4.1 Two-Level Approval (No Majority Override)

Per owner directive: "لا يجوز أن تتحول قاعدة «الأغلبية» إلى وسيلة لفرض التزام تنفيذي على وزارة لم توافق عليه."

```
Lead creates ReformCoordination (status: draft)
  │
  │ Lead adds participants (creates invitations)
  │
  ▼
Participants accept invitations (ReformCoordinationParticipant: pending_invitation → active)
  │
  │ Lead drafts coordination plan (title, description, objectives)
  │
  ▼
Coordination (status: plan_submitted)
  │
  │ Lead approves coordination plan
  │   (requires reform:coordination:approve — lead's reviewer/admin only)
  │   → audit: reform.coordination_plan_approved
  │
  ▼
Coordination (status: plan_approved)
  │
  │ Participants now create their own ReformProposals linked via coordinationId
  │
  ▼
Each participant's proposal goes through standard lifecycle:
  draft → under_review → approved (per-tenant reviewer approval)
  │
  ▼
When ALL participants' proposals are approved:
  Coordination (status: active)  — auto-triggered, NO majority rule
  → audit: reform.coordination_activated
```

### 4.2 Participant Management (B1 Closure — Option A Corrected)

The lead can remove a participant via `remove_coordination_participant()` function (SECURITY DEFINER, Option A corrected):

- **Lead check is INSIDE the UPDATE's WHERE clause** (not a separate CTE)
- **Zero rows modified** when the caller is not the lead
- **Dedicated `balance_coordination_admin` role** (NOLOGIN, minimal grants)
- **Atomic audit** with the removal
- **Denied attempts audited** (status: "denied")

See `G03_00_BLOCKER_CLOSURE_REV5.md` §2 for full function specification.

### 4.3 Shared Snapshots (B2 Closure + Draft Mode per D12)

Participants share explicitly approved snapshots:

```
Snapshot created (status: draft — private to owner)
  │
  │ Owner submits for review
  ▼
Snapshot (status: under_review)
  │
  │ Owner's reviewer approves (requires reform:coordination:share)
  ▼
Snapshot (status: approved — visible to coordination participants)
  │
  │ Owner's reviewer can revoke (creates revocation record — append-only)
  ▼
Snapshot revoked (status: approved + revocation record exists)
  │  → filtered out from shared view via RLS (NOT is_snapshot_revoked(id))
  │  → B2: enforced at DB level, not just service layer
  ▼
[History preserved indefinitely — owner can see their own revoked snapshots]
```

### 4.4 Institutional Authority (B3 Closure)

Per owner directive: "لا تجعل `canApproveCommitments` وحده تفويضاً سيادياً."

Three checks required to approve commitments claiming institutional authority:
1. `canApproveCommitments = true` (explicit grant by lead or admin)
2. `verifiedInstitutionId` is set (admin-verified — NOT the participant themselves)
3. `verifiedInstitutionId` matches the claimed institution

**Fail-closed**: Until the verification workflow exists (G03-L13), `verifiedInstitutionId` is always NULL. No institutional commitments can be approved.

See `G03_00_BLOCKER_CLOSURE_REV5.md` §4 for full contract.

---

## 5. State Machines (Summary)

### 5.1 ReformProposal

```
draft → under_review → approved/rejected/superseded
```

### 5.2 ReformAlternative

```
draft → selected (only ONE per proposal — partial unique index)
draft → withdrawn
```

### 5.3 ReformAction

```
planned → in_progress → completed (terminal for lifecycle)
                   ↘ blocked → in_progress (can resume)
planned/in_progress → cancelled (terminal)
```

### 5.4 ReformVerification (F6)

```
pending → verified (requires verifiedAction + evidenceSource — F6)
pending → disputed (requires disputeReason + disputeEvidenceSource)
verified ↔ disputed (re-verification allowed)
```

### 5.5 ReformCoordination

```
draft → plan_submitted → plan_approved → active (ALL proposals approved) → closed
                                                          ↘ superseded (historical link preserved — D11)
```

### 5.6 ReformCoordinationParticipant

```
pending_invitation → active (on accept)
                  ↘ removed (via remove_coordination_participant — B1 Option A)
                  ↘ withdrawn (self-service)
```

### 5.7 ReformCoordinationSharedSnapshot (with draft mode — D12)

```
draft (private to owner) → under_review → approved (visible to participants)
                                              ↘ revoked (via revocation table — append-only)
```

---

## 6. Audit Trail (Three-Layer Pattern)

Every G03 state transition writes to three layers (mirrors G01's `approveStrategyVersionWithAuditSafe`):

| Layer | Table | Atomicity |
|-------|-------|-----------|
| 1. Authorization | (in-memory check) | Throws `PermissionDeniedError` on failure |
| 2. Domain Event | `events` (G00) | Atomic with primary operation |
| 3. Audit Log | `audit_log` (G00) | Atomic via `writeAuditTx` |

### 6.1 Denied-Attempt Audit

Denied permission attempts are audited via the `*WithAuditSafe` wrapper pattern (mirrors G01). The denied audit entry has `status: "denied"`, `errorCode: "PERMISSION_DENIED"`. The original `PermissionDeniedError` is always re-thrown (not masked by audit failure).

### 6.2 Supersession Audit (D11 — Historical Preservation)

Per owner directive: "لا تنقل الروابط التاريخية للمقترحات أو الموافقات القديمة إلى تنسيق بديل بصمت."

The supersession trigger does NOT modify old proposals' `coordinationId`, `strategyVersionId`, or other historical links. The audit entry records:
- What was superseded (old proposal ID)
- What superseded it (new proposal ID)
- Why (reason)
- Historical context preserved (old proposal's coordinationId, strategyVersionId — NOT modified)

---

## 7. Workflow Validation Checklist

| Requirement | How verified |
|-------------|--------------|
| Every transition requires authenticated human | `withAuthenticatedTenant` wraps every service |
| Every transition checks CURRENT DB role | `requirePermissionWithCurrentRole` (not stale JWT) |
| Every transition writes atomic audit log | `writeAuditTx` inside transaction |
| Denied attempts audited | `*WithAuditSafe` wrapper |
| Evidence snapshots immutable post-approval | RLS blocks UPDATE/DELETE on `reform_approvals` |
| Action updates append-only | RLS blocks UPDATE/DELETE on `reform_action_updates` |
| F6 enforced (verifiedAction + evidenceSource) | Zod + DB trigger + service (triple enforcement) |
| Attribution level always "descriptive" | DB trigger on `reform_feedback_loops` |
| Cross-tenant references blocked | RLS + cross-tenant triggers |
| Supersession preserves history | Trigger does NOT modify historical links (D11) |
| Coordination `active` requires ALL proposals approved | Auto-trigger + no majority rule |
| Participant removal: zero modification on auth failure | B1 Option A — lead check inside UPDATE WHERE |
| Shared snapshots: revoked excluded at DB level | B2 — `NOT is_snapshot_revoked(id)` in RLS policy |
| Institutional commitments: fail-closed without verification | B3 — three-check approval |

---

*End of G03-00 Workflow & Approvals (REV 5 — Final). All REV 1-4 contracts have been superseded.*
