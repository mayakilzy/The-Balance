// ============================================================
// src/lib/reform/reform-proposal-service.ts
// ------------------------------------------------------------
// G03-02 — Minimum Viable Single-Tenant Reform Vertical Slice
//
// Implements:
//   createReformProposal — creates proposal + single alternative atomically
//   getReformProposal
//   listReformProposals
//   submitForReview — draft → under_review
//   approveReformProposal — under_review → approved (creates ReformApproval
//                           + ReformAlternative already exists from create)
//   rejectReformProposal — under_review → rejected
//
// Authorization model (per G03-00 INTEGRATION_CONTRACTS §6):
//   - create/submit:        reform:proposal:write (analyst, admin)
//   - get/list:             reform:proposal:read  (all roles)
//   - approve/reject:       reform:proposal:approve (reviewer, admin)
//
// Atomicity:
//   Every state transition (submit, approve, reject) writes audit_log
//   in the SAME transaction via writeAuditTx. If the audit write fails,
//   the entire transaction rolls back.
//
// Schema compatibility:
//   G03-01 has ReformAlternative + ReformApproval as separate tables,
//   with approval.alternativeId being required (NOT NULL).
//   G03-02 defers multi-alternative CRUD to G03-03. Therefore, the
//   minimal representation is:
//     1. createReformProposal creates ONE proposal + ONE alternative
//        (status="draft") atomically.
//     2. approveReformProposal creates ONE approval record referencing
//        that single alternative.
//   Multi-alternative selection, comparison, ranking, and withdrawal
//   are OUT OF SCOPE for G03-02.
// ============================================================
import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import { requirePermissionWithCurrentRole, PermissionDeniedError } from "@/lib/permissions";
import {
  CreateReformProposalInputSchema,
  SubmitForReviewInputSchema,
  ApproveReformProposalInputSchema,
  RejectReformProposalInputSchema,
  ListReformProposalsInputSchema,
  NotFoundError,
  ConflictError,
} from "./contracts";
import type {
  ReformProposal,
  CreateReformProposalInput,
  ApproveReformProposalInput,
  RejectReformProposalInput,
} from "./contracts";

// ============================================================
// Create: analyst drafts a proposal linked to an existing G02 alert
// ============================================================
export async function createReformProposal(
  session: Session | null,
  input: CreateReformProposalInput
): Promise<{ proposalId: string; alternativeId: string }> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:write");

  const parsed = CreateReformProposalInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify the originating alert belongs to this tenant
      const alert = await tx.alert.findFirst({
        where: { id: parsed.originatingAlertId, tenantId },
      });
      if (!alert) {
        throw new NotFoundError(
          `Alert ${parsed.originatingAlertId} not found in tenant ${tenantId}`
        );
      }

      // Create proposal + single alternative atomically
      const proposal = await tx.reformProposal.create({
        data: {
          tenantId,
          originatingAlertId: parsed.originatingAlertId,
          title: parsed.title,
          problemStatement: parsed.problemStatement,
          hypothesizedCauses: parsed.hypothesizedCauses,
          status: "draft",
          createdBy: userId,
        },
      });

      const alternative = await tx.reformAlternative.create({
        data: {
          tenantId,
          proposalId: proposal.id,
          title: parsed.alternative.title,
          description: parsed.alternative.description,
          costEstimateMin: parsed.alternative.costEstimateMin
            ? new Prisma.Decimal(parsed.alternative.costEstimateMin)
            : null,
          costEstimateMax: parsed.alternative.costEstimateMax
            ? new Prisma.Decimal(parsed.alternative.costEstimateMax)
            : null,
          costCurrency: parsed.alternative.costCurrency,
          riskLevel: parsed.alternative.riskLevel,
          feasibilityScore: parsed.alternative.feasibilityScore,
          status: "draft",
          draftedVia: "human",
          simulated: false,
          createdBy: userId,
        },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.proposal.created",
        details: {
          proposalId: proposal.id,
          alternativeId: alternative.id,
          originatingAlertId: parsed.originatingAlertId,
          title: parsed.title,
        },
        status: "ok",
      });

      return { proposalId: proposal.id, alternativeId: alternative.id };
    }
  );
}

