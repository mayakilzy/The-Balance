# G03-00 — Integration Contracts (REV 5 — Final)

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Service contract specification (DESIGN ONLY — no code)
> **Date:** 2026-10-18 (revision 5 — final, post blocker closure)
> **Author:** GLM (implementation agent)
> **Status:** REV 5 — all blockers (B1-B4) closed; awaiting owner FINAL PASS
> **Companion to:** `G03_00_BLOCKER_CLOSURE_REV5.md` (authoritative for B1-B4)

> ✅ **REV 5 STATUS**: This document is fully consistent with REV 5.
> All REV 1-4 contracts have been superseded.
> For B1/B2/B3/B4 closure details, see `G03_00_BLOCKER_CLOSURE_REV5.md`.
> For full Zod schemas, see `G03_00_DOMAIN_MODEL.md` §5.

---

## 1. Service Modules (12 total — 11 core + 1 coordination)

| # | Module | File | Mission | Purpose |
|---|--------|------|---------|---------|
| 1 | Contracts | `contracts.ts` | 03-01 | Zod schemas, enums, error classes |
| 2 | Reform Proposal | `reform-proposal-service.ts` | 03-02 | Proposal CRUD + lifecycle |
| 3 | Reform Alternative | `reform-alternative-service.ts` | 03-03 | Alternative CRUD + selection |
| 4 | Reform Comparison | `reform-comparison-service.ts` | 03-04 | Deterministic comparison (no LLM) |
| 5 | Reform Advisor | `reform-advisor-service.ts` | 03-04 | LLM-assisted drafting (advisory only) |
| 6 | Reform Approval | `reform-approval-service.ts` | 03-05 | Atomic approval + evidence snapshot + B3 checks |
| 7 | Reform Action | `reform-action-service.ts` | 03-02 (vertical slice), 03-05 (enhanced) | Action CRUD + lifecycle |
| 8 | Reform Action Update | `reform-action-update-service.ts` | 03-02 | Append-only progress log |
| 9 | Reform Verification | `reform-verification-service.ts` | 03-02 | F6 verification |
| 10 | Reform Feedback | `reform-feedback-service.ts` | 03-02 | Descriptive feedback loop + close alert |
| 11 | Reform Query | `reform-query-service.ts` | 03-08 | Cross-entity snapshot + dashboard |
| 12 | **Reform Coordination** | `reform-coordination-service.ts` | 03-06 | Coordination CRUD + invitations + shared snapshots + participant removal (B1 Option A) + institutional authority (B3) |

---

## 2. Error Classes (Inherited from G02)

G03 reuses G02's three error classes:

| Error | When thrown | HTTP status |
|-------|-------------|--------------|
| `PermissionDeniedError` | Permission check fails | 403 |
| `NotFoundError` | Entity not found in tenant scope | 404 |
| `ConflictError` | Lifecycle transition invalid | 409 |

---

## 3. Lifecycle Enums (REV 5)

| Enum | Values |
|------|--------|
| `ReformProposalStatus` | `draft` \| `under_review` \| `approved` \| `rejected` \| `superseded` |
| `ReformAlternativeStatus` | `draft` \| `selected` \| `withdrawn` |
| `ReformActionStatus` | `planned` \| `in_progress` \| `completed` \| `blocked` \| `cancelled` |
| `ReformActionUpdateType` | `progress` \| `blocker` \| `milestone` \| `evidence` \| `note` |
| `ReformVerificationStatus` | `pending` \| `verified` \| `disputed` |
| `ReformFeedbackComparisonType` | `before_after` \| `parallel` \| `none` (never `causal`) |
| `ReformCoordinationStatus` | `draft` \| `plan_submitted` \| `plan_approved` \| `active` \| `closed` \| `superseded` |
| `ReformCoordinationParticipantStatus` | `pending_invitation` \| `active` \| `removed` \| `withdrawn` |
| `ReformCoordinationInvitationStatus` | `pending` \| `accepted` \| `declined` \| `expired` \| `revoked` |
| `ReformCoordinationApprovalPolicy` | `unanimous` \| `lead_with_no_objection` \| `lead_only` (immutable post-creation) |
| `ReformSharedSnapshotStatus` | `draft` \| `under_review` \| `approved` \| `revoked` (via revocation table) |
| `HypothesisReviewStatus` (D3) | `proposed` \| `under_review` \| `validated` \| `invalidated` \| `inconclusive` \| `superseded` |
| `HypothesisConfidenceLevel` (D3) | `unknown` \| `low` \| `medium` \| `high` (descriptive, not probabilistic) |
| `HypothesisConfidenceBasis` (D3) | `analyst_judgment` \| `historical_pattern` \| `statistical_correlation` \| `expert_consultation` \| `literature_review` \| `international_comparison` \| `unknown` |

