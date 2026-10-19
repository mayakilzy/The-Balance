// ============================================================
// src/lib/reform/contracts.ts
// ------------------------------------------------------------
// G03-02 — Minimum Viable Single-Tenant Reform Vertical Slice
//
// Zod schemas + types for the reform workflow:
//   proposal create/submit/approve/reject
//   action create/start/complete + append-only updates
//   F6 verification
//   descriptive feedback loop
//   alert closure precondition
//
// Design constraints (per G03-00 frozen contracts):
//   - D5: Four distinct lifecycle states
//       (approval / implementation / verification / measurement)
//   - F6: verifyReformAction requires verifiedAction + evidenceSource
//         for "verified" status, disputeReason + disputeEvidenceSource
//         for "disputed" status. Enforced by Zod + service + DB trigger
//         (triple defense).
//   - Attribution: ReformFeedbackLoop.attributionLevel MUST be "descriptive".
//         Causal claims are forbidden. Enforced by Zod + service + DB trigger.
//   - D4 (deferred partial): single-alternative representation. NO multiple
//         alternatives CRUD, comparison, or selection (G03-03 scope).
//
// Schemas are intentionally narrow — only the minimal viable slice.
// Authority-bearing fields (canApproveCommitments, verifiedInstitutionId, etc.)
// are NEVER accepted from client input. They are set ONLY by authorized
// administrative functions in G03-06+ (currently DORMANT).
// ============================================================
import { z } from "zod";
import type {
  ReformProposal as PrismaReformProposal,
  ReformAlternative as PrismaReformAlternative,
  ReformApproval as PrismaReformApproval,
  ReformAction as PrismaReformAction,
  ReformActionUpdate as PrismaReformActionUpdate,
  ReformVerification as PrismaReformVerification,
  ReformFeedbackLoop as PrismaReformFeedbackLoop,
} from "@prisma/client";

// ============================================================
// Re-export Prisma types (single source of truth)
// ============================================================
export type ReformProposal = PrismaReformProposal;
export type ReformAlternative = PrismaReformAlternative;
export type ReformApproval = PrismaReformApproval;
export type ReformAction = PrismaReformAction;
export type ReformActionUpdate = PrismaReformActionUpdate;
export type ReformVerification = PrismaReformVerification;
export type ReformFeedbackLoop = PrismaReformFeedbackLoop;

