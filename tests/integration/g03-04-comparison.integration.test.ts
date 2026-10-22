// ============================================================
// tests/integration/g03-04-comparison.integration.test.ts
// ------------------------------------------------------------
// G03-04 — Integration tests for the deterministic comparison service.
// Requires real PostgreSQL 16 + pgvector.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-04-cmp-it-";

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

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  const tenantA = await adminClient.tenant.findUnique({
    where: { code: "DML-MOP-TENANT" },
  });
  const tenantB = await adminClient.tenant.findUnique({
    where: { code: "DML-CB-TENANT" },
  });
  if (!tenantA || !tenantB) throw new Error("Tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const adminUser = await adminClient.user.findUnique({
    where: { email: "admin@demolandia.test" },
  });
  const analystUser = await adminClient.user.findUnique({
    where: { email: "analyst@demolandia.test" },
  });
  if (!adminUser || !analystUser) throw new Error("Users not seeded");
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g03-04-cmp-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-04-cmp-reviewer@demolandia.test",
      name: "G03-04 Cmp Reviewer",
      passwordHash: await hashPassword("Test1234!"),
      status: "active",
    },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "reviewer" },
    create: {
      userId: reviewer.id,
      tenantId: tenantAId,
      roleCode: "reviewer",
      status: "active",
    },
  });
  reviewerUserId = reviewer.id;

  let sv = await adminClient.strategyVersion.findFirst({
    where: { tenantId: tenantAId, status: "approved" },
  });
  if (!sv) {
    const strategy = await adminClient.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "G03-04 Cmp Strategy",
        createdBy: analystUserId,
      },
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
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`
    );
    await adminClient.reformActionUpdate.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformAction.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformApproval.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformAlternative.deleteMany({
      where: { id: { in: createdAlternativeIds } },
    });
    await adminClient.reformProposal.deleteMany({
      where: { id: { in: createdProposalIds } },
    });
    if (createdAlertIds.length > 0) {
      await adminClient.alert.deleteMany({ where: { id: { in: createdAlertIds } } });
    }
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`
    );
  } finally {
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
});

async function createTestAlert(): Promise<string> {
  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      tenantId: tenantAId,
      strategyVersionId,
      title: "G03-04 Cmp Alert",
      description: "Test alert for comparison testing.",
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
  return alert.id;
}

async function setupProposalWith3Alts(): Promise<{ proposalId: string }> {
  const { createReformProposal } = await import(
    "@/lib/reform/reform-proposal-service"
  );
  const { addReformAlternative } = await import(
    "@/lib/reform/reform-alternative-service"
  );
  const analystSession = makeSession({
    id: analystUserId,
    tenantId: tenantAId,
    roleCode: "analyst",
    membershipStatus: "active",
  });
  const alertId = await createTestAlert();
  const result = await createReformProposal(analystSession, {
    originatingAlertId: alertId,
    title: `${FIXTURE_PREFIX} Proposal`,
    problemStatement: "Test proposal for G03-04 comparison testing.",
    hypothesizedCauses: [],
  });
  createdProposalIds.push(result.proposalId);

  for (let i = 0; i < 3; i++) {
    const alt = await addReformAlternative(analystSession, {
      proposalId: result.proposalId,
      title: `${FIXTURE_PREFIX} Alt ${i}`,
      description: `Alternative ${i} description for comparison testing here.`,
      costCurrency: "USD",
      riskLevel: i === 0 ? "low" : i === 1 ? "medium" : "high",
      feasibilityScore: i === 0 ? "high" : i === 1 ? "medium" : "low",
      anticipatedOutcomes: [`Outcome ${i}.1`, `Outcome ${i}.2`],
      assumptions: [`Assumption ${i}.1`],
    });
    createdAlternativeIds.push(alt.alternativeId);
  }

  return { proposalId: result.proposalId };
}