---

## 4. Service Signatures (REV 5)

### 4.1 Reform Proposal Service

```typescript
export async function createReformProposal(session, input: CreateReformProposalInput): Promise<{ proposalId: string }>;
export async function getReformProposal(session, proposalId): Promise<ReformProposal | null>;
export async function listReformProposals(session, filters): Promise<{ proposals[]; nextCursor }>;
export async function submitForReview(session, input: SubmitForReviewInput): Promise<{ proposalId; status }>;
export async function rejectReformProposal(session, input: RejectReformProposalInput): Promise<{ proposalId; status }>;
export async function returnForRevision(session, input: ReturnForRevisionInput): Promise<{ proposalId; status }>;
export async function archiveReformProposal(session, proposalId): Promise<{ proposalId; archivedAt }>;
```

### 4.2 Reform Alternative Service

```typescript
export async function addReformAlternative(session, input: CreateReformAlternativeInput): Promise<{ alternativeId }>;
export async function listReformAlternatives(session, proposalId): Promise<ReformAlternative[]>;
export async function selectAlternative(session, input: SelectAlternativeInput): Promise<{ alternativeId; status }>;
export async function withdrawAlternative(session, input: WithdrawAlternativeInput): Promise<{ alternativeId; status }>;
```

### 4.3 Reform Comparison Service (Deterministic — No LLM, No Recommendation)

```typescript
export interface AlternativeComparison {
  proposalId: string;
  alternatives: Array<{
    alternativeId: string;
    title: string;
    costRange: { min: number | null; max: number | null; currency: string } | null;
    riskLevel: ReformRiskLevel;
    feasibilityScore: ReformFeasibilityScore;
    assumptionCount: number;
    anticipatedOutcomeCount: number;
  }>;
  comparisonMatrix: {
    dimensions: string[];
    notes: string;
  };
  // NO "recommended" field — the human selects, not the system
}

export async function compareReformAlternatives(session, proposalId): Promise<AlternativeComparison>;
```

### 4.4 Reform Advisor Service (LLM-Assisted, Advisory Only)

```typescript
export interface AdvisorDraftResult {
  draft: string;
  simulated: boolean;  // always true with StubProvider
  provider: string;
  model: string;
  warnings: string[];
  // NO confidence score, NO recommendation
}

export async function draftProblemStatement(session, input): Promise<AdvisorDraftResult>;
export async function draftReformAlternatives(session, input): Promise<AdvisorDraftResult[]>;
export async function draftComparisonSummary(session, proposalId): Promise<AdvisorDraftResult>;
export async function draftAnticipatedOutcomes(session, input): Promise<AdvisorDraftResult>;
```

### 4.5 Reform Approval Service (B3 — Three-Check Institutional Approval)

```typescript
export async function approveReformProposal(
  session, proposalId, alternativeId, input: ApproveReformProposalInput
): Promise<{ approvalId; proposalStatus }>;

export async function approveReformProposalWithAuditSafe(...): Promise<...>;

export async function getReformApproval(session, proposalId): Promise<ReformApproval | null>;
```

**B3 Three-Check Approval** (inside `approveReformProposal`):

```typescript
// If proposal claims institutional authority (proposal.actingOnBehalfOfInstitutionId set):
if (proposal.actingOnBehalfOfInstitutionId) {
  const participant = await tx.reformCoordinationParticipant.findFirst({
    where: { tenantId, coordinationId: proposal.coordinationId, status: 'active' },
  });
  // Check 1: canApproveCommitments = true
  if (!participant?.canApproveCommitments) throw PermissionDeniedError(...);
  // Check 2: verifiedInstitutionId is set (fail-closed if NULL)
  if (!participant?.verifiedInstitutionId) throw PermissionDeniedError(...);
  // Check 3: verifiedInstitutionId matches claimed institution
  if (participant.verifiedInstitutionId !== proposal.actingOnBehalfOfInstitutionId)
    throw PermissionDeniedError(...);
}
```

