// ============================================================
// tests/integration/g03-02-attribution-sentinel.integration.test.ts
// ------------------------------------------------------------
// Attribution sentinel — verifies the DB trigger
// `enforce_reform_feedback_attribution_descriptive` enforces the
// descriptive-only invariant at the row level.
//
// Defense-in-depth: the Zod schema rejects causal LANGUAGE, but the DB
// trigger is the authoritative invariant — it rejects ANY value other
// than "descriptive", even if the service bypasses Zod.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-02-attrib-";

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
    where: { email: "g03-02-attrib-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-02-attrib-reviewer@demolandia.test",
      name: "G03-02 Attribution Reviewer",
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
      data: { tenantId: tenantAId, title: "G03-02 Attribution Test Strategy", createdBy: analystUserId },
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
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" DISABLE TRIGGER prevent_delete_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`);
    await adminClient.reformFeedbackLoop.deleteMany({ where: { id: { in: createdFeedbackIds } } });
    await adminClient.reformVerification.deleteMany({ where: { id: { in: createdVerificationIds } } });
    await adminClient.reformAction.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformApproval.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAlternative.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformProposal.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    if (createdAlertIds.length > 0) {
      await adminClient.alert.deleteMany({ where: { id: { in: createdAlertIds } } });
    }
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" ENABLE TRIGGER prevent_delete_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`);
  } finally {
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
});

async function setupVerifiedAction(): Promise<string> {
  const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
  const { createReformAction, startReformAction, completeReformAction } = await import("@/lib/reform/reform-action-service");
  const { verifyReformAction } = await import("@/lib/reform/reform-verification-service");

  const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
  const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tenantId: tenantAId,
      strategyVersionId,
      title: "G03-02 Attribution Test Alert",
      description: "Test alert for attribution sentinel.",
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
    problemStatement: "Test proposal for attribution sentinel setup.",
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
    rationale: "Approved for attribution sentinel setup.",
  });
  const action = await createReformAction(analystSession, {
    proposalId: proposal.proposalId,
    title: `${FIXTURE_PREFIX} Action`,
  });
  createdActionIds.push(action.actionId);
  await startReformAction(analystSession, action.actionId);
  await completeReformAction(analystSession, { actionId: action.actionId });
  await verifyReformAction(reviewerSession, {
    actionId: action.actionId,
    verificationStatus: "verified",
    verifiedAction: "Action mandate published in gazette on 2026-04-15; verified via gazette archive URL",
    evidenceSource: "gazette-2026-04-15.pdf",
  });

  const verification = await adminClient.reformVerification.findFirst({ where: { actionId: action.actionId, tenantId: tenantAId } });
  if (verification) createdVerificationIds.push(verification.id);
  return action.actionId;
}

describeIntegration("G03-02 Attribution Sentinel — DB trigger enforcement", () => {
  it("ATTR-1: direct INSERT with attributionLevel='causal' is rejected by DB trigger", async () => {
    const actionId = await setupVerifiedAction();
    const { raised, message } = await expectDenial(() =>
      adminClient.reformFeedbackLoop.create({
        data: {
          id: `${FIXTURE_PREFIX}fb-causal-${Date.now()}`,
          tenantId: tenantAId,
          actionId,
          descriptiveSummary: "The action caused inflation to decrease.",
          attributionLevel: "causal",
          comparisonType: "none",
          createdBy: analystUserId,
        },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("attributionLevel");
    expect(message).toContain("descriptive");
  });

  it("ATTR-2: direct INSERT with attributionLevel='statistical' is rejected", async () => {
    const actionId = await setupVerifiedAction();
    const { raised, message } = await expectDenial(() =>
      adminClient.reformFeedbackLoop.create({
        data: {
          id: `${FIXTURE_PREFIX}fb-stat-${Date.now()}`,
          tenantId: tenantAId,
          actionId,
          descriptiveSummary: "Statistical correlation observed post-implementation.",
          attributionLevel: "statistical",
          comparisonType: "none",
          createdBy: analystUserId,
        },
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("descriptive");
  });

  it("ATTR-3: direct INSERT with attributionLevel=NULL is rejected", async () => {
    const actionId = await setupVerifiedAction();
    const { raised } = await expectDenial(() =>
      adminClient.reformFeedbackLoop.create({
        data: {
          id: `${FIXTURE_PREFIX}fb-null-${Date.now()}`,
          tenantId: tenantAId,
          actionId,
          descriptiveSummary: "Feedback without attribution level.",
          // attributionLevel is NOT NULL in DB schema — passing null here
          // forces a NOT NULL violation (defensive: would also be caught
          // by the trigger if the column were nullable)
          // @ts-expect-error — testing runtime rejection of NULL attributionLevel
          attributionLevel: null,
          comparisonType: "none",
          createdBy: analystUserId,
        },
      })
    );
    expect(raised).toBe(true);
  });

  it("ATTR-4: direct INSERT with attributionLevel='descriptive' SUCCEEDS", async () => {
    // Positive control — when the value is "descriptive", the trigger allows it.
    const actionId = await setupVerifiedAction();
    const feedbackId = `${FIXTURE_PREFIX}fb-desc-${Date.now()}`;
    await adminClient.reformFeedbackLoop.create({
      data: {
        id: feedbackId,
        tenantId: tenantAId,
        actionId,
        descriptiveSummary: "The action was implemented on 2026-04-15; observation recorded inflation at 4.2%.",
        attributionLevel: "descriptive",
        comparisonType: "none",
        createdBy: analystUserId,
      },
    });
    createdFeedbackIds.push(feedbackId);

    const feedback = await adminClient.reformFeedbackLoop.findUnique({ where: { id: feedbackId } });
    expect(feedback?.attributionLevel).toBe("descriptive");
  });
});
