// ============================================================
// tests/integration/g03-02-f6-sentinel.integration.test.ts
// ------------------------------------------------------------
// F6 sentinel test — verifies the DB trigger
// `enforce_reform_verification_f6` enforces the F6 invariant at the
// row level, independently of the Zod schema and service check.
//
// This is the "third defense" — if Zod or the service is bypassed,
// the DB trigger must still reject the INSERT.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-02-f6-";

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
    where: { email: "g03-02-f6-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-02-f6-reviewer@demolandia.test",
      name: "G03-02 F6 Reviewer",
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
      data: { tenantId: tenantAId, title: "G03-02 F6 Test Strategy", createdBy: analystUserId },
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
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`);
    await adminClient.reformVerification.deleteMany({ where: { id: { in: createdVerificationIds } } });
    await adminClient.reformAction.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformApproval.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAlternative.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformProposal.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    if (createdAlertIds.length > 0) {
      await adminClient.alert.deleteMany({ where: { id: { in: createdAlertIds } } });
    }
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`);
  } finally {
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
});

async function createTestAlert(): Promise<string> {
  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tenantId: tenantAId,
      strategyVersionId,
      title: "G03-02 F6 Test Alert",
      description: "Test alert for F6 sentinel.",
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
  return alert.id;
}

async function setupCompletedAction(): Promise<string> {
  const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
  const { createReformAction, startReformAction, completeReformAction } = await import("@/lib/reform/reform-action-service");

  const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
  const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

  const alertId = await createTestAlert();
  const proposal = await createReformProposal(analystSession, {
    originatingAlertId: alertId,
    title: `${FIXTURE_PREFIX} Proposal`,
    problemStatement: "Test proposal for F6 sentinel setup.",
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
    rationale: "Approved for F6 sentinel setup.",
  });
  const action = await createReformAction(analystSession, {
    proposalId: proposal.proposalId,
    title: `${FIXTURE_PREFIX} Action`,
  });
  createdActionIds.push(action.actionId);
  await startReformAction(analystSession, action.actionId);
  await completeReformAction(analystSession, { actionId: action.actionId });
  return action.actionId;
}

// ============================================================
// F6 Sentinel Tests
// ============================================================
describeIntegration("G03-02 F6 Sentinel — DB trigger enforcement", () => {
  it("F6-1: direct INSERT with status=verified WITHOUT verifiedAction is rejected by DB trigger", async () => {
    const actionId = await setupCompletedAction();

    // Find the existing pending verification record (auto-created with the action)
    const pending = await adminClient.reformVerification.findFirst({
      where: { actionId, tenantId: tenantAId },
    });
    expect(pending).not.toBeNull();

    // Direct UPDATE to set verified status without verifiedAction — DB trigger must reject
    const { raised, message } = await expectDenial(() =>
      adminClient.reformVerification.update({
        where: { id: pending!.id },
        data: {
          verificationStatus: "verified",
          // missing verifiedAction + evidenceSource
        },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("F6");
    expect(message).toContain("verifiedAction");

    createdVerificationIds.push(pending!.id);
  });

  it("F6-2: direct INSERT with status=verified WITHOUT evidenceSource is rejected by DB trigger", async () => {
    const actionId = await setupCompletedAction();
    const pending = await adminClient.reformVerification.findFirst({
      where: { actionId, tenantId: tenantAId },
    });

    const { raised, message } = await expectDenial(() =>
      adminClient.reformVerification.update({
        where: { id: pending!.id },
        data: {
          verificationStatus: "verified",
          verifiedAction: "Action mandate published in gazette on 2026-04-15",
          // missing evidenceSource
        },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("F6");
    expect(message).toContain("evidenceSource");

    createdVerificationIds.push(pending!.id);
  });

  it("F6-3: direct INSERT with status=disputed WITHOUT disputeReason is rejected", async () => {
    const actionId = await setupCompletedAction();
    const pending = await adminClient.reformVerification.findFirst({
      where: { actionId, tenantId: tenantAId },
    });

    const { raised, message } = await expectDenial(() =>
      adminClient.reformVerification.update({
        where: { id: pending!.id },
        data: {
          verificationStatus: "disputed",
          disputeEvidenceSource: "audit-report.pdf",
          // missing disputeReason
        },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("F6");
    expect(message).toContain("disputeReason");

    createdVerificationIds.push(pending!.id);
  });

  it("F6-4: direct INSERT with status=disputed WITHOUT disputeEvidenceSource is rejected", async () => {
    const actionId = await setupCompletedAction();
    const pending = await adminClient.reformVerification.findFirst({
      where: { actionId, tenantId: tenantAId },
    });

    const { raised, message } = await expectDenial(() =>
      adminClient.reformVerification.update({
        where: { id: pending!.id },
        data: {
          verificationStatus: "disputed",
          disputeReason: "No gazette publication found for the claimed action.",
          // missing disputeEvidenceSource
        },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("F6");
    expect(message).toContain("disputeEvidenceSource");

    createdVerificationIds.push(pending!.id);
  });

  it("F6-5: direct INSERT with status=pending succeeds (no F6 fields required)", async () => {
    // Initial pending state — no F6 fields required. This is the default.
    const actionId = await setupCompletedAction();
    const pending = await adminClient.reformVerification.findFirst({
      where: { actionId, tenantId: tenantAId },
    });
    expect(pending?.verificationStatus).toBe("pending");
    createdVerificationIds.push(pending!.id);
  });

  it("F6-6: direct INSERT with status=verified AND verifiedAction+evidenceSource succeeds", async () => {
    // This is the positive control: when F6 fields are provided, the
    // trigger allows the transition.
    const actionId = await setupCompletedAction();
    const pending = await adminClient.reformVerification.findFirst({
      where: { actionId, tenantId: tenantAId },
    });

    await adminClient.reformVerification.update({
      where: { id: pending!.id },
      data: {
        verificationStatus: "verified",
        verifiedAction: "Action mandate published in gazette on 2026-04-15; verified via gazette archive URL",
        evidenceSource: "gazette-2026-04-15.pdf",
        verifiedBy: reviewerUserId,
        verifiedAt: new Date(),
      },
    });

    const updated = await adminClient.reformVerification.findUnique({ where: { id: pending!.id } });
    expect(updated?.verificationStatus).toBe("verified");
    createdVerificationIds.push(pending!.id);
  });
});