### 4.6 Reform Coordination Service (B1 Option A + B3 Authority)

```typescript
// Coordination CRUD
export async function createCoordination(session, input): Promise<{ coordinationId }>;
export async function getCoordination(session, coordinationId): Promise<ReformCoordination | null>;
export async function listCoordinations(session, filters): Promise<{ coordinations[]; nextCursor }>;
export async function closeCoordination(session, coordinationId, reason): Promise<{ coordinationId; status }>;
export async function supersedeCoordination(session, oldCoordinationId, newCoordinationId, reason): Promise<...>;

// Plan approval (lead only)
export async function submitCoordinationPlan(session, coordinationId): Promise<{ status }>;
export async function approveCoordinationPlan(session, coordinationId): Promise<{ status }>;

// Participant management
export async function addCoordinationParticipant(session, input): Promise<{ participantId }>;
export async function listCoordinationParticipants(session, coordinationId): Promise<ReformCoordinationParticipant[]>;
export async function withdrawFromCoordination(session, coordinationId, reason): Promise<{ status }>;

// B1: Participant removal via SECURITY DEFINER function (Option A corrected)
export async function removeCoordinationParticipant(
  session, coordinationId, participantId, reason
): Promise<{ removed: boolean }>;
// Calls the SQL function remove_coordination_participant() which has the lead
// check INSIDE the UPDATE's WHERE clause — zero modification on auth failure.

// Invitations
export async function createCoordinationInvitation(session, input): Promise<{ invitationId }>;
export async function acceptCoordinationInvitation(session, invitationId): Promise<{ status }>;
export async function declineCoordinationInvitation(session, invitationId, reason): Promise<{ status }>;
export async function revokeCoordinationInvitation(session, invitationId, reason): Promise<{ status }>;

// Shared snapshots (B2 — DB-level revocation + D12 draft mode)
export async function createSharedSnapshot(session, input): Promise<{ snapshotId }>;
export async function submitSharedSnapshotForReview(session, snapshotId): Promise<{ status }>;
export async function approveSharedSnapshot(session, snapshotId): Promise<{ status }>;
export async function revokeSharedSnapshot(session, snapshotId, reason): Promise<{ status }>;
export async function getCoordinationSharedView(session, coordinationId): Promise<SharedSnapshot[]>;
// Returns only approved, non-revoked snapshots (enforced at DB level via RLS).

// B3: Institutional authority management
export async function grantCommitmentApproval(session, participantId, reason): Promise<{ granted }>;
export async function revokeCommitmentApproval(session, participantId, reason): Promise<{ revoked }>;
export async function verifyInstitutionalAuthority(
  session, participantId, institutionId, method, notes
): Promise<{ verified }>;
// Admin-only (NOT lead reviewer) — sets verifiedInstitutionId.
export async function revokeInstitutionalVerification(session, participantId, reason): Promise<{ revoked }>;
// Admin-only. Sets verifiedInstitutionId = NULL. Future institutional commitments fail-closed.

// Close originating alert (integration with G02)
export async function closeOriginatingAlert(session, proposalId): Promise<{ alertClosed }>;
```

### 4.7 Reform Action Service

```typescript
export async function createReformAction(session, input: CreateReformActionInput): Promise<{ actionId }>;
export async function getReformAction(session, actionId): Promise<ReformAction | null>;
export async function listReformActions(session, filters): Promise<{ actions[]; nextCursor }>;
export async function startReformAction(session, input: StartReformActionInput): Promise<{ actionId; status }>;
export async function blockReformAction(session, input: BlockReformActionInput): Promise<{ actionId; status }>;
export async function unblockReformAction(session, actionId, notes): Promise<{ actionId; status }>;
export async function completeReformAction(session, input: CompleteReformActionInput): Promise<{ actionId; status }>;
export async function cancelReformAction(session, input: CancelReformActionInput): Promise<{ actionId; status }>;
```

**D4 — Cross-strategy links forbidden by default**: `programId`/`projectId` must match the `ReformProposal.strategyVersionId`. No `allowCrossStrategyProgramLink` flag.

