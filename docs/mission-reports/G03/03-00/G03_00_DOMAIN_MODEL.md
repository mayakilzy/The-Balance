# G03-00 — Domain Model

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Domain model specification (DESIGN ONLY — no code, no migrations)
> **Date:** 2026-10-18 (revision 2 — post owner review)
> **Author:** GLM (implementation agent)
> **Status:** REVISED per owner directive — re-awaiting final approval
> **Companion to:** `G03_00_ARCHITECTURE_PROPOSAL.md` §7

> ⚠️ **REVISION NOTE (2026-10-18 rev 2)**: This document specifies the 7 core reform tables from rev 1.
> The **5 coordination tables** added per owner directive D6 are documented in:
> - `G03_00_THREAT_MODEL.md` §4 (table schemas + RLS pattern)
> - `G03_00_OPEN_DECISIONS.md` §7 (D6 — coordination model details)
>
> **Total table count is now 12** (7 core below + 5 coordination):
> - Core: `reform_proposals`, `reform_alternatives`, `reform_approvals`, `reform_actions`, `reform_action_updates`, `reform_verifications`, `reform_feedback_loops`
> - Coordination (NEW): `reform_coordinations`, `reform_coordination_participants`, `reform_coordination_invitations`, `reform_coordination_shared_snapshots`, `reform_coordination_shared_snapshot_revocations`
>
> **D3 revision**: `hypothesizedCauses[]` schema expanded with `confidenceBasis`, `contradictingEvidenceIds`, `reviewStatus`, `reviewedBy`, `reviewedAt` — see `G03_00_OPEN_DECISIONS.md` §4.
>
> The 7 core table schemas below remain accurate. The coordination tables will be specified
> in detail in mission 03-01's migration SQL. A full content update of this document
> (integrating coordination tables + D3 schema expansion) will be done if the owner requires it.

---

## 1. Overview

### 1.1 Design Philosophy

GROUP 03's domain model follows the same principles that governed G01 and G02:

1. **Additive only** — no modifications to existing G00/G01/G02 tables.
2. **Tenant-scoped (PRIVATE)** — all 12 new tables have `tenantId` and RLS ENABLE + FORCE.
3. **Read-only FK to approved G01 entities** — `strategyVersionId`, `programId`, `projectId` are nullable references; G03 never writes to these tables.
4. **Append-only where history matters** — `reform_action_updates`, `reform_coordination_shared_snapshots`, `reform_coordination_shared_snapshot_revocations`, `reform_coordination_invitations` block UPDATE/DELETE via RLS.
5. **Immutable post-approval** — `reform_approvals` and `reform_feedback_loops` block UPDATE/DELETE via RLS.
6. **DB-level enforcement of invariants** — F6 pattern (verifiedAction + evidenceSource) enforced by trigger, not just service layer.
7. **Coordination-aware RLS** — coordination tables use a `SECURITY INVOKER` helper function `is_coordination_participant(text)` for cross-participant visibility (see `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md`).
8. **Same naming conventions** — snake_case tables (`reform_proposals`), camelCase Prisma fields, `@@map` + `@@index` pattern from G01/G02.
9. **Historical preservation on supersession** — supersession is a documented historical link, NOT a silent rewrite of old proposals' `coordinationId`. See §3.8.

### 1.2 New Tables Summary (12 tables — 7 core + 5 coordination)

#### Core Reform Tables (7)

| # | Table (Prisma model) | DB table | Purpose | Lifecycle |
|---|---------------------|----------|---------|-----------|
| 1 | `ReformProposal` | `reform_proposals` | Top-level reform container (with optional `coordinationId`) | draft → under_review → approved/rejected/superseded |
| 2 | `ReformAlternative` | `reform_alternatives` | Multiple options per proposal | draft → selected/withdrawn |
| 3 | `ReformApproval` | `reform_approvals` | Atomic approval + evidence snapshot | One-shot, immutable |
| 4 | `ReformAction` | `reform_actions` | Implementation tracking | planned → in_progress → completed/blocked/cancelled |
| 5 | `ReformActionUpdate` | `reform_action_updates` | Append-only progress log | Append-only (no UPDATE/DELETE) |
| 6 | `ReformVerification` | `reform_verifications` | F6-pattern verification (execution verification — separate from outcome measurement) | pending → verified/disputed |
| 7 | `ReformFeedbackLoop` | `reform_feedback_loops` | Descriptive outcome measurement (separate from execution verification) | One-shot, immutable |

#### Coordination Tables (5 — per D6, multi-institution coordination is core)

| # | Table (Prisma model) | DB table | Purpose | Lifecycle |
|---|---------------------|----------|---------|-----------|
| 8 | `ReformCoordination` | `reform_coordinations` | Coordination metadata (title, lead tenant, policy, status) | draft → plan_submitted → plan_approved → active → closed/superseded |
| 9 | `ReformCoordinationParticipant` | `reform_coordination_participants` | M:N coordination↔tenant (with optional institutionId) | pending_invitation → active → removed/withdrawn |
| 10 | `ReformCoordinationInvitation` | `reform_coordination_invitations` | Pending invitations (with expiry) | pending → accepted/declined/expired/revoked (append-only) |
| 11 | `ReformCoordinationSharedSnapshot` | `reform_coordination_shared_snapshots` | Explicitly shared, reviewer-approved snapshots | draft → under_review → approved → (revoked via separate table) |
| 12 | `ReformCoordinationSharedSnapshotRevocation` | `reform_coordination_shared_snapshot_revocations` | Append-only revocations (no UPDATE on snapshots) | One-shot, append-only |

**Total**: 12 new PRIVATE tables, all RLS ENABLE + FORCE.

### 1.3 New Enums

| Enum | Values | Used by |
|------|--------|---------|
| `ReformProposalStatus` | `draft` \| `under_review` \| `approved` \| `rejected` \| `superseded` | ReformProposal.status |
| `ReformAlternativeStatus` | `draft` \| `selected` \| `withdrawn` | ReformAlternative.status |
| `ReformActionStatus` | `planned` \| `in_progress` \| `completed` \| `blocked` \| `cancelled` | ReformAction.status |
| `ReformActionUpdateType` | `progress` \| `blocker` \| `milestone` \| `evidence` \| `note` | ReformActionUpdate.updateType |
| `ReformVerificationStatus` | `pending` \| `verified` \| `disputed` | ReformVerification.verificationStatus (execution verification — separate from outcome measurement) |
| `ReformFeedbackComparisonType` | `before_after` \| `parallel` \| `none` | ReformFeedbackLoop.comparisonType (outcome measurement — descriptive, never causal) |
| `ReformRiskLevel` | `low` \| `medium` \| `high` \| `critical` | ReformAlternative.riskLevel |
| `ReformFeasibilityScore` | `high` \| `medium` \| `low` \| `unknown` | ReformAlternative.feasibilityScore |
| `ReformCoordinationStatus` | `draft` \| `plan_submitted` \| `plan_approved` \| `active` \| `closed` \| `superseded` | ReformCoordination.status |
| `ReformCoordinationParticipantStatus` | `pending_invitation` \| `active` \| `removed` \| `withdrawn` | ReformCoordinationParticipant.status |
| `ReformCoordinationInvitationStatus` | `pending` \| `accepted` \| `declined` \| `expired` \| `revoked` | ReformCoordinationInvitation.status |
| `ReformCoordinationApprovalPolicy` | `unanimous` \| `lead_with_no_objection` \| `lead_only` | ReformCoordination.approvalPolicy (immutable post-creation) |
| `ReformSharedSnapshotStatus` | `draft` \| `under_review` \| `approved` \| `revoked` | ReformCoordinationSharedSnapshot.status (revoked via separate revocation table) |
| `ReformSharedSnapshotType` | `commitment` \| `milestone` \| `progress` \| `outcome` \| `constraint` | ReformCoordinationSharedSnapshot.snapshotType |
| `HypothesisReviewStatus` | `proposed` \| `under_review` \| `validated` \| `invalidated` \| `inconclusive` \| `superseded` | HypothesizedCause.reviewStatus (D3 expansion) |
| `HypothesisConfidenceLevel` | `unknown` \| `low` \| `medium` \| `high` | HypothesizedCause.confidenceLevel (descriptive, not probabilistic) |
| `HypothesisConfidenceBasis` | `analyst_judgment` \| `historical_pattern` \| `statistical_correlation` \| `expert_consultation` \| `literature_review` \| `international_comparison` \| `unknown` | HypothesizedCause.confidenceBasis (D3 expansion) |

---

## 2. Table Specifications

### 2.1 ReformProposal

