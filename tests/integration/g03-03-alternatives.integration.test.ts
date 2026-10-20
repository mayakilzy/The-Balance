// ============================================================
// tests/integration/g03-03-alternatives.integration.test.ts
// ------------------------------------------------------------
// G03-03 — Integration tests for reform alternatives.
// Requires real PostgreSQL 16 + pgvector.
// Covers: lifecycle, selection, withdrawal, backward compat, sentinel.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-03-it-";

let adminClient: PrismaClient;
let appClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let analystUserId: string;
let reviewerUserId: string;
let adminUserId: string;
let strategyVersionId: string;
let createdAlertIds: string[] = [];
let createdProposalIds: string[] = [];
let createdAlternativeIds: string[] = [];
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

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("Tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const adminUser = await adminClient.user.findUnique({ where: { email: "admin@demolandia.test" } });
  const analystUser = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  if (!adminUser || !analystUser) throw new Error("Users not seeded");
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g03-03-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-03-reviewer@demolandia.test",
      name: "G03-03 Reviewer",
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
    const strategy = await adminClient.strategy.create({ data: { tenantId: tenantAId, title: "G03-03 Test Strategy", createdBy: analystUserId } });
    sv = await adminClient.strategyVersion.create({
      data: { strategyId: strategy.id, tenantId: tenantAId, versionNumber: 1, content: "{}", status: "approved", approvedBy: adminUserId, approvedAt: new Date(), metadata: { simulated: true }, createdBy: analystUserId },
    });
  }
  strategyVersionId = sv.id;
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  try {
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`);

    if (createdVerificationIds.length > 0) await adminClient.reformVerification.deleteMany({ where: { id: { in: createdVerificationIds } } });
    await adminClient.reformActionUpdate.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAction.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformApproval.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
    await adminClient.reformAlternative.deleteMany({ where: { id: { in: createdAlternativeIds } } });
    await adminClient.reformProposal.deleteMany({ where: { id: { in: createdProposalIds } } });
    if (createdAlertIds.length > 0) await adminClient.alert.deleteMany({ where: { id: { in: createdAlertIds } } });

    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`);
  } finally {
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
});

async function createTestAlert(): Promise<string> {
  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tenantId: tenantAId, strategyVersionId,
      title: "G03-03 Test Alert", description: "Test alert",
      severity: "warning", lifecycleStage: "reviewed",
      executionStatus: "verified", executionVerifiedAction: "test",
      executionVerificationSource: "test", executionVerifiedById: reviewerUserId,
      executionVerifiedAt: new Date(), createdBy: "system",
      reviewedBy: reviewerUserId, reviewedAt: new Date(),
      isAutoGenerated: true, metadata: { simulated: true },
    },
  });
  createdAlertIds.push(alert.id);
  return alert.id;
}

async function createProposalWithAlert(): Promise<{ proposalId: string; alternativeId?: string }> {
  const { createReformProposal } = await import("@/lib/reform/reform-proposal-service");
  const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
  const alertId = await createTestAlert();
  const result = await createReformProposal(analystSession, {
    originatingAlertId: alertId,
    title: `${FIXTURE_PREFIX} Proposal`,
    problemStatement: "Test proposal for G03-03 alternatives testing.",
    hypothesizedCauses: [],
    alternative: {
      title: `${FIXTURE_PREFIX} Inline Alternative`,
      description: "Test inline alternative description for the proposal here.",
      costCurrency: "USD", riskLevel: "medium", feasibilityScore: "high",
    },
  });
  createdProposalIds.push(result.proposalId);
  if (result.alternativeId) createdAlternativeIds.push(result.alternativeId);
  return result;
}

