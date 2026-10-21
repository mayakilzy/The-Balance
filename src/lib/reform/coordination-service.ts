// ============================================================
// src/lib/reform/coordination-service.ts
// ------------------------------------------------------------
// G03-06 — Multi-Institution Coordination Service
//
// Implements the approved G03-06 capabilities (OD-7: 16 active routes):
//   - Coordination creation and lifecycle (create, list, get, close)
//   - Participant management (add, list, withdraw — self-withdrawal only;
//     B3 remove-participant DEFERRED to G03-07)
//   - Invitations (create, accept, decline, revoke)
//   - Plan submission and human approval
//   - Shared snapshots (create, list, approve, revoke)
//   - Cross-tenant shared view (coordination-aware)
//
// Lock ordering (OD-4): L-ALERT → L-COORD → L-PROP
// L-COORD uses a CANONICAL key: hashtext(coordinationId) — NOT tenantId.
// This ensures all participants share the same lock across tenants.
//
// B3 operations (remove participant, grant commitment, verify institution)
// remain DORMANT — deferred to G03-07.
// ============================================================
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import { NotFoundError, ConflictError, PermissionDeniedError } from "./contracts";
import { coordinationLockKey } from "./coordination-contracts";
import type {
  CreateCoordinationInput,
  ListCoordinationsInput,
  GetCoordinationInput,
  CloseCoordinationInput,
  AddCoordinationParticipantInput,
  ListCoordinationParticipantsInput,
  WithdrawCoordinationParticipantInput,
  CreateCoordinationInvitationInput,
  AcceptCoordinationInvitationInput,
  DeclineCoordinationInvitationInput,
  RevokeCoordinationInvitationInput,
  SubmitCoordinationPlanInput,
  ApproveCoordinationPlanInput,
  CreateSharedSnapshotInput,
  ListSharedSnapshotsInput,
  ApproveSharedSnapshotInput,
  RevokeSharedSnapshotInput,
  GetCoordinationSharedViewInput,
} from "./coordination-contracts";

// ============================================================
// 1. Create coordination
// ============================================================
export async function createCoordination(
  session: Session | null,
  input: CreateCoordinationInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const leadTenantId = input.leadTenantId || tenantId;
    // Only the lead tenant can create a coordination where they are the lead
    if (leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }

    const coordination = await tx.reformCoordination.create({
      data: {
        leadTenantId,
        countryId: input.countryId,
        title: input.title,
        description: input.description,
        originatingAlertId: input.originatingAlertId,
        originatingVarianceRecordId: input.originatingVarianceRecordId,
        approvalPolicy: input.approvalPolicy,
        status: "draft",
        createdBy: userId,
        metadata: (input.metadata as any) ?? {},
      },
    });

    // Auto-add the lead as a participant
    await tx.reformCoordinationParticipant.create({
      data: {
        coordinationId: coordination.id,
        tenantId,
        role: "lead",
        status: "active",
        joinedAt: new Date(),
        addedBy: userId,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.created",
      details: { coordinationId: coordination.id, title: coordination.title },
      status: "ok",
    });

    return { coordinationId: coordination.id };
  });
}

// ============================================================
// 2. List coordinations (coordination-aware RLS — lead OR participant)
// ============================================================
export async function listCoordinations(
  session: Session | null,
  input: ListCoordinationsInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    return tx.reformCoordination.findMany({
      where: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.leadTenantId ? { leadTenantId: input.leadTenantId } : {}),
      },
      take: input.limit,
      skip: input.offset,
      orderBy: { createdAt: "desc" },
      // RLS ensures only coordinations where the caller is lead or active participant are visible
    });
  });
}

// ============================================================
// 3. Get coordination
// ============================================================
export async function getCoordination(
  session: Session | null,
  input: GetCoordinationInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx }) => {
    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }
    return coordination;
  });
}