// ============================================================
// Error classes (inherit from G02 pattern)
// ============================================================
export class NotFoundError extends Error {
  constructor(message: string) {
    super(`Not Found: ${message}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(`Conflict: ${message}`);
    this.name = "ConflictError";
  }
}

// Re-export PermissionDeniedError from permissions module for convenience
export { PermissionDeniedError } from "@/lib/permissions";

// ============================================================
// Lifecycle enums (frozen per G03-00 INTEGRATION_CONTRACTS §3)
// ============================================================
export const ReformProposalStatusSchema = z.enum([
  "draft",
  "under_review",
  "approved",
  "rejected",
  "superseded",
]);
export type ReformProposalStatus = z.infer<typeof ReformProposalStatusSchema>;

export const ReformActionStatusSchema = z.enum([
  "planned",
  "in_progress",
  "completed",
  // blocked + cancelled are out of scope for G03-02 vertical slice
  // (deferred to G03-05 enhanced action lifecycle). They exist in the
  // G03-00 enum but are not reachable via G03-02 service transitions.
]);
export type ReformActionStatus = z.infer<typeof ReformActionStatusSchema>;

export const ReformActionUpdateTypeSchema = z.enum([
  "progress",
  "blocker",
  "milestone",
  "evidence",
  "note",
]);
export type ReformActionUpdateType = z.infer<typeof ReformActionUpdateTypeSchema>;

export const ReformVerificationStatusSchema = z.enum([
  "pending",
  "verified",
  "disputed",
]);
export type ReformVerificationStatus = z.infer<typeof ReformVerificationStatusSchema>;

export const ReformFeedbackComparisonTypeSchema = z.enum([
  "before_after",
  "parallel",
  "none",
  // NOTE: "causal" is NOT in this enum. The DB trigger
  // `enforce_reform_feedback_attribution_descriptive` enforces
  // attributionLevel = "descriptive" at the row level regardless of Zod.
]);
export type ReformFeedbackComparisonType = z.infer<typeof ReformFeedbackComparisonTypeSchema>;

// ============================================================
// Proposal input schemas
// ============================================================

/**
 * Create a reform proposal linked to an existing G02 Alert.
 *
 * The alert MUST belong to the same tenant as the session. The service
 * verifies this via tenant-scoped findFirst inside the transaction.
 *
 * `originatingAlertId` is REQUIRED for the G03-02 vertical slice.
 * Proposals without an originating alert are deferred to G03-03+ where
 * direct policy proposals (not alert-driven) are introduced.
 *
 * `alternativeInput` is the MINIMAL single-alternative representation.
 * G03-00 has ReformAlternative + ReformApproval as separate tables, with
 * approval.alternativeId being required. To avoid premature G03-03 work,
 * the vertical slice accepts ONE alternative inline at proposal-creation
 * time and creates the alternative + approval records atomically when the
 * reviewer approves.
 */
export const CreateReformProposalInputSchema = z
  .object({
    originatingAlertId: z.string().min(1, "originatingAlertId is required"),
    title: z.string().min(5, "title must be at least 5 characters").max(200),
    problemStatement: z
      .string()
      .min(20, "problemStatement must be at least 20 characters"),
    hypothesizedCauses: z.array(z.string().min(1)).max(5).optional().default([]),
    // Minimal single-alternative representation (defers multi-alternative to G03-03)
    alternative: z
      .object({
        title: z.string().min(5).max(200),
        description: z.string().min(20),
        costEstimateMin: z.number().nonnegative().optional(),
        costEstimateMax: z.number().nonnegative().optional(),
        costCurrency: z.string().length(3).optional().default("USD"),
        riskLevel: z.enum(["low", "medium", "high"]).optional().default("medium"),
        feasibilityScore: z
          .enum(["unknown", "low", "medium", "high"])
          .optional()
          .default("unknown"),
      })
      .strict(), // reject unknown fields (e.g. canApproveCommitments — authority-bearing fields are NEVER client-set)
  })
  .strict(); // reject unknown fields (defense-in-depth against authority-bearing field injection)
;
export type CreateReformProposalInput = z.infer<
  typeof CreateReformProposalInputSchema
>;

export const GetReformProposalInputSchema = z.object({
  proposalId: z.string().min(1),
});
export type GetReformProposalInput = z.infer<typeof GetReformProposalInputSchema>;

export const ListReformProposalsInputSchema = z.object({
  status: ReformProposalStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});
export type ListReformProposalsInput = z.infer<
  typeof ListReformProposalsInputSchema
>;

export const SubmitForReviewInputSchema = z.object({
  proposalId: z.string().min(1),
});
export type SubmitForReviewInput = z.infer<typeof SubmitForReviewInputSchema>;

/**
 * Approve a proposal. The approver's `approvalNotes` and `rationale` are
 * recorded in `reform_approvals` (append-only, immutable after creation).
 *
 * The alternative to attach to the approval is determined as follows:
 *   - If `alternativeId` is provided, it must be the single alternative
 *     created with the proposal (G03-02 minimal representation).
 *   - If `alternativeId` is omitted, the service selects the single
 *     existing alternative for the proposal (there is exactly one in
 *     G03-02; multi-alternative is deferred to G03-03).
 *
 * `actingOnBehalfOfInstitutionId` is intentionally NOT accepted from
 * client input in G03-02. B3 institutional authority checks belong to
 * G03-06 coordination flows.
 */
export const ApproveReformProposalInputSchema = z
  .object({
    proposalId: z.string().min(1),
    alternativeId: z.string().min(1).optional(),
    approvalNotes: z.string().max(2000).optional(),
    rationale: z
      .string()
      .min(20, "rationale must be at least 20 characters")
      .max(2000),
  })
  .strict(); // reject actingOnBehalfOfInstitutionId and other B3 fields (G03-06 scope)
;
export type ApproveReformProposalInput = z.infer<
  typeof ApproveReformProposalInputSchema
>;

export const RejectReformProposalInputSchema = z.object({
  proposalId: z.string().min(1),
  rejectionReason: z
    .string()
    .min(20, "rejectionReason must be at least 20 characters")
    .max(2000),
});
export type RejectReformProposalInput = z.infer<
  typeof RejectReformProposalInputSchema
>;

// ============================================================
// Action input schemas
// ============================================================
export const CreateReformActionInputSchema = z
  .object({
    proposalId: z.string().min(1),
    title: z.string().min(5).max(200),
    description: z.string().max(2000).optional(),
    assignedTo: z.string().min(1).optional(),
    dueDate: z.string().datetime().optional(),
  })
  .strict(); // reject programId/projectId (D4 cross-strategy links deferred to G03-05)
;
export type CreateReformActionInput = z.infer<
  typeof CreateReformActionInputSchema
>;

export const GetReformActionInputSchema = z.object({
  actionId: z.string().min(1),
});
export type GetReformActionInput = z.infer<typeof GetReformActionInputSchema>;

export const ListReformActionsInputSchema = z.object({
  proposalId: z.string().min(1).optional(),
  status: ReformActionStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});
export type ListReformActionsInput = z.infer<
  typeof ListReformActionsInputSchema
>;

export const StartReformActionInputSchema = z.object({
  actionId: z.string().min(1),
});
export type StartReformActionInput = z.infer<
  typeof StartReformActionInputSchema
>;

export const CompleteReformActionInputSchema = z.object({
  actionId: z.string().min(1),
  completedDate: z.string().datetime().optional(),
});
export type CompleteReformActionInput = z.infer<
  typeof CompleteReformActionInputSchema
>;

// ============================================================
// Action update (append-only) schemas
// ============================================================
export const AddReformActionUpdateInputSchema = z.object({
  actionId: z.string().min(1),
  updateType: ReformActionUpdateTypeSchema,
  notes: z.string().min(1).max(5000),
  progressPercentage: z.number().int().min(0).max(100).optional(),
  evidenceIds: z.array(z.string().min(1)).optional().default([]),
});
export type AddReformActionUpdateInput = z.infer<
  typeof AddReformActionUpdateInputSchema
>;

export const ListReformActionUpdatesInputSchema = z.object({
  actionId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});
export type ListReformActionUpdatesInput = z.infer<
  typeof ListReformActionUpdatesInputSchema
>;

// ============================================================
// F6 Verification schemas (triple defense: Zod + service + DB trigger)
// ============================================================
/**
 * F6 verification requires:
 *   - status="verified" → verifiedAction + evidenceSource required
 *   - status="disputed" → disputeReason + disputeEvidenceSource required
 *
 * `verifiedAction` MUST describe the SPECIFIC action verified, NOT a policy
 * outcome (e.g. "Action #A1 mandate published in official gazette on
 * 2025-03-15; verified via gazette archive URL"). Vague claims like
 * "inflation improved" are rejected by the service-level check.
 *
 * The DB trigger `enforce_reform_verification_f6` enforces this at the
 * row level (defense-in-depth) — even if Zod or service logic is bypassed,
 * the trigger raises an exception.
 */
export const VerifyReformActionInputSchema = z
  .object({
    actionId: z.string().min(1),
    verificationStatus: ReformVerificationStatusSchema,
    verifiedAction: z.string().max(2000).optional(),
    evidenceSource: z.string().max(2000).optional(),
    disputeReason: z.string().max(2000).optional(),
    disputeEvidenceSource: z.string().max(2000).optional(),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.verificationStatus === "verified") {
      if (
        !data.verifiedAction ||
        data.verifiedAction.trim().length < 10
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedAction"],
          message:
            "F6: verifiedAction is required (min 10 chars) when verificationStatus=verified. Describe the SPECIFIC action verified, NOT a policy outcome.",
        });
      }
      if (
        !data.evidenceSource ||
        data.evidenceSource.trim().length < 5
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceSource"],
          message:
            "F6: evidenceSource is required (min 5 chars) when verificationStatus=verified.",
        });
      }
    }
    if (data.verificationStatus === "disputed") {
      if (
        !data.disputeReason ||
        data.disputeReason.trim().length < 10
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["disputeReason"],
          message:
            "F6: disputeReason is required (min 10 chars) when verificationStatus=disputed.",
        });
      }
      if (
        !data.disputeEvidenceSource ||
        data.disputeEvidenceSource.trim().length < 5
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["disputeEvidenceSource"],
          message:
            "F6: disputeEvidenceSource is required (min 5 chars) when verificationStatus=disputed.",
        });
      }
    }
  });
export type VerifyReformActionInput = z.infer<
  typeof VerifyReformActionInputSchema
>;

export const GetReformVerificationInputSchema = z.object({
  actionId: z.string().min(1),
});
export type GetReformVerificationInput = z.infer<
  typeof GetReformVerificationInputSchema
>;

// ============================================================
// Descriptive Feedback schemas
// ============================================================
/**
 * Descriptive feedback loop. `attributionLevel` is ALWAYS "descriptive".
 *
 * The Zod schema does NOT accept `attributionLevel` from client input —
 * the service hardcodes it to "descriptive". The DB trigger
 * `enforce_reform_feedback_attribution_descriptive` enforces this at the
 * row level (defense-in-depth).
 *
 * `descriptiveSummary` MUST NOT contain causal language. The service
 * rejects phrases like "the action CAUSED", "as a RESULT of", "the
 * impact of". This is a defense-in-depth check; the DB trigger is the
 * authoritative invariant.
 *
 * `beforeObservationId` and `afterObservationId` are OPTIONAL. If both
 * are provided, the service links them via the feedback loop's comparison
 * fields. Existing observations are NEVER mutated.
 */
const CAUSAL_LANGUAGE_PATTERNS = [
  /\bcaused?\b/i,
  /\bas a result of\b/i,
  /\bthe impact of\b/i,
  /\bdue to\b/i,
  /\bbecause of\b/i,
  /\blead to\b/i,
  /\bled to\b/i,
  /\bresulted in\b/i,
  /\bcontributed to\b/i,
  /\battributable to\b/i,
];

export const CreateReformFeedbackLoopInputSchema = z
  .object({
    actionId: z.string().min(1),
    comparisonType: ReformFeedbackComparisonTypeSchema.optional().default("none"),
    descriptiveSummary: z
      .string()
      .min(20, "descriptiveSummary must be at least 20 characters")
      .max(5000),
    beforeObservationId: z.string().min(1).optional(),
    afterObservationId: z.string().min(1).optional(),
    // Optional: ingest a new observation as the "after" observation.
    // If provided, the service calls G02 ingestObservation and uses the
    // returned observationId as `afterObservationId`. The existing
    // `beforeObservationId` (if any) is NOT mutated.
    newAfterObservation: z
      .object({
        indicatorDefinitionId: z.string().min(1),
        observationPeriodId: z.string().min(1),
        observedValue: z.number(),
        originType: z.enum(["observed", "derived"]),
        sourceId: z.string().min(1).optional(),
        derivationMethod: z.string().min(1).optional(),
        isSynthetic: z.boolean().optional().default(false),
      })
      .optional(),
  })
  .strict() // reject attributionLevel (service hardcodes to "descriptive"; DB trigger enforces)
  .superRefine((data, ctx) => {
    // Defense-in-depth: reject causal language in descriptiveSummary.
    for (const pattern of CAUSAL_LANGUAGE_PATTERNS) {
      if (pattern.test(data.descriptiveSummary)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["descriptiveSummary"],
          message: `Descriptive feedback must NOT contain causal language. Detected pattern: ${pattern.source}. Use descriptive phrasing instead (e.g. "the action was implemented on DATE; observation X recorded value Y").`,
        });
        break;
      }
    }
  });
export type CreateReformFeedbackLoopInput = z.infer<
  typeof CreateReformFeedbackLoopInputSchema
>;

// ============================================================
// Alert closure schema (uses G02 closeAlert contract)
// ============================================================
export const CloseOriginatingAlertInputSchema = z.object({
  proposalId: z.string().min(1),
  closureReason: z
    .string()
    .min(20, "closureReason must be at least 20 characters")
    .max(2000),
});
export type CloseOriginatingAlertInput = z.infer<
  typeof CloseOriginatingAlertInputSchema
>;
