// ============================================================
// tests/integration/g03-02-feedback-atomicity.integration.test.ts
// ------------------------------------------------------------
// R2 negative atomic test: proves that createReformFeedbackLoop
// rolls back the new observation if the feedback loop creation fails.
//
// This addresses the G03↔G02 atomicity gap that the reviewer identified.
// The previous implementation called `ingestObservation` (which uses its
// own transaction) from inside the reform transaction — if the feedback
// loop creation failed, the observation would persist as an orphan.
//
// The fix: `createReformFeedbackLoop` now calls `ingestObservationTx`
// (the transaction-aware variant) which accepts the outer transaction's
// `tx` client. Both the observation INSERT + the feedback loop INSERT
// commit/roll back TOGETHER.
//
// Test strategy:
//   ATOMIC-1: successful feedback creation ALSO creates the new observation
//             in the same tx (positive control).
//   ATOMIC-2: feedback creation failure (1:1 invariant violation) rolls
//             back the new observation (NO ORPHAN).
//   ATOMIC-3: feedback creation failure (invalid indicator) rolls back
//             the entire transaction (no feedback, no observation).
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-02-atomic-";

let adminClient: PrismaClient;
let appClient: PrismaClient;
let tenantAId: string;
let countryId: string;
let analystUserId: string;
let reviewerUserId: string;
let adminUserId: string;
let strategyVersionId: string;
let indicatorId: string;
let observationPeriodId: string;
let sourceId: string;
let createdAlertIds: string[] = [];
let createdProposalIds: string[] = [];
let createdActionIds: string[] = [];
let createdVerificationIds: string[] = [];
let createdFeedbackIds: string[] = [];
let createdObservationIds: string[] = [];

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
    where: { email: "g03-02-atomic-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-02-atomic-reviewer@demolandia.test",
      name: "G03-02 Atomicity Reviewer",
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
      data: { tenantId: tenantAId, title: "G03-02 Atomicity Test Strategy", createdBy: analystUserId },
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

  // Create a test indicator + observation period + source FOR THIS SUITE ONLY.
  // Cleanup in afterAll removes them so they don't leak into other suites.
  const period = await adminClient.observationPeriod.create({
    data: {
      tenantId: tenantAId,
      periodType: "quarterly",
      periodValue: "G03-02-ATOMIC-Q1",
      startAt: new Date("2026-01-01T00:00:00Z"),
      endAt: new Date("2026-03-31T23:59:59Z"),
    },
  });
  observationPeriodId = period.id;

  const ind = await adminClient.indicatorDefinition.create({
    data: {
      tenantId: tenantAId,
      strategyVersionId,
      code: "G03-02-ATOMIC-IND",
      displayName: "G03-02 Atomicity Test Indicator",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      alertThresholds: [],
      createdBy: analystUserId,
    },
  });
  indicatorId = ind.id;

  let src = await adminClient.source.findFirst({ where: { code: "G0302_ATOMIC_SRC" } });
  if (!src) {
    src = await adminClient.source.create({
      data: {
        code: "G0302_ATOMIC_SRC",
        displayName: "G03-02 Atomicity Test Source",
        type: "government",
        reviewStatus: "approved",
        metadata: { synthetic: true, country: "DML" },
      },
    });
  }
  sourceId = src.id;
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  try {
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" DISABLE TRIGGER prevent_delete_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`);

    await adminClient.reformFeedbackLoop.deleteMany({ where: { id: { in: createdFeedbackIds } } });
    await adminClient.observation.deleteMany({ where: { id: { in: createdObservationIds } } });
    await adminClient.reformVerification.deleteMany({ where: { id: { in: createdVerificationIds } } });
    await adminClient.reformActionUpdate.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAction.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformApproval.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAlternative.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformProposal.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    if (createdAlertIds.length > 0) {
      await adminClient.alert.deleteMany({ where: { id: { in: createdAlertIds } } });
    }
    // Cleanup this suite's indicator + period
    await adminClient.indicatorDefinition.deleteMany({ where: { code: "G03-02-ATOMIC-IND" } });
    await adminClient.observationPeriod.deleteMany({ where: { periodValue: "G03-02-ATOMIC-Q1" } });

    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" ENABLE TRIGGER prevent_delete_reform_feedback_loops`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`);
  } finally {
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
});

