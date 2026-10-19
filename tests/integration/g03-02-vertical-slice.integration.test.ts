// ============================================================
// tests/integration/g03-02-vertical-slice.integration.test.ts
// ------------------------------------------------------------
// G03-02 — Real PostgreSQL integration tests.
//
// Covers (per directive Section 8.2):
//   I-01: Successful end-to-end workflow from alert to closure
//   I-03: Analyst approval attempt denied (analyst lacks reform:proposal:approve)
//   I-05: Invalid lifecycle transition denied
//   I-07: F6 invalid verification rejected (Zod + service check)
//   I-09: Non-descriptive attribution rejected by DB trigger
//   I-12: G02 alert closure preconditions verified
//   I-13: Cross-tenant proposal access rejected (RLS)
//   I-14: Observer access rejected where permission is absent
//   I-15: Audit write atomicity verified (audit_log row exists for each transition)
//   I-16: Repeated approval attempts do not duplicate immutable records
//
// Pattern follows G02-t2-slice: appClient (RLS) + adminClient (BYPASSRLS).
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Session } from "next-auth";
import { hashPassword } from "@/lib/password";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-02-it-";

let appClient: PrismaClient;
let adminClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let analystUserId: string;
let reviewerUserId: string;
let adminUserId: string;
let observerUserId: string;
let tenantBAnalystUserId: string;
let strategyVersionId: string;
let indicatorId: string;
let observationPeriodId: string;
let sourceId: string;
let createdAlertIds: string[] = [];
let createdProposalIds: string[] = [];
let createdActionIds: string[] = [];

