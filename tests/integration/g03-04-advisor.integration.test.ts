// ============================================================
// tests/integration/g03-04-advisor.integration.test.ts
// ------------------------------------------------------------
// G03-04 — Integration tests for the LLM-assisted advisor service.
// Requires real PostgreSQL 16 + pgvector + StubProvider.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-04-adv-it-";

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
    where: { email: "g03-04-adv-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-04-adv-reviewer@demolandia.test",
      name: "G03-04 Adv Reviewer",
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
        title: "G03-04 Adv Strategy",
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
      title: "G03-04 Adv Alert",
      description: "Test alert for advisor testing.",
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

async function setupProposal(): Promise<{ proposalId: string }> {
  const { createReformProposal } = await import(
    "@/lib/reform/reform-proposal-service"
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
    problemStatement: "Test proposal for G03-04 advisor testing here.",
    hypothesizedCauses: [],
  });
  createdProposalIds.push(result.proposalId);
  return { proposalId: result.proposalId };
}

describeIntegration("G03-04 Advisor Service", () => {
  it("I-ADV-1: draftProblemStatement returns simulated draft", async () => {
    const { draftProblemStatement } = await import(
      "@/lib/reform/reform-advisor-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const alertId = await createTestAlert();

    const result = await draftProblemStatement(analystSession, {
      alertId,
      includeVariance: false, // avoid varianceRecord lookup complexity
    });

    expect(result.draft).toBeTruthy();
    expect(result.simulated).toBe(true);
    expect(result.provider).toBe("stub");
    expect(result.model).toBe("stub-v0");
    expect(result.receipt).toBeTruthy(); // receipt issued
  });

  it("I-ADV-2: draftReformAlternatives returns 3 simulated drafts", async () => {
    const { draftReformAlternatives } = await import(
      "@/lib/reform/reform-advisor-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposal();

    const results = await draftReformAlternatives(analystSession, {
      proposalId,
      count: 3,
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.simulated).toBe(true);
      expect(r.receipt).toBeTruthy();
    }
  });

  it("I-ADV-3: draftComparisonSummary returns simulated draft with proposal context", async () => {
    const { draftComparisonSummary } = await import(
      "@/lib/reform/reform-advisor-service"
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
    const { proposalId } = await setupProposal();
    const alt = await addReformAlternative(analystSession, {
      proposalId,
      title: `${FIXTURE_PREFIX} Alt`,
      description: "Test alternative description for advisor here.",
      costCurrency: "USD",
      riskLevel: "low",
      feasibilityScore: "high",
      anticipatedOutcomes: [],
      assumptions: [],
    });
    createdAlternativeIds.push(alt.alternativeId);

    const result = await draftComparisonSummary(analystSession, proposalId);

    expect(result.draft).toBeTruthy();
    expect(result.simulated).toBe(true);
    expect(result.receipt).toBeTruthy();
  });

  it("I-ADV-4: draftAnticipatedOutcomes returns simulated draft with alternative context", async () => {
    const { draftAnticipatedOutcomes } = await import(
      "@/lib/reform/reform-advisor-service"
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
    const { proposalId } = await setupProposal();
    const alt = await addReformAlternative(analystSession, {
      proposalId,
      title: `${FIXTURE_PREFIX} Alt`,
      description: "Test alternative for outcomes drafting here.",
      costCurrency: "USD",
      riskLevel: "low",
      feasibilityScore: "high",
      anticipatedOutcomes: [],
      assumptions: [],
    });
    createdAlternativeIds.push(alt.alternativeId);

    const result = await draftAnticipatedOutcomes(analystSession, {
      alternativeId: alt.alternativeId,
    });

    expect(result.draft).toBeTruthy();
    expect(result.simulated).toBe(true);
    expect(result.receipt).toBeTruthy();
  });

  it("I-ADV-5: advisor does NOT create audit_log entries", async () => {
    const { draftProblemStatement } = await import(
      "@/lib/reform/reform-advisor-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const alertId = await createTestAlert();

    const beforeCount = await adminClient.auditLog.count({
      where: { tenantId: tenantAId },
    });

    await draftProblemStatement(analystSession, {
      alertId,
      includeVariance: false,
    });

    const afterCount = await adminClient.auditLog.count({
      where: { tenantId: tenantAId },
    });
    expect(afterCount).toBe(beforeCount); // no audit entries
  });

  it("I-ADV-6: advisor does NOT modify any reform_proposals rows", async () => {
    const { draftProblemStatement } = await import(
      "@/lib/reform/reform-advisor-service"
    );
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { proposalId } = await setupProposal();
    const alertId = await createTestAlert();

    const beforeProposal = await adminClient.reformProposal.findUnique({
      where: { id: proposalId },
    });

    await draftProblemStatement(analystSession, {
      alertId,
      includeVariance: false,
    });

    const afterProposal = await adminClient.reformProposal.findUnique({
      where: { id: proposalId },
    });
    expect(afterProposal?.title).toBe(beforeProposal?.title);
    expect(afterProposal?.status).toBe(beforeProposal?.status);
  });

  it("I-ADV-9: cross-tenant advisor request denied (RLS)", async () => {
    const { draftProblemStatement } = await import(
      "@/lib/reform/reform-advisor-service"
    );
    const alertId = await createTestAlert();
    const tenantBAnalyst = makeSession({
      id: analystUserId,
      tenantId: tenantBId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    await expect(
      draftProblemStatement(tenantBAnalyst, {
        alertId,
        includeVariance: false,
      })
    ).rejects.toThrow();
  });
});
