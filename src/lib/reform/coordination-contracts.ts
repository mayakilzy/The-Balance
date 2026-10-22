// ============================================================
// src/lib/reform/coordination-contracts.ts
// ------------------------------------------------------------
// G03-06 — Multi-Institution Coordination
//
// Zod schemas + types for the coordination lifecycle:
//   - create / list / get / close coordinations
//   - add / list / withdraw participants
//   - create / accept / decline / revoke invitations
//   - submit / approve coordination plan
//   - create / list / approve / revoke shared snapshots
//   - get shared view (cross-tenant, coordination-aware)
//
// Design constraints (per G03-06 frozen contracts):
//   - OD-1: atomic activation (same tx as approval)
//   - OD-2: B3 privileged operations DEFERRED to G03-07 (DORMANT)
//   - OD-4: lock order L-ALERT → L-COORD → L-PROP (canonical key
//     uses coordinationId only — NOT tenantId — to ensure all
//     participants share the same lock across tenants)
//   - OD-5: cross-tenant RLS (lead sees participants; content stays isolated)
//   - OD-6: ONE forward-only additive migration (migration 26)
//   - OD-7: 16 active API routes + 3 deferred (501)
//   - OD-Q1.A: ALL linked proposals approved (strict quantifier)
//
// Authority-bearing fields (canApproveCommitments, verifiedInstitutionId,
// removalReason, etc.) are NEVER accepted from client input. They are set
// ONLY by authorized administrative functions in G03-07 (currently DORMANT).
// ============================================================
import { z } from "zod";
import type {
  ReformCoordination,
  ReformCoordinationParticipant,
  ReformCoordinationInvitation,
  ReformCoordinationSharedSnapshot,
  ReformCoordinationSharedSnapshotRevocation,
} from "@prisma/client";

// ============================================================
// Re-export Prisma types (single source of truth)
// ============================================================
export type Coordination = ReformCoordination;
export type CoordinationParticipant = ReformCoordinationParticipant;
export type CoordinationInvitation = ReformCoordinationInvitation;
export type CoordinationSharedSnapshot = ReformCoordinationSharedSnapshot;
export type CoordinationSharedSnapshotRevocation = ReformCoordinationSharedSnapshotRevocation;

// ============================================================
// Coordination status enum
// ============================================================
export const CoordinationStatusSchema = z.enum([
  "draft",
  "plan_submitted",
  "plan_approved",
  "active",
  "closed",
  "superseded",
  "archived",
]);
export type CoordinationStatus = z.infer<typeof CoordinationStatusSchema>;

export const CoordinationApprovalPolicySchema = z.enum([
  "unanimous",
  "lead_with_no_objection",
  "lead_only",
]);
export type CoordinationApprovalPolicy = z.infer<
  typeof CoordinationApprovalPolicySchema
>;