function makeSession(user: {
  id: string;
  tenantId: string;
  roleCode: string;
  membershipStatus: string;
}): Session {
  return {
    user: {
      id: user.id,
      tenantId: user.tenantId,
      roleCode: user.roleCode,
      membershipStatus: user.membershipStatus,
    },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as unknown as Session;
}

async function expectDenial<T>(
  fn: () => Promise<T>
): Promise<{ raised: boolean; message: string }> {
  try {
    await fn();
    return { raised: false, message: "" };
  } catch (e) {
    return { raised: true, message: e instanceof Error ? e.message : String(e) };
  }
}

// Helpers that build valid input objects (avoids repeating required fields)
function makeAlternativeInput(title: string, description: string) {
  return {
    title,
    description,
    costCurrency: "USD" as const,
    riskLevel: "medium" as const,
    feasibilityScore: "high" as const,
  };
}

function makeProposalInput(alertId: string, title: string, problemStatement: string, alternativeTitle: string) {
  return {
    originatingAlertId: alertId,
    title,
    problemStatement,
    hypothesizedCauses: ["test cause"],
    alternative: makeAlternativeInput(alternativeTitle, "Test alternative description for the proposal."),
  };
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;

  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
  await appClient.$queryRaw`SELECT 1`;
  await adminClient.$queryRaw`SELECT 1`;

  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia (DML) not seeded");
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("Test tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const adminUser = await adminClient.user.findUnique({ where: { email: "admin@demolandia.test" } });
  const analystUser = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  if (!adminUser || !analystUser) throw new Error("Test users not seeded");
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g03-02-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-02-reviewer@demolandia.test",
      name: "G03-02 Reviewer",
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

  const observer = await adminClient.user.upsert({
    where: { email: "g03-02-observer@demolandia.test" },
    update: {},
    create: {
      email: "g03-02-observer@demolandia.test",
      name: "G03-02 Observer",
      passwordHash: await hashPassword("Test1234!"),
      status: "active",
    },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: observer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "observer" },
    create: { userId: observer.id, tenantId: tenantAId, roleCode: "observer", status: "active" },
  });
  observerUserId = observer.id;

  const tenantBAnalyst = await adminClient.user.upsert({
    where: { email: "g03-02-tenantb-analyst@demolandia.test" },
    update: {},
    create: {
      email: "g03-02-tenantb-analyst@demolandia.test",
      name: "G03-02 Tenant B Analyst",
      passwordHash: await hashPassword("Test1234!"),
      status: "active",
    },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: tenantBAnalyst.id, tenantId: tenantBId } },
    update: { status: "active", roleCode: "analyst" },
    create: { userId: tenantBAnalyst.id, tenantId: tenantBId, roleCode: "analyst", status: "active" },
  });
  tenantBAnalystUserId = tenantBAnalyst.id;

  let sv = await adminClient.strategyVersion.findFirst({
    where: { tenantId: tenantAId, status: "approved" },
  });
  if (!sv) {
    const strategy = await adminClient.strategy.create({
      data: { tenantId: tenantAId, title: "G03-02 Test Strategy", createdBy: analystUserId },
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
        approvalNotes: "G03-02 test fixture",
        metadata: { simulated: true },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  let src = await adminClient.sourceRegistry.findFirst({ where: { code: "G0302_TEST_SRC" } });
  if (!src) {
    src = await adminClient.sourceRegistry.create({
      data: { code: "G0302_TEST_SRC", displayName: "G03-02 Test Source", type: "government", license: "CC-BY-4.0" },
    });
  }
  sourceId = src.id;

  let period = await adminClient.observationPeriod.findFirst({
    where: { tenantId: tenantAId, periodType: "quarterly", periodValue: "2026-Q1" },
  });
  if (!period) {
    period = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2026-Q1",
        startAt: new Date("2026-01-01T00:00:00Z"),
        endAt: new Date("2026-03-31T23:59:59Z"),
      },
    });
  }
  observationPeriodId = period.id;

  let ind = await adminClient.indicatorDefinition.findFirst({
    where: { tenantId: tenantAId, code: "G0302_TEST_IND" },
  });
  if (!ind) {
    ind = await adminClient.indicatorDefinition.create({
      data: {
        tenantId: tenantAId,
        strategyVersionId,
        code: "G0302_TEST_IND",
        displayName: "G03-02 Test Indicator",
        unit: "percent",
        preferredDirection: "decrease",
        defaultTargetValue: 5.0,
        targetTimeHorizon: "multi_year",
        alertThresholds: [
          {
            metric: "varianceAbsolute",
            operator: "gt",
            value: 0.5,
            logicalOp: "and",
            severity: "warning",
            rationale: "Test threshold for G03-02 alert generation",
            sourceRef: "synthetic:demolandia-g0302-test-001",
          },
        ],
        createdBy: analystUserId,
      },
    });
  }
  indicatorId = ind.id;
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  try {
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_coordination_shared_snapshots" DISABLE TRIGGER shared_snapshot_immutable_after_approval_trigger`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_coordination_shared_snapshot_revocations" DISABLE TRIGGER prevent_delete_reform_coord_revocations`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_feedback_loops" DISABLE TRIGGER prevent_delete_reform_feedback_loops`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`
    );

    await adminClient.reformFeedbackLoop.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformVerification.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformActionUpdate.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAction.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformApproval.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAlternative.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformProposal.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });

    if (createdAlertIds.length > 0) {
      await adminClient.alert.deleteMany({ where: { id: { in: createdAlertIds } } });
    }

    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_coordination_shared_snapshots" ENABLE TRIGGER shared_snapshot_immutable_after_approval_trigger`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_coordination_shared_snapshot_revocations" ENABLE TRIGGER prevent_delete_reform_coord_revocations`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_feedback_loops" ENABLE TRIGGER prevent_delete_reform_feedback_loops`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`
    );
  } finally {
    await appClient?.$disconnect();
    await adminClient?.$disconnect();
  }
});

async function createTestAlert(tenantId: string, userId: string): Promise<string> {
  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      strategyVersionId,
      title: "G03-02 Test Alert",
      description: "Test alert for G03-02 vertical slice integration tests.",
      severity: "warning",
      lifecycleStage: "reviewed",
      executionStatus: "verified",
      executionVerifiedAction: "G03-02 test fixture — alert already verified",
      executionVerificationSource: "g03-02-test-fixture",
      executionVerifiedById: userId,
      executionVerifiedAt: new Date(),
      createdBy: "system",
      reviewedBy: userId,
      reviewedAt: new Date(),
      isAutoGenerated: true,
      metadata: { simulated: true, source: "g03-02-test-fixture" },
    },
  });
  createdAlertIds.push(alert.id);
  return alert.id;
}

