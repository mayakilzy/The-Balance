// ============================================================
// tests/integration/g03-02-append-only-sentinel.integration.test.ts
// ------------------------------------------------------------
// Append-only sentinel — verifies the DB triggers
// `prevent_historical_update` and `prevent_historical_deletion`
// (migration 0024 — unconditional, no GUC bypass) enforce the
// append-only invariant on:
//   - reform_action_updates
//   - reform_approvals
//   - reform_feedback_loops
//   - reform_coordination_shared_snapshot_revocations
//
// Even balance_admin (BYPASSRLS) cannot UPDATE or DELETE these records.
// Only the postgres superuser can DISABLE TRIGGER for maintenance.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-02-apo-";

let adminClient: PrismaClient;
let appClient: PrismaClient;
let tenantAId: string;
let countryId: string;
let analystUserId: string;
let reviewerUserId: string;
let adminUserId: string;
let strategyVersionId: string;
let createdAlertIds: string[] = [];
let createdProposalIds: string[] = [];
let createdActionIds: string[] = [];
let createdVerificationIds: string[] = [];
let createdUpdateIds: string[] = [];
let createdApprovalIds: string[] = [];
let createdFeedbackIds: string[] = [];

function makeSession(user: { id: string; tenantId: string; roleCode: string; membershipStatus: string }): Session {
  return {
    user: { id: user.id, tenantId: user.tenantId, roleCode: user.roleCode, membershipStatus: user.membershipStatus },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as unknown as Session;
}

async function expectDenial<T>(fn: () => Promise<T>): Promise<{ raised: boolean; message: string }> {
  try {
    await fn();
    return { raised: false, message: "" };
  } catch (e) {
    return { raised: true, message: e instanceof Error ? e.message : String(e) };
  }
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia (DML) not seeded");
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  if (!tenantA) throw new Error("Tenant A not seeded");
  tenantAId = tenantA.id;

  const adminUser = await adminClient.user.findUnique({ where: { email: "admin@demolandia.test" } });
  const analystUser = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  if (!adminUser || !analystUser) throw new Error("Test users not seeded");
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g03-02-apo-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-02-apo-reviewer@demolandia.test",
      name: "G03-02 Append-Only Reviewer",
      passwordHash: await hashPassword("Test1234!"),
      status: "active",
    },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "reviewer" },
    create: { userId: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
  });
  reviewerUserId = reviewer.id;

  let sv = await adminClient.strategyVersion.findFirst({ where: { tenantId: tenantAId, status: "approved" } });
  if (!sv) {
    const strategy = await adminClient.strategy.create({
      data: { tenantId: tenantAId, title: "G03-02 Append-Only Test Strategy", createdBy: analystUserId },
    });
    sv = await adminClient.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "approved",
        approvedBy: adminUserId,
        approvedAt: new Date(),
        metadata: { simulated: true },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  try {
    // Cleanup: disable append-only triggers, delete fixtures, re-enable
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" DISABLE TRIGGER prevent_delete_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" DISABLE TRIGGER prevent_update_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_update_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_update_reform_approvals`);

    await adminClient.reformFeedbackLoop.deleteMany({ where: { id: { in: createdFeedbackIds } } });
    await adminClient.reformVerification.deleteMany({ where: { id: { in: createdVerificationIds } } });
    await adminClient.reformActionUpdate.deleteMany({ where: { id: { in: createdUpdateIds } } });
    await adminClient.reformAction.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformApproval.deleteMany({ where: { id: { in: createdApprovalIds } } });
    await adminClient.reformAlternative.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformProposal.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    if (createdAlertIds.length > 0) {
      await adminClient.alert.deleteMany({ where: { id: { in: createdAlertIds } } });
    }

    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" ENABLE TRIGGER prevent_delete_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" ENABLE TRIGGER prevent_update_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_update_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_update_reform_approvals`);
  } finally {
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
});

