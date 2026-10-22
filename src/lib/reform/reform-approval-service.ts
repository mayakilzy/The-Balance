// ============================================================
// src/lib/reform/reform-approval-service.ts
// ------------------------------------------------------------
// G03-05 — Enhanced Approval Workflow
//
// Implements:
//   approveReformProposalWithAuditSafe — wrapper with denied-audit
//   getReformApproval — read approval with snapshot
//
// DENIED AUDIT POLICY (per PRE-02):
//   Only PermissionDeniedError is classified as "denied".
//   ConflictError (business rules) and NotFoundError (missing resources)
//   are NOT logged as denied — they propagate normally.
//   The original error is ALWAYS re-thrown (never masked).
//   Audit failure does NOT convert denial into approval.
//
// SINGLE TRANSACTION (per reviewer directive):
//   approveReformProposalWithAuditSafe does NOT open a separate
//   transaction for the approval. It delegates to the EXISTING
//   approveReformProposal which runs inside withAuthenticatedTenant.
//   The denied-audit (if needed) runs in a SEPARATE best-effort
//   transaction AFTER the original has rolled back — this is correct
//   because the original tx is already failed.
// ============================================================
import type { Session } from "next-auth";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole, PermissionDeniedError } from "@/lib/permissions";
import { writeAuditTx, writeAudit } from "@/lib/audit";
import { childLogger } from "@/lib/observability";
import { approveReformProposal } from "./reform-proposal-service";
import type { ApproveReformProposalInput } from "./contracts";
import type { ReformApproval } from "@prisma/client";

const log = childLogger({ module: "reform-approval" });

/**
 * Wrap approveReformProposal with best-effort denied-attempt auditing.
 *
 * ONLY PermissionDeniedError is audited as "denied". Business conflicts
 * (ConflictError) and missing resources (NotFoundError) are NOT
 * authorization denials — they are legitimate business-rule rejections.
 *
 * The original error is ALWAYS re-thrown. If the denied-audit write
 * itself fails, it does NOT mask the original denial.
 *
 * CRITICAL: This wrapper does NOT open a separate transaction for the
 * approval itself. It delegates to approveReformProposal which uses
 * its own withAuthenticatedTenant transaction. The denied-audit (if
 * needed) runs in a separate best-effort transaction AFTER the
 * original has rolled back.
 */
export async function approveReformProposalWithAuditSafe(
  session: Session | null,
  input: ApproveReformProposalInput
): Promise<{ approvalId: string; proposalStatus: string }> {
  try {
    return await approveReformProposal(session, input);
  } catch (err) {
    // ONLY log authorization denials as "denied"
    if (err instanceof PermissionDeniedError) {
      // Best-effort denied audit (OUTSIDE the failed transaction)
      try {
        await withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
          await writeAuditTx(tx, {
            tenantId,
            actor: userId,
            action: "reform.proposal.approved",
            status: "denied",
            errorCode: "PERMISSION_DENIED",
            details: {
              proposalId: input.proposalId,
              permission: err.permission,
            },
          });
        });
      } catch {
        // Fall back to global writeAudit (best-effort, non-atomic)
        try {
          await writeAudit({
            tenantId: session?.user?.tenantId,
            actor: session?.user?.id,
            action: "reform.proposal.approved",
            status: "denied",
            errorCode: "PERMISSION_DENIED",
            details: {
              proposalId: input.proposalId,
              permission: err.permission,
            },
          });
        } catch {
          // Both audit paths failed. The denial is still enforced
          // (original error re-thrown below). Log the audit failure.
          log.error(
            { err: "denied-audit-write-failed", proposalId: input.proposalId },
            "DENIED_AUDIT_WRITE_FAILED — denial still enforced"
          );
        }
      }
    }
    // ALWAYS re-throw the original error (authorization, conflict, not found, etc.)
    throw err;
  }
}

/**
 * Read an approval record with its evidence snapshot.
 *
 * Returns null if no approval exists for the proposal.
 * Tenant-scoped via withAuthenticatedTenant + RLS.
 *
 * Permission: reform:proposal:read (all roles can read approvals)
 */
export async function getReformApproval(
  session: Session | null,
  proposalId: string
): Promise<ReformApproval | null> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const approval = await tx.reformApproval.findFirst({
      where: { proposalId, tenantId },
    });
    return approval;
  });
}