// ============================================================
// I-01: Successful end-to-end workflow
// ============================================================
describeIntegration("I-01: Successful authenticated reform workflow end-to-end", () => {
  it("Alert → Proposal → Submit → Approve → Action → Updates → Complete → Verify → Feedback → Close Alert", async () => {
    const { createReformProposal, submitForReview, approveReformProposal, getReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const { createReformAction, startReformAction, completeReformAction } = await import("@/lib/reform/reform-action-service");
    const { addReformActionUpdate } = await import("@/lib/reform/reform-action-update-service");
    const { verifyReformAction } = await import("@/lib/reform/reform-verification-service");
    const { createReformFeedbackLoop, closeOriginatingAlert } = await import("@/lib/reform/reform-feedback-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);

    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-01 Reform Proposal`,
      "Demolandia monetary base growth exceeded 7% in 2024, threatening price stability.",
      `${FIXTURE_PREFIX} I-01 Alternative`
    ));
    expect(proposal.proposalId).toBeDefined();
    createdProposalIds.push(proposal.proposalId);

    const draftProposal = await getReformProposal(analystSession, proposal.proposalId);
    expect(draftProposal?.status).toBe("draft");

    const submitted = await submitForReview(analystSession, proposal.proposalId);
    expect(submitted.status).toBe("under_review");

    const approval = await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "Approved based on cross-tenant evidence convergence (IMF + World Bank).",
    });
    expect(approval.proposalStatus).toBe("approved");

    const action = await createReformAction(analystSession, {
      proposalId: proposal.proposalId,
      title: `${FIXTURE_PREFIX} I-01 Action`,
      description: "Publish the new inflation targeting mandate in the official gazette.",
      assignedTo: analystUserId,
      dueDate: "2026-12-31T00:00:00Z",
    });
    createdActionIds.push(action.actionId);

    await startReformAction(analystSession, action.actionId);

    const update = await addReformActionUpdate(analystSession, {
      actionId: action.actionId,
      updateType: "progress",
      notes: "Draft mandate circulated to Central Bank for technical review.",
      progressPercentage: 40,
      evidenceIds: [],
    });
    expect(update.updateId).toBeDefined();

    const completed = await completeReformAction(analystSession, { actionId: action.actionId });
    expect(completed.status).toBe("completed");

    const verification = await verifyReformAction(reviewerSession, {
      actionId: action.actionId,
      verificationStatus: "verified",
      verifiedAction: "Action mandate published in gazette on 2026-04-15; verified via gazette archive URL gazette-2026-04-15.pdf",
      evidenceSource: "gazette-2026-04-15.pdf",
    });
    expect(verification.verificationStatus).toBe("verified");

    const feedback = await createReformFeedbackLoop(analystSession, {
      actionId: action.actionId,
      comparisonType: "none",
      descriptiveSummary: "The action was implemented on 2026-04-15; observation #X1 recorded inflation at 4.2% on 2026-04-30.",
    });
    expect(feedback.feedbackLoopId).toBeDefined();

    const closed = await closeOriginatingAlert(reviewerSession, {
      proposalId: proposal.proposalId,
      closureReason: "Reform action verified and descriptive feedback loop documented per G03-02 workflow.",
    });
    expect(closed.alertClosed).toBe(true);

    const finalAlert = await adminClient.alert.findUnique({ where: { id: alertId } });
    expect(finalAlert?.lifecycleStage).toBe("closed");
  });
});

// ============================================================
// I-03: Analyst cannot approve own proposal
// ============================================================
describeIntegration("I-03: Analyst cannot approve own proposal", () => {
  it("analyst approval raises PermissionDeniedError", async () => {
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-03 Proposal`,
      "Test proposal to verify analyst cannot approve own submission.",
      `${FIXTURE_PREFIX} I-03 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);

    const { raised, message } = await expectDenial(() =>
      approveReformProposal(analystSession, {
        proposalId: proposal.proposalId,
        rationale: "Analyst attempts to approve own proposal — must be denied.",
      })
    );
    expect(raised).toBe(true);
    expect(message.toLowerCase()).toContain("permission denied");
  });
});

// ============================================================
// I-05: Invalid lifecycle transitions denied
// ============================================================
describeIntegration("I-05: Invalid lifecycle transitions denied", () => {
  it("cannot approve a proposal that is still in draft", async () => {
    const { createReformProposal, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-05 Proposal`,
      "Test proposal for invalid transition detection.",
      `${FIXTURE_PREFIX} I-05 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);

    const { raised, message } = await expectDenial(() =>
      approveReformProposal(reviewerSession, {
        proposalId: proposal.proposalId,
        rationale: "Attempt to approve a draft proposal — should be rejected.",
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("Conflict");
  });

  it("cannot complete an action that is still planned", async () => {
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const { createReformAction, completeReformAction } = await import("@/lib/reform/reform-action-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-05b Proposal`,
      "Test proposal for action lifecycle transition validation.",
      `${FIXTURE_PREFIX} I-05b Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);
    await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "Approved for I-05b action lifecycle test.",
    });

    const action = await createReformAction(analystSession, {
      proposalId: proposal.proposalId,
      title: `${FIXTURE_PREFIX} I-05b Action`,
    });
    createdActionIds.push(action.actionId);

    const { raised, message } = await expectDenial(() =>
      completeReformAction(analystSession, { actionId: action.actionId })
    );
    expect(raised).toBe(true);
    expect(message).toContain("Conflict");
  });
});

// ============================================================
// I-07: F6 invalid verification rejected
// ============================================================
describeIntegration("I-07: F6 invalid verification rejected", () => {
  it("verified status without verifiedAction is rejected by Zod", async () => {
    const { verifyReformAction } = await import("@/lib/reform/reform-verification-service");
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const { raised, message } = await expectDenial(() =>
      verifyReformAction(reviewerSession, {
        actionId: "fake-action-id",
        verificationStatus: "verified",
      } as never)
    );
    expect(raised).toBe(true);
    expect(message).toContain("F6");
  });

  it("verified status with vague verifiedAction is rejected by service check", async () => {
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const { createReformAction, startReformAction, completeReformAction } = await import("@/lib/reform/reform-action-service");
    const { verifyReformAction } = await import("@/lib/reform/reform-verification-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-07 Proposal`,
      "Test proposal for F6 vague verification rejection.",
      `${FIXTURE_PREFIX} I-07 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);
    await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "Approved for I-07 F6 vague verification test.",
    });
    const action = await createReformAction(analystSession, {
      proposalId: proposal.proposalId,
      title: `${FIXTURE_PREFIX} I-07 Action`,
    });
    createdActionIds.push(action.actionId);
    await startReformAction(analystSession, action.actionId);
    await completeReformAction(analystSession, { actionId: action.actionId });

    const { raised, message } = await expectDenial(() =>
      verifyReformAction(reviewerSession, {
        actionId: action.actionId,
        verificationStatus: "verified",
        verifiedAction: "inflation improved after the reform was implemented",
        evidenceSource: "imf-data-2026.pdf",
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("F6 service check");
  });
});

// ============================================================
// I-09: Non-descriptive attribution rejected by DB trigger
// ============================================================
describeIntegration("I-09: Non-descriptive attribution rejected by DB trigger", () => {
  it("direct INSERT with attributionLevel='causal' is rejected by DB trigger", async () => {
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const { createReformAction, startReformAction, completeReformAction } = await import("@/lib/reform/reform-action-service");
    const { verifyReformAction } = await import("@/lib/reform/reform-verification-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-09 Proposal`,
      "Test proposal for I-09 attribution trigger verification.",
      `${FIXTURE_PREFIX} I-09 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);
    await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "Approved for I-09 attribution trigger test.",
    });
    const action = await createReformAction(analystSession, {
      proposalId: proposal.proposalId,
      title: `${FIXTURE_PREFIX} I-09 Action`,
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

    const { raised, message } = await expectDenial(() =>
      adminClient.reformFeedbackLoop.create({
        data: {
          id: `${FIXTURE_PREFIX}fb-i09-causal`,
          tenantId: tenantAId,
          actionId: action.actionId,
          descriptiveSummary: "The action caused inflation to decrease from 5% to 4%.",
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
});

// ============================================================
// I-12: Alert closure preconditions verified
// ============================================================
describeIntegration("I-12: Alert closure preconditions verified", () => {
  it("cannot close alert when workflow is incomplete", async () => {
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const { createReformAction, startReformAction } = await import("@/lib/reform/reform-action-service");
    const { closeOriginatingAlert } = await import("@/lib/reform/reform-feedback-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-12 Proposal`,
      "Test proposal for alert closure precondition verification.",
      `${FIXTURE_PREFIX} I-12 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);
    await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "Approved for I-12 precondition test.",
    });
    const action = await createReformAction(analystSession, {
      proposalId: proposal.proposalId,
      title: `${FIXTURE_PREFIX} I-12 Action`,
    });
    createdActionIds.push(action.actionId);
    await startReformAction(analystSession, action.actionId);
    // NOT completed, NOT verified, NO feedback

    const { raised, message } = await expectDenial(() =>
      closeOriginatingAlert(reviewerSession, {
        proposalId: proposal.proposalId,
        closureReason: "Attempt to close alert without completing workflow — must be rejected.",
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("Conflict");

    const alertAfter = await adminClient.alert.findUnique({ where: { id: alertId } });
    expect(alertAfter?.lifecycleStage).not.toBe("closed");
  });
});

// ============================================================
// I-13: Cross-tenant proposal access rejected (RLS)
// ============================================================
describeIntegration("I-13: Cross-tenant proposal access rejected", () => {
  it("Tenant B analyst cannot read Tenant A proposal", async () => {
    const { createReformProposal, getReformProposal } = await import("@/lib/reform/reform-proposal-service");

    const tenantASession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const tenantBSession = makeSession({ id: tenantBAnalystUserId, tenantId: tenantBId, roleCode: "analyst", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(tenantASession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-13 Proposal`,
      "Test proposal for cross-tenant isolation.",
      `${FIXTURE_PREFIX} I-13 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);

    const result = await getReformProposal(tenantBSession, proposal.proposalId);
    expect(result).toBeNull();
  });
});

// ============================================================
// I-14: Observer access rejected where permission is absent
// ============================================================
describeIntegration("I-14: Observer cannot create proposals", () => {
  it("observer lacks reform:proposal:write — creation denied", async () => {
    const { createReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const observerSession = makeSession({ id: observerUserId, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const { raised, message } = await expectDenial(() =>
      createReformProposal(observerSession, makeProposalInput(
        alertId,
        `${FIXTURE_PREFIX} I-14 Observer Attempt`,
        "Observer should NOT be able to create proposals.",
        `${FIXTURE_PREFIX} I-14 Alternative`
      ))
    );
    expect(raised).toBe(true);
    expect(message.toLowerCase()).toContain("permission denied");
  });

  it("observer CAN read proposals (reform:proposal:read granted to observer)", async () => {
    const { listReformProposals } = await import("@/lib/reform/reform-proposal-service");
    const observerSession = makeSession({ id: observerUserId, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active" });

    const result = await listReformProposals(observerSession, { limit: 5 });
    expect(result).toBeDefined();
    expect(Array.isArray(result.proposals)).toBe(true);
  });
});

// ============================================================
// I-15: Audit write atomicity verified
// ============================================================
describeIntegration("I-15: Audit write atomicity verified", () => {
  it("successful submission writes audit_log entry atomically", async () => {
    const { createReformProposal, submitForReview } = await import("@/lib/reform/reform-proposal-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-15 Proposal`,
      "Test proposal for audit atomicity verification.",
      `${FIXTURE_PREFIX} I-15 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);

    await submitForReview(analystSession, proposal.proposalId);

    const auditEntry = await adminClient.auditLog.findFirst({
      where: {
        tenantId: tenantAId,
        action: "reform.proposal.submitted",
      },
      orderBy: { at: "desc" },
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry?.actor).toBe(analystUserId);
    // Verify the audit entry references the proposal
    const details = auditEntry?.details as { proposalId?: string } | null;
    expect(details?.proposalId).toBe(proposal.proposalId);
  });
});

// ============================================================
// I-16: Idempotency — repeated approval does not duplicate
// ============================================================
describeIntegration("I-16: Repeated approval does not duplicate immutable records", () => {
  it("calling approveReformProposal twice does not create a second approval record", async () => {
    const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const alertId = await createTestAlert(tenantAId, reviewerUserId);
    const proposal = await createReformProposal(analystSession, makeProposalInput(
      alertId,
      `${FIXTURE_PREFIX} I-16 Proposal`,
      "Test proposal for idempotency verification of approval.",
      `${FIXTURE_PREFIX} I-16 Alternative`
    ));
    createdProposalIds.push(proposal.proposalId);
    await submitForReview(analystSession, proposal.proposalId);

    await approveReformProposal(reviewerSession, {
      proposalId: proposal.proposalId,
      rationale: "First approval for I-16 idempotency test.",
    });

    const { raised, message } = await expectDenial(() =>
      approveReformProposal(reviewerSession, {
        proposalId: proposal.proposalId,
        rationale: "Second approval attempt — must be rejected.",
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("Conflict");

    const approvalCount = await adminClient.reformApproval.count({
      where: { proposalId: proposal.proposalId, tenantId: tenantAId },
    });
    expect(approvalCount).toBe(1);
  });
});