### 4.8 Reform Action Update Service

```typescript
export async function addReformActionUpdate(session, input: AddReformActionUpdateInput): Promise<{ updateId }>;
export async function listReformActionUpdates(session, actionId, options?): Promise<{ updates[]; nextCursor }>;
```

### 4.9 Reform Verification Service (F6 Triple Enforcement)

```typescript
export async function verifyReformAction(
  session, actionId, input: VerifyReformActionInput
): Promise<{ verificationId; verificationStatus }>;
// F6 enforced by: Zod superRefine + DB trigger + service check (triple)

export async function verifyReformActionWithAuditSafe(...): Promise<...>;
export async function getReformVerification(session, actionId): Promise<ReformVerification | null>;
```

### 4.10 Reform Feedback Service

```typescript
export async function createReformFeedbackLoop(
  session, actionId, input: CreateReformFeedbackLoopInput
): Promise<{ feedbackLoopId }>;
// attributionLevel hardcoded to "descriptive" — DB trigger blocks any other value.
// Causal language rejected by Zod + service check (defense in depth).

export async function getReformFeedbackLoop(session, actionId): Promise<ReformFeedbackLoop | null>;
export async function closeOriginatingAlert(session, proposalId): Promise<{ alertClosed }>;
// Uses G02 verifyExecution + closeAlert contracts (NOT direct table writes).
```

### 4.11 Reform Query Service

```typescript
export async function getReformProposalSnapshot(session, proposalId): Promise<ReformProposalSnapshot | null>;
export async function getReformDashboardSummary(session): Promise<ReformDashboardSummary>;
```

---

## 5. API Routes (REV 5 — ~35 routes)

All under `/api/v1/reform/*`:

