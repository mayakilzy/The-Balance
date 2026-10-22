// ============================================================
// src/lib/reform/reform-action-update-service.ts
// ------------------------------------------------------------
// G03-02 — Minimum Viable Single-Tenant Reform Vertical Slice
//
// Implements:
//   addReformActionUpdate — append progress update (NEVER mutate/delete)
//   listReformActionUpdates
//
// Append-only enforcement (triple defense):
//   1. Service NEVER exposes an updateReformActionUpdate function.
//   2. RLS on reform_action_updates denies UPDATE + DELETE for balance_app.
//   3. PostgreSQL trigger `prevent_historical_update` + `prevent_delete_reform_action_updates`
//      blocks UPDATE + DELETE for ALL roles (unconditional, no GUC bypass —
//      migration 0024 R2 trust boundary).
//
// The service uses INSERT only — never UPDATE, never DELETE.
// ============================================================
import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  AddReformActionUpdateInputSchema,
  ListReformActionUpdatesInputSchema,
  NotFoundError,
  ConflictError,
} from "./contracts";
import type {
  ReformActionUpdate,
  AddReformActionUpdateInput,
} from "./contracts";

// ============================================================
// Add (append-only): INSERT only, never UPDATE/DELETE
// ============================================================
export async function addReformActionUpdate(
  session: Session | null,
  input: AddReformActionUpdateInput
): Promise<{ updateId: string }> {
  await requirePermissionWithCurrentRole(session, "reform:action:write");

  const parsed = AddReformActionUpdateInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify the action exists + belongs to this tenant.
      // Updates can be added at any action state (planned, in_progress, completed)
      // — even completed actions can receive retrospective evidence updates.
      const action = await tx.reformAction.findFirst({
        where: { id: parsed.actionId, tenantId },
      });
      if (!action) {
        throw new NotFoundError(
          `Action ${parsed.actionId} not found in tenant ${tenantId}`
        );
      }

      // INSERT only — never UPDATE. The DB trigger blocks UPDATE unconditionally.
      const update = await tx.reformActionUpdate.create({
        data: {
          tenantId,
          actionId: parsed.actionId,
          updateType: parsed.updateType,
          notes: parsed.notes,
          progressPercentage: parsed.progressPercentage ?? null,
          evidenceIds: parsed.evidenceIds,
          actor: userId,
        },
      });

      // If progressPercentage was provided AND the action is in_progress,
      // update the action's progressPercentage (this is an action-level
      // mutation, NOT a mutation of the update record — the update record
      // itself remains append-only).
      if (
        parsed.progressPercentage !== undefined &&
        action.status === "in_progress"
      ) {
        await tx.reformAction.update({
          where: { id: parsed.actionId },
          data: { progressPercentage: parsed.progressPercentage },
        });
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.action_update.added",
        details: {
          actionId: parsed.actionId,
          updateId: update.id,
          updateType: parsed.updateType,
          progressPercentage: parsed.progressPercentage ?? null,
        },
        status: "ok",
      });

      return { updateId: update.id };
    }
  );
}

// ============================================================
// List: tenant-scoped updates for an action
// ============================================================
export async function listReformActionUpdates(
  session: Session | null,
  input: {
    actionId: string;
    limit?: number;
    cursor?: string;
  }
): Promise<{ updates: ReformActionUpdate[]; nextCursor: string | null }> {
  await requirePermissionWithCurrentRole(session, "reform:action:read");

  const parsed = ListReformActionUpdatesInputSchema.parse(input);

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Verify the action belongs to this tenant (so we don't leak updates
    // by guessing actionId across tenants).
    const action = await tx.reformAction.findFirst({
      where: { id: parsed.actionId, tenantId },
      select: { id: true },
    });
    if (!action) {
      throw new NotFoundError(
        `Action ${parsed.actionId} not found in tenant ${tenantId}`
      );
    }

    const updates = await tx.reformActionUpdate.findMany({
      where: { actionId: parsed.actionId, tenantId },
      orderBy: { at: "desc" },
      take: parsed.limit + 1,
      cursor: parsed.cursor ? { id: parsed.cursor } : undefined,
      skip: parsed.cursor ? 1 : 0,
    });

    const nextCursor =
      updates.length > parsed.limit ? updates[updates.length - 1]!.id : null;
    const truncated = updates.length > parsed.limit ? updates.slice(0, parsed.limit) : updates;

    return { updates: truncated, nextCursor };
  });
}