**Purpose**: The top-level container for a targeted reform. Originates from an observatory signal (Alert/VarianceRecord) or human initiative.

```prisma
model ReformProposal {
  id                          String   @id @default(cuid())
  tenantId                    String
  // Originating signal (both nullable — reforms can be human-initiated)
  originatingAlertId         String?  // FK to G02 Alert
  originatingVarianceRecordId String? // FK to G02 VarianceRecord
  // Strategic context (read-only FK)
  strategyVersionId           String?  // FK to G01 StrategyVersion (read-only)
  objectiveId                 String?  // FK to G01 Objective (read-only)
  // Content
  title                       String
  problemStatement            String   // descriptive, no causal claims
  // D3 (revised per owner directive): expanded hypothesis schema with epistemic structure
  // Schema: [{ cause, confidenceLevel, confidenceBasis, supportingEvidenceIds, 
  //            contradictingEvidenceIds, reviewStatus, reviewedBy, reviewedAt, reviewNotes,
  //            proposedBy, proposedAt, lastModifiedAt, lastModifiedBy }]
  // See G03_00_OPEN_DECISIONS.md §4.2 for full Zod schema
  hypothesizedCauses          Json     @default("[]")
  // Optional coordination link (per D6 — multi-institution coordination is core)
  coordinationId              String?  // FK to ReformCoordination (optional, nullable)
  context                     Json     @default("{}") // free-form metadata
  // Lifecycle
  status                      String   @default("draft") // draft|under_review|approved|rejected|superseded
  // Ownership
  createdBy                   String
  createdAt                   DateTime @default(now())
  updatedAt                   DateTime @updatedAt
  submittedAt                 DateTime? // when status moved to under_review
  approvedAt                  DateTime? // when status moved to approved
  rejectedAt                  DateTime? // when status moved to rejected
  supersededAt                DateTime? // when status moved to superseded
  supersededById              String?  // FK self — the proposal that superseded this one
  // Soft deletion (not hard delete — audit trail preservation)
  archivedAt                  DateTime?
  // Metadata
  metadata                    Json     @default("{}") // provenance: { simulated, provider, draftedVia }

  tenant                Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  originatingAlert      Alert?              @relation(fields: [originatingAlertId], references: [id])
  originatingVariance   VarianceRecord?     @relation(fields: [originatingVarianceRecordId], references: [id])
  strategyVersion       StrategyVersion?    @relation(fields: [strategyVersionId], references: [id])
  objective             Objective?          @relation(fields: [objectiveId], references: [id])
  alternatives          ReformAlternative[]
  approval              ReformApproval?
  actions               ReformAction[]
  supersededBy          ReformProposal?     @relation("ReformProposalSupersession", fields: [supersededById], references: [id])
  supersedes            ReformProposal[]    @relation("ReformProposalSupersession")

  @@index([tenantId, status])
  @@index([tenantId, originatingAlertId])
  @@index([tenantId, originatingVarianceRecordId])
  @@index([tenantId, strategyVersionId])
  @@index([tenantId, objectiveId])
  @@index([tenantId, createdAt])
  @@map("reform_proposals")
}
```

**Key design decisions**:

1. **Both originating signals are nullable**: A reform can be initiated from an Alert, from a VarianceRecord, from both, or from neither (human initiative). This honors the "human remains sovereign" invariant — humans can propose reforms without waiting for a system signal.

2. **`hypothesizedCauses` is a JSONB array, not a single field**: Each cause has a `confidenceLevel` (low/medium/high) and optional `supportingEvidenceIds`. This explicitly separates *problem detection* (the `problemStatement`, descriptive) from *cause analysis* (the `hypothesizedCauses`, hypothetical). This addresses open decision D3.

3. **`supersededById` self-relation**: When a new proposal supersedes an approved one (e.g., a follow-up reform after the first one was insufficient), the old proposal's `status` moves to `superseded` and `supersededById` points to the new one. Both stay in history for audit.

4. **Soft archival, not hard delete**: `archivedAt` allows proposals to be hidden from default lists without losing the audit trail. Hard DELETE is blocked by RLS for `balance_app` (same pattern as G00 `audit_log`).

5. **No `publicationStatus` field**: Honors G02-L25 (fail-closed publication). Publication is a future mission.

### 2.2 ReformAlternative

**Purpose**: Multiple options for addressing the same problem. Each alternative has its own cost range, risk level, assumptions, and feasibility assessment.

```prisma
model ReformAlternative {
  id              String   @id @default(cuid())
  tenantId        String
  proposalId      String
  title           String
  description     String
  // Cost as RANGE (no fake precision — mirrors G01 BudgetLine pattern)
  costEstimateMin Decimal?  @db.Decimal(20, 2)
  costEstimateMax Decimal?  @db.Decimal(20, 2)
  costCurrency    String   @default("USD")
  costAssumptions Json     @default("[]")
  // Risk + feasibility
  riskLevel       String   @default("medium") // low|medium|high|critical
  riskNotes       String?
  feasibilityScore String  @default("unknown") // high|medium|low|unknown
  feasibilityNotes String?
  // Hypothesized outcomes (descriptive, never causal)
  anticipatedOutcomes Json  @default("[]") // [{ outcome, direction: "improve"|"worsen"|"neutral", assumptions: [], attributionLevel: "descriptive" }]
  assumptions     Json     @default("[]") // [{ title, description, validationMethod }]
  // Lifecycle
  status          String   @default("draft") // draft|selected|withdrawn
  selectedAt      DateTime?
  selectedBy      String?
  withdrawnAt     DateTime?
  withdrawnBy    String?
  withdrawalReason String?
  // Provenance
  draftedVia      String   @default("human") // human|llm_advisory|hybrid
  simulated       Boolean  @default(false) // true if LLM-assisted with StubProvider
  metadata        Json     @default("{}")
  createdBy       String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant     Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  proposal   ReformProposal  @relation(fields: [proposalId], references: [id], onDelete: Cascade)
  approvals  ReformApproval[]
  actions    ReformAction[]

  @@unique([tenantId, proposalId, title])
  @@index([tenantId, proposalId, status])
  @@map("reform_alternatives")
}
```

**Key design decisions**:

1. **`costEstimateMin` + `costEstimateMax` (Decimal range)**: Mirrors G01 `BudgetLine.minAmount`/`maxAmount` pattern — no fake precision. Cost is a range, not a point estimate.

2. **`anticipatedOutcomes` is descriptive, never causal**: Each outcome has an explicit `attributionLevel: "descriptive"` (hardcoded in the Zod schema) and `assumptions` array. This honors invariant #1.

3. **Only ONE alternative per proposal can be `selected`**: Enforced by partial unique index (see §3.2 below).

4. **`draftedVia` + `simulated` provenance**: Honors ADR-0002 (LLM Provider Abstraction) and ADR-0010 §"Simulated model output disclaimer". When StubProvider is active, `simulated = true`.

5. **`@@unique([tenantId, proposalId, title])`**: Prevents duplicate alternative titles within the same proposal.

### 2.3 ReformApproval

**Purpose**: Atomic approval record with evidence snapshot at approval time. Mirrors G00 `Decision` pattern (ADR-0010 §"Evidence snapshot at decision time").

```prisma
model ReformApproval {
  id              String   @id @default(cuid())
  tenantId        String
  proposalId      String
  alternativeId   String   // the selected alternative that was approved
  // Approval metadata
  approvedBy      String
  approvedAt      DateTime @default(now())
  approvalNotes   String?
  // Evidence snapshot (immutable post-approval — same pattern as G00 Decision)
  supportingEvidence Json   @default("[]") // [{ evidenceId, claim, type, verificationStatus, sourceCode }]
  counterEvidence    Json   @default("[]") // same structure
  // Rationale (why this alternative over others)
  rationale       String
  // Provenance
  metadata        Json     @default("{}")

  tenant     Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  proposal   ReformProposal  @relation(fields: [proposalId], references: [id], onDelete: Cascade)
  alternative ReformAlternative @relation(fields: [alternativeId], references: [id], onDelete: Cascade)

  @@unique([tenantId, proposalId]) // one approval per proposal
  @@index([tenantId, approvedAt])
  @@map("reform_approvals")
}
```

**Key design decisions**:

1. **`@@unique([tenantId, proposalId])`**: One approval per proposal. A proposal cannot be approved twice — to approve a different alternative, the proposal must be superseded first.

2. **`supportingEvidence` + `counterEvidence` JSONB snapshots**: Exact same structure as G00 `Decision` (ADR-0010 §"Evidence snapshot at decision time"). Captures `{ evidenceId, claim, type, verificationStatus, sourceCode }` at approval time — immutable even if evidence later changes.