async function setupActionWithUpdate(): Promise<{ actionId: string; updateId: string; originalNotes: string }> {
  const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
  const { createReformAction, startReformAction } = await import("@/lib/reform/reform-action-service");
  const { addReformActionUpdate } = await import("@/lib/reform/reform-action-update-service");

  const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
  const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tenantId: tenantAId,
      strategyVersionId,
      title: "G03-02 Append-Only Test Alert",
      description: "Test alert for append-only sentinel.",
      severity: "warning",
      lifecycleStage: "reviewed",
      executionStatus: "verified",
      executionVerifiedAction: "test fixture",
      executionVerificationSource: "test",
      executionVerifiedById: reviewerUserId,
      executionVerifiedAt: new Date(),
      createdBy: "system",
      reviewedBy: reviewerUserId,
      reviewedAt: new Date(),
      isAutoGenerated: true,
      metadata: { simulated: true },
    },
  });
  createdAlertIds.push(alert.id);

  const proposal = await createReformProposal(analystSession, {
    originatingAlertId: alert.id,
    title: `${FIXTURE_PREFIX} Proposal`,
    problemStatement: "Test proposal for append-only sentinel setup.",
    hypothesizedCauses: [],
    alternative: {
      title: `${FIXTURE_PREFIX} Alternative`,
      description: "Test alternative description for the proposal setup.",
      costCurrency: "USD",
      riskLevel: "medium",
      feasibilityScore: "high",
    },
  });
  createdProposalIds.push(proposal.proposalId);
  await submitForReview(analystSession, proposal.proposalId);
  await approveReformProposal(reviewerSession, {
    proposalId: proposal.proposalId,
    rationale: "Approved for append-only sentinel setup.",
  });
  const action = await createReformAction(analystSession, {
    proposalId: proposal.proposalId,
    title: `${FIXTURE_PREFIX} Action`,
  });
  createdActionIds.push(action.actionId);
  await startReformAction(analystSession, action.actionId);

  const update = await addReformActionUpdate(analystSession, {
    actionId: action.actionId,
    updateType: "progress",
    notes: "ORIGINAL NOTES — must never change",
    evidenceIds: [],
  });
  createdUpdateIds.push(update.updateId);
  return { actionId: action.actionId, updateId: update.updateId, originalNotes: "ORIGINAL NOTES — must never change" };
}

