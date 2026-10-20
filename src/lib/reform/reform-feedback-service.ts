// ============================================================
// src/lib/reform/reform-feedback-service.ts
// ------------------------------------------------------------
// G03-02 — Minimum Viable Single-Tenant Reform Vertical Slice
//
// Implements:
//   createReformFeedbackLoop — descriptive feedback + optional new G02 observation
//   getReformFeedbackLoop
//   closeOriginatingAlert — uses G02 closeAlert contract (NOT direct writes)
//
// Descriptive Attribution (per G03-00 SECURITY_AND_EVIDENCE_POLICY):
//   - attributionLevel is hardcoded to "descriptive" in the service.
//     The DB trigger `enforce_reform_feedback_attribution_descriptive`
//     enforces this at the row level (defense-in-depth).
//   - The service does NOT accept attributionLevel from client input.
//   - Zod schema rejects causal language in descriptiveSummary.
//
// Observation Integration (per G03-00 INTEGRATION_CONTRACTS §4.10):
//   - If `newAfterObservation` is provided, the service calls G02
//     `ingestObservationTx` (the transaction-aware variant of
//     `ingestObservation`) to create a NEW observation IN THE SAME
//     TRANSACTION as the feedback loop. The returned observationId is
//     set as `afterObservationId`. This guarantees atomicity: if the
//     feedback loop creation fails, the observation is rolled back too.
//   - The existing `beforeObservationId` (if any) is NEVER mutated.
//   - G02 business rules (provenance validation, country scope, E3
//     cross-country check) are reused via `ingestObservationTx` —
//     NO business logic duplication.
//
// Alert Closure (per G03-00 INTEGRATION_CONTRACTS §4.10):
//   - closeOriginatingAlert uses the G02 `closeAlert` contract, NOT
//     direct writes to the `alerts` table.
//   - The G02 closeAlert contract requires:
//       * lifecycleStage in {reviewed, decision_documented, closed}
//       * non-empty closureReason
//       * `observatory:alert:act` permission (reviewer, admin)
//   - If the alert is not in a closable stage, the operation fails
//     WITHOUT leaving a falsely completed workflow.
//
// Atomicity:
//   - createReformFeedbackLoop writes feedback + (optional) new observation
//     + audit_log in the SAME transaction via `ingestObservationTx`. If any
//     step fails, ALL rolled back (observation included — no orphan).
//   - closeOriginatingAlert is a separate operation (not part of the feedback
//     transaction) because the G02 closeAlert uses its own transaction via
//     withAuthenticatedTenant. This is intentional: alert closure is an
//     independent institutional action that requires its own audit record.
//
// Authorization:
//   - createReformFeedbackLoop: reform:action:write (analyst, admin) +
//     observatory:observation:ingest (when newAfterObservation is provided)
//   - getReformFeedbackLoop: reform:verification:read (analyst, reviewer, admin)
//   - closeOriginatingAlert: observatory:alert:act (reviewer, admin)
// ============================================================
import type { Session } from "next-auth";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { ingestObservationTx } from "@/lib/state-observatory/observation-service";
import { IngestObservationInputSchema } from "@/lib/state-observatory/contracts";
import { closeAlert } from "@/lib/state-observatory/alert-service";
import {
  CreateReformFeedbackLoopInputSchema,
  CloseOriginatingAlertInputSchema,
  NotFoundError,
  ConflictError,
} from "./contracts";
import type {
  ReformFeedbackLoop,
  CreateReformFeedbackLoopInput,
} from "./contracts";

// ============================================================
// Create: descriptive feedback loop + optional new G02 observation
// ============================================================
export async function createReformFeedbackLoop(
  session: Session | null,
  input: CreateReformFeedbackLoopInput
): Promise<{ feedbackLoopId: string; newObservationId?: string }> {
  // The analyst creating the feedback needs reform:action:write.
  await requirePermissionWithCurrentRole(session, "reform:action:write");

  // If a new observation is requested, the analyst ALSO needs
  // observatory:observation:ingest permission. We check this BEFORE
  // entering the transaction to fail fast on authorization.
  const parsed = CreateReformFeedbackLoopInputSchema.parse(input);
  if (parsed.newAfterObservation) {
    await requirePermissionWithCurrentRole(
      session,
      "observatory:observation:ingest"
    );
  }

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify the action exists + belongs to this tenant + is verified
      // (or disputed — feedback can describe disputed implementations too).
      // Feedback REQUIRES verification first — D5 separation.
      const action = await tx.reformAction.findFirst({
        where: { id: parsed.actionId, tenantId },
      });
      if (!action) {
        throw new NotFoundError(
          `Action ${parsed.actionId} not found in tenant ${tenantId}`
        );
      }

      const verification = await tx.reformVerification.findFirst({
        where: { actionId: parsed.actionId, tenantId },
      });
      if (!verification) {
        throw new ConflictError(
          `Action ${parsed.actionId} has no verification record. Feedback requires verification first (D5 separation).`
        );
      }
      if (
        verification.verificationStatus !== "verified" &&
        verification.verificationStatus !== "disputed"
      ) {
        throw new ConflictError(
          `Action ${parsed.actionId} verification is in status "${verification.verificationStatus}", cannot create feedback (must be "verified" or "disputed").`
        );
      }

      // Verify no existing feedback loop for this action (1:1 invariant)
      const existingFeedback = await tx.reformFeedbackLoop.findFirst({
        where: { actionId: parsed.actionId, tenantId },
      });
      if (existingFeedback) {
        throw new ConflictError(
          `Action ${parsed.actionId} already has a feedback loop (${existingFeedback.id}). 1:1 invariant — cannot create a second.`
        );
      }

      // Optional: ingest a NEW observation via the G02 contract.
      // CRITICAL ATOMICITY: this uses `ingestObservationTx` (the transaction-aware
      // variant) which accepts OUR `tx` client. The observation INSERT + its
      // audit_log entry commit/roll back WITH the feedback loop creation.
      // If the feedback loop creation fails (e.g., DB trigger violation),
      // the observation is rolled back too — no orphan observations.
      let newObservationId: string | undefined;
      if (parsed.newAfterObservation) {
        // Validate the observation input via G02's Zod schema (defense-in-depth)
        const obsInput = IngestObservationInputSchema.parse(
          parsed.newAfterObservation
        );
        const newObs = await ingestObservationTx(obsInput, tx, tenantId, userId);
        newObservationId = newObs.id;
      }

      // Create the feedback loop. attributionLevel is hardcoded to "descriptive"
      // — the service does NOT accept it from client input.
      const feedbackLoop = await tx.reformFeedbackLoop.create({
        data: {
          tenantId,
          actionId: parsed.actionId,
          beforeObservationId: parsed.beforeObservationId ?? null,
          afterObservationId: newObservationId ?? parsed.afterObservationId ?? null,
          comparisonType: parsed.comparisonType,
          descriptiveSummary: parsed.descriptiveSummary,
          attributionLevel: "descriptive", // hardcoded — DB trigger enforces
          createdBy: userId,
        },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.feedback.created",
        details: {
          actionId: parsed.actionId,
          feedbackLoopId: feedbackLoop.id,
          newObservationId: newObservationId ?? null,
          attributionLevel: "descriptive",
        },
        status: "ok",
      });

      return {
        feedbackLoopId: feedbackLoop.id,
        ...(newObservationId ? { newObservationId } : {}),
      };
    }
  );
}