// ============================================================
// 4. Close coordination (lead only)
// ============================================================
export async function closeCoordination(
  session: Session | null,
  input: CloseCoordinationInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Acquire L-COORD (canonical key — coordinationId only)
    const lockKey = coordinationLockKey(input.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }
    if (coordination.status !== "active" && coordination.status !== "plan_approved") {
      throw new ConflictError(
        `Coordination ${input.coordinationId} is in status "${coordination.status}", cannot close`
      );
    }

    await tx.reformCoordination.update({
      where: { id: input.coordinationId },
      data: {
        status: "closed",
        closedAt: new Date(),
        closedBy: userId,
        closureReason: input.closureReason,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.closed",
      details: { coordinationId: input.coordinationId, reason: input.closureReason },
      status: "ok",
    });

    return { coordinationId: input.coordinationId, status: "closed" };
  });
}

// ============================================================
// 5. Add participant (lead only)
// ============================================================
export async function addCoordinationParticipant(
  session: Session | null,
  input: AddCoordinationParticipantInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const lockKey = coordinationLockKey(input.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }

    // Check for existing participant (unique index on coordinationId + tenantId)
    const existing = await tx.reformCoordinationParticipant.findFirst({
      where: { coordinationId: input.coordinationId, tenantId: input.tenantId },
    });
    if (existing) {
      throw new ConflictError(
        `Tenant ${input.tenantId} is already a participant in coordination ${input.coordinationId}`
      );
    }

    const participant = await tx.reformCoordinationParticipant.create({
      data: {
        coordinationId: input.coordinationId,
        tenantId: input.tenantId,
        institutionId: input.institutionId,
        role: input.role,
        status: "active",
        joinedAt: new Date(),
        addedBy: userId,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.participant_added",
      details: {
        coordinationId: input.coordinationId,
        participantTenantId: input.tenantId,
        role: input.role,
      },
      status: "ok",
    });

    return { participantId: participant.id };
  });
}

// ============================================================
// 6. List participants (coordination-aware — lead sees all, participant sees all via OD-5 RLS)
// ============================================================
export async function listCoordinationParticipants(
  session: Session | null,
  input: ListCoordinationParticipantsInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx }) => {
    return tx.reformCoordinationParticipant.findMany({
      where: { coordinationId: input.coordinationId },
      orderBy: { joinedAt: "asc" },
      // RLS (OD-5) ensures lead sees all participants; participant sees own + lead sees theirs
    });
  });
}

// ============================================================
// 7. Withdraw participant (self-withdrawal — RLS-permitted, no DEFINER needed)
// ============================================================
export async function withdrawCoordinationParticipant(
  session: Session | null,
  input: WithdrawCoordinationParticipantInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const lockKey = coordinationLockKey(input.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const participant = await tx.reformCoordinationParticipant.findFirst({
      where: { coordinationId: input.coordinationId, tenantId, status: "active" },
    });
    if (!participant) {
      throw new NotFoundError(
        `Active participant for tenant ${tenantId} in coordination ${input.coordinationId} not found`
      );
    }
    if (participant.role === "lead") {
      throw new ConflictError("Lead cannot self-withdraw; close the coordination instead");
    }

    await tx.reformCoordinationParticipant.update({
      where: { id: participant.id },
      data: {
        status: "withdrawn",
        withdrawnAt: new Date(),
        withdrawalReason: input.withdrawalReason,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.participant_withdrawn",
      details: {
        coordinationId: input.coordinationId,
        reason: input.withdrawalReason,
      },
      status: "ok",
    });

    return { participantId: participant.id, status: "withdrawn" };
  });
}

// ============================================================
// 8. Create invitation (lead only)
// ============================================================
export async function createCoordinationInvitation(
  session: Session | null,
  input: CreateCoordinationInvitationInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const lockKey = coordinationLockKey(input.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }

    const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await tx.reformCoordinationInvitation.create({
      data: {
        coordinationId: input.coordinationId,
        invitedTenantId: input.invitedTenantId,
        invitedInstitutionId: input.invitedInstitutionId,
        invitedRole: input.invitedRole,
        status: "pending",
        expiresAt,
        createdBy: userId,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.invitation_created",
      details: {
        coordinationId: input.coordinationId,
        invitationId: invitation.id,
        invitedTenantId: input.invitedTenantId,
      },
      status: "ok",
    });

    return { invitationId: invitation.id };
  });
}