// ============================================================
// Get: read a proposal (tenant-scoped via RLS)
// ============================================================
export async function getReformProposal(
  session: Session | null,
  proposalId: string
): Promise<ReformProposal | null> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const proposal = await tx.reformProposal.findFirst({
      where: { id: proposalId, tenantId },
    });
    return proposal;
  });
}

// ============================================================
// List: tenant-scoped proposals with optional status filter
// ============================================================
export async function listReformProposals(
  session: Session | null,
  input: { status?: string; limit?: number; cursor?: string }
): Promise<{ proposals: ReformProposal[]; nextCursor: string | null }> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:read");

  const parsed = ListReformProposalsInputSchema.parse(input);

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const where: Prisma.ReformProposalWhereInput = { tenantId };
    if (parsed.status) {
      where.status = parsed.status;
    }

    const proposals = await tx.reformProposal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parsed.limit + 1,
      cursor: parsed.cursor ? { id: parsed.cursor } : undefined,
      skip: parsed.cursor ? 1 : 0,
    });

    const nextCursor =
      proposals.length > parsed.limit ? proposals[proposals.length - 1]!.id : null;
    const truncated = proposals.length > parsed.limit ? proposals.slice(0, parsed.limit) : proposals;

    return { proposals: truncated, nextCursor };
  });
}