3. **`alternativeId` required**: Approval always specifies which alternative was approved. No "approve the proposal in general" without selecting an alternative.

4. **`rationale` required (non-null)**: The reviewer must explain *why* this alternative was chosen. Mirrors G02's `alertThresholds.rationale` (min 10 chars) — but here we use the Zod schema to enforce min length, not the DB.

5. **Immutable post-approval**: RLS blocks UPDATE + DELETE for `balance_app` (see §3.4). To "change" an approval, create a new proposal that supersedes the old one.

### 2.4 ReformAction

**Purpose**: Implementation tracking for an approved reform. Optionally linked to G01 Program/Project when the reform fits existing planning.

```prisma
model ReformAction {
  id              String   @id @default(cuid())
  tenantId        String
  proposalId      String
  alternativeId   String
  // Optional link to G01 planning entities (read-only FK)
  programId       String?  // FK to G01 Program (read-only)
  projectId       String?  // FK to G01 Project (read-only)
  // Action details
  title           String
  description     String?
  // Ownership + assignment
  assignedTo      String?  // userId
  assignedAt      DateTime?
  // Lifecycle
  status          String   @default("planned") // planned|in_progress|completed|blocked|cancelled
  // Timeline
  startDate       DateTime?
  dueDate         DateTime?
  completedDate   DateTime?
  cancelledDate   DateTime?
  cancelledBy     String?
  cancellationReason String?
  // Progress (denormalized from latest ReformActionUpdate for query efficiency)
  progressPercentage Int   @default(0) // 0-100
  // Metadata
  metadata        Json     @default("{}")
  createdBy       String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant     Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  proposal   ReformProposal  @relation(fields: [proposalId], references: [id], onDelete: Cascade)
  alternative ReformAlternative @relation(fields: [alternativeId], references: [id], onDelete: Cascade)
  program    Program?        @relation(fields: [programId], references: [id])
  project    Project?        @relation(fields: [projectId], references: [id])
  updates    ReformActionUpdate[]
  verification ReformVerification?

  @@index([tenantId, proposalId, status])
  @@index([tenantId, assignedTo, status])
  @@index([tenantId, status, dueDate])
  @@index([tenantId, programId])
  @@index([tenantId, projectId])
  @@map("reform_actions")
}
```

**Key design decisions**:

1. **`programId` + `projectId` nullable**: Reforms may or may not align with existing G01 programs/projects. When they do, the link is read-only (G03 never updates G01 entities).

2. **`progressPercentage` denormalized**: Updated from the latest `ReformActionUpdate` for query efficiency (avoids JOIN + MAX on every list query). Service layer keeps it in sync.

3. **`assignedTo` is a userId string**: The user responsible for implementation. May be different from the proposal's `createdBy` (separation of duties).

4. **Lifecycle states cover the common implementation flow**: planned → in_progress → completed. `blocked` is a non-terminal state (can return to `in_progress`). `cancelled` is terminal.

5. **No `verifiedDate`**: Verification is a separate entity (`ReformVerification`) with its own lifecycle, following the F6 pattern.

### 2.5 ReformActionUpdate

**Purpose**: Append-only progress log for reform actions. Mirrors G00 `DecisionEvent` + `TaskEvent` pattern.

```prisma
model ReformActionUpdate {
  id              String   @id @default(cuid())
  tenantId        String
  actionId        String
  // Update content
  updateType      String   // progress|blocker|milestone|evidence|note
  notes           String
  // Progress (only meaningful for updateType="progress")
  progressPercentage Int?  // 0-100, sets action.progressPercentage
  // Evidence references (live links, not snapshots — these are progress reports, not sovereign decisions)
  evidenceIds     Json     @default("[]") // [evidenceId, ...]
  // Actor + timestamp
  actor           String
  at              DateTime @default(now())
  // Metadata
  metadata        Json     @default("{}")

  tenant  Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  action  ReformAction  @relation(fields: [actionId], references: [id], onDelete: Cascade)

  @@index([actionId, at])
  @@index([tenantId, at])
  @@index([tenantId, actionId, updateType])
  @@map("reform_action_updates")
}
```

**Key design decisions**:

1. **Append-only enforced by RLS**: `balance_app` has only SELECT + INSERT on this table. UPDATE and DELETE are REVOKE'd. Mirrors G00 `decision_events` + `events` pattern.

2. **`evidenceIds` is a live link array, not a snapshot**: Progress reports reference current evidence (which may be updated/verified over time). This is different from `ReformApproval.supportingEvidence` (which is a snapshot). The rationale: progress reports are ongoing, not sovereign decisions.

3. **`updateType` enum distinguishes update kinds**: `progress` (with `progressPercentage`), `blocker` (something is blocking), `milestone` (significant event), `evidence` (new evidence attached), `note` (general comment).

4. **`actor` is required**: Every update has a recorded human actor. No anonymous updates.

### 2.6 ReformVerification

**Purpose**: F6-pattern verification of reform execution. Describes the *specific action verified*, never a policy outcome.

```prisma
model ReformVerification {
  id              String   @id @default(cuid())
  tenantId        String
  actionId        String
  // Verification status (F6 pattern)
  verificationStatus String @default("pending") // pending|verified|disputed
  // F6 REQUIRED fields (when verificationStatus = "verified")
  verifiedAction  String?  // the SPECIFIC action verified (e.g., "memo #X issued", "infrastructure Y completed")
  evidenceSource  String?  // evidence for that specific action
  // Dispute fields (when verificationStatus = "disputed")
  disputeReason   String?
  disputeEvidenceSource String?
  // Verifier
  verifiedBy      String?
  verifiedAt      DateTime?
  // Notes
  notes           String?
  // Metadata
  metadata        Json     @default("{}")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant  Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  action  ReformAction  @relation(fields: [actionId], references: [id], onDelete: Cascade)
  feedbackLoop ReformFeedbackLoop?

  @@unique([tenantId, actionId]) // one verification per action
  @@index([tenantId, verificationStatus])
  @@index([tenantId, verifiedAt])
  @@map("reform_verifications")
}
```

**Key design decisions**:

1. **F6 enforcement at DB level**: A trigger (see §3.5) blocks INSERT/UPDATE when `verificationStatus = "verified"` but `verifiedAction` or `evidenceSource` is null/empty. Mirrors G02 Alert F6 pattern.

2. **`verifiedAction` describes a SPECIFIC action**: The Zod schema rejects policy-outcome language (e.g., "inflation reduced") and requires action-specific language (e.g., "memo #X issued"). The rejection is pattern-based (regex on common policy-outcome phrases).

3. **`disputeReason` + `disputeEvidenceSource` for disputes**: When verification fails, the verifier must explain why and provide evidence. Mirrors G02 Alert `executionStatus = "disputed"` pattern.

4. **`@@unique([tenantId, actionId])`**: One verification per action. To re-verify after a dispute is resolved, update the existing verification record (status changes from `disputed` to `verified`, with new `verifiedAction` + `evidenceSource`).

### 2.7 ReformFeedbackLoop

**Purpose**: Descriptive before/after comparison linking reform execution back to the observatory. **Never claims causal attribution.**

```prisma
model ReformFeedbackLoop {
  id              String   @id @default(cuid())
  tenantId        String
  actionId        String
  // Before/after observations (live links to G02 Observation)
  beforeObservationId String?  // FK to G02 Observation (the observation that triggered the reform)
  afterObservationId  String?  // FK to G02 Observation (a NEW observation post-reform, created via ingestObservation)
  // Comparison (descriptive only — never causal)
  comparisonType  String   @default("none") // before_after|parallel|none
  descriptiveSummary String // human-written summary of what was observed
  // Attribution (always "descriptive")
  attributionLevel String  @default("descriptive") // ALWAYS "descriptive" — trigger blocks any other value
  // Optional link to new VarianceRecord (created via computeVariance)
  newVarianceRecordId String? // FK to G02 VarianceRecord (descriptive comparison)
  // Provenance
  createdBy       String
  createdAt       DateTime @default(now())
  metadata        Json     @default("{}")

  tenant  Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  action  ReformAction  @relation(fields: [actionId], references: [id], onDelete: Cascade)

  @@unique([tenantId, actionId]) // one feedback loop per action
  @@index([tenantId, createdAt])
  @@map("reform_feedback_loops")
}
```

**Key design decisions**:

1. **`attributionLevel` is hardcoded to `"descriptive"`**: A DB trigger blocks INSERT/UPDATE with any other value. This is invariant #1 enforced at the DB level.