// ============================================================
// 9. Accept invitation (invited tenant)
// ============================================================
export async function acceptCoordinationInvitation(
  session: Session | null,
  input: AcceptCoordinationInvitationInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const invitation = await tx.reformCoordinationInvitation.findFirst({
      where: { id: input.invitationId },
    });
    if (!invitation) {
      throw new NotFoundError(`Invitation ${input.invitationId} not found`);
    }
    if (invitation.invitedTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:read");
    }
    if (invitation.status !== "pending") {
      throw new ConflictError(`Invitation ${input.invitationId} is not pending (status: ${invitation.status})`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new ConflictError(`Invitation ${input.invitationId} has expired`);
    }

    const lockKey = coordinationLockKey(invitation.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // G03-06 HTTP Acceptance fix: Insert participant BEFORE updating invitation
    // status. The RLS policy on reform_coordination_participants (migration 30)
    // requires a PENDING invitation to exist for the caller's tenant at INSERT
    // time. If we update the invitation status first, the EXISTS check fails.
    const participant = await tx.reformCoordinationParticipant.create({
      data: {
        coordinationId: invitation.coordinationId,
        tenantId,
        institutionId: invitation.invitedInstitutionId,
        role: invitation.invitedRole,
        status: "active",
        joinedAt: new Date(),
        addedBy: userId,
      },
    });

    // Now safe to transition the invitation to 'accepted' (participant already inserted)
    await tx.reformCoordinationInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "accepted",
        acceptedAt: new Date(),
        acceptedBy: userId,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.invitation_accepted",
      details: {
        coordinationId: invitation.coordinationId,
        invitationId: invitation.id,
        participantId: participant.id,
      },
      status: "ok",
    });

    return { participantId: participant.id };
  });
}

// ============================================================
// 10. Decline invitation (invited tenant)
// ============================================================
export async function declineCoordinationInvitation(
  session: Session | null,
  input: DeclineCoordinationInvitationInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const invitation = await tx.reformCoordinationInvitation.findFirst({
      where: { id: input.invitationId },
    });
    if (!invitation) {
      throw new NotFoundError(`Invitation ${input.invitationId} not found`);
    }
    if (invitation.invitedTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:read");
    }
    if (invitation.status !== "pending") {
      throw new ConflictError(`Invitation ${input.invitationId} is not pending`);
    }

    await tx.reformCoordinationInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "declined",
        declinedAt: new Date(),
        declinedBy: userId,
        declinedReason: input.declineReason,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.invitation_declined",
      details: { coordinationId: invitation.coordinationId, invitationId: invitation.id },
      status: "ok",
    });

    return { invitationId: invitation.id, status: "declined" };
  });
}

// ============================================================
// 11. Revoke invitation (lead only)
// ============================================================
export async function revokeCoordinationInvitation(
  session: Session | null,
  input: RevokeCoordinationInvitationInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const invitation = await tx.reformCoordinationInvitation.findFirst({
      where: { id: input.invitationId },
    });
    if (!invitation) {
      throw new NotFoundError(`Invitation ${input.invitationId} not found`);
    }

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: invitation.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${invitation.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }
    if (invitation.status !== "pending") {
      throw new ConflictError(`Invitation ${input.invitationId} is not pending`);
    }

    await tx.reformCoordinationInvitation.update({
      where: { id: invitation.id },
      data: {
        status: "revoked",
        revokedAt: new Date(),
        revokedBy: userId,
        revocationReason: input.revocationReason,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.invitation_revoked",
      details: {
        coordinationId: invitation.coordinationId,
        invitationId: invitation.id,
        reason: input.revocationReason,
      },
      status: "ok",
    });

    return { invitationId: invitation.id, status: "revoked" };
  });
}

// ============================================================
// 12. Submit coordination plan (lead)
// ============================================================
export async function submitCoordinationPlan(
  session: Session | null,
  input: SubmitCoordinationPlanInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const lockKey = coordinationLockKey(input.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }
    if (coordination.status !== "draft") {
      throw new ConflictError(
        `Coordination ${input.coordinationId} is in status "${coordination.status}", cannot submit plan (must be "draft")`
      );
    }

    await tx.reformCoordination.update({
      where: { id: input.coordinationId },
      data: {
        status: "plan_submitted",
        planSubmittedAt: new Date(),
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.plan_submitted",
      details: { coordinationId: input.coordinationId },
      status: "ok",
    });

    return { coordinationId: input.coordinationId, status: "plan_submitted" };
  });
}