// ============================================================
// Submit: draft → under_review (analyst action)
// ============================================================
export async function submitForReview(
  session: Session | null,
  proposalId: string
): Promise<{ proposalId: string; status: string }> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:write");

  const parsed = SubmitForReviewInputSchema.parse({ proposalId });

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Conditional update: only draft proposals can be submitted.
      // This prevents duplicate submission from creating inconsistent state.
      const result = await tx.reformProposal.updateMany({
        where: { id: parsed.proposalId, tenantId, status: "draft" },
        data: {
          status: "under_review",
          submittedAt: new Date(),
        },
      });

      if (result.count === 0) {
        // Either the proposal doesn't exist, doesn't belong to this tenant,
        // or is not in "draft" status. Distinguish via a read.
        const existing = await tx.reformProposal.findFirst({
          where: { id: parsed.proposalId, tenantId },
        });
        if (!existing) {
          throw new NotFoundError(
            `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
          );
        }
        throw new ConflictError(
          `Proposal ${parsed.proposalId} is in status "${existing.status}", cannot submit (must be "draft")`
        );
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.proposal.submitted",
        details: { proposalId: parsed.proposalId },
        status: "ok",
      });

      return { proposalId: parsed.proposalId, status: "under_review" };
    }
  );
}

// ============================================================
// Approve: under_review → approved (reviewer/admin action)
// ============================================================
export async function approveReformProposal(
  session: Session | null,
  input: ApproveReformProposalInput
): Promise<{ approvalId: string; proposalStatus: string }> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:approve");

  const parsed = ApproveReformProposalInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify proposal exists + is in under_review status
      const proposal = await tx.reformProposal.findFirst({
        where: { id: parsed.proposalId, tenantId },
      });
      if (!proposal) {
        throw new NotFoundError(
          `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
        );
      }
      if (proposal.status !== "under_review") {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} is in status "${proposal.status}", cannot approve (must be "under_review")`
        );
      }

      // Verify the proposal has not already been approved (idempotency check)
      const existingApproval = await tx.reformApproval.findFirst({
        where: { proposalId: parsed.proposalId, tenantId },
      });
      if (existingApproval) {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} already has an approval record (immutable). Idempotent re-approval is forbidden.`
        );
      }

      // Resolve the alternative to attach to the approval.
      // G03-02 minimal: there is exactly ONE alternative per proposal.
      // If the caller provides alternativeId, it must match. If not,
      // the service picks the single existing alternative.
      let alternativeId = parsed.alternativeId;
      if (!alternativeId) {
        const alternatives = await tx.reformAlternative.findMany({
          where: { proposalId: parsed.proposalId, tenantId },
        });
        if (alternatives.length === 0) {
          throw new ConflictError(
            `Proposal ${parsed.proposalId} has no alternative to attach to the approval. This indicates a data integrity issue.`
          );
        }
        if (alternatives.length > 1) {
          // G03-02 invariant: only ONE alternative per proposal. Multiple
          // alternatives belong to G03-03. If we ever see >1, fail closed.
          throw new ConflictError(
            `Proposal ${parsed.proposalId} has ${alternatives.length} alternatives; G03-02 supports exactly 1. Multi-alternative flows belong to G03-03.`
          );
        }
        alternativeId = alternatives[0]!.id;
      } else {
        // Verify the provided alternativeId belongs to this proposal + tenant
        const alt = await tx.reformAlternative.findFirst({
          where: {
            id: alternativeId,
            proposalId: parsed.proposalId,
            tenantId,
          },
        });
        if (!alt) {
          throw new NotFoundError(
            `Alternative ${alternativeId} not found for proposal ${parsed.proposalId} in tenant ${tenantId}`
          );
        }
      }

      // Mark alternative as "selected"
      await tx.reformAlternative.update({
        where: { id: alternativeId },
        data: {
          status: "selected",
          selectedAt: new Date(),
          selectedBy: userId,
        },
      });

      // Create the immutable approval record (append-only)
      const approval = await tx.reformApproval.create({
        data: {
          tenantId,
          proposalId: parsed.proposalId,
          alternativeId,
          approvedBy: userId,
          approvalNotes: parsed.approvalNotes ?? null,
          rationale: parsed.rationale,
          supportingEvidence: [],
          counterEvidence: [],
        },
      });

      // Transition proposal to approved (conditional update for safety)
      const updateResult = await tx.reformProposal.updateMany({
        where: { id: parsed.proposalId, tenantId, status: "under_review" },
        data: {
          status: "approved",
          approvedAt: new Date(),
        },
      });
      if (updateResult.count === 0) {
        // Race condition: another reviewer approved/rejected concurrently.
        // The approval record creation above will be rolled back by the
        // transaction.
        throw new ConflictError(
          `Proposal ${parsed.proposalId} transitioned concurrently; approval rolled back.`
        );
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.proposal.approved",
        details: {
          proposalId: parsed.proposalId,
          approvalId: approval.id,
          alternativeId,
        },
        status: "ok",
      });

      return { approvalId: approval.id, proposalStatus: "approved" };
    }
  );
}

// ============================================================
// Reject: under_review → rejected (reviewer/admin action)
// ============================================================
export async function rejectReformProposal(
  session: Session | null,
  input: RejectReformProposalInput
): Promise<{ proposalId: string; status: string }> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:approve");

  const parsed = RejectReformProposalInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Conditional update: only under_review proposals can be rejected
      const result = await tx.reformProposal.updateMany({
        where: {
          id: parsed.proposalId,
          tenantId,
          status: "under_review",
        },
        data: {
          status: "rejected",
          rejectedAt: new Date(),
        },
      });

      if (result.count === 0) {
        const existing = await tx.reformProposal.findFirst({
          where: { id: parsed.proposalId, tenantId },
        });
        if (!existing) {
          throw new NotFoundError(
            `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
          );
        }
        throw new ConflictError(
          `Proposal ${parsed.proposalId} is in status "${existing.status}", cannot reject (must be "under_review")`
        );
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.proposal.rejected",
        details: {
          proposalId: parsed.proposalId,
          rejectionReason: parsed.rejectionReason,
        },
        status: "ok",
      });

      return { proposalId: parsed.proposalId, status: "rejected" };
    }
  );
}
