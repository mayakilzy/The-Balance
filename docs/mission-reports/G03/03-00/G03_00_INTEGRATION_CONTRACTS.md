# G03-00 — Integration Contracts

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Service contract specification (DESIGN ONLY — no code)
> **Date:** 2026-10-18
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner + reviewer approval
> **Companion to:** `G03_00_ARCHITECTURE_PROPOSAL.md` §2.2, §4.2

---

## 1. Overview

This document specifies the **service contracts** for GROUP 03: function signatures, input/output types, error behavior, and integration points with G00/G01/G02. All contracts follow the proven G02 pattern (Zod-validated inputs, `withAuthenticatedTenant` wrapping, atomic audit via `writeAuditTx`).

### 1.1 Contract Layers

| Layer | Location | Pattern |
|-------|----------|---------|
| **Tier 1: Pure contracts** | `src/lib/reform/contracts.ts` | Zod schemas, enums, error classes, type re-exports |
| **Tier 2: Domain services** | `src/lib/reform/*-service.ts` | Business logic, DB operations, audit |
| **Tier 3: API routes** | `src/app/api/v1/reform/*/route.ts` | HTTP layer, request validation, response shaping |

### 1.2 Service Modules (11 planned)

| # | Module | File | Mission | Purpose |
|---|--------|------|---------|---------|
| 1 | Contracts | `contracts.ts` | 03-01 | Zod schemas, enums, error classes |
| 2 | Reform Proposal | `reform-proposal-service.ts` | 03-02 | Proposal CRUD + lifecycle |
| 3 | Reform Alternative | `reform-alternative-service.ts` | 03-02 | Alternative CRUD + selection |
| 4 | Reform Comparison | `reform-comparison-service.ts` | 03-03 | Deterministic alternative comparison |
| 5 | Reform Advisor | `reform-advisor-service.ts` | 03-03 | LLM-assisted drafting (advisory only) |
| 6 | Reform Approval | `reform-approval-service.ts` | 03-04 | Atomic approval + evidence snapshot |
| 7 | Reform Action | `reform-action-service.ts` | 03-05 | Action CRUD + lifecycle |
| 8 | Reform Action Update | `reform-action-update-service.ts` | 03-05 | Append-only progress log |
| 9 | Reform Verification | `reform-verification-service.ts` | 03-06 | F6-pattern verification |
| 10 | Reform Feedback | `reform-feedback-service.ts` | 03-06 | Descriptive feedback loop to observatory |
| 11 | Reform Query | `reform-query-service.ts` | 03-06 | Cross-entity snapshot (like G02 ObservatoryQuery) |

### 1.3 Barrel Export Pattern

`src/lib/reform/index.ts` exports all public APIs (mirrors G02's `state-observatory/index.ts`):

```typescript
export * from "./contracts";
export * from "./reform-proposal-service";
export * from "./reform-alternative-service";
export * from "./reform-comparison-service";
export * from "./reform-advisor-service";
export * from "./reform-approval-service";
export * from "./reform-action-service";
export * from "./reform-action-update-service";
export * from "./reform-verification-service";
export * from "./reform-feedback-service";
export * from "./reform-query-service";
```

---

## 2. Error Classes (Inherited from G02)

G03 reuses G02's three error classes (defined in `src/lib/state-observatory/contracts.ts`):

| Error | When thrown | HTTP status | Example |
|-------|-------------|--------------|---------|
| `PermissionDeniedError` | Permission check fails | 403 | Analyst tries to approve a proposal |
| `NotFoundError` | Entity not found in tenant scope | 404 | Proposal ID does not exist in tenant |
| `ConflictError` | Lifecycle transition invalid | 409 | Approving an already-approved proposal |

**Import**: `import { NotFoundError, ConflictError, PermissionDeniedError } from "@/lib/state-observatory";`

All other errors are sanitized by `src/lib/error-sanitizer.ts` (G00) — strips file paths, SQL fragments, env var names, stack traces, truncates to 300 chars.

---

## 3. Contracts (Tier 1 — Pure Schemas)

### 3.1 Type Re-exports

```typescript
// Re-export Prisma types for service signatures (single source of truth)
import type {
  ReformProposal as PrismaReformProposal,
  ReformAlternative as PrismaReformAlternative,
  ReformApproval as PrismaReformApproval,
  ReformAction as PrismaReformAction,
  ReformActionUpdate as PrismaReformActionUpdate,
  ReformVerification as PrismaReformVerification,
  ReformFeedbackLoop as PrismaReformFeedbackLoop,
} from "@prisma/client";

export type ReformProposal = PrismaReformProposal;
export type ReformAlternative = PrismaReformAlternative;
export type ReformApproval = PrismaReformApproval;
export type ReformAction = PrismaReformAction;
export type ReformActionUpdate = PrismaReformActionUpdate;
export type ReformVerification = PrismaReformVerification;
export type ReformFeedbackLoop = PrismaReformFeedbackLoop;
```

### 3.2 Lifecycle Enums

(Defined in `G03_00_DOMAIN_MODEL.md` §5.1 — repeated here for contract completeness)

```typescript
export const ReformProposalStatusSchema = z.enum([
  "draft", "under_review", "approved", "rejected", "superseded",
]);
export const ReformAlternativeStatusSchema = z.enum([
  "draft", "selected", "withdrawn",
]);
export const ReformActionStatusSchema = z.enum([
  "planned", "in_progress", "completed", "blocked", "cancelled",
]);
export const ReformActionUpdateTypeSchema = z.enum([
  "progress", "blocker", "milestone", "evidence", "note",
]);
export const ReformVerificationStatusSchema = z.enum([
  "pending", "verified", "disputed",
]);
export const ReformFeedbackComparisonTypeSchema = z.enum([
  "before_after", "parallel", "none",
]);
export const ReformRiskLevelSchema = z.enum([
  "low", "medium", "high", "critical",
]);
export const ReformFeasibilityScoreSchema = z.enum([
  "high", "medium", "low", "unknown",
]);
```

### 3.3 Shared Types

```typescript
export interface EvidenceSnapshot {
  evidenceId: string;
  claim: string;
  type: string;
  verificationStatus: string;
  sourceCode: string | null;
}

export interface HypothesizedCause {
  cause: string;
  confidenceLevel: "low" | "medium" | "high";
  supportingEvidenceIds: string[];
}

export interface AnticipatedOutcome {
  outcome: string;
  direction: "improve" | "worsen" | "neutral";
  assumptions: string[];
  attributionLevel: "descriptive"; // hardcoded
}

export interface ReformAssumption {
  title: string;
  description: string;
  validationMethod?: string;
}
```

### 3.4 Service Input Schemas (Full)

#### 3.4.1 Reform Proposal Inputs

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
}).superRefine((val, ctx) => {
  // If both originatingAlertId and originatingVarianceRecordId are set,
  // they must belong to the same strategy version (if either references one)
  // (service layer does the actual cross-check; Zod just ensures types)
});
export type CreateReformProposalInput = z.infer<typeof CreateReformProposalInputSchema>;

