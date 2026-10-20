// ============================================================
// src/lib/reform/reform-alternative-service.ts
// ------------------------------------------------------------
// G03-03 — Reform Alternatives
//
// Implements:
//   addReformAlternative — analyst adds alternative to a draft proposal
//   listReformAlternatives — read all alternatives for a proposal
//   selectAlternative — reviewer selects ONE (partial unique index enforces)
//   withdrawAlternative — reviewer withdraws a draft or selected alternative
//
// Concurrency strategy (REV 3 — Unified Proposal-Row Locking):
//   All mutating operations acquire SELECT FOR UPDATE on the proposal row
//   at the start of the transaction. This serializes competing operations
//   on the same proposal, eliminating race conditions.
//
// Decisions:
//   D1: Max 5 active (non-withdrawn) alternatives per proposal
//   D3: Alternatives can only be added while proposal is "draft"
//   D4: Selection is explicit for multi-alternative proposals
//
// Authorization:
//   - addReformAlternative: reform:alternative:write (analyst, admin)
//   - listReformAlternatives: reform:alternative:read (analyst, reviewer, admin)
//   - selectAlternative: reform:proposal:approve (reviewer, admin)
//   - withdrawAlternative: reform:proposal:approve (reviewer, admin)
// ============================================================
import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  CreateReformAlternativeInputSchema,
  SelectAlternativeInputSchema,
  WithdrawAlternativeInputSchema,
  NotFoundError,
  ConflictError,
} from "./contracts";
import type {
  ReformAlternative,
  CreateReformAlternativeInput,
  SelectAlternativeInput,
  WithdrawAlternativeInput,
} from "./contracts";
import { lockProposalRow } from "./lock-helper";

// ============================================================
// Helper: lockProposalRow is imported from ./lock-helper
// (G03-03-R1 — unified fail-closed SELECT FOR UPDATE).
// See lock-helper.ts for the production contract.
// ============================================================