2. **`beforeObservationId` + `afterObservationId`**: Live links to G02 Observation. The "before" observation is typically the one that triggered the originating Alert. The "after" observation is a NEW observation created post-reform (via `ingestObservation` — append-only, never mutates the "before" one).

3. **`comparisonType` enum**: `before_after` (sequential), `parallel` (concurrent comparison, e.g., two regions), `none` (no comparison possible yet). Never `causal`.

4. **`descriptiveSummary` is human-written**: The analyst writes what was observed. No LLM-generated causal claims.

5. **`newVarianceRecordId` optional**: A new VarianceRecord may be computed (via `computeVariance`) comparing the "after" observation to the planned value. This is descriptive — it shows whether the variance changed, not whether the reform *caused* the change.

---

### 2.8 ReformCoordination (NEW — per D6)

**Purpose**: Top-level coordination metadata for multi-institution reforms. Created by a lead tenant; participants join via invitation.

```prisma
model ReformCoordination {
  id              String   @id @default(cuid())
  // Lead tenant owns the coordination
  leadTenantId    String
  // Country scope (for cross-tenant same-country coordination validation)
  countryId       String
  // Content
  title           String
  description     String
  // Coordination context (originating alert/variance if shared signal)
  originatingAlertId          String?  // optional shared signal
  originatingVarianceRecordId String?  // optional shared signal
  // Approval policy — IMMUTABLE post-creation (trigger enforces)
  approvalPolicy   String   // "unanimous" | "lead_with_no_objection" | "lead_only"
  // Lifecycle
  status           String   @default("draft")
  // draft | plan_submitted | plan_approved | active | closed | superseded
  planSubmittedAt   DateTime?
  planApprovedAt    DateTime?
  planApprovedBy    String?
  activatedAt       DateTime?  // when ALL linked proposals approved
  closedAt          DateTime?
  closedBy          String?
  closureReason     String?
  // Supersession (historical link — see §3.8)
  supersededAt      DateTime?
  supersededById    String?   // FK self — the coordination that superseded this one
  // Soft archive (no hard delete)
  archivedAt        DateTime?
  // Provenance
  createdBy         String
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  metadata          Json     @default("{}")

  leadTenant        Tenant              @relation(fields: [leadTenantId], references: [id], onDelete: Cascade)
  country           Country             @relation(fields: [countryId], references: [id])
  originatingAlert  Alert?              @relation(fields: [originatingAlertId], references: [id])
  originatingVariance VarianceRecord?  @relation(fields: [originatingVarianceRecordId], references: [id])
  participants      ReformCoordinationParticipant[]
  invitations       ReformCoordinationInvitation[]
  sharedSnapshots   ReformCoordinationSharedSnapshot[]
  proposals         ReformProposal[]    // via coordinationId
  supersededBy      ReformCoordination? @relation("CoordinationSupersession", fields: [supersededById], references: [id])
  supersedes        ReformCoordination[] @relation("CoordinationSupersession")

  @@index([leadTenantId, status])
  @@index([countryId, status])
  @@index([originatingAlertId])
  @@map("reform_coordinations")
}
```

**Key design decisions**:
1. **`leadTenantId` (not `tenantId`)**: The coordination is owned by the lead tenant. RLS uses `leadTenantId` for write access; the `is_coordination_participant` helper for read access.
2. **`countryId` required**: For cross-tenant same-country coordination validation. Cross-country coordination is G03-L11 (deferred).
3. **`approvalPolicy` immutable post-creation**: A trigger blocks UPDATE on this field. Changing the policy requires superseding the coordination.
4. **Two-level approval reflected in `status`**: `plan_approved` (lead approved the plan) → `active` (ALL linked proposals approved — auto-triggered).
5. **Supersession is a historical link** (see §3.8) — does NOT rewrite old proposals' `coordinationId`.

---

### 2.9 ReformCoordinationParticipant (NEW — per D6)

**Purpose**: M:N relationship between coordination and tenant. Each participant has a role + status. Optional `institutionId` documents which institution the tenant represents.

```prisma
model ReformCoordinationParticipant {
  id              String   @id @default(cuid())
  coordinationId  String
  tenantId        String
  // Optional institution the tenant represents in this coordination
  // (documentation field — NOT authorization field; see Security Contract §5.4)
  institutionId   String?
  // Role within coordination
  role            String   @default("contributor")  // "lead" | "contributor" | "observer"
  // Lifecycle
  status          String   @default("pending_invitation")
  // pending_invitation | active | removed | withdrawn
  joinedAt        DateTime?  // when status moved to active
  removedAt       DateTime?  // when status moved to removed
  removedBy       String?    // who removed (lead userId or self)
  removalReason   String?
  withdrawnAt     DateTime?
  withdrawalReason String?
  // Provenance
  addedBy         String   // lead userId who added this participant
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  metadata        Json     @default("{}")

  coordination   ReformCoordination @relation(fields: [coordinationId], references: [id], onDelete: Cascade)
  tenant         Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([coordinationId, tenantId])
  @@index([tenantId, status])
  @@map("reform_coordination_participants")
}
```