export const SubmitForReviewInputSchema = z.object({
  proposalId: z.string().min(1),
  notes: z.string().optional(),
});
export type SubmitForReviewInput = z.infer<typeof SubmitForReviewInputSchema>;

export const RejectReformProposalInputSchema = z.object({
  proposalId: z.string().min(1),
  rejectionReason: z.string().min(10).max(5000),
});
export type RejectReformProposalInput = z.infer<typeof RejectReformProposalInputSchema>;

export const ReturnForRevisionInputSchema = z.object({
  proposalId: z.string().min(1),
  revisionNotes: z.string().min(10).max(5000),
});
export type ReturnForRevisionInput = z.infer<typeof ReturnForRevisionInputSchema>;
```

#### 3.4.2 Reform Alternative Inputs

```typescript
export const CreateReformAlternativeInputSchema = z.object({
  proposalId: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().min(10).max(20000),
  costEstimateMin: z.number().nonnegative().optional(),
  costEstimateMax: z.number().nonnegative().optional(),
  costCurrency: z.string().min(3).max(3).default("USD"),
  costAssumptions: z.array(z.string()).default([]),
  riskLevel: ReformRiskLevelSchema.default("medium"),
  riskNotes: z.string().optional(),
  feasibilityScore: ReformFeasibilityScoreSchema.default("unknown"),
  feasibilityNotes: z.string().optional(),
  anticipatedOutcomes: z.array(z.object({
    outcome: z.string().min(1),
    direction: z.enum(["improve", "worsen", "neutral"]),
    assumptions: z.array(z.string()).default([]),
    attributionLevel: z.literal("descriptive").default("descriptive"),
  })).default([]),
  assumptions: z.array(z.object({
    title: z.string().min(1),
    description: z.string(),
    validationMethod: z.string().optional(),
  })).default([]),
  draftedVia: z.enum(["human", "llm_advisory", "hybrid"]).default("human"),
  simulated: z.boolean().default(false),
}).superRefine((val, ctx) => {
  if (val.costEstimateMin !== undefined && val.costEstimateMax !== undefined) {
    if (val.costEstimateMin > val.costEstimateMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costEstimateMax"],
        message: "costEstimateMax must be >= costEstimateMin",
      });
    }
  }
});
export type CreateReformAlternativeInput = z.infer<typeof CreateReformAlternativeInputSchema>;

export const SelectAlternativeInputSchema = z.object({
  proposalId: z.string().min(1),
  alternativeId: z.string().min(1),
  selectionRationale: z.string().min(10).max(2000).optional(),
});
export type SelectAlternativeInput = z.infer<typeof SelectAlternativeInputSchema>;

