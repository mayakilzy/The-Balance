// ============================================================
// src/lib/reform/reform-verification-service.ts
// ------------------------------------------------------------
// G03-02 — Minimum Viable Single-Tenant Reform Vertical Slice
//
// Implements:
//   verifyReformAction  — F6 verification (verified/disputed)
//   getReformVerification — read pending verification record
//
// F6 Triple Defense (per G03-00 SECURITY_AND_EVIDENCE_POLICY):
//   1. Zod superRefine: rejects verifiedAction/evidenceSource missing
//      when verificationStatus=verified (in contracts.ts).
//   2. Service check: rejects vague verifiedAction descriptions like
//      "inflation improved" — the verifiedAction MUST describe the
//      SPECIFIC action verified, NOT a policy outcome.
//   3. DB trigger `enforce_reform_verification_f6` (migration 0022):
//      raises exception at the row level if verified/disputed fields
//      are missing. The service does NOT bypass this trigger.
//
// Precondition: action MUST be in "completed" status before verification
// can be set to "verified" or "disputed". A pending verification record
// is created automatically when the action is created (via the action
// service). The verification is updated in-place via conditional UPDATE
// (only `pending` → `verified` or `pending` → `disputed` is allowed).
//
// Atomicity:
//   The verification transition + audit_log write are in the SAME
//   transaction. If the audit write fails, the verification does not
//   commit.
//
// Authorization: `reform:action:verify` (reviewer, admin) — NOT analyst.
// ============================================================
import type { Session } from "next-auth";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  VerifyReformActionInputSchema,
  GetReformVerificationInputSchema,
  NotFoundError,
  ConflictError,
} from "./contracts";
import type { ReformVerification, VerifyReformActionInput } from "./contracts";

// ============================================================
// Verify: pending → verified OR pending → disputed
// ============================================================
export async function verifyReformAction(
  session: Session | null,
  input: VerifyReformActionInput
): Promise<{ verificationId: string; verificationStatus: string }> {
  await requirePermissionWithCurrentRole(session, "reform:action:verify");

  const parsed = VerifyReformActionInputSchema.parse(input);

  // Defense-in-depth: service-level check on verifiedAction content.
  // The verifiedAction MUST describe the SPECIFIC action verified,
  // NOT a policy outcome. Vague claims like "inflation improved" or
  // "the policy worked" are rejected.
  if (parsed.verificationStatus === "verified") {
    const vaguePatterns = [
      /\binflation\b.*\b(improved|reduced|decreased|increased)\b/i,
      /\bthe policy\b.*\b(worked|succeeded|failed)\b/i,
      /\boutcome\b.*\b(improved|worse|better)\b/i,
      /\bgdp\b.*\b(grew|increased|decreased)\b/i,
      /\bunemployment\b.*\b(fell|rose|decreased|increased)\b/i,
    ];
    for (const pattern of vaguePatterns) {
      if (pattern.test(parsed.verifiedAction ?? "")) {
        throw new ConflictError(
          `F6 service check: verifiedAction must describe the SPECIFIC action verified (e.g. "Action #A1 mandate published in gazette on 2025-03-15"), NOT a policy outcome. Detected vague pattern: ${pattern.source}`
        );
      }
    }
  }

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify the action exists + belongs to this tenant + is completed
      const action = await tx.reformAction.findFirst({
        where: { id: parsed.actionId, tenantId },
      });
      if (!action) {
        throw new NotFoundError(
          `Action ${parsed.actionId} not found in tenant ${tenantId}`
        );
      }
      if (action.status !== "completed") {
        throw new ConflictError(
          `Action ${parsed.actionId} is in status "${action.status}", cannot verify (must be "completed")`
        );
      }

      // Find the existing verification record (created when the action was created)
      const verification = await tx.reformVerification.findFirst({
        where: { actionId: parsed.actionId, tenantId },
      });
      if (!verification) {
        throw new ConflictError(
          `Action ${parsed.actionId} has no verification record. This indicates a data integrity issue — the action service should have created one when the action was created.`
        );
      }
      if (verification.verificationStatus !== "pending") {
        throw new ConflictError(
          `Verification ${verification.id} is in status "${verification.verificationStatus}", cannot verify again (must be "pending"). Immutable once set.`
        );
      }

      // Update the verification record. The F6 DB trigger will enforce
      // that verifiedAction + evidenceSource are present when status=verified.
      // We do NOT bypass the trigger.
      await tx.reformVerification.update({
        where: { id: verification.id },
        data: {
          verificationStatus: parsed.verificationStatus,
          verifiedAction: parsed.verifiedAction ?? null,
          evidenceSource: parsed.evidenceSource ?? null,
          disputeReason: parsed.disputeReason ?? null,
          disputeEvidenceSource: parsed.disputeEvidenceSource ?? null,
          verifiedBy: userId,
          verifiedAt: new Date(),
          notes: parsed.notes ?? null,
        },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.verification.set",
        details: {
          actionId: parsed.actionId,
          verificationId: verification.id,
          verificationStatus: parsed.verificationStatus,
        },
        status: "ok",
      });

      return {
        verificationId: verification.id,
        verificationStatus: parsed.verificationStatus,
      };
    }
  );
}

// ============================================================
// Get: read the verification record for an action
// ============================================================
export async function getReformVerification(
  session: Session | null,
  actionId: string
): Promise<ReformVerification | null> {
  await requirePermissionWithCurrentRole(session, "reform:verification:read");

  GetReformVerificationInputSchema.parse({ actionId });

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const verification = await tx.reformVerification.findFirst({
      where: { actionId, tenantId },
    });
    return verification;
  });
}