**Key design decisions**:
1. **`institutionId` optional**: Per ADR-0004, the Institution-Tenant relationship is not 1:1. The lead is responsible for verifying institutional representation (governance process, not system-enforced — G03-L12).
2. **`role` enum**: `lead` (only the lead tenant's participant row), `contributor` (can create proposals + share snapshots), `observer` (read-only on shared snapshots).
3. **`status` lifecycle**: `pending_invitation` → `active` (on accept) → `removed` (by lead) or `withdrawn` (by self).
4. **Soft delete only**: Hard DELETE blocked by RLS. Status changes preserve history.

---

### 2.10 ReformCoordinationInvitation (NEW — per D6)

**Purpose**: Pending invitations with expiry. Append-only (status changes, never deleted).

```prisma
model ReformCoordinationInvitation {
  id              String   @id @default(cuid())
  coordinationId  String
  invitedTenantId String   // the invited tenant
  invitedInstitutionId String?  // optional institution the tenant is invited to represent
  invitedRole     String   @default("contributor")  // "contributor" | "observer"
  // Lifecycle (append-only — status changes, never deleted)
  status          String   @default("pending")
  // pending | accepted | declined | expired | revoked
  expiresAt       DateTime  // default: 7 days from creation
  acceptedAt      DateTime?
  acceptedBy      String?   // userId in invited tenant who accepted
  declinedAt      DateTime?
  declinedBy      String?
  declinedReason  String?
  revokedAt       DateTime?
  revokedBy       String?    // lead userId who revoked
  revocationReason String?
  // Provenance
  createdBy       String   // lead userId who sent invitation
  createdAt       DateTime @default(now())
  metadata        Json     @default("{}")

  coordination    ReformCoordination @relation(fields: [coordinationId], references: [id], onDelete: Cascade)
  invitedTenant   Tenant             @relation(fields: [invitedTenantId], references: [id], onDelete: Cascade)

  @@index([coordinationId, status])
  @@index([invitedTenantId, status])
  @@index([expiresAt])
  @@map("reform_coordination_invitations")
}
```

**Key design decisions**:
1. **`expiresAt` required**: Default 7 days. Expired invitations cannot be accepted.
2. **`invitedTenantId` verified on accept**: The accept service checks `session.tenantId === invitation.invitedTenantId` (T8 mitigation).
3. **Append-only**: RLS blocks UPDATE on most fields; only `status` + acceptance/decline/revocation fields can be updated. DELETE blocked entirely.
4. **`invitedInstitutionId` optional**: Documents which institution the lead expects the tenant to represent.

---

### 2.11 ReformCoordinationSharedSnapshot (NEW — per D6)

**Purpose**: Explicitly shared, reviewer-approved, immutable snapshots. Supports draft mode (private to owner) before approval.

```prisma
model ReformCoordinationSharedSnapshot {
  id              String   @id @default(cuid())
  coordinationId  String
  ownerTenantId   String   // the sharing tenant
  // Content (reviewed before sharing — no classified content)
  snapshotType    String   // "commitment" | "milestone" | "progress" | "outcome" | "constraint"
  title           String   // human-readable (reviewed)
  summary         String   // human-written (reviewed, no classified content)
  // Lifecycle (draft mode supported per owner decision)
  status          String   @default("draft")
  // draft | under_review | approved | revoked
  // draft: private to owner (per owner decision on shared snapshots)
  // under_review: submitted for reviewer approval
  // approved: visible to coordination participants
  // revoked: revoked via revocation table (no UPDATE)
  submittedAt     DateTime?
  approvedAt      DateTime?
  approvedBy      String?   // reviewer userId (required before visible to participants)
  // Classification (always "shared_within_coordination" — never "public")
  classification  String   @default("shared_within_coordination")
  // Linked proposal/action (optional — owner may share context)
  proposalId      String?   // FK to owner's ReformProposal (optional)
  actionId        String?   // FK to owner's ReformAction (optional)
  // Provenance
  createdBy       String   // analyst userId who created
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  metadata        Json     @default("{}")

  coordination   ReformCoordination @relation(fields: [coordinationId], references: [id], onDelete: Cascade)
  ownerTenant    Tenant             @relation(fields: [ownerTenantId], references: [id], onDelete: Cascade)
  proposal       ReformProposal?    @relation(fields: [proposalId], references: [id])
  action         ReformAction?      @relation(fields: [actionId], references: [id])
  revocations    ReformCoordinationSharedSnapshotRevocation[]

  @@index([coordinationId, status])
  @@index([ownerTenantId, status])
  @@map("reform_coordination_shared_snapshots")
}
```

**Key design decisions**:
1. **Draft mode supported** (per owner decision): Snapshots start as `draft` (private to owner). The owner can submit for review (`under_review`), then the reviewer approves (`approved`). Only `approved` snapshots are visible to other participants.
2. **`classification` always `"shared_within_coordination"`**: Never `"public"` — these snapshots are for coordination participants only, not for the public/research tiers (G02-L25 inheritance).
3. **Reviewer approval required**: `approvedBy` + `approvedAt` must be set before the snapshot appears in other participants' shared view.
4. **Revocation via separate table**: To revoke, the owner's reviewer creates a row in `ReformCoordinationSharedSnapshotRevocation` (append-only). The shared view service filters out revoked snapshots.

---

### 2.12 ReformCoordinationSharedSnapshotRevocation (NEW — per D6)

**Purpose**: Append-only revocation records. Allows revoking a shared snapshot without UPDATE on the snapshot table.

```prisma
model ReformCoordinationSharedSnapshotRevocation {
  id              String   @id @default(cuid())
  tenantId        String   // the revoking tenant (must match snapshot's ownerTenantId)
  coordinationId  String
  snapshotId      String
  // Revocation details
  revokedBy       String   // reviewer userId
  revokedAt       DateTime @default(now())
  reason          String   // min 10 chars
  // Provenance
  metadata        Json     @default("{}")

  snapshot        ReformCoordinationSharedSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  @@unique([snapshotId])  // one revocation per snapshot
  @@index([coordinationId])
  @@map("reform_coordination_shared_snapshot_revocations")
}
```

**Key design decisions**:
1. **Append-only**: RLS blocks UPDATE + DELETE. Once a revocation is recorded, it cannot be undone (the snapshot stays revoked). To "un-revoke", create a NEW shared snapshot with the same content.
2. **`@@unique([snapshotId])`**: One revocation per snapshot. Attempting to revoke an already-revoked snapshot fails.
3. **`tenantId` must match `snapshot.ownerTenantId`**: Enforced by RLS (only the owner tenant can INSERT into this table for their snapshots).

---

## 3. Database-Level Enforcement

### 3.1 RLS Policies (all 12 tables)

Each of the 12 new tables gets the appropriate RLS policy pattern:

- **7 core tables**: Standard tenant-isolation RLS (same as G01/G02 pattern)
- **5 coordination tables**: Coordination-aware RLS using `is_coordination_participant()` helper (see `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md` for full policy specifications)

```sql
-- Enable + Force RLS
ALTER TABLE reform_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_proposals FORCE ROW LEVEL SECURITY;

-- balance_app: tenant-scoped access
CREATE POLICY reform_proposals_tenant_isolation ON reform_proposals
  FOR ALL
  TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- balance_admin: full access (for migrations + seed only)
CREATE POLICY reform_proposals_admin_all ON reform_proposals
  FOR ALL
  TO balance_admin
  USING (true)
  WITH CHECK (true);

-- Grant DML to balance_app
GRANT SELECT, INSERT, UPDATE, DELETE ON reform_proposals TO balance_app;

-- (repeat for all 7 tables)
```

### 3.2 Append-Only Tables (UPDATE + DELETE blocked)

For `reform_action_updates`, `reform_approvals`, `reform_feedback_loops`:

```sql
-- Block UPDATE and DELETE for balance_app (append-only / immutable)
REVOKE UPDATE, DELETE ON reform_action_updates FROM balance_app;
REVOKE UPDATE, DELETE ON reform_approvals FROM balance_app;
REVOKE UPDATE, DELETE ON reform_feedback_loops FROM balance_app;
```

These tables can only be INSERT'd into (and SELECT'd from) by `balance_app`. To "correct" an approval, create a new proposal that supersedes the old one — never mutate the approval record itself.

### 3.3 Partial Unique Indexes

```sql
-- Only ONE selected alternative per proposal
CREATE UNIQUE INDEX reform_alternatives_one_selected_per_proposal
  ON reform_alternatives ("tenantId", "proposalId")
  WHERE status = 'selected';

-- Only ONE approval per proposal (already enforced by @@unique in Prisma)
-- (no additional SQL needed — Prisma generates this)
```

### 3.4 Cross-Tenant Triggers (G01/G02 pattern)

```sql
-- Ensure ReformAlternative belongs to the same tenant as its ReformProposal
CREATE OR REPLACE FUNCTION enforce_reform_alternative_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM 1 FROM reform_proposals
  WHERE id = NEW."proposalId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cross-tenant violation: ReformAlternative.tenantId must match ReformProposal.tenantId';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_reform_alternative_same_tenant
  BEFORE INSERT OR UPDATE ON reform_alternatives
  FOR EACH ROW EXECUTE FUNCTION enforce_reform_alternative_same_tenant();

-- (repeat for reform_approvals, reform_actions, reform_action_updates, reform_verifications, reform_feedback_loops)
```

### 3.5 F6 Enforcement Trigger (ReformVerification)

```sql
-- F6: verifiedAction + evidenceSource required when verificationStatus = "verified"
CREATE OR REPLACE FUNCTION enforce_reform_verification_f6()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."verificationStatus" = 'verified' THEN
    IF NEW."verifiedAction" IS NULL OR btrim(NEW."verifiedAction") = '' THEN
      RAISE EXCEPTION 'F6 violation: verifiedAction is required when verificationStatus = verified. Describe the SPECIFIC action verified (e.g., "memo #X issued"), NOT a policy outcome.';
    END IF;
    IF NEW."evidenceSource" IS NULL OR btrim(NEW."evidenceSource") = '' THEN
      RAISE EXCEPTION 'F6 violation: evidenceSource is required when verificationStatus = verified.';
    END IF;
  END IF;
  IF NEW."verificationStatus" = 'disputed' THEN
    IF NEW."disputeReason" IS NULL OR btrim(NEW."disputeReason") = '' THEN
      RAISE EXCEPTION 'F6 violation: disputeReason is required when verificationStatus = disputed.';
    END IF;
    IF NEW."disputeEvidenceSource" IS NULL OR btrim(NEW."disputeEvidenceSource") = '' THEN
      RAISE EXCEPTION 'F6 violation: disputeEvidenceSource is required when verificationStatus = disputed.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_reform_verification_f6
  BEFORE INSERT OR UPDATE ON reform_verifications
  FOR EACH ROW EXECUTE FUNCTION enforce_reform_verification_f6();
```

### 3.6 Attribution Level Trigger (ReformFeedbackLoop)

```sql
-- Invariant #1: attributionLevel = "descriptive" always
CREATE OR REPLACE FUNCTION enforce_reform_feedback_attribution_descriptive()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."attributionLevel" IS DISTINCT FROM 'descriptive' THEN
    RAISE EXCEPTION 'Invariant violation: ReformFeedbackLoop.attributionLevel must always be "descriptive". Causal claims are forbidden.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_reform_feedback_attribution_descriptive
  BEFORE INSERT OR UPDATE ON reform_feedback_loops
  FOR EACH ROW EXECUTE FUNCTION enforce_reform_feedback_attribution_descriptive();
```

### 3.7 Supersession Trigger (ReformProposal) — Historical Preservation

**Owner directive (REV 3)**: "لا تنقل الروابط التاريخية للمقترحات أو الموافقات القديمة إلى تنسيق بديل بصمت. يجب أن يدعم supersession تاريخاً واضحاً وروابط ثابتة، مع سجلات تدقيق تشرح الإحلال."

The supersession trigger enforces **historical preservation** — it does NOT rewrite old proposals' `coordinationId` or any other historical link.