// ============================================================
// Get: read the feedback loop for an action
// ============================================================
export async function getReformFeedbackLoop(
  session: Session | null,
  actionId: string
): Promise<ReformFeedbackLoop | null> {
  await requirePermissionWithCurrentRole(session, "reform:verification:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const feedback = await tx.reformFeedbackLoop.findFirst({
      where: { actionId, tenantId },
    });
    return feedback;
  });
}

// ============================================================
// Close Originating Alert: uses G02 closeAlert contract
// ============================================================
export async function closeOriginatingAlert(
  session: Session | null,
  input: { proposalId: string; closureReason: string }
): Promise<{ alertClosed: boolean; alertId: string }> {
  await requirePermissionWithCurrentRole(session, "observatory:alert:act");

  const parsed = CloseOriginatingAlertInputSchema.parse(input);

  // Read the proposal to find its originatingAlertId. This read uses
  // withAuthenticatedTenant to enforce RLS — we cannot close an alert
  // for a proposal that doesn't belong to our tenant.
  const proposalInfo = await withAuthenticatedTenant(
    session,
    async ({ tx, tenantId }) => {
      const proposal = await tx.reformProposal.findFirst({
        where: { id: parsed.proposalId, tenantId },
        select: {
          id: true,
          originatingAlertId: true,
          status: true,
        },
      });
      if (!proposal) {
        throw new NotFoundError(
          `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
        );
      }
      if (!proposal.originatingAlertId) {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} has no originating alert to close.`
        );
      }
      // Verify the proposal workflow is complete before closing the alert:
      //   - proposal is approved (not draft/under_review/rejected)
      //   - action exists and is completed
      //   - verification exists and is verified (not pending)
      //   - feedback loop exists
      // This is the institutional-sovereignty gate — we cannot claim an
      // alert is closed just because someone called the API. The workflow
      // must actually be complete.
      if (proposal.status !== "approved") {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} is in status "${proposal.status}", cannot close alert (must be "approved")`
        );
      }
      const action = await tx.reformAction.findFirst({
        where: { proposalId: proposal.id, tenantId },
        select: { id: true, status: true },
      });
      if (!action) {
        throw new ConflictError(
          `Proposal ${parsed.proposalId} has no action; cannot close alert.`
        );
      }
      if (action.status !== "completed") {
        throw new ConflictError(
          `Action ${action.id} is in status "${action.status}", cannot close alert (must be "completed")`
        );
      }
      const verification = await tx.reformVerification.findFirst({
        where: { actionId: action.id, tenantId },
        select: { verificationStatus: true },
      });
      if (!verification) {
        throw new ConflictError(
          `Action ${action.id} has no verification record; cannot close alert.`
        );
      }
      if (verification.verificationStatus !== "verified") {
        throw new ConflictError(
          `Action ${action.id} verification is in status "${verification.verificationStatus}", cannot close alert (must be "verified"). Disputed actions cannot close alerts.`
        );
      }
      const feedback = await tx.reformFeedbackLoop.findFirst({
        where: { actionId: action.id, tenantId },
        select: { id: true },
      });
      if (!feedback) {
        throw new ConflictError(
          `Action ${action.id} has no feedback loop; cannot close alert. Descriptive feedback must be created first.`
        );
      }
      return {
        alertId: proposal.originatingAlertId,
      };
    }
  );

  // Use the G02 closeAlert contract — NOT direct table writes.
  // closeAlert uses its own withAuthenticatedTenant transaction and
  // writes its own audit_log entry. The precondition checks above ensure
  // we don't reach closeAlert unless the workflow is genuinely complete.
  await closeAlert(session, proposalInfo.alertId, parsed.closureReason);

  return { alertClosed: true, alertId: proposalInfo.alertId };
}
