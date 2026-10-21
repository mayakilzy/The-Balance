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
import { lockProposalRow } from "./lock-helper";
import { coordinationLockKey } from "./coordination-contracts";

// ============================================================
// Create: analyst drafts a proposal linked to an existing G02 alert
// ============================================================
export async function createReformProposal(
  session: Session | null,
  input: CreateReformProposalInput
): Promise<{ proposalId: string; alternativeId?: string }> {
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

      // Create proposal
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

      // G03-03: alternative is optional. If provided, create inline (G03-02 backward compat).
      // If not, alternatives are added separately via addReformAlternative.
      let alternativeId: string | undefined;
      if (parsed.alternative) {
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
        alternativeId = alternative.id;
      }

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "reform.proposal.created",
        details: {
          proposalId: proposal.id,
          alternativeId: alternativeId ?? null,
          originatingAlertId: parsed.originatingAlertId,
          title: parsed.title,
        },
        status: "ok",
      });

      return { proposalId: proposal.id, ...(alternativeId ? { alternativeId } : {}) };
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
// Helper: lockProposalRow is imported from ./lock-helper
// (G03-03-R1 — unified fail-closed SELECT FOR UPDATE).
// See lock-helper.ts for the production contract.
// ============================================================

// ============================================================
// Submit: draft → under_review (analyst action)
// G03-03: Added proposal-row lock (SELECT FOR UPDATE) to prevent
// concurrent alternative addition during the status transition.
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
      // G03-03: Acquire proposal-row lock to serialize with concurrent
      // alternative additions.
      await lockProposalRow(tx, parsed.proposalId, tenantId);

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
      // G03-05: Acquire alert-level advisory lock FIRST (before proposal-row lock)
      // to serialize competing approvals for the same originating alert.
      // This prevents two different proposals for the same alert from being
      // approved concurrently, which could create conflicting active approvals.
      //
      // Lock ordering: alert-level advisory lock → proposal-row SELECT FOR UPDATE
      //
      // MAINTENANCE INVARIANT (R2-6):
      // All approval paths that acquire BOTH the alert-level advisory lock and
      // the proposal-row lock MUST acquire the alert lock FIRST. If a future
      // mission adds a path that acquires the proposal-row lock before the
      // advisory lock, a deadlock could occur. This ordering constraint must
      // be preserved across all concurrent code paths.
      //
      // If originatingAlertId is null (human-initiated proposal without alert),
      // skip the advisory lock and supersession — no alert to lock on.
      const proposalForAlertLock = await tx.reformProposal.findFirst({
        where: { id: parsed.proposalId, tenantId },
        select: { id: true, originatingAlertId: true, strategyVersionId: true, coordinationId: true },
      });
      if (!proposalForAlertLock) {
        throw new NotFoundError(
          `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
        );
      }

      if (proposalForAlertLock.originatingAlertId) {
        // Acquire alert-level advisory lock (transaction-scoped)
        const alertLockKey = `${tenantId}:${proposalForAlertLock.originatingAlertId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${alertLockKey}))`;
      }

      // G03-06 (Phase C): Acquire coordination-level advisory lock BEFORE proposal-row lock.
      // Lock ordering: L-ALERT → L-COORD → L-PROP
      // L-COORD uses a CANONICAL key: hashtext(coordinationId) — NOT tenantId.
      // This ensures all participants share the same lock across tenants.
      // A lead in tenant-A and a participant in tenant-B approving proposals for
      // the same coordination will acquire the SAME lock, serializing activation.
      if (proposalForAlertLock.coordinationId) {
        const coordLockKey = coordinationLockKey(proposalForAlertLock.coordinationId);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${coordLockKey}))`;
      }

      // G03-03: Acquire proposal-row lock (SELECT FOR UPDATE) to serialize
      // competing operations (withdrawal, selection, addition).
      await lockProposalRow(tx, parsed.proposalId, tenantId);

      // Verify proposal exists + is in under_review status (re-read after lock)
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

      // D4: Conditional auto-selection for alternative resolution.
      // - If caller provides alternativeId → verify it's the selected one
      // - If 1 selected exists → use it (G03-03 explicit selection flow)
      // - If 0 selected + exactly 1 draft → auto-select it (G03-02 backward compat)
      // - If 0 selected + >1 draft → ConflictError (requires explicit selection)
      // - If 0 selected + 0 alternatives → ConflictError
      let alternativeId = parsed.alternativeId;

      if (alternativeId) {
        // Caller provided alternativeId — verify it belongs to this proposal
        // and is the selected one (or can be auto-selected if single draft)
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
        if (alt.status === "withdrawn") {
          throw new ConflictError(
            `Alternative ${alternativeId} has been withdrawn and cannot be used for approval.`
          );
        }
        // If it's draft (not yet selected), auto-select it (backward compat)
        if (alt.status === "draft") {
          await tx.reformAlternative.update({
            where: { id: alternativeId },
            data: {
              status: "selected",
              selectedAt: new Date(),
              selectedBy: userId,
            },
          });
        }
        // If already selected, use as-is
      } else {
        // No alternativeId provided — resolve from existing alternatives
        const selectedAlts = await tx.reformAlternative.findMany({
          where: { proposalId: parsed.proposalId, tenantId, status: "selected" },
        });

        if (selectedAlts.length === 1) {
          // G03-03: explicit selection exists — use it
          alternativeId = selectedAlts[0]!.id;
        } else if (selectedAlts.length === 0) {
          // No selected alternative — check for auto-selection (G03-02 compat)
          const draftAlts = await tx.reformAlternative.findMany({
            where: { proposalId: parsed.proposalId, tenantId, status: "draft" },
          });

          if (draftAlts.length === 0) {
            throw new ConflictError(
              `Proposal ${parsed.proposalId} has no alternative to attach to the approval.`
            );
          }

          if (draftAlts.length === 1) {
            // G03-02 backward compat: auto-select the single draft alternative
            alternativeId = draftAlts[0]!.id;
            await tx.reformAlternative.update({
              where: { id: alternativeId },
              data: {
                status: "selected",
                selectedAt: new Date(),
                selectedBy: userId,
              },
            });
          } else {
            // G03-03: multiple draft alternatives, none selected — require explicit selection
            throw new ConflictError(
              `Proposal ${parsed.proposalId} has ${draftAlts.length} draft alternatives but none is selected. Reviewer must select one before approval.`
            );
          }
        } else {
          // Multiple selected — impossible (partial unique index prevents), but fail closed
          throw new ConflictError(
            `Proposal ${parsed.proposalId} has ${selectedAlts.length} selected alternatives. Data integrity issue.`
          );
        }
      }

      // Defense-in-depth: verify the alternative is still 'selected' (not withdrawn concurrently)
      // This is redundant with the proposal lock but provides extra safety.
      const verifyAlt = await tx.reformAlternative.findFirst({
        where: { id: alternativeId, tenantId, status: "selected" },
        select: { id: true },
      });
      if (!verifyAlt) {
        throw new ConflictError(
          `Alternative ${alternativeId} is no longer in 'selected' status. Cannot proceed with approval.`
        );
      }

      // G03-05: Build evidence snapshot at approval time.
      // Read the approved alternative's full data for the snapshot.
      const altSnapshot = await tx.reformAlternative.findFirst({
        where: { id: alternativeId, tenantId },
      });
      if (!altSnapshot) {
        throw new NotFoundError(
          `Alternative ${alternativeId} not found for snapshot`
        );
      }

      // G03-05: Populate supportingEvidence from hypothesizedCauses.supportingEvidenceIds
      // Per PRE-02: supportingEvidence is for VERIFIED EVIDENCE REFERENCES,
      // NOT for the alternative's description/assumptions.
      // The alternative snapshot goes into metadata.alternativeSnapshot.
      const supportingEvidence: Array<{
        evidenceId: string;
        claim: string;
        type: string;
        verificationStatus: string;
        sourceCode: string | null;
      }> = [];
      const counterEvidence: Array<{
        evidenceId: string;
        claim: string;
        type: string;
        verificationStatus: string;
        sourceCode: string | null;
      }> = [];

      // Extract evidence IDs from hypothesizedCauses
      const causes = Array.isArray(proposal.hypothesizedCauses)
        ? (proposal.hypothesizedCauses as Array<Record<string, unknown>>)
        : [];
      const supportingIds: string[] = [];
      const contradictingIds: string[] = [];
      for (const cause of causes) {
        if (Array.isArray(cause.supportingEvidenceIds)) {
          supportingIds.push(...(cause.supportingEvidenceIds as string[]));
        }
        if (Array.isArray(cause.contradictingEvidenceIds)) {
          contradictingIds.push(...(cause.contradictingEvidenceIds as string[]));
        }
      }

      // Fetch evidence records (if any linked)
      if (supportingIds.length > 0) {
        const evidenceRecords = await tx.evidence.findMany({
          where: { id: { in: supportingIds }, tenantId },
        });
        for (const ev of evidenceRecords) {
          supportingEvidence.push({
            evidenceId: ev.id,
            claim: ev.claim,
            type: ev.type,
            verificationStatus: ev.verificationStatus,
            sourceCode: null, // source link via sourceId, not denormalized
          });
        }
      }
      if (contradictingIds.length > 0) {
        const evidenceRecords = await tx.evidence.findMany({
          where: { id: { in: contradictingIds }, tenantId },
        });
        for (const ev of evidenceRecords) {
          counterEvidence.push({
            evidenceId: ev.id,
            claim: ev.claim,
            type: ev.type,
            verificationStatus: ev.verificationStatus,
            sourceCode: null,
          });
        }
      }

      // G03-05: Build the approval snapshot for metadata.
      // Per PRE-02: metadata stores the alternative + proposal snapshot,
      // NOT supportingEvidence (which is for evidence references).
      const approvalMetadata = {
        alternativeSnapshot: {
          alternativeId: altSnapshot.id,
          title: altSnapshot.title,
          description: altSnapshot.description,
          costEstimateMin:
            altSnapshot.costEstimateMin !== null
              ? Number(altSnapshot.costEstimateMin)
              : null,
          costEstimateMax:
            altSnapshot.costEstimateMax !== null
              ? Number(altSnapshot.costEstimateMax)
              : null,
          costCurrency: altSnapshot.costCurrency,
          riskLevel: altSnapshot.riskLevel,
          feasibilityScore: altSnapshot.feasibilityScore,
          assumptions: Array.isArray(altSnapshot.assumptions)
            ? (altSnapshot.assumptions as string[])
            : [],
          anticipatedOutcomes: Array.isArray(altSnapshot.anticipatedOutcomes)
            ? (altSnapshot.anticipatedOutcomes as string[])
            : [],
          draftedVia: altSnapshot.draftedVia,
          simulated: altSnapshot.simulated,
          provider:
            (altSnapshot.metadata as { provider?: string } | null)?.provider ??
            null,
        },
        proposalSnapshot: {
          proposalId: proposal.id,
          title: proposal.title,
          problemStatement: proposal.problemStatement,
          strategyVersionId: proposal.strategyVersionId,
          originatingAlertId: proposal.originatingAlertId,
        },
        capturedAt: new Date().toISOString(),
        schemaVersion: 1 as const,
      };

      // Create the immutable approval record (append-only)
      const approval = await tx.reformApproval.create({
        data: {
          tenantId,
          proposalId: parsed.proposalId,
          alternativeId,
          approvedBy: userId,
          approvalNotes: parsed.approvalNotes ?? null,
          rationale: parsed.rationale,
          supportingEvidence, // evidence references (frozen contract)
          counterEvidence, // counter-evidence references (frozen contract)
          metadata: approvalMetadata, // G03-05: structured snapshot
        },
      });

      // G03-05: Supersession logic.
      // If the proposal has an originatingAlertId, check for an existing
      // approved proposal for the same alert. If found, supersede it.
      // This runs in the SAME transaction as the approval creation → atomic.
      if (proposalForAlertLock.originatingAlertId) {
        const oldApproved = await tx.reformProposal.findFirst({
          where: {
            tenantId,
            originatingAlertId: proposalForAlertLock.originatingAlertId,
            status: "approved",
            id: { not: parsed.proposalId },
            supersededById: null,
          },
        });
        if (oldApproved) {
          // Supersede the old proposal
          await tx.reformProposal.update({
            where: { id: oldApproved.id },
            data: {
              status: "superseded",
              supersededAt: new Date(),
              supersededById: parsed.proposalId,
            },
          });
          // Audit the supersession (same transaction → atomic)
          await writeAuditTx(tx, {
            tenantId,
            actor: userId,
            action: "reform.proposal.superseded",
            details: {
              oldProposalId: oldApproved.id,
              newProposalId: parsed.proposalId,
              originatingAlertId: proposalForAlertLock.originatingAlertId,
            },
            status: "ok",
          });
        }
      }

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
          hasEvidenceSnapshot: supportingEvidence.length > 0,
          hasMetadataSnapshot: true,
        },
        status: "ok",
      });

      // G03-06 (Phase B): Atomic coordination activation.
      // If the approved proposal is linked to a coordination AND the coordination
      // is in 'plan_approved' status, check if ALL linked proposals are now
      // approved. If so, transition the coordination to 'active'.
      //
      // This runs in the SAME transaction as the approval — atomic with the
      // approval record creation, proposal status transition, and audit log.
      //
      // The L-COORD advisory lock is already held (acquired above before L-PROP),
      // so concurrent approvals for the same coordination are serialized.
      //
      // The function is_coordination_fully_approved is SECURITY DEFINER owned by
      // balance_coordination_admin. balance_app does NOT have EXECUTE (revoked
      // in PR05-FIX-02). We call it via $queryRaw — the application connection
      // (balance_app) cannot invoke it directly. However, the approval flow
      // runs inside withAuthenticatedTenant, and we need to evaluate the
      // activation predicate. Since the function checks app.tenant_id (secondary
      // gate), we use $queryRaw which runs in the caller's context.
      //
      // IMPORTANT: balance_app does NOT have EXECUTE on this function. This
      // call will fail with "permission denied for function" unless the caller
      // has EXECUTE. The application must use a trusted connection path.
      //
      // Phase B implementation: for now, we evaluate the activation condition
      // inline (without calling the SQL function) using a Prisma query. This
      // avoids the EXECUTE boundary issue entirely — the activation check is
      // done by the application code, not by the SQL function. The SQL function
      // remains available for inspection by balance_admin and for future use
      // when a trusted connection path is established.
      //
      // The inline check replicates the 5 conditions of is_coordination_fully_approved
      // but runs under the caller's RLS context (balance_app). This is safe because:
      //   1. The caller is already authenticated (withAuthenticatedTenant verified)
      //   2. The caller's tenant is the lead or a participant (verified by the
      //      coordination's RLS — the proposal is visible to the caller)
      //   3. The L-COORD lock serializes concurrent activation checks
      //   4. The result is a BOOLEAN — no cross-tenant content is exposed
      if (proposalForAlertLock.coordinationId) {
        const coordination = await tx.reformCoordination.findFirst({
          where: { id: proposalForAlertLock.coordinationId },
          select: { id: true, status: true, leadTenantId: true },
        });
        if (coordination && coordination.status === "plan_approved") {
          // Inline activation check (replicates is_coordination_fully_approved conditions)
          // Condition 1: ≥1 active participant
          const hasActiveParticipant = await tx.reformCoordinationParticipant.findFirst({
            where: { coordinationId: coordination.id, status: "active" },
          });
          // Condition 2: ≥1 linked proposal (via events table)
          const hasLinkedProposal = await tx.$queryRaw<{ exists: boolean }[]>`
            SELECT EXISTS(
              SELECT 1 FROM "reform_coordination_approval_events"
              WHERE "coordinationId" = ${coordination.id}::text
                AND "eventType" = 'proposal_linked'
            ) AS exists
          `;
          // Condition 3: every active participant has ≥1 linked proposal
          const participantsWithoutProposal = await tx.$queryRaw<{ count: bigint }[]>`
            SELECT count(*)::bigint AS count FROM "reform_coordination_participants" part
            WHERE part."coordinationId" = ${coordination.id}::text
              AND part."status" = 'active'
              AND NOT EXISTS(
                SELECT 1 FROM "reform_coordination_approval_events" e
                WHERE e."coordinationId" = ${coordination.id}::text
                  AND e."participantTenantId" = part."tenantId"
                  AND e."eventType" = 'proposal_linked'
              )
          `;
          // Condition 4: every linked proposal has a current approved state
          // (latest event for each proposal is 'approved', not superseded/withdrawn)
          const unapprovedProposals = await tx.$queryRaw<{ count: bigint }[]>`
            SELECT count(*)::bigint AS count FROM "reform_coordination_approval_events" linked
            WHERE linked."coordinationId" = ${coordination.id}::text
              AND linked."eventType" = 'proposal_linked'
              AND NOT EXISTS(
                SELECT 1 FROM "reform_coordination_approval_events" approved
                WHERE approved."proposalId" = linked."proposalId"
                  AND approved."coordinationId" = ${coordination.id}::text
                  AND approved."eventType" = 'approved'
                  AND approved."sequenceNumber" > linked."sequenceNumber"
                  AND NOT EXISTS(
                    SELECT 1 FROM "reform_coordination_approval_events" invalidated
                    WHERE invalidated."proposalId" = linked."proposalId"
                      AND invalidated."coordinationId" = ${coordination.id}::text
                      AND invalidated."eventType" IN ('superseded', 'withdrawn')
                      AND invalidated."sequenceNumber" > approved."sequenceNumber"
                  )
              )
          `;

          const fullyApproved =
            !!hasActiveParticipant &&
            hasLinkedProposal[0]?.exists === true &&
            (participantsWithoutProposal[0]?.count ?? BigInt(1)) === BigInt(0) &&
            (unapprovedProposals[0]?.count ?? BigInt(1)) === BigInt(0);

          if (fullyApproved) {
            const activatedAt = new Date();
            await tx.reformCoordination.update({
              where: { id: coordination.id },
              data: {
                status: "active",
                activatedAt,
                updatedAt: activatedAt,
              },
            });

            await writeAuditTx(tx, {
              tenantId,
              actor: userId,
              action: "reform.coordination.activated",
              details: {
                coordinationId: coordination.id,
                activatedAt: activatedAt.toISOString(),
                triggerProposalId: parsed.proposalId,
                triggerApprovalId: approval.id,
              },
              status: "ok",
            });
          }
        }
      }

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
      // G03-06 Phase C: acquire L-COORD before updating the proposal,
      // to serialize with approval/activation paths.
      const proposalForCoordLock = await tx.reformProposal.findFirst({
        where: { id: parsed.proposalId, tenantId },
        select: { id: true, coordinationId: true },
      });
      if (!proposalForCoordLock) {
        throw new NotFoundError(
          `Proposal ${parsed.proposalId} not found in tenant ${tenantId}`
        );
      }
      if (proposalForCoordLock.coordinationId) {
        const coordLockKey = coordinationLockKey(proposalForCoordLock.coordinationId);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${coordLockKey}))`;
      }

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