export const WithdrawAlternativeInputSchema = z.object({
  alternativeId: z.string().min(1),
  withdrawalReason: z.string().min(10).max(2000),
});
export type WithdrawAlternativeInput = z.infer<typeof WithdrawAlternativeInputSchema>;
```

#### 3.4.3 Reform Approval Inputs

```typescript
export const ApproveReformProposalInputSchema = z.object({
  proposalId: z.string().min(1),
  alternativeId: z.string().min(1),
  rationale: z.string().min(20).max(10000),
  approvalNotes: z.string().max(5000).optional(),
  supportingEvidenceIds: z.array(z.string()).default([]),
  counterEvidenceIds: z.array(z.string()).default([]),
});
export type ApproveReformProposalInput = z.infer<typeof ApproveReformProposalInputSchema>;
```

#### 3.4.4 Reform Action Inputs

```typescript
export const CreateReformActionInputSchema = z.object({
  proposalId: z.string().min(1),
  alternativeId: z.string().min(1),
  programId: z.string().min(1).optional(), // optional link to G01 Program
  projectId: z.string().min(1).optional(), // optional link to G01 Project
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  assignedTo: z.string().min(1).optional(),
  startDate: z.date().optional(),
  dueDate: z.date().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((val, ctx) => {
  if (val.startDate && val.dueDate && val.startDate > val.dueDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dueDate"],
      message: "dueDate must be >= startDate",
    });
  }
});
export type CreateReformActionInput = z.infer<typeof CreateReformActionInputSchema>;

export const StartReformActionInputSchema = z.object({
  actionId: z.string().min(1),
  actualStartDate: z.date().optional(),
});
export type StartReformActionInput = z.infer<typeof StartReformActionInputSchema>;

export const BlockReformActionInputSchema = z.object({
  actionId: z.string().min(1),
  blockerDescription: z.string().min(10).max(5000),
});
export type BlockReformActionInput = z.infer<typeof BlockReformActionInputSchema>;

export const CompleteReformActionInputSchema = z.object({
  actionId: z.string().min(1),
  completionNotes: z.string().max(5000).optional(),
  actualCompletedDate: z.date().optional(),
});
export type CompleteReformActionInput = z.infer<typeof CompleteReformActionInputSchema>;