```sql
-- When a proposal is superseded, set supersededAt + status
-- CRITICAL: This trigger does NOT modify the old proposal's coordinationId, 
-- strategyVersionId, or any other historical link. The old proposal's 
-- context is preserved exactly as it was when it was approved.
CREATE OR REPLACE FUNCTION enforce_reform_proposal_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'superseded' AND OLD.status != 'superseded' THEN
    IF NEW."supersededById" IS NULL THEN
      RAISE EXCEPTION 'supersededById is required when status = superseded';
    END IF;
    IF NEW."supersededAt" IS NULL THEN
      NEW."supersededAt" := NOW();
    END IF;
    -- CRITICAL: Do NOT modify coordinationId, strategyVersionId, or other historical links.
    -- The old proposal's context stays as it was when approved.
    -- The supersession is a documented historical link, NOT a rewrite.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_reform_proposal_supersession
  BEFORE UPDATE ON reform_proposals
  FOR EACH ROW EXECUTE FUNCTION enforce_reform_proposal_supersession();
```

#### 3.7.1 Coordination Supersession (Historical Link)

```sql
-- When a coordination is superseded, the same historical-preservation rule applies:
-- do NOT rewrite old proposals' coordinationId to the new coordination.
-- The new coordination must explicitly link its own proposals.
CREATE OR REPLACE FUNCTION enforce_reform_coordination_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'superseded' AND OLD.status != 'superseded' THEN
    IF NEW."supersededById" IS NULL THEN
      RAISE EXCEPTION 'supersededById is required when coordination status = superseded';
    END IF;
    IF NEW."supersededAt" IS NULL THEN
      NEW."supersededAt" := NOW();
    END IF;
    -- CRITICAL: Do NOT update reform_proposals.coordinationId for old proposals.
    -- Old proposals retain their original coordinationId (pointing to this superseded coordination).
    -- New proposals are created with the new coordinationId (pointing to the superseding coordination).
    -- This preserves the historical context of each proposal.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_reform_coordination_supersession
  BEFORE UPDATE ON reform_coordinations
  FOR EACH ROW EXECUTE FUNCTION enforce_reform_coordination_supersession();
```

#### 3.7.2 Audit Trail for Supersession

Every supersession is atomically audited via `writeAuditTx`:

```typescript
// Service-layer audit (inside the supersession transaction)
await writeAuditTx(tx, {
  tenantId,
  actor: userId,
  action: "reform.proposal_superseded",  // or "reform.coordination_superseded"
  status: "ok",
  details: {
    supersededProposalId: oldProposalId,
    supersedingProposalId: newProposalId,
    reason: "New proposal approved for same originating alert",
    // CRITICAL: historical context preserved
    oldProposalCoordinationId: oldProposal.coordinationId,  // unchanged
    oldProposalStrategyVersionId: oldProposal.strategyVersionId,  // unchanged
  },
});
```