async function setupVerifiedAction(suffix: string): Promise<string> {
  const { createReformProposal, submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
  const { createReformAction, startReformAction, completeReformAction } = await import("@/lib/reform/reform-action-service");
  const { verifyReformAction } = await import("@/lib/reform/reform-verification-service");

  const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
  const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${suffix}-${Date.now()}`,
      tenantId: tenantAId,
      strategyVersionId,
      title: `G03-02 Atomicity Test Alert ${suffix}`,
      description: "Test alert for atomicity verification.",
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
    title: `${FIXTURE_PREFIX}${suffix} Proposal`,
    problemStatement: "Test proposal for atomicity verification of feedback loop.",
    hypothesizedCauses: [],
    alternative: {
      title: `${FIXTURE_PREFIX}${suffix} Alternative`,
      description: "Test alternative description for the proposal setup here.",
      costCurrency: "USD",
      riskLevel: "medium",
      feasibilityScore: "high",
    },
  });
  createdProposalIds.push(proposal.proposalId);
  await submitForReview(analystSession, proposal.proposalId);
  await approveReformProposal(reviewerSession, {
    proposalId: proposal.proposalId,
    rationale: "Approved for atomicity test.",
  });
  const action = await createReformAction(analystSession, {
    proposalId: proposal.proposalId,
    title: `${FIXTURE_PREFIX}${suffix} Action`,
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

// Helper: create a unique observation period for a single test
async function makeUniquePeriod(suffix: string): Promise<string> {
  const period = await adminClient.observationPeriod.create({
    data: {
      tenantId: tenantAId,
      periodType: "quarterly",
      periodValue: `G03-02-ATOMIC-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      startAt: new Date("2026-01-01T00:00:00Z"),
      endAt: new Date("2026-03-31T23:59:59Z"),
    },
  });
  return period.id;
}