export const CancelReformActionInputSchema = z.object({
  actionId: z.string().min(1),
  cancellationReason: z.string().min(10).max(5000),
});
export type CancelReformActionInput = z.infer<typeof CancelReformActionInputSchema>;
```

#### 3.4.5 Reform Action Update Inputs

```typescript
export const AddReformActionUpdateInputSchema = z.object({
  actionId: z.string().min(1),
  updateType: ReformActionUpdateTypeSchema,
  notes: z.string().min(1).max(10000),
  progressPercentage: z.number().int().min(0).max(100).optional(),
  evidenceIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((val, ctx) => {
  if (val.updateType === "progress" && val.progressPercentage === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["progressPercentage"],
      message: "progressPercentage is required when updateType = 'progress'",
    });
  }
});
export type AddReformActionUpdateInput = z.infer<typeof AddReformActionUpdateInputSchema>;
```

#### 3.4.6 Reform Verification Inputs

(Defined in `G03_00_DOMAIN_MODEL.md` §5.2 — `VerifyReformActionInputSchema` with F6 `superRefine`)

```typescript
export const VerifyReformActionInputSchema = z
  .object({
    actionId: z.string().min(1),
    verificationStatus: z.enum(["verified", "disputed"]),
    verifiedAction: z.string().optional(),
    evidenceSource: z.string().optional(),
    notes: z.string().optional(),
    disputeReason: z.string().optional(),
    disputeEvidenceSource: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    // F6 enforcement (also enforced by DB trigger)
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
      // Reject policy-outcome language (defense in depth)
      const policyOutcomePatterns = [
        /\binflation (was )?reduced\b/i,
        /\bunemployment (was )?decreased\b/i,
        /\bgdp (was )?increased\b/i,
        /\bthe policy worked\b/i,
        /\bthe reform caused\b/i,
        /\bthis action caused\b/i,
      ];
      for (const pattern of policyOutcomePatterns) {
        if (val.verifiedAction && pattern.test(val.verifiedAction)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["verifiedAction"],
            message:
              "verifiedAction must describe a SPECIFIC action, not a policy outcome. " +
              "Avoid causal language. Use action-specific language.",
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
export type VerifyReformActionInput = z.infer<typeof VerifyReformActionInputSchema>;
```

#### 3.4.7 Reform Feedback Loop Inputs

```typescript
export const CreateReformFeedbackLoopInputSchema = z.object({
  actionId: z.string().min(1),
  comparisonType: ReformFeedbackComparisonTypeSchema,
  descriptiveSummary: z.string().min(20).max(20000),
  afterObservationInput: z.object({
    indicatorDefinitionId: z.string().min(1),
    observationPeriodId: z.string().min(1),
    observedValue: z.number().nullable(),
    originType: z.enum(["observed", "derived", "synthetic"]),
    verificationStatus: z.enum(["unverified", "verified", "disputed", "rejected"]).optional(),
    derivationMethod: z.string().optional(),
    sourceId: z.string().optional(),
    evidenceId: z.string().optional(),
    isSynthetic: z.boolean().optional(),
    observedAt: z.date().optional(),
    qualityNotes: z.record(z.string(), z.unknown()).optional(),
    geoLevel: z.enum(["national", "sectoral", "institutional", "subnational"]).optional(),
    geoRefId: z.string().optional(),
  }).optional(),
  computeNewVariance: z.boolean().default(false),
  // attributionLevel is NOT in the input — it's hardcoded to "descriptive" in the service
}).superRefine((val, ctx) => {
  // Reject causal language in descriptiveSummary (defense in depth)
  const causalPatterns = [
    /\bcaused\b/i,
    /\bdue to\b/i,
    /\bas a result of\b/i,
    /\bthe reform led to\b/i,
    /\bthis action resulted in\b/i,
  ];
  for (const pattern of causalPatterns) {
    if (pattern.test(val.descriptiveSummary)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["descriptiveSummary"],
        message:
          "descriptiveSummary must be DESCRIPTIVE, not causal. " +
          "Avoid phrases like 'caused', 'due to', 'as a result of', 'led to'. " +
          "Use descriptive language like 'after the reform, the indicator was observed at X'.",
      });
    }
  }
});
export type CreateReformFeedbackLoopInput = z.infer<typeof CreateReformFeedbackLoopInputSchema>;
```

---

## 4. Service Signatures (Tier 2)

### 4.1 Reform Proposal Service

```typescript
// reform-proposal-service.ts

export async function createReformProposal(
  session: Session,
  input: CreateReformProposalInput
): Promise<{ proposalId: string }>;

export async function getReformProposal(
  session: Session,
  proposalId: string
): Promise<ReformProposal | null>;

export async function listReformProposals(
  session: Session,
  filters: {
    status?: ReformProposalStatus;
    originatingAlertId?: string;
    strategyVersionId?: string;
    objectiveId?: string;
    cursor?: string;
    limit?: number;
  }
): Promise<{ proposals: ReformProposal[]; nextCursor: string | null }>;

export async function submitForReview(
  session: Session,
  input: SubmitForReviewInput
): Promise<{ proposalId: string; status: string }>;

export async function rejectReformProposal(
  session: Session,
  input: RejectReformProposalInput
): Promise<{ proposalId: string; status: string }>;

export async function returnForRevision(
  session: Session,
  input: ReturnForRevisionInput
): Promise<{ proposalId: string; status: string }>;

export async function archiveReformProposal(
  session: Session,
  proposalId: string
): Promise<{ proposalId: string; archivedAt: Date }>;
```

### 4.2 Reform Alternative Service

```typescript
// reform-alternative-service.ts

export async function addReformAlternative(
  session: Session,
  input: CreateReformAlternativeInput
): Promise<{ alternativeId: string }>;

export async function listReformAlternatives(
  session: Session,
  proposalId: string
): Promise<ReformAlternative[]>;

export async function selectAlternative(
  session: Session,
  input: SelectAlternativeInput
): Promise<{ alternativeId: string; status: string }>;

export async function withdrawAlternative(
  session: Session,
  input: WithdrawAlternativeInput
): Promise<{ alternativeId: string; status: string }>;
```

### 4.3 Reform Comparison Service (Deterministic)

```typescript
// reform-comparison-service.ts

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
  // Descriptive comparison matrix — NO ranking, NO recommendation
  comparisonMatrix: {
    dimensions: string[]; // ["cost", "risk", "feasibility", "assumptions", "outcomes"]
    notes: string; // human-readable descriptive summary
  };
  // NO "recommended" field — the human selects, not the system
}

export async function compareReformAlternatives(
  session: Session,
  proposalId: string
): Promise<AlternativeComparison>;
```

**Critical**: This service does NOT recommend. It presents a descriptive comparison matrix. The reviewer selects based on judgment, not system ranking.

### 4.4 Reform Advisor Service (LLM-assisted, Advisory Only)

```typescript
// reform-advisor-service.ts

export interface AdvisorDraftResult {
  draft: string;
  simulated: boolean; // always true when StubProvider is active
  provider: string;
  model: string;
  // NO confidence score — LLMs cannot reliably self-assess confidence
  // NO recommendation — advisory only
  warnings: string[]; // e.g., "This is a simulated draft. Review and edit before saving."
}

export async function draftProblemStatement(
  session: Session,
  input: {
    alertId?: string;
    varianceRecordId?: string;
    additionalContext?: string;
  }
): Promise<AdvisorDraftResult>;

export async function draftReformAlternatives(
  session: Session,
  input: {
    proposalId: string;
    count?: number; // default 3
  }
): Promise<AdvisorDraftResult[]>;

export async function draftComparisonSummary(
  session: Session,
  proposalId: string
): Promise<AdvisorDraftResult>;

export async function draftAnticipatedOutcomes(
  session: Session,
  input: { proposalId: string; alternativeId: string }
): Promise<AdvisorDraftResult>;
```

**Critical constraints on advisor output**:
1. Every result carries `simulated: true` when StubProvider is active.
2. The advisor NEVER:
   - Selects an alternative
   - Approves a proposal
   - Verifies an action
   - Makes causal claims
   - Overrides human decisions
3. The output is always a **draft** for human review/edit. The analyst must explicitly accept, edit, or reject the draft before it becomes part of a proposal.

### 4.5 Reform Approval Service

```typescript
// reform-approval-service.ts

export async function approveReformProposal(
  session: Session,
  proposalId: string,
  alternativeId: string,
  input: ApproveReformProposalInput
): Promise<{ approvalId: string; proposalStatus: string }>;

export async function approveReformProposalWithAuditSafe(
  session: Session,
  proposalId: string,
  alternativeId: string,
  input: ApproveReformProposalInput
): Promise<{ approvalId: string; proposalStatus: string }>;

export async function getReformApproval(
  session: Session,
  proposalId: string
): Promise<ReformApproval | null>;
```

### 4.6 Reform Action Service

```typescript
// reform-action-service.ts

export async function createReformAction(
  session: Session,
  input: CreateReformActionInput
): Promise<{ actionId: string }>;

export async function getReformAction(
  session: Session,
  actionId: string
): Promise<ReformAction | null>;

export async function listReformActions(
  session: Session,
  filters: {
    proposalId?: string;
    status?: ReformActionStatus;
    assignedTo?: string;
    programId?: string;
    projectId?: string;
    cursor?: string;
    limit?: number;
  }
): Promise<{ actions: ReformAction[]; nextCursor: string | null }>;

export async function startReformAction(
  session: Session,
  input: StartReformActionInput
): Promise<{ actionId: string; status: string }>;

export async function blockReformAction(
  session: Session,
  input: BlockReformActionInput
): Promise<{ actionId: string; status: string }>;

export async function unblockReformAction(
  session: Session,
  actionId: string,
  unblockNotes: string
): Promise<{ actionId: string; status: string }>;

export async function completeReformAction(
  session: Session,
  input: CompleteReformActionInput
): Promise<{ actionId: string; status: string }>;

export async function cancelReformAction(
  session: Session,
  input: CancelReformActionInput
): Promise<{ actionId: string; status: string }>;
```

### 4.7 Reform Action Update Service

```typescript
// reform-action-update-service.ts

export async function addReformActionUpdate(
  session: Session,
  input: AddReformActionUpdateInput
): Promise<{ updateId: string }>;

export async function listReformActionUpdates(
  session: Session,
  actionId: string,
  options?: { cursor?: string; limit?: number }
): Promise<{ updates: ReformActionUpdate[]; nextCursor: string | null }>;
```

### 4.8 Reform Verification Service

```typescript
// reform-verification-service.ts

export async function verifyReformAction(
  session: Session,
  actionId: string,
  input: VerifyReformActionInput
): Promise<{ verificationId: string; verificationStatus: string }>;

export async function verifyReformActionWithAuditSafe(
  session: Session,
  actionId: string,
  input: VerifyReformActionInput
): Promise<{ verificationId: string; verificationStatus: string }>;

export async function getReformVerification(
  session: Session,
  actionId: string
): Promise<ReformVerification | null>;
```

### 4.9 Reform Feedback Service

```typescript
// reform-feedback-service.ts

export async function createReformFeedbackLoop(
  session: Session,
  actionId: string,
  input: CreateReformFeedbackLoopInput
): Promise<{ feedbackLoopId: string }>;

export async function getReformFeedbackLoop(
  session: Session,
  actionId: string
): Promise<ReformFeedbackLoop | null>;

export async function closeOriginatingAlert(
  session: Session,
  proposalId: string
): Promise<{ alertClosed: boolean }>;
```

### 4.10 Reform Query Service (Cross-Entity Snapshot)

```typescript
// reform-query-service.ts

export interface ReformProposalSnapshot {
  proposal: ReformProposal;
  alternatives: ReformAlternative[];
  approval: ReformApproval | null;
  actions: Array<{
    action: ReformAction;
    updates: ReformActionUpdate[]; // last 10
    verification: ReformVerification | null;
    feedbackLoop: ReformFeedbackLoop | null;
  }>;
  // Cross-entity context (read-only from G01/G02)
  originatingAlert: Alert | null;
  originatingVarianceRecord: VarianceRecord | null;
  strategyVersion: StrategyVersion | null;
  objective: Objective | null;
}

export async function getReformProposalSnapshot(
  session: Session,
  proposalId: string
): Promise<ReformProposalSnapshot | null>;

export interface ReformDashboardSummary {
  // Per-tenant summary statistics
  totalProposals: number;
  proposalsByStatus: Record<ReformProposalStatus, number>;
  totalActions: number;
  actionsByStatus: Record<ReformActionStatus, number>;
  pendingVerifications: number;
  overdueActions: number;
  // Descriptive only — no causal claims
  reformsWithVerifiedFeedback: number;
}

export async function getReformDashboardSummary(
  session: Session
): Promise<ReformDashboardSummary>;
```

---

## 5. API Routes (Tier 3)

### 5.1 Route Map

All routes under `/api/v1/reform/*` follow the G00/G01/G02 REST pattern.

| Method | Path | Permission | Service |
|--------|------|-----------|---------|
| POST | `/api/v1/reform/proposals` | `reform:proposal:write` | `createReformProposal` |
| GET | `/api/v1/reform/proposals` | `reform:proposal:read` | `listReformProposals` |
| GET | `/api/v1/reform/proposals/:id` | `reform:proposal:read` | `getReformProposal` |
| GET | `/api/v1/reform/proposals/:id/snapshot` | `reform:proposal:read` | `getReformProposalSnapshot` |
| POST | `/api/v1/reform/proposals/:id/submit` | `reform:proposal:write` | `submitForReview` |
| POST | `/api/v1/reform/proposals/:id/reject` | `reform:proposal:approve` | `rejectReformProposal` |
| POST | `/api/v1/reform/proposals/:id/return` | `reform:proposal:approve` | `returnForRevision` |
| POST | `/api/v1/reform/proposals/:id/approve` | `reform:proposal:approve` | `approveReformProposalWithAuditSafe` |
| POST | `/api/v1/reform/proposals/:id/archive` | `reform:proposal:write` | `archiveReformProposal` |
| POST | `/api/v1/reform/proposals/:id/alternatives` | `reform:alternative:write` | `addReformAlternative` |
| GET | `/api/v1/reform/proposals/:id/alternatives` | `reform:alternative:read` | `listReformAlternatives` |
| POST | `/api/v1/reform/alternatives/:id/select` | `reform:proposal:approve` | `selectAlternative` |
| POST | `/api/v1/reform/alternatives/:id/withdraw` | `reform:proposal:approve` | `withdrawAlternative` |
| GET | `/api/v1/reform/proposals/:id/comparison` | `reform:alternative:read` | `compareReformAlternatives` |
| POST | `/api/v1/reform/advisor/draft-problem-statement` | `reform:proposal:write` | `draftProblemStatement` |
| POST | `/api/v1/reform/advisor/draft-alternatives` | `reform:alternative:write` | `draftReformAlternatives` |
| POST | `/api/v1/reform/advisor/draft-comparison` | `reform:alternative:read` | `draftComparisonSummary` |
| POST | `/api/v1/reform/actions` | `reform:action:write` | `createReformAction` |
| GET | `/api/v1/reform/actions` | `reform:action:read` | `listReformActions` |
| GET | `/api/v1/reform/actions/:id` | `reform:action:read` | `getReformAction` |
| POST | `/api/v1/reform/actions/:id/start` | `reform:action:write` | `startReformAction` |
| POST | `/api/v1/reform/actions/:id/block` | `reform:action:write` | `blockReformAction` |
| POST | `/api/v1/reform/actions/:id/unblock` | `reform:action:write` | `unblockReformAction` |
| POST | `/api/v1/reform/actions/:id/complete` | `reform:action:write` | `completeReformAction` |
| POST | `/api/v1/reform/actions/:id/cancel` | `reform:action:write` | `cancelReformAction` |
| POST | `/api/v1/reform/actions/:id/updates` | `reform:action:write` | `addReformActionUpdate` |
| GET | `/api/v1/reform/actions/:id/updates` | `reform:action:read` | `listReformActionUpdates` |
| POST | `/api/v1/reform/actions/:id/verify` | `reform:action:verify` | `verifyReformActionWithAuditSafe` |
| GET | `/api/v1/reform/actions/:id/verification` | `reform:verification:read` | `getReformVerification` |
| POST | `/api/v1/reform/actions/:id/feedback` | `reform:action:write` | `createReformFeedbackLoop` |
| GET | `/api/v1/reform/actions/:id/feedback` | `reform:verification:read` | `getReformFeedbackLoop` |
| POST | `/api/v1/reform/proposals/:id/close-alert` | `observatory:alert:act` | `closeOriginatingAlert` |
| GET | `/api/v1/reform/dashboard` | `reform:proposal:read` | `getReformDashboardSummary` |

### 5.2 Route Handler Pattern

Each route handler follows the G02 pattern:

```typescript
// src/app/api/v1/reform/proposals/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createReformProposal, CreateReformProposalInputSchema } from "@/lib/reform";
import { PermissionDeniedError } from "@/lib/permissions";
import { NotFoundError, ConflictError } from "@/lib/state-observatory";
import { sanitizeError } from "@/lib/error-sanitizer";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const input = CreateReformProposalInputSchema.parse(body);

    const result = await createReformProposal(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", details: err.issues }, { status: 422 });
    }
    const sanitized = sanitizeError(err);
    return NextResponse.json({ error: sanitized.message }, { status: sanitized.status });
  }
}

export async function GET(request: NextRequest) {
  // ... (list proposals with pagination)
}
```

### 5.3 Rate Limiting

G03 routes inherit G00's rate limiting (per-IP, in-memory). Proposal creation and approval are added to the rate-limited paths:

| Path | Rate limit |
|------|-----------|
| `/api/v1/reform/proposals` (POST) | 20 req/min |
| `/api/v1/reform/proposals/:id/approve` (POST) | 10 req/min |
| `/api/v1/reform/actions/:id/verify` (POST) | 10 req/min |
| Other `/api/v1/reform/*` | 60 req/min (default) |

### 5.4 Response Envelope

All responses follow the G00/G01/G02 pattern:

```json
// Success (201 Created)
{
  "proposalId": "clx..."
}

// Success (200 OK) — single entity
{
  "id": "clx...",
  "title": "...",
  "status": "draft",
  ...
}

// Success (200 OK) — list with pagination
{
  "proposals": [...],
  "nextCursor": "clx..." | null
}

// Error (403 Forbidden)
{
  "error": "Permission denied: reform:proposal:approve"
}

// Error (422 Unprocessable Entity)
{
  "error": "Validation failed",
  "details": [
    { "code": "custom", "path": ["verifiedAction"], "message": "..." }
  ]
}

// Error (500 Internal Server Error) — sanitized
{
  "error": "Request failed"
}
```

---

## 6. Integration with G00/G01/G02 Services

### 6.1 Imports from G02 (Read-Only Function Calls)

G03 services import and call G02 exported functions:

```typescript
// In reform-feedback-service.ts
import {
  ingestObservation,
  computeVariance,
  verifyExecution,
  closeAlert,
  getObservatorySnapshot,
  assessEarlyWarning,
  analyzeTemporalTrend,
} from "@/lib/state-observatory";
```

**Critical**: These are **read-only function calls**. G03 never modifies G02 source files. If G02 contracts are insufficient, the gap is documented as an open decision — G03 does NOT extend G02 without explicit owner approval.

### 6.2 Imports from G01 (Read-Only Function Calls)

```typescript
// In reform-action-service.ts (if linking to G01 entities)
// G01 services are NOT directly called — G03 reads G01 tables via Prisma
// (e.g., tx.program.findFirst) rather than calling G01 service functions.
// This is because G01 services are about CREATING strategies; G03 only reads them.
```

### 6.3 Reuse of G00 Infrastructure

```typescript
// Every G03 service uses:
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole, PermissionDeniedError } from "@/lib/permissions";
import { writeAudit, writeAuditTx } from "@/lib/audit";
import { childLogger } from "@/lib/observability";
```

### 6.4 Optional: Capability Registration

G03 may register capabilities in G00's `Capability` table (for inventory + observability):

```typescript
// In 03-01 seed (optional):
await tx.capability.upsert({
  where: { code: "reform.draft_alternatives" },
  create: {
    code: "reform.draft_alternatives",
    displayName: "Draft Reform Alternatives (LLM Advisory)",
    description: "LLM-assisted drafting of reform alternatives. Advisory only — never authoritative.",
    type: "tool",
    readiness: "stub", // StubProvider active
    requiredPermission: "reform:alternative:write",
    domains: ["reform"],
    metadata: { simulated: true, provider: "stub" },
  },
  update: {},
});
```

This is optional and deferred to 03-03 (advisor mission). The capability registry is for inventory — G03 services do not require capabilities to be registered to function.

---

## 7. Test Contracts

### 7.1 Unit Test Pattern (Tier 1)

```typescript
// tests/unit/reform/contracts.test.ts
import { describe, it, expect } from "vitest";
import { VerifyReformActionInputSchema } from "@/lib/reform/contracts";

describe("VerifyReformActionInputSchema", () => {
  it("rejects verified without verifiedAction", () => {
    const result = VerifyReformActionInputSchema.safeParse({
      actionId: "act1",
      verificationStatus: "verified",
      evidenceSource: "memo #X issued",
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(["verifiedAction"]);
  });

  it("rejects policy-outcome language in verifiedAction", () => {
    const result = VerifyReformActionInputSchema.safeParse({
      actionId: "act1",
      verificationStatus: "verified",
      verifiedAction: "inflation was reduced",
      evidenceSource: "memo #X",
    });
    expect(result.success).toBe(false);
  });

  it("accepts action-specific verifiedAction", () => {
    const result = VerifyReformActionInputSchema.safeParse({
      actionId: "act1",
      verificationStatus: "verified",
      verifiedAction: "memo #X issued by Ministry of Planning",
      evidenceSource: "official gazette #456, page 12",
    });
    expect(result.success).toBe(true);
  });
});
```

### 7.2 Integration Test Pattern (Tier 2 + 3)

```typescript
// tests/integration/g03-04-approval.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FixtureTracker } from "../helpers/fixture-tracker";

describe("G03-04: Reform Approval", () => {
  const tracker = new FixtureTracker();

  beforeAll(async () => {
    // Setup: seed tenant, user, strategy, alert, variance, proposal, alternative
  });

  afterAll(async () => {
    await tracker.cleanup(prismaClient);
  });

  it("approves a proposal atomically with evidence snapshot + audit", async () => {
    const result = await approveReformProposalWithAuditSafe(
      reviewerSession,
      proposalId,
      alternativeId,
      {
        proposalId, alternativeId,
        rationale: "Alternative B has lower risk and aligns with existing program X.",
        supportingEvidenceIds: [evidenceId1, evidenceId2],
      }
    );

    expect(result.proposalStatus).toBe("approved");
    expect(result.approvalId).toBeDefined();

    // Verify evidence snapshot was captured
    const approval = await getReformApproval(reviewerSession, proposalId);
    expect(approval?.supportingEvidence).toHaveLength(2);
    expect(approval?.supportingEvidence[0]).toMatchObject({
      evidenceId: evidenceId1,
      claim: expect.any(String),
      verificationStatus: expect.any(String),
    });

    // Verify audit log entry
    const audit = await prismaClient.auditLog.findFirst({
      where: { action: "reform.proposal_approved", status: "ok" },
    });
    expect(audit).toBeTruthy();
  });

  it("denies approval from analyst (no reform:proposal:approve permission)", async () => {
    await expect(
      approveReformProposalWithAuditSafe(analystSession, proposalId, alternativeId, { ... })
    ).rejects.toThrow(PermissionDeniedError);

    // Verify denied audit entry was written
    const deniedAudit = await prismaClient.auditLog.findFirst({
      where: { action: "reform.proposal_approved", status: "denied" },
    });
    expect(deniedAudit).toBeTruthy();
  });
});
```

### 7.3 Sentinel Regression Tests

```typescript
// tests/integration/g03-04-f6-sentinel.integration.test.ts
describe("G03 F6 Sentinel", () => {
  it("DB trigger blocks verified status without verifiedAction", async () => {
    await expect(
      prismaClient.reformVerification.create({
        data: {
          tenantId, actionId,
          verificationStatus: "verified",
          verifiedAction: null, // missing
          evidenceSource: "memo",
        },
      })
    ).rejects.toThrow(/F6 violation/);
  });

  it("DB trigger blocks non-descriptive attributionLevel in feedback loop", async () => {
    await expect(
      prismaClient.reformFeedbackLoop.create({
        data: {
          tenantId, actionId,
          comparisonType: "before_after",
          descriptiveSummary: "test",
          attributionLevel: "causal", // forbidden
          createdBy: userId,
        },
      })
    ).rejects.toThrow(/Invariant violation/);
  });

  it("RLS blocks UPDATE on reform_action_updates for balance_app", async () => {
    // Create an update as balance_app
    const update = await createUpdate(...);
    // Attempt to UPDATE it — should fail
    await expect(
      prismaClient.reformActionUpdate.update({
        where: { id: update.id },
        data: { notes: "tampered" },
      })
    ).rejects.toThrow(); // RLS blocks
  });
});
```

---

## 8. Contract Stability Guarantees

### 8.1 What Is Stable

- All Zod schema names + field names
- All service function names + signatures
- All API route paths + HTTP methods
- All permission names (9 new permissions)
- All lifecycle enum values
- All error classes + their inheritance

These are stable across all G03 missions. Changing any of them requires a new ADR + owner approval.

### 8.2 What May Evolve

- Internal implementation details (e.g., SQL query optimization)
- Additional optional fields (additive only — never breaking)
- New service functions (additive only)
- New API routes (additive only)
- New permission values for new sub-resources

### 8.3 Backward Compatibility

- Any contract accepted in 03-01 (bootstrap) remains valid through 03-06.
- If a future mission (03-07+) needs to change a contract, it must:
  1. Add a new contract (additive)
  2. Deprecate the old one (mark `@deprecated`)
  3. Maintain backward compatibility for at least one full GROUP
  4. Only remove the deprecated contract after explicit owner approval

---

## 9. Contract Review Checklist

| Requirement | Verified by |
|-------------|-------------|
| All inputs validated by Zod | `contracts.test.ts` covers every schema |
| All services wrap in `withAuthenticatedTenant` | Code review + integration test |
| All privileged operations check `requirePermissionWithCurrentRole` | Code review + integration test |
| All state transitions write atomic audit log | Integration test verifies `audit_log` row |
| Denied attempts are audited | Integration test verifies denied audit row |
| Evidence snapshots captured at approval time | Integration test verifies snapshot content |
| F6 enforced (verifiedAction + evidenceSource) | Sentinel integration test (DB trigger) |
| Attribution level always "descriptive" | Sentinel integration test (DB trigger) |
| Cross-tenant references blocked | Integration test (Tenant B cannot see Tenant A) |
| Append-only tables block UPDATE/DELETE | Sentinel integration test (RLS) |
| API routes follow G00/G01/G02 pattern | Code review |
| Rate limiting extended to G03 routes | Integration test |

---

*End of G03-00 Integration Contracts. Companion documents: DOMAIN_MODEL.md, WORKFLOW_AND_APPROVALS.md, SECURITY_AND_EVIDENCE_POLICY.md.*