// ============================================================
// Create coordination
// ============================================================
export const CreateCoordinationInputSchema = z
  .object({
    leadTenantId: z.string().min(1).optional(), // defaults to caller's tenant
    countryId: z.string().min(1, "countryId is required"),
    title: z.string().min(5, "title must be at least 5 characters").max(200),
    description: z.string().min(20, "description must be at least 20 characters"),
    originatingAlertId: z.string().min(1).optional(),
    originatingVarianceRecordId: z.string().min(1).optional(),
    approvalPolicy: CoordinationApprovalPolicySchema.optional().default("unanimous"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateCoordinationInput = z.infer<typeof CreateCoordinationInputSchema>;

// ============================================================
// List / Get coordination
// ============================================================
export const ListCoordinationsInputSchema = z.object({
  status: CoordinationStatusSchema.optional(),
  leadTenantId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
}).strict();
export type ListCoordinationsInput = z.infer<typeof ListCoordinationsInputSchema>;

export const GetCoordinationInputSchema = z.object({
  coordinationId: z.string().min(1),
}).strict();
export type GetCoordinationInput = z.infer<typeof GetCoordinationInputSchema>;

// ============================================================
// Close coordination
// ============================================================
export const CloseCoordinationInputSchema = z.object({
  coordinationId: z.string().min(1),
  closureReason: z.string().min(10, "closureReason must be at least 10 characters"),
}).strict();
export type CloseCoordinationInput = z.infer<typeof CloseCoordinationInputSchema>;

// ============================================================
// Add participant
// ============================================================
export const AddCoordinationParticipantInputSchema = z.object({
  coordinationId: z.string().min(1),
  tenantId: z.string().min(1, "tenantId is required"),
  institutionId: z.string().min(1).optional(),
  role: z.enum(["lead", "contributor", "observer"]).optional().default("contributor"),
}).strict();
export type AddCoordinationParticipantInput = z.infer<
  typeof AddCoordinationParticipantInputSchema
>;

// ============================================================
// List participants
// ============================================================
export const ListCoordinationParticipantsInputSchema = z.object({
  coordinationId: z.string().min(1),
}).strict();
export type ListCoordinationParticipantsInput = z.infer<
  typeof ListCoordinationParticipantsInputSchema
>;

// ============================================================
// Withdraw participant (self-withdrawal — RLS-permitted, no DEFINER needed)
// ============================================================
export const WithdrawCoordinationParticipantInputSchema = z.object({
  coordinationId: z.string().min(1),
  withdrawalReason: z.string().min(10, "withdrawalReason must be at least 10 characters"),
}).strict();
export type WithdrawCoordinationParticipantInput = z.infer<
  typeof WithdrawCoordinationParticipantInputSchema
>;

// ============================================================
// Create invitation
// ============================================================
export const CreateCoordinationInvitationInputSchema = z.object({
  coordinationId: z.string().min(1),
  invitedTenantId: z.string().min(1, "invitedTenantId is required"),
  invitedInstitutionId: z.string().min(1).optional(),
  invitedRole: z.enum(["contributor", "observer"]).optional().default("contributor"),
  expiresAt: z.date().optional(), // defaults to 7 days from now
}).strict();
export type CreateCoordinationInvitationInput = z.infer<
  typeof CreateCoordinationInvitationInputSchema
>;

// ============================================================
// Accept / Decline / Revoke invitation
// ============================================================
export const AcceptCoordinationInvitationInputSchema = z.object({
  invitationId: z.string().min(1),
}).strict();
export type AcceptCoordinationInvitationInput = z.infer<
  typeof AcceptCoordinationInvitationInputSchema
>;

export const DeclineCoordinationInvitationInputSchema = z.object({
  invitationId: z.string().min(1),
  declineReason: z.string().min(10).optional(),
}).strict();
export type DeclineCoordinationInvitationInput = z.infer<
  typeof DeclineCoordinationInvitationInputSchema
>;

export const RevokeCoordinationInvitationInputSchema = z.object({
  invitationId: z.string().min(1),
  revocationReason: z.string().min(10, "revocationReason must be at least 10 characters"),
}).strict();
export type RevokeCoordinationInvitationInput = z.infer<
  typeof RevokeCoordinationInvitationInputSchema
>;

// ============================================================
// Submit / Approve coordination plan
// ============================================================
export const SubmitCoordinationPlanInputSchema = z.object({
  coordinationId: z.string().min(1),
}).strict();
export type SubmitCoordinationPlanInput = z.infer<
  typeof SubmitCoordinationPlanInputSchema
>;

export const ApproveCoordinationPlanInputSchema = z.object({
  coordinationId: z.string().min(1),
  approvalNotes: z.string().min(10, "approvalNotes must be at least 10 characters").optional(),
}).strict();
export type ApproveCoordinationPlanInput = z.infer<
  typeof ApproveCoordinationPlanInputSchema
>;

// ============================================================
// Create / List / Approve / Revoke shared snapshots
// ============================================================
export const CreateSharedSnapshotInputSchema = z.object({
  coordinationId: z.string().min(1),
  snapshotType: z.enum(["proposal_summary", "alternative_summary", "evidence_summary", "custom"]).default("custom"),
  title: z.string().min(5, "title must be at least 5 characters").max(200),
  summary: z.string().min(20, "summary must be at least 20 characters"),
  proposalId: z.string().min(1).optional(),
  classification: z.enum(["shared_within_coordination", "restricted"]).optional().default("shared_within_coordination"),
}).strict();
export type CreateSharedSnapshotInput = z.infer<typeof CreateSharedSnapshotInputSchema>;

export const ListSharedSnapshotsInputSchema = z.object({
  coordinationId: z.string().min(1),
}).strict();
export type ListSharedSnapshotsInput = z.infer<typeof ListSharedSnapshotsInputSchema>;

export const ApproveSharedSnapshotInputSchema = z.object({
  snapshotId: z.string().min(1),
  approvalNotes: z.string().optional(),
}).strict();
export type ApproveSharedSnapshotInput = z.infer<typeof ApproveSharedSnapshotInputSchema>;

export const RevokeSharedSnapshotInputSchema = z.object({
  snapshotId: z.string().min(1),
  reason: z.string().min(10, "reason must be at least 10 characters"),
}).strict();
export type RevokeSharedSnapshotInput = z.infer<typeof RevokeSharedSnapshotInputSchema>;

// ============================================================
// Get coordination shared view (cross-tenant, coordination-aware)
// ============================================================
export const GetCoordinationSharedViewInputSchema = z.object({
  coordinationId: z.string().min(1),
}).strict();
export type GetCoordinationSharedViewInput = z.infer<
  typeof GetCoordinationSharedViewInputSchema
>;

// ============================================================
// Coordination lock key helper
// ============================================================
// OD-4: canonical lock key uses coordinationId ONLY (not tenantId).
// This ensures all participants share the same L-COORD across tenants.
// A lead in tenant-A and a participant in tenant-B who both approve
// proposals for the same coordination will acquire the SAME lock,
// serializing their activation checks.
//
// Lock order: L-ALERT → L-COORD → L-PROP
// L-COORD key: hashtext(coordinationId)
// ============================================================
export function coordinationLockKey(coordinationId: string): string {
  return coordinationId;
}