The audit entry records:
- **What was superseded** (old proposal ID)
- **What superseded it** (new proposal ID)
- **Why** (reason)
- **Historical context preserved** (old proposal's coordinationId, strategyVersionId — NOT modified)

This ensures the audit trail explains the supersession without rewriting history.

---

## 4. Cross-Entity Relationships

### 4.1 Relationship Diagram (text)

```
Tenant (G00)
  │
  ├── ReformProposal (G03)
  │     │
  │     ├── originatingAlertId? ──── Alert (G02, read-only)
  │     ├── originatingVarianceRecordId? ── VarianceRecord (G02, read-only)
  │     ├── strategyVersionId? ───── StrategyVersion (G01, read-only)
  │     ├── objectiveId? ─────────── Objective (G01, read-only)
  │     │
  │     ├── ReformAlternative[] (G03)
  │     │     │
  │     │     └── (one selected) ── ReformApproval.alternativeId
  │     │
  │     ├── ReformApproval? (G03, one per proposal)
  │     │     │
  │     │     └── supportingEvidence/counterEvidence ── Evidence (G00, snapshot)
  │     │
  │     ├── ReformAction[] (G03)
  │     │     │
  │     │     ├── programId? ─────── Program (G01, read-only)
  │     │     ├── projectId? ─────── Project (G01, read-only)
  │     │     │
  │     │     ├── ReformActionUpdate[] (G03, append-only)
  │     │     │     └── evidenceIds[] ── Evidence (G00, live link)
  │     │     │
  │     │     ├── ReformVerification? (G03, one per action)
  │     │     │     └── (F6 pattern: verifiedAction + evidenceSource)
  │     │     │
  │     │     └── ReformFeedbackLoop? (G03, one per action)
  │     │           ├── beforeObservationId? ── Observation (G02, read-only)
  │     │           ├── afterObservationId? ─── Observation (G02, created via ingestObservation)
  │     │           ├── newVarianceRecordId? ─── VarianceRecord (G02, created via computeVariance)
  │     │           └── attributionLevel = "descriptive" (always)
  │     │
  │     └── supersededById? (self-reference)
  │
  └── Event[] (G00 — generic timeline, reform.* events)
```

### 4.2 Foreign Key Summary

| From (G03) | To (G00/G01/G02) | Type | Behavior |
|------------|------------------|------|----------|
| ReformProposal.originatingAlertId | Alert (G02) | Optional FK | `ON DELETE SET NULL` — alert deletion doesn't cascade to proposal |
| ReformProposal.originatingVarianceRecordId | VarianceRecord (G02) | Optional FK | `ON DELETE SET NULL` |
| ReformProposal.strategyVersionId | StrategyVersion (G01) | Optional FK | `ON DELETE SET NULL` (G01 doesn't delete approved versions, but safe default) |
| ReformProposal.objectiveId | Objective (G01) | Optional FK | `ON DELETE SET NULL` |
| ReformAlternative.proposalId | ReformProposal | Required FK | `ON DELETE CASCADE` — deleting a proposal deletes its alternatives |
| ReformApproval.proposalId | ReformProposal | Required FK | `ON DELETE CASCADE` |
| ReformApproval.alternativeId | ReformAlternative | Required FK | `ON DELETE CASCADE` |
| ReformAction.proposalId | ReformProposal | Required FK | `ON DELETE CASCADE` |
| ReformAction.alternativeId | ReformAlternative | Required FK | `ON DELETE CASCADE` |
| ReformAction.programId | Program (G01) | Optional FK | `ON DELETE SET NULL` |
| ReformAction.projectId | Project (G01) | Optional FK | `ON DELETE SET NULL` |
| ReformActionUpdate.actionId | ReformAction | Required FK | `ON DELETE CASCADE` |
| ReformVerification.actionId | ReformAction | Required FK | `ON DELETE CASCADE` |
| ReformFeedbackLoop.actionId | ReformAction | Required FK | `ON DELETE CASCADE` |
| ReformFeedbackLoop.beforeObservationId | Observation (G02) | Optional FK | `ON DELETE SET NULL` |
| ReformFeedbackLoop.afterObservationId | Observation (G02) | Optional FK | `ON DELETE SET NULL` |
| ReformFeedbackLoop.newVarianceRecordId | VarianceRecord (G02) | Optional FK | `ON DELETE SET NULL` |

**Critical**: G03 → G02 FKs use `ON DELETE SET NULL` (not CASCADE) to prevent G02 cleanup from destroying G03 history. This is the same pattern G02 uses to reference G01 StrategyVersion.

---

## 5. Zod Schema Foundations

> Full Zod schemas are defined in `src/lib/reform/contracts.ts` (created in mission 03-01). This section documents the schema design.

### 5.1 Lifecycle Enums (Zod)

```typescript
export const ReformProposalStatusSchema = z.enum([
  "draft",
  "under_review",
  "approved",
  "rejected",
  "superseded",
]);

export const ReformAlternativeStatusSchema = z.enum([
  "draft",
  "selected",
  "withdrawn",
]);

export const ReformActionStatusSchema = z.enum([
  "planned",
  "in_progress",
  "completed",
  "blocked",
  "cancelled",
]);

export const ReformActionUpdateTypeSchema = z.enum([
  "progress",
  "blocker",
  "milestone",
  "evidence",
  "note",
]);

export const ReformVerificationStatusSchema = z.enum([
  "pending",
  "verified",
  "disputed",
]);

export const ReformFeedbackComparisonTypeSchema = z.enum([
  "before_after",
  "parallel",
  "none",
]);
```

### 5.2 Service Input Schemas (Examples)

```typescript
export const CreateReformProposalInputSchema = z.object({
  originatingAlertId: z.string().min(1).optional(),
  originatingVarianceRecordId: z.string().min(1).optional(),
  strategyVersionId: z.string().min(1).optional(),
  objectiveId: z.string().min(1).optional(),
  title: z.string().min(1).max(500),
  problemStatement: z.string().min(10).max(10000),
  hypothesizedCauses: z.array(z.object({
    cause: z.string().min(1),
    confidenceLevel: z.enum(["low", "medium", "high"]),
    supportingEvidenceIds: z.array(z.string()).default([]),
  })).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const CreateReformAlternativeInputSchema = z.object({
  proposalId: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().min(10).max(20000),
  costEstimateMin: z.number().nonnegative().optional(),
  costEstimateMax: z.number().nonnegative().optional(),
  costCurrency: z.string().min(3).max(3).default("USD"),
  costAssumptions: z.array(z.string()).default([]),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  riskNotes: z.string().optional(),
  feasibilityScore: z.enum(["high", "medium", "low", "unknown"]).default("unknown"),
  feasibilityNotes: z.string().optional(),
  anticipatedOutcomes: z.array(z.object({
    outcome: z.string().min(1),
    direction: z.enum(["improve", "worsen", "neutral"]),
    assumptions: z.array(z.string()).default([]),
    attributionLevel: z.literal("descriptive").default("descriptive"), // hardcoded
  })).default([]),
  assumptions: z.array(z.object({
    title: z.string().min(1),
    description: z.string(),
    validationMethod: z.string().optional(),
  })).default([]),
  draftedVia: z.enum(["human", "llm_advisory", "hybrid"]).default("human"),
  simulated: z.boolean().default(false),
});

export const VerifyReformActionInputSchema = z
  .object({
    actionId: z.string().min(1),
    verificationStatus: z.enum(["verified", "disputed"]),
    // F6 fields (required when verified)
    verifiedAction: z.string().optional(),
    evidenceSource: z.string().optional(),
    notes: z.string().optional(),
    // Dispute fields (required when disputed)
    disputeReason: z.string().optional(),
    disputeEvidenceSource: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.verificationStatus === "verified") {
      if (!val.verifiedAction || val.verifiedAction.trim().length < 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedAction"],
          message:
            "verifiedAction is REQUIRED and must be ≥5 chars when verificationStatus = 'verified'. " +
            "Describe the SPECIFIC action verified (e.g., 'memo #X issued'), NOT a policy outcome.",
        });
      }
      if (!val.evidenceSource || val.evidenceSource.trim().length < 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceSource"],
          message: "evidenceSource is REQUIRED and must be ≥5 chars when verificationStatus = 'verified'.",
        });
      }
      // Reject policy-outcome language
      const policyOutcomePatterns = [
        /\binflation (was )?reduced\b/i,
        /\bunemployment (was )?decreased\b/i,
        /\bgdp (was )?increased\b/i,
        /\bthe policy worked\b/i,
        /\bthe reform caused\b/i,
      ];
      for (const pattern of policyOutcomePatterns) {
        if (val.verifiedAction && pattern.test(val.verifiedAction)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["verifiedAction"],
            message:
              "verifiedAction must describe a SPECIFIC action, not a policy outcome. " +
              "Avoid phrases like 'inflation reduced', 'unemployment decreased', 'reform caused'. " +
              "Use action-specific language like 'memo #X issued', 'infrastructure Y completed'.",
          });
        }
      }
    }
    if (val.verificationStatus === "disputed") {
      if (!val.disputeReason || val.disputeReason.trim().length < 10) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["disputeReason"],
          message: "disputeReason is REQUIRED and must be ≥10 chars when verificationStatus = 'disputed'.",
        });
      }
      if (!val.disputeEvidenceSource || val.disputeEvidenceSource.trim().length < 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["disputeEvidenceSource"],
          message: "disputeEvidenceSource is REQUIRED when verificationStatus = 'disputed'.",
        });
      }
    }
  });
```

---

## 6. Index Strategy

### 6.1 Index Summary

| Table | Index | Purpose |
|-------|-------|---------|
| reform_proposals | `@@index([tenantId, status])` | List proposals by status |
| reform_proposals | `@@index([tenantId, originatingAlertId])` | Find proposals for an alert |
| reform_proposals | `@@index([tenantId, strategyVersionId])` | Find proposals for a strategy |
| reform_proposals | `@@index([tenantId, createdAt])` | Chronological list |
| reform_alternatives | `@@unique([tenantId, proposalId, title])` | Prevent duplicate titles |
| reform_alternatives | `@@index([tenantId, proposalId, status])` | List alternatives by status |
| reform_alternatives | partial unique on `(tenantId, proposalId) WHERE status='selected'` | Only one selected per proposal |
| reform_approvals | `@@unique([tenantId, proposalId])` | One approval per proposal |
| reform_approvals | `@@index([tenantId, approvedAt])` | Chronological approvals |
| reform_actions | `@@index([tenantId, proposalId, status])` | List actions by proposal + status |
| reform_actions | `@@index([tenantId, assignedTo, status])` | User's assigned actions |
| reform_actions | `@@index([tenantId, status, dueDate])` | Overdue actions |
| reform_actions | `@@index([tenantId, programId])` | Actions linked to a program |
| reform_action_updates | `@@index([actionId, at])` | Chronological updates per action |
| reform_action_updates | `@@index([tenantId, at])` | Tenant-wide update feed |
| reform_verifications | `@@unique([tenantId, actionId])` | One verification per action |
| reform_verifications | `@@index([tenantId, verificationStatus])` | List by verification status |
| reform_feedback_loops | `@@unique([tenantId, actionId])` | One feedback loop per action |
| reform_feedback_loops | `@@index([tenantId, createdAt])` | Chronological feedback |

### 6.2 Query Pattern Examples

```typescript
// List all draft proposals for a tenant
await tx.reformProposal.findMany({
  where: { tenantId, status: "draft" },
  orderBy: { createdAt: "desc" },
});

// Find proposals linked to a specific alert
await tx.reformProposal.findMany({
  where: { tenantId, originatingAlertId: alertId },
});

// Get proposal with all alternatives + approval
await tx.reformProposal.findFirst({
  where: { id: proposalId, tenantId },
  include: {
    alternatives: { orderBy: { createdAt: "asc" } },
    approval: { include: { alternative: true } },
    actions: { include: { updates: { orderBy: { at: "desc" } } } },
  },
});

// List overdue actions
await tx.reformAction.findMany({
  where: {
    tenantId,
    status: { in: ["planned", "in_progress"] },
    dueDate: { lt: new Date() },
  },
  orderBy: { dueDate: "asc" },
});

// Get action with verification + feedback loop
await tx.reformAction.findFirst({
  where: { id: actionId, tenantId },
  include: {
    proposal: true,
    alternative: true,
    updates: { orderBy: { at: "desc" }, take: 10 },
    verification: true,
    feedbackLoop: true,
  },
});
```

---

## 7. Seed Extension (Demolandia)

`prisma/seed-ontology.ts` is extended additively to create sample reform data per tenant:

### 7.1 Per-Tenant Seed Data

| Entity | Count per tenant | Notes |
|--------|-----------------|-------|
| ReformProposal | 3 | 1 from alert, 1 from variance, 1 human-initiated |
| ReformAlternative | 2-3 per proposal | One `selected` per approved proposal |
| ReformApproval | 1 per approved proposal | 1 of 3 proposals is approved |
| ReformAction | 1 per approved proposal | Status: planned/in_progress/completed mix |
| ReformActionUpdate | 2-3 per action | Mix of progress/milestone/note |
| ReformVerification | 1 per completed action | Status: verified |
| ReformFeedbackLoop | 1 per verified action | comparisonType: before_after |

### 7.2 Idempotent Re-run

The seed uses upserts keyed on `(tenantId, title)` for proposals and `(tenantId, proposalId, title)` for alternatives — idempotent re-run does not create duplicates.

### 7.3 Sample Proposal (DML-MOP-TENANT)

```typescript
// Sample: Reform proposal from an alert
await upsertReformProposal(tx, {
  tenantId: "DML-MOP-TENANT",
  originatingAlertId: seededAlert.id,
  strategyVersionId: seededStrategyVersion.id,
  title: "Reduce quarterly inflation variance via monetary policy coordination",
  problemStatement:
    "Quarterly inflation has exceeded the planned milestone by 2.3 percentage points " +
    "for two consecutive periods. The variance is descriptive — no causal attribution is made. " +
    "This proposal explores coordinated monetary-fiscal responses.",
  hypothesizedCauses: [
    {
      cause: "Lag in monetary transmission mechanism",
      confidenceLevel: "medium",
      supportingEvidenceIds: [],
    },
  ],
  status: "approved",
  createdBy: seededAnalyst.id,
});
```

---

## 8. Schema Validation Summary

### 8.1 Invariant Coverage

| Invariant | Enforcement Layer | Verification |
|-----------|-------------------|--------------|
| #1 `attributionLevel = "descriptive"` | DB trigger on `reform_feedback_loops` + Zod hardcoded literal | Sentinel integration test |
| #2 StrategyVersion read-only FK | FK reference only — G03 never calls `strategyVersion.update` | Code review + integration test (no UPDATE on G01 tables from G03) |
| #3 Observations append-only | G03 calls `ingestObservation` (G02 contract), never mutates | Integration test (no direct `observation.update` from G03) |
| #6 VarianceRecord.observationId nullable | N/A (G03 doesn't create VarianceRecord directly — calls `computeVariance`) | N/A |
| #7 Lifecycle separated from verification | `ReformAction.status` (lifecycle) vs `ReformVerification.verificationStatus` (verification) | Schema review |
| #8 F6 verifiedAction + evidenceSource | DB trigger + Zod superRefine + service check (triple enforcement) | Sentinel integration test |
| #9 No new tables in service missions | Mission 03-01 is the only schema mission; 03-02 through 03-06 have schema diff = 0 | CI check on migration files |
| #10 `state-builder/` diff = 0 | No imports from `state-builder` that call write operations | CI check |
| #11 `state-observatory/` diff = 0 | No imports from `state-observatory` that call write operations directly (only via exported service contracts) | CI check |

### 8.2 Test Coverage Plan

| Test | Layer | Verifies |
|------|-------|----------|
| `g03-01-schema.integration.test.ts` | Integration | Migration applies, RLS enabled, indexes created |
| `g03-01-rls.integration.test.ts` | Integration | Tenant B cannot see Tenant A's reform proposals |
| `g03-01-f6-trigger.integration.test.ts` | Integration | DB trigger blocks F6 violations |
| `g03-01-attribution-trigger.integration.test.ts` | Integration | DB trigger blocks non-"descriptive" attribution |
| `g03-01-append-only.integration.test.ts` | Integration | UPDATE/DELETE on `reform_action_updates` blocked for `balance_app` |
| `g03-01-cross-tenant-trigger.integration.test.ts` | Integration | Cross-tenant FK violations blocked by trigger |
| `g03-01-permissions.integration.test.ts` | Integration | 9 new permissions work correctly per role |

---

## 9. Migration File (03-01 Preview)

> The actual migration SQL is written in mission 03-01. This section previews the structure.

```
prisma/migrations/20261018000022_g03_reform_bootstrap/
├── migration.sql    # ~600 lines (was ~400 — added coordination tables + helper function)
└── migration_lock.toml
```

**migration.sql contents (in order)**:

1. `CREATE TABLE reform_proposals (...)` (with `coordinationId` field per D6)
2. `CREATE TABLE reform_alternatives (...)`
3. `CREATE TABLE reform_approvals (...)`
4. `CREATE TABLE reform_actions (...)`
5. `CREATE TABLE reform_action_updates (...)`
6. `CREATE TABLE reform_verifications (...)`
7. `CREATE TABLE reform_feedback_loops (...)`
8. `CREATE TABLE reform_coordinations (...)` (per D6)
9. `CREATE TABLE reform_coordination_participants (...)` (per D6)
10. `CREATE TABLE reform_coordination_invitations (...)` (per D6)
11. `CREATE TABLE reform_coordination_shared_snapshots (...)` (per D6)
12. `CREATE TABLE reform_coordination_shared_snapshot_revocations (...)` (per D6)
13. `CREATE INDEX ...` (all indexes)
14. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (all 12 tables)
15. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` (all 12 tables)
16. `CREATE POLICY ... FOR balance_app` (7 core tables — standard tenant isolation)
17. `CREATE POLICY ... FOR balance_admin` (all 12 tables)
18. `CREATE FUNCTION public.is_coordination_participant(TEXT) RETURNS BOOLEAN ...` (SECURITY INVOKER, per Security Contract §2)
19. `GRANT EXECUTE ON FUNCTION ... TO balance_app, balance_admin`
20. `CREATE POLICY reform_coordinations_select ... USING (leadTenantId = ... OR is_coordination_participant(...))` (coordination-aware RLS — see Security Contract §3)
21. `CREATE POLICY reform_coordination_participants_*` (coordination RLS)
22. `CREATE POLICY reform_coordination_invitations_*` (coordination RLS)
23. `CREATE POLICY reform_coordination_shared_snapshots_*` (coordination RLS)
24. `CREATE POLICY reform_coordination_shared_snapshot_revocations_*` (coordination RLS)
25. `GRANT SELECT, INSERT, UPDATE, DELETE ON 7 core tables TO balance_app` (with appropriate restrictions)
26. `GRANT SELECT, INSERT, UPDATE ON coordination tables TO balance_app` (with restrictions per Security Contract §6.1)
27. `REVOKE UPDATE, DELETE ON reform_action_updates FROM balance_app`
28. `REVOKE UPDATE, DELETE ON reform_approvals FROM balance_app`
29. `REVOKE UPDATE, DELETE ON reform_feedback_loops FROM balance_app`
30. `REVOKE UPDATE, DELETE ON reform_coordination_shared_snapshots FROM balance_app`
31. `REVOKE UPDATE, DELETE ON reform_coordination_shared_snapshot_revocations FROM balance_app`
32. `REVOKE DELETE ON reform_coordination_invitations FROM balance_app`
33. `CREATE UNIQUE INDEX reform_alternatives_one_selected_per_proposal ...`
34. `CREATE UNIQUE INDEX reform_coordination_shared_snapshot_revocations_one_per_snapshot ...`
35. `CREATE FUNCTION enforce_reform_alternative_same_tenant() ...` (cross-tenant trigger)
36. `CREATE TRIGGER enforce_reform_alternative_same_tenant ...`
37. (repeat cross-tenant triggers for approvals, actions, action_updates, verifications, feedback_loops)
38. `CREATE FUNCTION enforce_reform_verification_f6() ...`
39. `CREATE TRIGGER enforce_reform_verification_f6 ...`
40. `CREATE FUNCTION enforce_reform_feedback_attribution_descriptive() ...`
41. `CREATE TRIGGER enforce_reform_feedback_attribution_descriptive ...`
42. `CREATE FUNCTION enforce_reform_proposal_supersession() ...` (preserves historical links — see §3.8)
43. `CREATE TRIGGER enforce_reform_proposal_supersession ...`
44. `CREATE FUNCTION enforce_reform_coordination_supersession() ...` (preserves historical links)
45. `CREATE TRIGGER enforce_reform_coordination_supersession ...`
46. `CREATE FUNCTION enforce_coordination_approval_policy_immutable() ...` (blocks UPDATE on approvalPolicy)
47. `CREATE TRIGGER enforce_coordination_approval_policy_immutable ...`
48. `CREATE FUNCTION enforce_coordination_activation() ...` (sets status=active when ALL linked proposals approved)
49. `CREATE TRIGGER enforce_coordination_activation ...` (fires on ReformProposal status change)

---

## 10. Conclusion

The domain model proposed here introduces **12 new PRIVATE tables** (7 core + 5 coordination) with **50+ fields**, **25+ indexes**, **12 RLS policies** (7 standard + 5 coordination-aware), **1 SECURITY INVOKER helper function**, **8 cross-tenant triggers**, **1 F6 enforcement trigger**, **1 attribution-level trigger**, **2 supersession triggers** (proposal + coordination), **1 coordination approval policy immutability trigger**, and **1 coordination activation trigger**. All tables follow the proven G01/G02 pattern: tenant-scoped, RLS-enforced, append-only where history matters, immutable where sovereignty matters.

The model honors all 14 inherited invariants and introduces **10 new G03 invariants** that become frozen after owner approval. The DB-level enforcement (triggers + RLS + SECURITY INVOKER function) ensures that invariants cannot be bypassed by application bugs — the database itself rejects violations.

**Coordination-specific guarantees** (per `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md`):
- No cross-tenant data leak via coordination system (RLS + SECURITY INVOKER)
- No RLS bypass (function uses caller's privileges)
- No data exfiltration via helper function (returns BOOLEAN only)
- Append-only history (snapshots, revocations, invitations)
- Audit trail completeness (every coordination action atomically audited)
- 20 negative tests verify the contract on real PostgreSQL 16

---

*End of G03-00 Domain Model. Companion documents: WORKFLOW_AND_APPROVALS.md, INTEGRATION_CONTRACTS.md, SECURITY_AND_EVIDENCE_POLICY.md.*
