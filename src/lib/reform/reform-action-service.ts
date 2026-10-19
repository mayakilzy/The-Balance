// ============================================================
// src/lib/reform/reform-action-service.ts
// ------------------------------------------------------------
// G03-02 — Minimum Viable Single-Tenant Reform Vertical Slice
//
// Implements:
//   createReformAction  — only for approved proposals
//   getReformAction
//   listReformActions
//   startReformAction   — planned → in_progress
//   completeReformAction — in_progress → completed
//
// Lifecycle (per G03-00 INTEGRATION_CONTRACTS §3):
//   planned → in_progress → completed
//
// `blocked` and `cancelled` states exist in the G03-00 enum but are NOT
// reachable via G03-02 service transitions (deferred to G03-05 enhanced
// action lifecycle). The service explicitly rejects attempts to set them.
//
// Atomicity:
//   Every state transition writes audit_log in the SAME transaction
//   via writeAuditTx. If the audit write fails, the entire transaction
//   rolls back.
//
// D4 (cross-strategy links):
//   G03-02 does NOT support programId/projectId linking — that requires
//   the proposal's strategyVersionId to match the program's. This is
//   deferred to G03-05. The service accepts no programId/projectId input
//   in G03-02.
// ============================================================
import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  CreateReformActionInputSchema,
  StartReformActionInputSchema,
  CompleteReformActionInputSchema,
  ListReformActionsInputSchema,
  NotFoundError,
  ConflictError,
} from "./contracts";
import type {
  ReformAction,
  CreateReformActionInput,
  StartReformActionInput,
  CompleteReformActionInput,
} from "./contracts";

// ============================================================
// Create: only for approved proposals (analyst action)
// ============================================================
export async function createReformAction(
  session: Session | null,
  input: CreateReformActionInput
): Promise<{ actionId: string }> {
  await requirePermissionWithCurrentRole(session, "reform:action:write");

  const parsed = CreateReformActionInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify the proposal exists, belongs to this tenant, AND is approved.
      // Actions can only be created for approved proposals — this is the
      // human-approval gate.
      const proposal = await tx.reformProposal.findFirst({
        where: { id: parsed.proposalId, tenantId },
      });
      if (!proposal) {
        throw new NotFoundError(
          `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
        );
      }
      if (proposal.status !== "approved") {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} is in status "${proposal.status}", cannot create action (must be "approved")`
        );
      }

      // Find the alternative attached to the approval (G03-02: exactly one)
      const approval = await tx.reformApproval.findFirst({
        where: { proposalId: parsed.proposalId, tenantId },
      });
      if (!approval) {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} has no approval record. Cannot create action without an approved alternative.`
        );
      }

      const action = await tx.reformAction.create({
        data: {
          tenantId,
          proposalId: parsed.proposalId,
          alternativeId: approval.alternativeId,
          title: parsed.title,
          description: parsed.description ?? null,
          assignedTo: parsed.assignedTo ?? null,
          assignedAt: parsed.assignedTo ? new Date() : null,
          dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
          status: "planned",
          createdBy: userId,
        },
      });

      // Create a pending verification record (1:1 with action, per G03-00)
      await tx.reformVerification.create({
        data: {
          tenantId,
          actionId: action.id,
          verificationStatus: "pending",
        },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.action.created",
        details: {
          actionId: action.id,
          proposalId: parsed.proposalId,
          alternativeId: approval.alternativeId,
          title: parsed.title,
        },
        status: "ok",
      });

      return { actionId: action.id };
    }
  );
}

// ============================================================
// Get: read an action (tenant-scoped via RLS)
// ============================================================
export async function getReformAction(
  session: Session | null,
  actionId: string
): Promise<ReformAction | null> {
  await requirePermissionWithCurrentRole(session, "reform:action:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const action = await tx.reformAction.findFirst({
      where: { id: actionId, tenantId },
    });
    return action;
  });
}

// ============================================================
// List: tenant-scoped actions with optional filters
// ============================================================
export async function listReformActions(
  session: Session | null,
  input: {
    proposalId?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }
): Promise<{ actions: ReformAction[]; nextCursor: string | null }> {
  await requirePermissionWithCurrentRole(session, "reform:action:read");

  const parsed = ListReformActionsInputSchema.parse(input);

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const where: Prisma.ReformActionWhereInput = { tenantId };
    if (parsed.proposalId) {
      where.proposalId = parsed.proposalId;
    }
    if (parsed.status) {
      where.status = parsed.status;
    }

    const actions = await tx.reformAction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parsed.limit + 1,
      cursor: parsed.cursor ? { id: parsed.cursor } : undefined,
      skip: parsed.cursor ? 1 : 0,
    });

    const nextCursor =
      actions.length > parsed.limit ? actions[actions.length - 1]!.id : null;
    const truncated = actions.length > parsed.limit ? actions.slice(0, parsed.limit) : actions;

    return { actions: truncated, nextCursor };
  });
}

// ============================================================
// Start: planned → in_progress (analyst action)
// ============================================================
export async function startReformAction(
  session: Session | null,
  actionId: string
): Promise<{ actionId: string; status: string }> {
  await requirePermissionWithCurrentRole(session, "reform:action:write");

  const parsed = StartReformActionInputSchema.parse({ actionId });

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Conditional update: only planned actions can be started
      const result = await tx.reformAction.updateMany({
        where: { id: parsed.actionId, tenantId, status: "planned" },
        data: {
          status: "in_progress",
          startDate: new Date(),
        },
      });

      if (result.count === 0) {
        const existing = await tx.reformAction.findFirst({
          where: { id: parsed.actionId, tenantId },
        });
        if (!existing) {
          throw new NotFoundError(
            `Action ${parsed.actionId} not found in tenant ${tenantId}`
          );
        }
        throw new ConflictError(
          `Action ${parsed.actionId} is in status "${existing.status}", cannot start (must be "planned")`
        );
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.action.started",
        details: { actionId: parsed.actionId },
        status: "ok",
      });

      return { actionId: parsed.actionId, status: "in_progress" };
    }
  );
}

// ============================================================
// Complete: in_progress → completed (analyst action)
// ============================================================
export async function completeReformAction(
  session: Session | null,
  input: CompleteReformActionInput
): Promise<{ actionId: string; status: string }> {
  await requirePermissionWithCurrentRole(session, "reform:action:write");

  const parsed = CompleteReformActionInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Conditional update: only in_progress actions can be completed
      const result = await tx.reformAction.updateMany({
        where: { id: parsed.actionId, tenantId, status: "in_progress" },
        data: {
          status: "completed",
          completedDate: parsed.completedDate ? new Date(parsed.completedDate) : new Date(),
          progressPercentage: 100,
        },
      });

      if (result.count === 0) {
        const existing = await tx.reformAction.findFirst({
          where: { id: parsed.actionId, tenantId },
        });
        if (!existing) {
          throw new NotFoundError(
            `Action ${parsed.actionId} not found in tenant ${tenantId}`
          );
        }
        throw new ConflictError(
          `Action ${parsed.actionId} is in status "${existing.status}", cannot complete (must be "in_progress")`
        );
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.action.completed",
        details: { actionId: parsed.actionId },
        status: "ok",
      });

      return { actionId: parsed.actionId, status: "completed" };
    }
  );
}