describeIntegration("G03-03 — Reform Alternatives", () => {
  it("ALT-01: add alternatives to a draft proposal (up to 5)", async () => {
    const { createReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const alertId = await createTestAlert();
    const proposal = await createReformProposal(analystSession, {
      originatingAlertId: alertId,
      title: `${FIXTURE_PREFIX} ALT-01 Proposal`,
      problemStatement: "Test proposal for adding alternatives.",
      hypothesizedCauses: [],
    });
    createdProposalIds.push(proposal.proposalId);

    // Add 5 alternatives (no inline — proposal was created without one)
    for (let i = 0; i < 5; i++) {
      const result = await addReformAlternative(analystSession, {
        proposalId: proposal.proposalId,
        title: `${FIXTURE_PREFIX} ALT-01 Alternative ${i}`,
        description: `Test alternative ${i} description for the proposal here.`,
        costCurrency: "USD", riskLevel: "low", feasibilityScore: "medium",
        anticipatedOutcomes: [], assumptions: [],
      });
      createdAlternativeIds.push(result.alternativeId);
    }

    const { listReformAlternatives } = await import("@/lib/reform/reform-alternative-service");
    const alts = await listReformAlternatives(analystSession, proposal.proposalId);
    expect(alts.length).toBe(5);
  });

  it("ALT-02: reject 6th alternative (D1 max 5)", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const { proposalId } = await createProposalWithAlert();

    // Already has 1 inline alternative, add 4 more = 5
    for (let i = 0; i < 5; i++) {
      const result = await addReformAlternative(analystSession, {
        proposalId, title: `${FIXTURE_PREFIX} ALT-02 Alt ${i}`,
        description: `Test alternative ${i} description for the proposal here.`,
        costCurrency: "USD", riskLevel: "low", feasibilityScore: "medium",
        anticipatedOutcomes: [], assumptions: [],
      });
      createdAlternativeIds.push(result.alternativeId);
    }

    // 6th should fail
    const { raised, message } = await expectDenial(() =>
      addReformAlternative(analystSession, {
        proposalId, title: `${FIXTURE_PREFIX} ALT-02 6th`,
        description: "This should be rejected because max is 5.",
        costCurrency: "USD", riskLevel: "low", feasibilityScore: "medium",
        anticipatedOutcomes: [], assumptions: [],
      })
    );
    expect(raised).toBe(true);
    expect(message).toMatch(/maximum.*5/i);
  });

  it("ALT-03: reject addition after submission (D3)", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const { proposalId } = await createProposalWithAlert();
    await submitForReview(analystSession, proposalId);

    const { raised, message } = await expectDenial(() =>
      addReformAlternative(analystSession, {
        proposalId, title: `${FIXTURE_PREFIX} ALT-03 After Submit`,
        description: "This should be rejected because proposal is under_review.",
        costCurrency: "USD", riskLevel: "low", feasibilityScore: "medium",
        anticipatedOutcomes: [], assumptions: [],
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("Conflict");
  });

  it("ALT-04: select one alternative (reviewer)", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { selectAlternative, listReformAlternatives } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const { proposalId } = await createProposalWithAlert();
    const alt2 = await addReformAlternative(analystSession, {
      proposalId, title: `${FIXTURE_PREFIX} ALT-04 Second Alt`,
      description: "Second test alternative for selection testing here.",
      costCurrency: "USD", riskLevel: "low", feasibilityScore: "high",
      anticipatedOutcomes: [], assumptions: [],
    });
    createdAlternativeIds.push(alt2.alternativeId);

    await submitForReview(analystSession, proposalId);

    const result = await selectAlternative(reviewerSession, { alternativeId: alt2.alternativeId });
    expect(result.status).toBe("selected");

    const alts = await listReformAlternatives(reviewerSession, proposalId);
    const selected = alts.filter(a => a.status === "selected");
    expect(selected.length).toBe(1);
    expect(selected[0]!.id).toBe(alt2.alternativeId);
  });

  it("ALT-05: reject selecting a second alternative (partial unique index)", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { selectAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const proposalResult = await createProposalWithAlert(); const proposalId = proposalResult.proposalId; const alt1Id = proposalResult.alternativeId!
    const alt2 = await addReformAlternative(analystSession, {
      proposalId, title: `${FIXTURE_PREFIX} ALT-05 Second Alt`,
      description: "Second test alternative for double-select testing here.",
      costCurrency: "USD", riskLevel: "low", feasibilityScore: "high",
      anticipatedOutcomes: [], assumptions: [],
    });
    createdAlternativeIds.push(alt2.alternativeId);

    await submitForReview(analystSession, proposalId);
    await selectAlternative(reviewerSession, { alternativeId: alt1Id });

    // Try to select alt2 — should fail
    const { raised, message } = await expectDenial(() =>
      selectAlternative(reviewerSession, { alternativeId: alt2.alternativeId })
    );
    expect(raised).toBe(true);
    expect(message).toContain("Conflict");
  });

  it("ALT-06: withdraw selected alternative, then select another", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { selectAlternative, withdrawAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const proposalResult = await createProposalWithAlert(); const proposalId = proposalResult.proposalId; const alt1Id = proposalResult.alternativeId!
    const alt2 = await addReformAlternative(analystSession, {
      proposalId, title: `${FIXTURE_PREFIX} ALT-06 Second Alt`,
      description: "Second test alternative for withdraw testing here.",
      costCurrency: "USD", riskLevel: "low", feasibilityScore: "high",
      anticipatedOutcomes: [], assumptions: [],
    });
    createdAlternativeIds.push(alt2.alternativeId);

    await submitForReview(analystSession, proposalId);
    await selectAlternative(reviewerSession, { alternativeId: alt1Id });

    // Withdraw alt1
    const withdrawResult = await withdrawAlternative(reviewerSession, {
      alternativeId: alt1Id,
      withdrawalReason: "This alternative is no longer viable due to changed conditions.",
    });
    expect(withdrawResult.status).toBe("withdrawn");

    // Now select alt2
    const selectResult = await selectAlternative(reviewerSession, { alternativeId: alt2.alternativeId });
    expect(selectResult.status).toBe("selected");
  });

  it("ALT-07: approve proposal with selected alternative", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { selectAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const proposalResult = await createProposalWithAlert(); const proposalId = proposalResult.proposalId; const alt1Id = proposalResult.alternativeId!
    const alt2 = await addReformAlternative(analystSession, {
      proposalId, title: `${FIXTURE_PREFIX} ALT-07 Second Alt`,
      description: "Second test alternative for approval testing here.",
      costCurrency: "USD", riskLevel: "low", feasibilityScore: "high",
      anticipatedOutcomes: [], assumptions: [],
    });
    createdAlternativeIds.push(alt2.alternativeId);

    await submitForReview(analystSession, proposalId);
    await selectAlternative(reviewerSession, { alternativeId: alt2.alternativeId });

    const approval = await approveReformProposal(reviewerSession, {
      proposalId,
      rationale: "Approved with explicitly selected alternative for testing.",
    });
    expect(approval.proposalStatus).toBe("approved");
  });

  it("ALT-08: reject approval with multiple drafts and no selection (D4)", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const { proposalId } = await createProposalWithAlert();
    const alt2 = await addReformAlternative(analystSession, {
      proposalId, title: `${FIXTURE_PREFIX} ALT-08 Second Alt`,
      description: "Second test alternative for multi-draft approval testing.",
      costCurrency: "USD", riskLevel: "low", feasibilityScore: "high",
      anticipatedOutcomes: [], assumptions: [],
    });
    createdAlternativeIds.push(alt2.alternativeId);

    await submitForReview(analystSession, proposalId);

    // 2 draft alternatives, no selection → should fail
    const { raised, message } = await expectDenial(() =>
      approveReformProposal(reviewerSession, {
        proposalId,
        rationale: "This should fail because no alternative is selected.",
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("must select");
  });

  it("ALT-09: backward compat — single alternative auto-selected during approval", async () => {
    const { submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const { proposalId } = await createProposalWithAlert();
    await submitForReview(analystSession, proposalId);

    // Single draft alternative → auto-select during approval (G03-02 compat)
    const approval = await approveReformProposal(reviewerSession, {
      proposalId,
      rationale: "Approved via G03-02 backward compatible auto-selection.",
    });
    expect(approval.proposalStatus).toBe("approved");
  });

  it("ALT-10: reject withdrawal after approval", async () => {
    const { selectAlternative, withdrawAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview, approveReformProposal } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const proposalResult = await createProposalWithAlert(); const proposalId = proposalResult.proposalId; const alt1Id = proposalResult.alternativeId!
    await submitForReview(analystSession, proposalId);
    await selectAlternative(reviewerSession, { alternativeId: alt1Id });
    await approveReformProposal(reviewerSession, {
      proposalId,
      rationale: "Approved to test post-approval withdrawal rejection.",
    });

    const { raised, message } = await expectDenial(() =>
      withdrawAlternative(reviewerSession, {
        alternativeId: alt1Id,
        withdrawalReason: "Attempt to withdraw after approval — should fail.",
      })
    );
    expect(raised).toBe(true);
    expect(message).toContain("approved");
  });

  it("ALT-11: cross-tenant alternative access denied (RLS)", async () => {
    const { listReformAlternatives } = await import("@/lib/reform/reform-alternative-service");
    const { proposalId } = await createProposalWithAlert();
    const tenantBAnalyst = makeSession({ id: analystUserId, tenantId: tenantBId, roleCode: "analyst", membershipStatus: "active" });

    // Tenant B analyst should not see Tenant A's alternatives
    const { raised } = await expectDenial(() =>
      listReformAlternatives(tenantBAnalyst, proposalId)
    );
    expect(raised).toBe(true);
  });

  it("ALT-12: sentinel — direct DB INSERT of second 'selected' rejected by partial unique index", async () => {
    const { addReformAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { selectAlternative } = await import("@/lib/reform/reform-alternative-service");
    const { submitForReview } = await import("@/lib/reform/reform-proposal-service");
    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const proposalResult = await createProposalWithAlert(); const proposalId = proposalResult.proposalId; const alt1Id = proposalResult.alternativeId!
    const alt2 = await addReformAlternative(analystSession, {
      proposalId, title: `${FIXTURE_PREFIX} ALT-12 Second Alt`,
      description: "Second alternative for partial unique index sentinel test.",
      costCurrency: "USD", riskLevel: "low", feasibilityScore: "high",
      anticipatedOutcomes: [], assumptions: [],
    });
    createdAlternativeIds.push(alt2.alternativeId);

    await submitForReview(analystSession, proposalId);
    await selectAlternative(reviewerSession, { alternativeId: alt1Id });

    // Direct DB INSERT of second 'selected' — should fail
    const { raised } = await expectDenial(() =>
      adminClient.reformAlternative.update({
        where: { id: alt2.alternativeId },
        data: { status: "selected", selectedAt: new Date(), selectedBy: reviewerUserId },
      })
    );
    expect(raised).toBe(true);
  });
});