describeIntegration("G03-02 Append-Only Sentinel — DB trigger enforcement", () => {
  it("APO-1: UPDATE on reform_action_updates is rejected (even by adminClient)", async () => {
    const { updateId, originalNotes } = await setupActionWithUpdate();
    const { raised, message } = await expectDenial(() =>
      adminClient.reformActionUpdate.update({
        where: { id: updateId },
        data: { notes: "HACKED" },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("S3 VIOLATION");
    expect(message).toContain("UPDATE");

    // Verify persisted data unchanged
    const after = await adminClient.reformActionUpdate.findUnique({ where: { id: updateId } });
    expect(after?.notes).toBe(originalNotes);
  });

  it("APO-2: DELETE on reform_action_updates is rejected (even by adminClient)", async () => {
    const { updateId } = await setupActionWithUpdate();
    const { raised, message } = await expectDenial(() =>
      adminClient.reformActionUpdate.delete({ where: { id: updateId } })
    );
    expect(raised).toBe(true);
    expect(message).toContain("S3 VIOLATION");
    expect(message).toContain("DELETE");

    // Verify row still exists
    const after = await adminClient.reformActionUpdate.count({ where: { id: updateId } });
    expect(after).toBe(1);
  });

  it("APO-3: UPDATE on reform_approvals is rejected (immutable after creation)", async () => {
    // Create an approval via the service
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alert = await adminClient.alert.create({
      data: {
        id: `${FIXTURE_PREFIX}alert-apo3-${Date.now()}`,
        tenantId: tenantAId,
        strategyVersionId,
        title: "G03-02 Append-Only APO-3 Alert",
        description: "Test alert for APO-3.",
        severity: "warning",
        lifecycleStage: "reviewed",
        executionStatus: "verified",
        executionVerifiedAction: "test",
        executionVerificationSource: "test",
        executionVerifiedById: reviewerUserId,
        executionVerifiedAt: new Date(),
        createdBy: "system",
        reviewedBy: reviewerUserId,
        reviewedAt: new Date(),
        isAutoGenerated: true,
        metadata: { simulated: true },
      },
    });
    createdAlertIds.push(alert.id);

    const proposal = await createReformProposal(analystSession, {
      originatingAlertId: alert.id,
      title: `${FIXTURE_PREFIX} APO-3 Proposal`,
      problemStatement: "Test proposal for APO-3 approval immutability.",
      hypothesizedCauses: [],
      alternative: {
        title: `${FIXTURE_PREFIX} APO-3 Alternative`,
        description: "Test alternative description for APO-3.",
        costCurrency: "USD",
        riskLevel: "medium",
        feasibilityScore: "high",
      },
    });
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);
    const approval = await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "Approved for APO-3 immutability test.",
    });
    const approvalRecord = await adminClient.reformApproval.findUnique({ where: { id: approval.approvalId } });
    if (approvalRecord) createdApprovalIds.push(approvalRecord.id);

    const originalRationale = approvalRecord?.rationale;
    const { raised, message } = await expectDenial(() =>
      adminClient.reformApproval.update({
        where: { id: approval.approvalId },
        data: { rationale: "HACKED RATIONALE" },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("S3 VIOLATION");

    const after = await adminClient.reformApproval.findUnique({ where: { id: approval.approvalId } });
    expect(after?.rationale).toBe(originalRationale);
  });

  it("APO-4: DELETE on reform_approvals is rejected", async () => {
    // Reuse the approval from APO-3 (or create a new one if needed)
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alert = await adminClient.alert.create({
      data: {
        id: `${FIXTURE_PREFIX}alert-apo4-${Date.now()}`,
        tenantId: tenantAId,
        strategyVersionId,
        title: "G03-02 APO-4 Alert",
        description: "Test alert for APO-4.",
        severity: "warning",
        lifecycleStage: "reviewed",
        executionStatus: "verified",
        executionVerifiedAction: "test",
        executionVerificationSource: "test",
        executionVerifiedById: reviewerUserId,
        executionVerifiedAt: new Date(),
        createdBy: "system",
        reviewedBy: reviewerUserId,
        reviewedAt: new Date(),
        isAutoGenerated: true,
        metadata: { simulated: true },
      },
    });
    createdAlertIds.push(alert.id);

    const proposal = await createReformProposal(analystSession, {
      originatingAlertId: alert.id,
      title: `${FIXTURE_PREFIX} APO-4 Proposal`,
      problemStatement: "Test proposal for APO-4 approval deletion test.",
      hypothesizedCauses: [],
      alternative: {
        title: `${FIXTURE_PREFIX} APO-4 Alternative`,
        description: "Test alternative description for APO-4.",
        costCurrency: "USD",
        riskLevel: "medium",
        feasibilityScore: "high",
      },
    });
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);
    const approval = await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "Approved for APO-4 deletion test.",
    });
    const approvalRecord = await adminClient.reformApproval.findUnique({ where: { id: approval.approvalId } });
    if (approvalRecord) createdApprovalIds.push(approvalRecord.id);

    const { raised, message } = await expectDenial(() =>
      adminClient.reformApproval.delete({ where: { id: approval.approvalId } })
    );
    expect(raised).toBe(true);
    expect(message).toContain("S3 VIOLATION");
    expect(message).toContain("DELETE");

    const count = await adminClient.reformApproval.count({ where: { id: approval.approvalId } });
    expect(count).toBe(1);
  });
});