describeIntegration("G03-04 Comparison Service", () => {
  it("I-CMP-1: returns correct data for proposal with 3 alternatives", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposalWith3Alts();

    const result = await compareReformAlternatives(analystSession, proposalId);

    expect(result.proposalId).toBe(proposalId);
    expect(result.alternatives).toHaveLength(3);

    // Each alternative has actual content
    for (const alt of result.alternatives) {
      expect(alt.assumptions.length).toBeGreaterThan(0);
      expect(alt.anticipatedOutcomes.length).toBeGreaterThan(0);
      expect(alt.assumptionCount).toBe(alt.assumptions.length);
      expect(alt.anticipatedOutcomeCount).toBe(alt.anticipatedOutcomes.length);
      expect(alt.provenance).toBeDefined();
      expect(alt.provenance.draftedVia).toBe("human");
      expect(alt.provenance.simulated).toBe(false);
    }

    // Honesty block
    expect(result.honestyBlock.simulatedData).toBe(false);
    expect(result.honestyBlock.knownLimitations.length).toBeGreaterThan(0);
  });

  it("I-CMP-2: returns actual assumptions[] text per alternative", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposalWith3Alts();

    const result = await compareReformAlternatives(analystSession, proposalId);

    expect(result.alternatives[0]!.assumptions).toEqual(["Assumption 0.1"]);
    expect(result.alternatives[1]!.assumptions).toEqual(["Assumption 1.1"]);
    expect(result.alternatives[2]!.assumptions).toEqual(["Assumption 2.1"]);
  });

  it("I-CMP-3: returns actual anticipatedOutcomes[] text", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposalWith3Alts();

    const result = await compareReformAlternatives(analystSession, proposalId);

    expect(result.alternatives[0]!.anticipatedOutcomes).toEqual([
      "Outcome 0.1",
      "Outcome 0.2",
    ]);
  });

  it("I-CMP-4: returns provenance per alternative", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposalWith3Alts();

    const result = await compareReformAlternatives(analystSession, proposalId);

    for (const alt of result.alternatives) {
      expect(alt.provenance).toEqual({
        draftedVia: "human",
        simulated: false,
        provider: null,
      });
    }
  });

  it("I-CMP-5: returns honestyBlock with simulatedData=false (no LLM-assisted)", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposalWith3Alts();

    const result = await compareReformAlternatives(analystSession, proposalId);

    expect(result.honestyBlock.simulatedData).toBe(false);
    expect(result.honestyBlock.knownLimitations).toContain(
      "No LLM-assisted drafts in this proposal."
    );
  });

  it("I-CMP-6: cross-tenant access denied (RLS)", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const tenantBAnalyst = makeSession({
      id: analystUserId,
      tenantId: tenantBId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposalWith3Alts();

    await expect(
      compareReformAlternatives(tenantBAnalyst, proposalId)
    ).rejects.toThrow();
  });

  it("I-CMP-7: comparison is read-only (audit_log count unchanged)", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposalWith3Alts();

    const beforeCount = await adminClient.auditLog.count({
      where: { tenantId: tenantAId },
    });

    await compareReformAlternatives(analystSession, proposalId);

    const afterCount = await adminClient.auditLog.count({
      where: { tenantId: tenantAId },
    });
    expect(afterCount).toBe(beforeCount); // no audit entries created
  });

  it("I-CMP-8: all alternative statuses returned (including withdrawn)", async () => {
    const { compareReformAlternatives } = await import(
      "@/lib/reform/reform-comparison-service"
    );
    const { createReformProposal } = await import(
      "@/lib/reform/reform-proposal-service"
    );
    const { submitForReview } = await import(
      "@/lib/reform/reform-proposal-service"
    );
    const { selectAlternative, withdrawAlternative, addReformAlternative } =
      await import("@/lib/reform/reform-alternative-service");
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const reviewerSession = makeSession({
      id: reviewerUserId,
      tenantId: tenantAId,
      roleCode: "reviewer",
      membershipStatus: "active",
    });

    // Setup fresh proposal with 2 alternatives
    const alertId = await createTestAlert();
    const proposal = await createReformProposal(analystSession, {
      originatingAlertId: alertId,
      title: `${FIXTURE_PREFIX} Proposal I-CMP-8 ${Date.now()}`,
      problemStatement: "Test proposal for I-CMP-8 status coverage here.",
      hypothesizedCauses: [],
    });
    createdProposalIds.push(proposal.proposalId);

    const alt1 = await addReformAlternative(analystSession, {
      proposalId: proposal.proposalId,
      title: `${FIXTURE_PREFIX} I-CMP-8 Alt 1`,
      description: "First alternative for status testing purposes here.",
      costCurrency: "USD",
      riskLevel: "low",
      feasibilityScore: "high",
      anticipatedOutcomes: [],
      assumptions: [],
    });
    createdAlternativeIds.push(alt1.alternativeId);
    const alt2 = await addReformAlternative(analystSession, {
      proposalId: proposal.proposalId,
      title: `${FIXTURE_PREFIX} I-CMP-8 Alt 2`,
      description: "Second alternative for status testing here.",
      costCurrency: "USD",
      riskLevel: "medium",
      feasibilityScore: "medium",
      anticipatedOutcomes: [],
      assumptions: [],
    });
    createdAlternativeIds.push(alt2.alternativeId);

    // Submit, then select alt1 + withdraw alt2
    await submitForReview(analystSession, proposal.proposalId);
    await selectAlternative(reviewerSession, { alternativeId: alt1.alternativeId });
    await withdrawAlternative(reviewerSession, {
      alternativeId: alt2.alternativeId,
      withdrawalReason: "Withdrawn for testing purposes in G03-04 I-CMP-8.",
    });

    const result = await compareReformAlternatives(
      analystSession,
      proposal.proposalId
    );
    const statuses = result.alternatives.map((a) => a.status).sort();
    // 2 alternatives: 1 selected, 1 withdrawn
    expect(statuses).toContain("selected");
    expect(statuses).toContain("withdrawn");
  });
});