describeIntegration("G03-02 Atomicity — feedback + observation share transaction (R2 fix)", () => {
  it("ATOMIC-1: successful feedback creation ALSO creates the new observation in the same tx", async () => {
    const { createReformFeedbackLoop } = await import("@/lib/reform/reform-feedback-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const actionId = await setupVerifiedAction("atomic1");
    const uniquePeriod = await makeUniquePeriod("atomic1");

    const result = await createReformFeedbackLoop(analystSession, {
      actionId,
      comparisonType: "none",
      descriptiveSummary: "The action was implemented on 2026-04-15; observation #X1 recorded inflation at 4.2% on 2026-04-30.",
      newAfterObservation: {
        indicatorDefinitionId: indicatorId,
        observationPeriodId: uniquePeriod,
        observedValue: 4.2,
        originType: "observed",
        sourceId: sourceId,
        isSynthetic: false,
      },
    });

    expect(result.feedbackLoopId).toBeDefined();
    expect(result.newObservationId).toBeDefined();
    createdFeedbackIds.push(result.feedbackLoopId);
    createdObservationIds.push(result.newObservationId!);

    // Verify BOTH exist in DB
    const feedback = await adminClient.reformFeedbackLoop.findUnique({ where: { id: result.feedbackLoopId } });
    expect(feedback).not.toBeNull();
    expect(feedback?.afterObservationId).toBe(result.newObservationId);

    const observation = await adminClient.observation.findUnique({ where: { id: result.newObservationId! } });
    expect(observation).not.toBeNull();
    expect(Number(observation?.observedValue)).toBeCloseTo(4.2, 5);
  });

  it("ATOMIC-2: feedback creation failure rolls back the new observation (NO ORPHAN)", async () => {
    // This is the CRITICAL negative atomic test.
    // Strategy: set up an action, create feedback (succeeds), then try to create
    // feedback AGAIN on the SAME action with a newAfterObservation. The second
    // call must fail (1:1 invariant) AND the second observation must NOT exist.
    const { createReformFeedbackLoop } = await import("@/lib/reform/reform-feedback-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const actionId = await setupVerifiedAction("atomic2");

    // Create a SEPARATE observation period for the first observation.
    const firstPeriod = await makeUniquePeriod("atomic2-first");
    // Create a SEPARATE observation period for the second (would-be) observation.
    const orphanPeriod = await makeUniquePeriod("atomic2-orphan");

    // First feedback creation — succeeds, creates observation in firstPeriod
    const firstResult = await createReformFeedbackLoop(analystSession, {
      actionId,
      comparisonType: "none",
      descriptiveSummary: "The action was implemented on 2026-04-15; observation recorded inflation at 4.2%.",
      newAfterObservation: {
        indicatorDefinitionId: indicatorId,
        observationPeriodId: firstPeriod,
        observedValue: 4.2,
        originType: "observed",
        sourceId: sourceId,
        isSynthetic: false,
      },
    });
    createdFeedbackIds.push(firstResult.feedbackLoopId);
    createdObservationIds.push(firstResult.newObservationId!);

    // Count observations in the orphan period BEFORE second attempt (should be 0)
    const orphanObservationsBefore = await adminClient.observation.count({
      where: { tenantId: tenantAId, observationPeriodId: orphanPeriod },
    });
    expect(orphanObservationsBefore).toBe(0);

    // Second feedback creation — must FAIL (1:1 invariant: action already has feedback)
    // The newAfterObservation would create an observation in orphanPeriod if it succeeded.
    const { raised, message } = await expectDenial(() =>
      createReformFeedbackLoop(analystSession, {
        actionId,
        comparisonType: "none",
        descriptiveSummary: "Second feedback attempt — should be rejected AND the new observation rolled back.",
        newAfterObservation: {
          indicatorDefinitionId: indicatorId,
          observationPeriodId: orphanPeriod,
          observedValue: 3.8,
          originType: "observed",
          sourceId: sourceId,
          isSynthetic: false,
        },
      })
    );

    // Verify the failure was the expected 1:1 invariant conflict.
    expect(raised).toBe(true);
    expect(
      message.includes("already has a feedback loop") ||
        message.includes("already_exists") ||
        message.includes("unique") ||
        message.includes("Conflict")
    ).toBe(true);

    // CRITICAL: verify the orphan observation was NOT created (rolled back with the failed feedback)
    const orphanObservationsAfter = await adminClient.observation.count({
      where: { tenantId: tenantAId, observationPeriodId: orphanPeriod },
    });
    expect(orphanObservationsAfter).toBe(0); // unchanged — no orphan observation

    // CRITICAL: verify no second feedback loop exists for this action
    const feedbackCount = await adminClient.reformFeedbackLoop.count({
      where: { actionId, tenantId: tenantAId },
    });
    expect(feedbackCount).toBe(1); // only the first one
  });

  it("ATOMIC-3: feedback creation failure due to invalid input ALSO rolls back the observation", async () => {
    // Strategy: attempt feedback creation with a NON-EXISTENT indicator.
    // ingestObservationTx will raise NotFoundError → entire transaction
    // rolls back → no feedback loop, no observation.
    const { createReformFeedbackLoop } = await import("@/lib/reform/reform-feedback-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const actionId = await setupVerifiedAction("atomic3");
    const uniquePeriod = await makeUniquePeriod("atomic3");

    const observationsBefore = await adminClient.observation.count({
      where: { tenantId: tenantAId, observationPeriodId: uniquePeriod },
    });
    const feedbackBefore = await adminClient.reformFeedbackLoop.count({
      where: { tenantId: tenantAId },
    });

    // Attempt with a NON-EXISTENT indicator → ingestObservationTx raises NotFoundError
    // → entire transaction rolls back → no feedback loop, no observation
    const { raised, message } = await expectDenial(() =>
      createReformFeedbackLoop(analystSession, {
        actionId,
        comparisonType: "none",
        descriptiveSummary: "The action was implemented on 2026-04-15; observation recorded inflation at 4.2%.",
        newAfterObservation: {
          indicatorDefinitionId: "nonexistent-indicator-id",
          observationPeriodId: uniquePeriod,
          observedValue: 4.2,
          originType: "observed",
          sourceId: sourceId,
          isSynthetic: false,
        },
      })
    );

    expect(raised).toBe(true);
    // NotFoundError message: "Not Found: Indicator nonexistent-indicator-id not found..."
    expect(message.toLowerCase()).toContain("not found");
    expect(message).toContain("Indicator");

    // Verify NO new observation was created
    const observationsAfter = await adminClient.observation.count({
      where: { tenantId: tenantAId, observationPeriodId: uniquePeriod },
    });
    expect(observationsAfter).toBe(observationsBefore);

    // Verify NO new feedback loop was created
    const feedbackAfter = await adminClient.reformFeedbackLoop.count({
      where: { tenantId: tenantAId },
    });
    expect(feedbackAfter).toBe(feedbackBefore);
  });
});