// ============================================================
// 13. Approve coordination plan (lead — transitions to plan_approved, enabling activation)
// ============================================================
export async function approveCoordinationPlan(
  session: Session | null,
  input: ApproveCoordinationPlanInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const lockKey = coordinationLockKey(input.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }
    if (coordination.status !== "plan_submitted") {
      throw new ConflictError(
        `Coordination ${input.coordinationId} is in status "${coordination.status}", cannot approve plan (must be "plan_submitted")`
      );
    }

    await tx.reformCoordination.update({
      where: { id: input.coordinationId },
      data: {
        status: "plan_approved",
        planApprovedAt: new Date(),
        planApprovedBy: userId,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.plan_approved",
      details: { coordinationId: input.coordinationId, notes: input.approvalNotes },
      status: "ok",
    });

    return { coordinationId: input.coordinationId, status: "plan_approved" };
  });
}

// ============================================================
// 14. Create shared snapshot (participant — creates in "draft" status)
// ============================================================
export async function createSharedSnapshot(
  session: Session | null,
  input: CreateSharedSnapshotInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:share");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const lockKey = coordinationLockKey(input.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }

    const snapshot = await tx.reformCoordinationSharedSnapshot.create({
      data: {
        coordinationId: input.coordinationId,
        ownerTenantId: tenantId,
        snapshotType: input.snapshotType,
        title: input.title,
        summary: input.summary,
        status: "draft",
        createdBy: userId,
        proposalId: input.proposalId,
        classification: input.classification,
        submittedAt: new Date(),
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.snapshot_created",
      details: {
        coordinationId: input.coordinationId,
        snapshotId: snapshot.id,
        snapshotType: input.snapshotType,
      },
      status: "ok",
    });

    return { snapshotId: snapshot.id };
  });
}

// ============================================================
// 15. List shared snapshots (coordination-aware — owner sees all; others see approved + non-revoked)
// ============================================================
export async function listSharedSnapshots(
  session: Session | null,
  input: ListSharedSnapshotsInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx }) => {
    return tx.reformCoordinationSharedSnapshot.findMany({
      where: { coordinationId: input.coordinationId },
      orderBy: { submittedAt: "desc" },
      // RLS ensures: owner sees all their snapshots; others see only approved + non-revoked
    });
  });
}

// ============================================================
// 16. Approve shared snapshot (lead — transitions to "approved", making it visible to participants)
// ============================================================
export async function approveSharedSnapshot(
  session: Session | null,
  input: ApproveSharedSnapshotInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:approve");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const snapshot = await tx.reformCoordinationSharedSnapshot.findFirst({
      where: { id: input.snapshotId },
    });
    if (!snapshot) {
      throw new NotFoundError(`Snapshot ${input.snapshotId} not found`);
    }

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: snapshot.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${snapshot.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:approve");
    }

    const lockKey = coordinationLockKey(snapshot.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    if (snapshot.status !== "draft") {
      throw new ConflictError(`Snapshot ${input.snapshotId} is not in draft status`);
    }

    // G03-06 HTTP Acceptance fix: invoke the SECURITY DEFINER function
    // approve_coordination_shared_snapshot (migration 30) instead of a
    // direct UPDATE. The function runs as balance_coordination_admin
    // (NOLOGIN), which is exempt from the G03-01 trigger
    // `enforce_shared_snapshot_immutable_after_approval` (it only fires
    // when current_user = 'balance_app'). The function performs its own
    // lead-tenant verification (GUC vs parameter) and writes the audit
    // entry as part of the same transaction.
    const approvalNotes = input.approvalNotes ?? "";
    const rows = await tx.$queryRaw<{ approve_coordination_shared_snapshot: boolean }[]>`
      SELECT public.approve_coordination_shared_snapshot(
        ${snapshot.id}::text,
        ${userId}::text,
        ${tenantId}::text,
        ${approvalNotes}::text
      ) AS approve_coordination_shared_snapshot
    `;
    const result = rows[0];
    if (!result || !result.approve_coordination_shared_snapshot) {
      throw new Error(`approve_coordination_shared_snapshot returned false for snapshot ${snapshot.id}`);
    }

    return { snapshotId: snapshot.id, status: "approved" };
  });
}

