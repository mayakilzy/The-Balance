// ============================================================
// approval-service.ts — Human Approval Workflow (G01 wrapper)
// ------------------------------------------------------------
// Mission 01-10: Wraps G00's approveStrategyVersion with denied-attempt
// audit logging. The approval itself (authorization, immutability,
// domain event, atomic audit_log write) is handled by G00's
// approveStrategyVersion — which now calls writeAuditTx INSIDE its
// transaction (01-10 modification to strategy-service.ts).
//
// This wrapper adds:
//   - Denied-attempt audit logging (for T1.10): when a user without
//     strategy:approve attempts approval, the PermissionDeniedError
//     is caught, an audit_log row with status="denied" is written
//     (best-effort, outside the failed transaction), and the error
//     is re-thrown.
//
// The advisor (01-09) does NOT have access to this function — it
// only produces advisory reports. The human decides.
//
// Per §13 Correction B: three independent evidence layers:
//   1. Authorization enforcement (requirePermissionWithCurrentRole)
//   2. Domain Event (events table — domain timeline)
//   3. Audit Log (audit_log table — sovereign audit trail, atomic)
// ============================================================
import type { Session } from "next-auth";
import { approveStrategyVersion } from "@/lib/strategy-service";
import { writeAuditTx, writeAudit } from "@/lib/audit";
import { PermissionDeniedError } from "@/lib/permissions";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";

export { approveStrategyVersion };

/**
 * Safe approval wrapper — catches PermissionDeniedError and writes
 * an audit_log row with status="denied" BEFORE re-throwing.
 *
 * For SUCCESSFUL approvals: G00's approveStrategyVersion already writes
 * the audit_log row atomically inside the transaction (via writeAuditTx).
 * This wrapper does NOT add a second audit row for successful approvals.
 *
 * For DENIED approvals: the transaction is rolled back (permission check
 * fails before any write), so the atomic audit_log write inside the
 * transaction never executes. This wrapper catches the error and writes
 * a best-effort audit_log row with status="denied" AFTER the rollback.
 * This ensures denied attempts are still recorded in the audit trail.
 */
export async function approveStrategyVersionWithAuditSafe(
  session: Session,
  versionId: string,
  approvalNotes?: string
): Promise<{ versionId: string; status: string; approvedBy: string }> {
  try {
    // This calls G00's approveStrategyVersion, which:
    //   1. Checks permission (throws PermissionDeniedError if denied)
    //   2. Updates version to approved
    //   3. Supersedes previous versions
    //   4. Creates domain event
    //   5. Writes audit_log (atomic, via writeAuditTx)
    // All in ONE transaction.
    return await approveStrategyVersion(session, versionId, approvalNotes);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      // Denied attempt — the primary transaction was rolled back.
      // Write an audit_log row for the denied attempt using a NEW
      // withAuthenticatedTenant transaction (to set tenant context for RLS).
      // This is OUTSIDE the failed transaction, so it's a separate
      // best-effort write. If this also fails, the denial is still
      // enforced (the original PermissionDeniedError is re-thrown).
      //
      // FIX-2 (01-10-FINAL-CLOSURE): The original PermissionDeniedError MUST
      // always be the error the caller sees. Audit logging failures are
      // operational issues — they must NOT replace or hide the authorization
      // error. We wrap the entire denial-audit in a try/catch that swallows
      // any secondary error, then re-throw the ORIGINAL PermissionDeniedError.
      try {
        try {
          await withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
            await writeAuditTx(tx, {
              tenantId,
              actor: userId,
              action: "strategy.version_approved",
              status: "denied",
              errorCode: "PERMISSION_DENIED",
              details: {
                strategyVersionId: versionId,
                permission: err.permission,
              },
            });
          });
        } catch {
          // withAuthenticatedTenant or writeAuditTx failed (e.g. membership suspended).
          // Fall back to the global writeAudit (best-effort, may also fail due to RLS).
          // The original PermissionDeniedError is preserved regardless.
          await writeAudit({
            tenantId: session.user?.tenantId,
            actor: session.user?.id,
            action: "strategy.version_approved",
            status: "denied",
            errorCode: "PERMISSION_DENIED",
            details: { strategyVersionId: versionId, permission: err.permission },
          });
        }
      } catch {
        // Both audit paths failed. The denial is still enforced —
        // the original PermissionDeniedError is re-thrown below.
        // The audit failure is an operational issue that must be
        // alerted on via log monitoring (writeAudit logs internally
        // before throwing, but even if it doesn't, we swallow here).
      }
    }
    // Re-throw the ORIGINAL error (always — denied or otherwise)
    throw err;
  }
}