// ============================================================
// Add: analyst adds an alternative to a draft proposal
// ============================================================
export async function addReformAlternative(
  session: Session | null,
  input: CreateReformAlternativeInput
): Promise<{ alternativeId: string }> {
  await requirePermissionWithCurrentRole(session, "reform:alternative:write");

  const parsed = CreateReformAlternativeInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // D3: Lock proposal row, then verify it's in draft status
      await lockProposalRow(tx, parsed.proposalId, tenantId);

      const proposal = await tx.reformProposal.findFirst({
        where: { id: parsed.proposalId, tenantId },
      });
      if (!proposal) {
        throw new NotFoundError(
          `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
        );
      }
      if (proposal.status !== "draft") {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} is in status "${proposal.status}", cannot add alternatives (must be "draft")`
        );
      }

      // D1: Count active (non-withdrawn) alternatives
      const activeCount = await tx.reformAlternative.count({
        where: {
          proposalId: parsed.proposalId,
          tenantId,
          status: { not: "withdrawn" },
        },
      });
      if (activeCount >= 5) {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} already has ${activeCount} active alternatives. Maximum is 5.`
        );
      }

      const alternative = await tx.reformAlternative.create({
        data: {
          tenantId,
          proposalId: parsed.proposalId,
          title: parsed.title,
          description: parsed.description,
          costEstimateMin: parsed.costEstimateMin
            ? new Prisma.Decimal(parsed.costEstimateMin)
            : null,
          costEstimateMax: parsed.costEstimateMax
            ? new Prisma.Decimal(parsed.costEstimateMax)
            : null,
          costCurrency: parsed.costCurrency,
          riskLevel: parsed.riskLevel,
          feasibilityScore: parsed.feasibilityScore,
          anticipatedOutcomes: parsed.anticipatedOutcomes,
          assumptions: parsed.assumptions,
          status: "draft",
          draftedVia: "human",
          simulated: false,
          createdBy: userId,
        },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.alternative.added",
        details: {
          proposalId: parsed.proposalId,
          alternativeId: alternative.id,
          title: parsed.title,
        },
        status: "ok",
      });

      return { alternativeId: alternative.id };
    }
  );
}

// ============================================================
// List: read all alternatives for a proposal (tenant-scoped via RLS)
// ============================================================
export async function listReformAlternatives(
  session: Session | null,
  proposalId: string
): Promise<ReformAlternative[]> {
  await requirePermissionWithCurrentRole(session, "reform:alternative:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Verify proposal belongs to tenant (don't leak existence across tenants)
    const proposal = await tx.reformProposal.findFirst({
      where: { id: proposalId, tenantId },
      select: { id: true },
    });
    if (!proposal) {
      throw new NotFoundError(
        `Proposal ${proposalId} not found in tenant ${tenantId}`
      );
    }

    return tx.reformAlternative.findMany({
      where: { proposalId, tenantId },
      orderBy: { createdAt: "asc" },
    });
  });
}

// ============================================================
// Select: reviewer selects ONE alternative (draft → selected)
// ============================================================
export async function selectAlternative(
  session: Session | null,
  input: SelectAlternativeInput
): Promise<{ alternativeId: string; status: string }> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:approve");

  const parsed = SelectAlternativeInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Find the alternative to get its proposalId
      const alternative = await tx.reformAlternative.findFirst({
        where: { id: parsed.alternativeId, tenantId },
      });
      if (!alternative) {
        throw new NotFoundError(
          `Alternative ${parsed.alternativeId} not found in tenant ${tenantId}`
        );
      }

      // Lock the proposal row (serializes competing operations)
      await lockProposalRow(tx, alternative.proposalId, tenantId);

      // Re-read alternative after lock (status may have changed)
      const current = await tx.reformAlternative.findFirst({
        where: { id: parsed.alternativeId, tenantId },
      });
      if (!current) {
        throw new NotFoundError(
          `Alternative ${parsed.alternativeId} not found after lock`
        );
      }

      // Verify alternative is in draft status
      if (current.status !== "draft") {
        throw new ConflictError(
          `Alternative ${parsed.alternativeId} is in status "${current.status}", cannot select (must be "draft")`
        );
      }

      // Verify proposal is under_review (selection happens during review)
      const proposal = await tx.reformProposal.findFirst({
        where: { id: current.proposalId, tenantId },
      });
      if (!proposal) {
        throw new NotFoundError(
          `Proposal ${current.proposalId} not found`
        );
      }
      if (proposal.status !== "under_review") {
        throw new ConflictError(
          `Proposal ${current.proposalId} is in status "${proposal.status}", cannot select alternatives (must be "under_review")`
        );
      }

      // Conditional UPDATE: only update if still 'draft'
      // Partial unique index enforces only ONE 'selected' per proposal at DB level
      let result;
      try {
        result = await tx.reformAlternative.updateMany({
          where: { id: parsed.alternativeId, tenantId, status: "draft" },
          data: {
            status: "selected",
            selectedAt: new Date(),
            selectedBy: userId,
          },
        });
      } catch (err) {
        // Partial unique index violation — another alternative is already selected
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Unique constraint") || msg.includes("unique")) {
          throw new ConflictError(
            `Alternative ${parsed.alternativeId} could not be selected. Another alternative may already be selected for this proposal.`
          );
        }
        throw err;
      }

      if (result.count === 0) {
        throw new ConflictError(
          `Alternative ${parsed.alternativeId} could not be selected. It may have been withdrawn or another alternative may already be selected.`
        );
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.alternative.selected",
        details: {
          proposalId: current.proposalId,
          alternativeId: parsed.alternativeId,
        },
        status: "ok",
      });

      return { alternativeId: parsed.alternativeId, status: "selected" };
    }
  );
}

// ============================================================
// Withdraw: reviewer withdraws a draft or selected alternative
// ============================================================
export async function withdrawAlternative(
  session: Session | null,
  input: WithdrawAlternativeInput
): Promise<{ alternativeId: string; status: string }> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:approve");

  const parsed = WithdrawAlternativeInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Find the alternative to get its proposalId
      const alternative = await tx.reformAlternative.findFirst({
        where: { id: parsed.alternativeId, tenantId },
      });
      if (!alternative) {
        throw new NotFoundError(
          `Alternative ${parsed.alternativeId} not found in tenant ${tenantId}`
        );
      }

      // Lock the proposal row (serializes competing operations)
      await lockProposalRow(tx, alternative.proposalId, tenantId);

      // Re-read alternative after lock
      const current = await tx.reformAlternative.findFirst({
        where: { id: parsed.alternativeId, tenantId },
      });
      if (!current) {
        throw new NotFoundError(
          `Alternative ${parsed.alternativeId} not found after lock`
        );
      }

      // Verify alternative is in draft or selected status
      if (current.status !== "draft" && current.status !== "selected") {
        throw new ConflictError(
          `Alternative ${parsed.alternativeId} is in status "${current.status}", cannot withdraw (must be "draft" or "selected")`
        );
      }

      // Verify proposal is NOT approved (cannot withdraw after approval)
      const proposal = await tx.reformProposal.findFirst({
        where: { id: current.proposalId, tenantId },
      });
      if (!proposal) {
        throw new NotFoundError(
          `Proposal ${current.proposalId} not found`
        );
      }
      if (proposal.status === "approved") {
        throw new ConflictError(
          `Proposal ${current.proposalId} is already approved. Cannot withdraw alternatives after approval.`
        );
      }

      // Conditional UPDATE: only update if still in draft or selected
      const result = await tx.reformAlternative.updateMany({
        where: {
          id: parsed.alternativeId,
          tenantId,
          status: { in: ["draft", "selected"] },
        },
        data: {
          status: "withdrawn",
          withdrawnAt: new Date(),
          withdrawnBy: userId,
          withdrawalReason: parsed.withdrawalReason,
        },
      });

      if (result.count === 0) {
        throw new ConflictError(
          `Alternative ${parsed.alternativeId} could not be withdrawn. Its status may have changed concurrently.`
        );
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.alternative.withdrawn",
        details: {
          proposalId: current.proposalId,
          alternativeId: parsed.alternativeId,
          withdrawalReason: parsed.withdrawalReason,
        },
        status: "ok",
      });

      return { alternativeId: parsed.alternativeId, status: "withdrawn" };
    }
  );
}