// ============================================================
// 17. Revoke shared snapshot (lead — append-only INSERT into revocations table)
// ============================================================
export async function revokeSharedSnapshot(
  session: Session | null,
  input: RevokeSharedSnapshotInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:manage");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    const snapshot = await tx.reformCoordinationSharedSnapshot.findFirst({
      where: { id: input.snapshotId },
    });
    if (!snapshot) {
      throw new NotFoundError(`Snapshot ${input.snapshotId} not found`);
    }

    const coordination = await tx.reformCoordination.findFirst({
      where: { id: snapshot.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${snapshot.coordinationId} not found`);
    }
    if (coordination.leadTenantId !== tenantId) {
      throw new PermissionDeniedError("reform:coordination:manage");
    }

    const lockKey = coordinationLockKey(snapshot.coordinationId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // Check if already revoked (append-only — no UPDATE/DELETE on revocations)
    const existingRevocation = await tx.reformCoordinationSharedSnapshotRevocation.findFirst({
      where: { snapshotId: snapshot.id },
    });
    if (existingRevocation) {
      throw new ConflictError(`Snapshot ${input.snapshotId} is already revoked`);
    }

    await tx.reformCoordinationSharedSnapshotRevocation.create({
      data: {
        tenantId,
        coordinationId: snapshot.coordinationId,
        snapshotId: snapshot.id,
        revokedBy: userId,
        reason: input.reason,
      },
    });

    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "reform.coordination.snapshot_revoked",
      details: {
        coordinationId: snapshot.coordinationId,
        snapshotId: snapshot.id,
        reason: input.reason,
      },
      status: "ok",
    });

    return { snapshotId: snapshot.id, status: "revoked" };
  });
}

// ============================================================
// 18. Get coordination shared view (cross-tenant, coordination-aware)
// ============================================================
export async function getCoordinationSharedView(
  session: Session | null,
  input: GetCoordinationSharedViewInput
) {
  await requirePermissionWithCurrentRole(session, "reform:coordination:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const coordination = await tx.reformCoordination.findFirst({
      where: { id: input.coordinationId },
    });
    if (!coordination) {
      throw new NotFoundError(`Coordination ${input.coordinationId} not found`);
    }

    const participants = await tx.reformCoordinationParticipant.findMany({
      where: { coordinationId: input.coordinationId, status: "active" },
    });

    // Approved, non-revoked snapshots visible to all participants
    const snapshots = await tx.reformCoordinationSharedSnapshot.findMany({
      where: { coordinationId: input.coordinationId, status: "approved" },
    });

    // Filter out revoked snapshots (can't use is_snapshot_revoked in Prisma easily — use raw)
    const revocations = await tx.reformCoordinationSharedSnapshotRevocation.findMany({
      where: { coordinationId: input.coordinationId },
      select: { snapshotId: true },
    });
    const revokedIds = new Set(revocations.map((r) => r.snapshotId));
    const visibleSnapshots = snapshots.filter((s) => !revokedIds.has(s.id));

    return {
      coordination: {
        id: coordination.id,
        title: coordination.title,
        description: coordination.description,
        status: coordination.status,
        leadTenantId: coordination.leadTenantId,
        approvalPolicy: coordination.approvalPolicy,
        activatedAt: coordination.activatedAt,
      },
      participants: participants.map((p) => ({
        tenantId: p.tenantId,
        role: p.role,
        status: p.status,
        joinedAt: p.joinedAt,
      })),
      sharedSnapshots: visibleSnapshots.map((s) => ({
        id: s.id,
        snapshotType: s.snapshotType,
        title: s.title,
        summary: s.summary,
        ownerTenantId: s.ownerTenantId,
        approvedAt: s.approvedAt,
      })),
    };
  });
}