| Method | Path | Permission | Service |
|--------|------|-----------|---------|
| POST | `/proposals` | `reform:proposal:write` | createReformProposal |
| GET | `/proposals` | `reform:proposal:read` | listReformProposals |
| GET | `/proposals/:id` | `reform:proposal:read` | getReformProposal |
| POST | `/proposals/:id/submit` | `reform:proposal:write` | submitForReview |
| POST | `/proposals/:id/reject` | `reform:proposal:approve` | rejectReformProposal |
| POST | `/proposals/:id/return` | `reform:proposal:approve` | returnForRevision |
| POST | `/proposals/:id/approve` | `reform:proposal:approve` | approveReformProposalWithAuditSafe |
| POST | `/proposals/:id/archive` | `reform:proposal:write` | archiveReformProposal |
| POST | `/proposals/:id/alternatives` | `reform:alternative:write` | addReformAlternative |
| GET | `/proposals/:id/alternatives` | `reform:alternative:read` | listReformAlternatives |
| GET | `/proposals/:id/comparison` | `reform:alternative:read` | compareReformAlternatives |
| POST | `/alternatives/:id/select` | `reform:proposal:approve` | selectAlternative |
| POST | `/alternatives/:id/withdraw` | `reform:proposal:approve` | withdrawAlternative |
| POST | `/advisor/draft-problem-statement` | `reform:proposal:write` | draftProblemStatement |
| POST | `/advisor/draft-alternatives` | `reform:alternative:write` | draftReformAlternatives |
| POST | `/advisor/draft-comparison` | `reform:alternative:read` | draftComparisonSummary |
| POST | `/advisor/draft-anticipated-outcomes` | `reform:alternative:write` | draftAnticipatedOutcomes |
| POST | `/actions` | `reform:action:write` | createReformAction |
| GET | `/actions` | `reform:action:read` | listReformActions |
| GET | `/actions/:id` | `reform:action:read` | getReformAction |
| POST | `/actions/:id/start` | `reform:action:write` | startReformAction |
| POST | `/actions/:id/block` | `reform:action:write` | blockReformAction |
| POST | `/actions/:id/unblock` | `reform:action:write` | unblockReformAction |
| POST | `/actions/:id/complete` | `reform:action:write` | completeReformAction |
| POST | `/actions/:id/cancel` | `reform:action:write` | cancelReformAction |
| POST | `/actions/:id/updates` | `reform:action:write` | addReformActionUpdate |
| GET | `/actions/:id/updates` | `reform:action:read` | listReformActionUpdates |
| POST | `/actions/:id/verify` | `reform:action:verify` | verifyReformActionWithAuditSafe |
| GET | `/actions/:id/verification` | `reform:verification:read` | getReformVerification |
| POST | `/actions/:id/feedback` | `reform:action:write` | createReformFeedbackLoop |
| GET | `/actions/:id/feedback` | `reform:verification:read` | getReformFeedbackLoop |
| POST | `/proposals/:id/close-alert` | `observatory:alert:act` | closeOriginatingAlert |
| GET | `/dashboard` | `reform:proposal:read` | getReformDashboardSummary |
| POST | `/coordinations` | `reform:coordination:manage` | createCoordination |
| GET | `/coordinations` | `reform:coordination:read` | listCoordinations |
| GET | `/coordinations/:id` | `reform:coordination:read` | getCoordination |
| POST | `/coordinations/:id/close` | `reform:coordination:manage` | closeCoordination |
| POST | `/coordinations/:id/approve-plan` | `reform:coordination:approve` | approveCoordinationPlan |
| POST | `/coordinations/:id/participants` | `reform:coordination:manage` | addCoordinationParticipant |
| GET | `/coordinations/:id/participants` | `reform:coordination:read` | listCoordinationParticipants |
| POST | `/coordinations/:id/participants/:pid/remove` | `reform:coordination:manage` | removeCoordinationParticipant (B1 Option A) |
| POST | `/coordinations/:id/invitations` | `reform:coordination:manage` | createCoordinationInvitation |
| POST | `/coordinations/:id/invitations/:iid/accept` | `reform:coordination:read` | acceptCoordinationInvitation |
| POST | `/coordinations/:id/invitations/:iid/decline` | `reform:coordination:read` | declineCoordinationInvitation |
| POST | `/coordinations/:id/snapshots` | `reform:coordination:share` | createSharedSnapshot |
| POST | `/coordinations/:id/snapshots/:sid/approve` | `reform:coordination:share` | approveSharedSnapshot |
| POST | `/coordinations/:id/snapshots/:sid/revoke` | `reform:coordination:share` | revokeSharedSnapshot |
| GET | `/coordinations/:id/shared-view` | `reform:coordination:read` | getCoordinationSharedView |
| POST | `/coordinations/:id/authority/grant` | `reform:coordination:manage` | grantCommitmentApproval |
| POST | `/coordinations/:id/authority/revoke` | `reform:coordination:manage` | revokeCommitmentApproval |
| POST | `/coordinations/:id/authority/verify-institution` | `tenant:write` (admin) | verifyInstitutionalAuthority (B3) |
| POST | `/coordinations/:id/authority/revoke-verification` | `tenant:write` (admin) | revokeInstitutionalVerification (B3) |

---

## 6. Permission Matrix (REV 5 — 13 permissions)

| Permission | admin | reviewer | analyst | observer |
|-----------|:-----:|:--------:|:-------:|:--------:|
| reform:proposal:read | ✓ | ✓ | ✓ | ✓ |
| reform:proposal:write | ✓ | — | ✓ | — |
| reform:proposal:approve | ✓ | ✓ | — | — |
| reform:alternative:read | ✓ | ✓ | ✓ | — |
| reform:alternative:write | ✓ | — | ✓ | — |
| reform:action:read | ✓ | ✓ | ✓ | ✓ |
| reform:action:write | ✓ | — | ✓ | — |
| reform:action:verify | ✓ | ✓ | — | — |
| reform:verification:read | ✓ | ✓ | ✓ | — |
| reform:coordination:read | ✓ | ✓ | ✓ | ✓ |
| reform:coordination:manage | ✓ | (delegated only — G03-L14) | — | — |
| reform:coordination:approve | ✓ | ✓ (lead tenant) | — | — |
| reform:coordination:share | ✓ | ✓ | — | — |

---

## 7. Contract Stability Guarantees

### 7.1 Stable

- All Zod schema names + field names
- All service function names + signatures
- All API route paths + HTTP methods
- All permission names (13)
- All lifecycle enum values
- All error classes + inheritance

### 7.2 May Evolve (Additive Only)

- Internal implementation details
- Additional optional fields
- New service functions
- New API routes
- New permission values for new sub-resources

---

*End of G03-00 Integration Contracts (REV 5 — Final). All REV 1-4 contracts have been superseded.*
