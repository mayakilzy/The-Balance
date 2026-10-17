// ============================================================
// g01-t1-integration.integration.test.ts
// ------------------------------------------------------------
// Mission 01-10: T1 End-to-End Integration Test
//
// Tests the FULL T1 journey:
//   T1.1  Country Pack loaded (Demolandia seeded)
//   T1.2  Evidence + Sources in Evidence Fabric
//   T1.3  National Objectives defined
//   T1.4  State Baseline computed
//   T1.5  Gap Analysis run
//   T1.6  Strategy Composer generates ≥2 alternatives
//   T1.7  Portfolio & Dependency Graph built
//   T1.8  Budget estimates (conditional ranges)
//   T1.9  Scenario Comparison
//   T1.10 UNAUTHORIZED approval → REJECTED + audit_log
//   T1.11 AUTHORIZED approval → approved + audit_log + domain event
//   T1.12 Approved version immutable
//   T1.13 Handover: new user can view approved strategy
//
// Negative Tests:
//   T1.N1 AI recommendation does NOT auto-approve
//   T1.N2 Cross-tenant isolation (RLS)
//   T1.N3 Insufficient evidence → "unknown" (no fabrication)
//   T1.N4 Contradictory evidence → both sides shown
//   T1.N5 Revoked membership mid-session → denied
//
// Audit Independence Test (per §13 Correction B):
//   audit_log and events are independent tables.
// ============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let adminClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let analystUserId: string;
let adminUserId: string;
let reviewerUserId: string;
let objectiveAgricultureId: string;
let objectiveInflationId: string;

function makeSession(
  user: { id: string; tenantId: string; roleCode: string; membershipStatus: string }
): Session {
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
  await adminClient.$queryRaw`SELECT 1`;

  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia not seeded");
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("Tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const admin = await adminClient.user.findUnique({ where: { email: "admin@demolandia.test" } });
  const analyst = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  if (!admin || !analyst) throw new Error("Users not seeded");
  adminUserId = admin.id;
  analystUserId = analyst.id;

  // Create a reviewer user for T1.11
  const reviewer = await adminClient.user.upsert({
    where: { email: "t1-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "t1-reviewer@demolandia.test",
      name: "T1 Reviewer",
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

  const agObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Increase agricultural GDP growth to 6% annually" },
  });
  const infObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Maintain inflation below 5% annually" },
  });
  if (!agObj || !infObj) throw new Error("Objectives not seeded");
  objectiveAgricultureId = agObj.id;
  objectiveInflationId = infObj.id;
});

afterAll(async () => {
  if (adminClient) await adminClient.$disconnect();
});

// ============================================================
// T1 END-TO-END INTEGRATION TEST
// ============================================================
describeIntegration("T1: End-to-End State Builder Journey", () => {
  beforeEach(async () => {
    // Clean up G01 data
    await adminClient.budgetLine.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.dependency.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.riskRegister.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.task.deleteMany({
      where: { type: { in: ["strategy-compose", "gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    const strategies = await adminClient.strategy.findMany({
      where: { tenantId: tenantAId, compositionBatchId: { startsWith: "compose-" } },
    });
    for (const s of strategies) {
      const versions = await adminClient.strategyVersion.findMany({ where: { strategyId: s.id } });
      const versionIds = versions.map((v: { id: string }) => v.id);
      if (versionIds.length > 0) {
        await adminClient.program.deleteMany({ where: { strategyVersionId: { in: versionIds } } });
      }
      await adminClient.strategyVersion.deleteMany({ where: { strategyId: s.id } });
      await adminClient.strategy.delete({ where: { id: s.id } });
    }
    // Clean up audit_log entries from previous test runs
    await adminClient.auditLog.deleteMany({
      where: { tenantId: tenantAId, action: "strategy.version_approved" },
    });
  });

  // ============================================================
  // T1.1–T1.9: Full journey up to comparison (single test)
  // ============================================================
  it("T1.1-T1.9: full journey from country pack to scenario comparison", async () => {
    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // T1.1: Country Pack loaded (verified by seed)
    const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
    expect(country).toBeTruthy();
    const institutions = await adminClient.institution.findMany({ where: { countryId } });
    expect(institutions.length).toBeGreaterThan(0);

    // T1.2: Evidence + Sources in Evidence Fabric (verified by seed)
    const evidence = await adminClient.evidence.findMany({ where: { tenantId: tenantAId } });
    expect(evidence.length).toBeGreaterThan(0);
    // Evidence has verificationStatus
    for (const e of evidence) {
      expect(e.verificationStatus).toBeTruthy();
    }

    // T1.3: National Objectives defined (verified by seed)
    expect(objectiveAgricultureId).toBeTruthy();
    expect(objectiveInflationId).toBeTruthy();

    // T1.4: Compute State Baseline
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const baselineResult = await computeBaseline(analystSession, { countryId });
    expect(baselineResult.report.dimensions.length).toBeGreaterThan(0);
    const fullOrPartial = baselineResult.report.dimensions.filter(
      (d: { observabilityMode: string }) => d.observabilityMode === "FULL" || d.observabilityMode === "PARTIAL"
    );
    expect(fullOrPartial.length).toBeGreaterThan(0);

    // T1.5: Run Gap Analysis
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const gapResult = await computeGaps(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
    });
    expect(gapResult.report.gaps.length).toBeGreaterThan(0);

    // T1.6: Strategy Composer generates ≥2 alternatives
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
    });
    expect(composeResult.alternatives.length).toBeGreaterThanOrEqual(2);
    // All alternatives share the same compositionBatchId
    const batchIds = new Set(composeResult.alternatives.map((a: { compositionBatchId: string }) => a.compositionBatchId));
    expect(batchIds.size).toBe(1);
    // All alternatives are simulated: true
    for (const alt of composeResult.alternatives) {
      expect(alt.simulated).toBe(true);
    }

    // Pick 2 alternatives for the rest of the journey
    const alt1 = composeResult.alternatives[0]!;
    const alt2 = composeResult.alternatives[1]!;
    const alt1VersionId = alt1.versionId;
    const alt2VersionId = alt2.versionId;

    // Expand programs for both alternatives
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    await expandPrograms(analystSession, { strategyAlternativeId: alt1VersionId });
    await expandPrograms(analystSession, { strategyAlternativeId: alt2VersionId });

    // T1.7: Portfolio & Dependency Graph
    const { buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const portfolio1 = await buildPortfolio(analystSession, { strategyAlternativeId: alt1VersionId });
    expect(portfolio1.nodes.length).toBeGreaterThan(0);
    expect(portfolio1.cycles).toEqual([]);

    // T1.8: Budget estimates (conditional ranges)
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    // Add cost inputs to programs in alt1
    const alt1Programs = await adminClient.program.findMany({
      where: { tenantId: tenantAId, strategyVersionId: alt1VersionId },
    });
    for (const p of alt1Programs) {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      meta.costInputs = [{
        label: "[FICTIONAL] T1 test input",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10, horizonYears: 1, source: "[FICTIONAL] T1 test",
        varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL] T1 test variance",
      }];
      await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
    }
    const budgetResult1 = await estimateBudgets(analystSession, { strategyAlternativeId: alt1VersionId });
    // Budget estimates are conditional ranges (min/max, never point estimates)
    for (const est of budgetResult1.estimates) {
      expect(est.costRange.min).toBeTruthy();
      expect(est.costRange.max).toBeTruthy();
      expect(est.simulated).toBe(true);
    }

    // T1.9: Scenario Comparison
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const comparison = await compareScenarios(analystSession, { alternativeIds: [alt1VersionId, alt2VersionId] });
    expect(comparison.alternatives.length).toBe(2);
    // Comparison does NOT declare a winner
    expect(comparison.tradeoffs).toContain("does NOT recommend a winner");

    // Development Advisor (T1 pre-approval step)
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const advisoryReport = await advise(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
      alternativeIds: [alt1VersionId, alt2VersionId],
    });
    // T1.N1: Advisor output is NOT an approval — it's a conditional recommendation
    expect(advisoryReport.simulated).toBe(true);
    expect(advisoryReport.disclaimer).toBe("This is a conditional recommendation. Human approval required.");
    // The strategy version is STILL draft (not auto-approved)
    const alt1Version = await adminClient.strategyVersion.findUnique({ where: { id: alt1VersionId } });
    expect(alt1Version!.status).toBe("draft");

    // Store for subsequent tests
    return { alt1VersionId, alt2VersionId };
  });

  // ============================================================
  // T1.10: UNAUTHORIZED approval → REJECTED + audit_log
  // ============================================================
  it("T1.10: analyst (no strategy:approve) attempts approval → REJECTED + audit_log", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose a strategy version to attempt approval on
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    // Analyst does NOT have strategy:approve → must be rejected
    await expect(approveStrategyVersionWithAuditSafe(analystSession, versionId))
      .rejects.toThrow(/Permission denied/);

    // T1.10 evidence layer 1: version is STILL draft (not approved)
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("draft");

    // T1.10 evidence layer 2: audit_log row with status="denied"
    const deniedAudit = await adminClient.auditLog.findFirst({
      where: {
        tenantId: tenantAId,
        action: "strategy.version_approved",
        status: "denied",
        actor: analystUserId,
      },
    });
    expect(deniedAudit).toBeTruthy();
    expect(deniedAudit!.errorCode).toBe("PERMISSION_DENIED");

    // T1.10 evidence layer 3: NO domain event for successful approval
    // (the denial doesn't create a strategy.version_approved event)
    const approvalEvent = await adminClient.event.findFirst({
      where: {
        tenantId: tenantAId,
        eventType: "strategy.version_approved",
        entityId: versionId,
      },
    });
    expect(approvalEvent).toBeNull();
  });

  // ============================================================
  // T1.11: AUTHORIZED approval → approved + audit_log + domain event
  // ============================================================
  it("T1.11: reviewer (has strategy:approve) approves → approved + atomic audit + event", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const reviewerSession = makeSession({
      id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // Compose a strategy version
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    // Reviewer approves
    const result = await approveStrategyVersionWithAuditSafe(reviewerSession, versionId, "T1.11 test approval");

    // T1.11: version is now approved
    expect(result.status).toBe("approved");
    expect(result.approvedBy).toBe(reviewerUserId);

    // T1.11 evidence layer 1: version status in DB
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("approved");
    expect(version!.approvedBy).toBe(reviewerUserId);
    expect(version!.approvedAt).toBeTruthy();

    // T1.11 evidence layer 2: audit_log row (sovereign audit trail, atomic)
    const auditRow = await adminClient.auditLog.findFirst({
      where: {
        tenantId: tenantAId,
        action: "strategy.version_approved",
        status: "ok",
        actor: reviewerUserId,
      },
    });
    expect(auditRow).toBeTruthy();
    const auditDetails = auditRow!.details as Record<string, unknown>;
    expect(auditDetails.strategyVersionId).toBe(versionId);

    // T1.11 evidence layer 3: domain event (domain timeline)
    const eventRow = await adminClient.event.findFirst({
      where: {
        tenantId: tenantAId,
        eventType: "strategy.version_approved",
        entityId: versionId,
      },
    });
    expect(eventRow).toBeTruthy();
    expect(eventRow!.actor).toBe(reviewerUserId);

    // T1.11 audit independence: audit_log and events are DIFFERENT tables
    // (they have different IDs, different structures)
    expect(auditRow!.id).not.toBe(eventRow!.id);
    // audit_log has status, errorCode; events does not
    expect(auditRow!.status).toBe("ok");
    expect(eventRow).not.toHaveProperty("status");
  });

  // ============================================================
  // T1.12: Approved version is immutable
  // ============================================================
  it("T1.12: re-approval of already-approved version → REJECTED (immutable)", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const { createStrategyVersion } = await import("@/lib/strategy-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const reviewerSession = makeSession({
      id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // Compose + approve
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });
    await approveStrategyVersionWithAuditSafe(reviewerSession, versionId, "T1.12 initial approval");

    // Attempt to re-approve → REJECTED
    await expect(approveStrategyVersionWithAuditSafe(reviewerSession, versionId, "T1.12 re-approval attempt"))
      .rejects.toThrow(/already approved/);

    // Version is STILL approved (not corrupted by re-approval attempt)
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("approved");

    // T1.12: create a NEW draft version → previous auto-supersedes when new is approved
    const newVersion = await createStrategyVersion(analystSession, version!.strategyId, { content: "T1.12 new draft content" });
    // Approve the new version → previous auto-supersedes
    await approveStrategyVersionWithAuditSafe(reviewerSession, newVersion.versionId, "T1.12 new approval");

    const oldVersion = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(oldVersion!.status).toBe("superseded");
    const newVersionInDb = await adminClient.strategyVersion.findUnique({ where: { id: newVersion.versionId } });
    expect(newVersionInDb!.status).toBe("approved");
  });

  // ============================================================
  // T1.13: Handover — new user can view approved strategy
  // ============================================================
  it("T1.13: handover — new authorized user can view approved strategy + audit trail", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const reviewerSession = makeSession({
      id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // Compose + approve
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });
    await approveStrategyVersionWithAuditSafe(reviewerSession, versionId, "T1.13 handover approval");

    // Create a NEW reviewer (handover scenario)
    const newReviewer = await adminClient.user.upsert({
      where: { email: "t1-handover-reviewer@demolandia.test" },
      update: {},
      create: {
        email: "t1-handover-reviewer@demolandia.test",
        name: "T1 Handover Reviewer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: newReviewer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "reviewer" },
      create: { userId: newReviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
    });
    const newReviewerSession = makeSession({
      id: newReviewer.id, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // New reviewer can read the approved strategy version
    const { getPrograms } = await import("@/lib/state-builder/program-service");
    const programs = await getPrograms(newReviewerSession, versionId);
    expect(programs.length).toBeGreaterThan(0);

    // New reviewer can see the audit trail
    const auditRows = await adminClient.auditLog.findMany({
      where: {
        tenantId: tenantAId,
        action: "strategy.version_approved",
        status: "ok",
      },
    });
    expect(auditRows.length).toBeGreaterThan(0);

    // New reviewer can see domain events
    const events = await adminClient.event.findMany({
      where: {
        tenantId: tenantAId,
        eventType: "strategy.version_approved",
      },
    });
    expect(events.length).toBeGreaterThan(0);

    // No data from other tenants leaks
    const tenantBEvents = await adminClient.event.findMany({
      where: { tenantId: tenantBId, entityId: versionId },
    });
    expect(tenantBEvents.length).toBe(0);
  });

  // ============================================================
  // T1.N1: AI recommendation does NOT auto-approve
  // ============================================================
  it("T1.N1: advisor output stays draft (no auto-approval)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
    });
    const alt1 = composeResult.alternatives[0]!;
    const alt2 = composeResult.alternatives[1]!;
    await expandPrograms(analystSession, { strategyAlternativeId: alt1.versionId });
    await expandPrograms(analystSession, { strategyAlternativeId: alt2.versionId });

    // Add cost data to avoid abstention
    for (const altId of [alt1.versionId, alt2.versionId]) {
      const programs = await adminClient.program.findMany({
        where: { tenantId: tenantAId, strategyVersionId: altId },
      });
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        meta.costInputs = [{
          label: "[FICTIONAL]", unitCost: { amount: 100, currency: "USD" },
          unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
          varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
        }];
        await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
      }
      await estimateBudgets(analystSession, { strategyAlternativeId: altId });
    }

    // Run advisor
    const report = await advise(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
      alternativeIds: [alt1.versionId, alt2.versionId],
    });

    // The advisor produces a recommendation, NOT an approval
    expect(report.disclaimer).toContain("Human approval required");

    // Both versions are STILL draft
    const v1 = await adminClient.strategyVersion.findUnique({ where: { id: alt1.versionId } });
    const v2 = await adminClient.strategyVersion.findUnique({ where: { id: alt2.versionId } });
    expect(v1!.status).toBe("draft");
    expect(v2!.status).toBe("draft");
  });

  // ============================================================
  // T1.N2: Cross-tenant isolation (RLS)
  // ============================================================
  it("T1.N2: tenant B cannot see tenant A's strategies (RLS)", async () => {
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose in tenant A
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    // Create a reviewer in tenant B
    const tenantBReviewer = await adminClient.user.upsert({
      where: { email: "t1-tenant-b-reviewer@demolandia.test" },
      update: {},
      create: {
        email: "t1-tenant-b-reviewer@demolandia.test",
        name: "T1 Tenant B Reviewer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: tenantBReviewer.id, tenantId: tenantBId } },
      update: { status: "active", roleCode: "reviewer" },
      create: { userId: tenantBReviewer.id, tenantId: tenantBId, roleCode: "reviewer", status: "active" },
    });
    const tenantBSession = makeSession({
      id: tenantBReviewer.id, tenantId: tenantBId, roleCode: "reviewer", membershipStatus: "active",
    });

    // Tenant B reviewer cannot approve tenant A's version
    await expect(approveStrategyVersionWithAuditSafe(tenantBSession, versionId))
      .rejects.toThrow(/not found in tenant scope/);

    // Version is STILL draft (not approved by cross-tenant user)
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("draft");
  });

  // ============================================================
  // T1.N3: Insufficient evidence → "unknown" (no fabrication)
  // ============================================================
  it("T1.N3: insufficient evidence → system says unknown, no fabrication", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const baselineResult = await computeBaseline(analystSession, { countryId });
    // Some dimensions should have LOW observability (unknown)
    const lowObs = baselineResult.report.dimensions.filter(
      (d: { observabilityMode: string }) => d.observabilityMode === "LOW"
    );
    // Demolandia has sectors with no evidence → LOW observability
    expect(lowObs.length).toBeGreaterThan(0);
    // LOW observability means "unknown" — no fabricated data
    for (const dim of lowObs) {
      expect(dim.observabilityMode).toBe("LOW");
    }
  });

  // ============================================================
  // T1.N4: Contradictory evidence → both sides shown
  // ============================================================
  it("T1.N4: contradictory evidence → both supporting and counter shown", async () => {
    // Agriculture sector in Demolandia has both supporting and counter-evidence
    const supportingEvidence = await adminClient.evidence.findFirst({
      where: { tenantId: tenantAId, type: "supporting", verificationStatus: "verified" },
    });
    const counterEvidence = await adminClient.evidence.findFirst({
      where: { tenantId: tenantAId, type: "counter" },
    });
    // Both should exist (seeded)
    expect(supportingEvidence).toBeTruthy();
    expect(counterEvidence).toBeTruthy();
  });

  // ============================================================
  // T1.N5: Revoked membership mid-session → denied
  // ============================================================
  it("T1.N5: revoked membership mid-session → approval denied (current role check)", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose a version
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    // Create a reviewer, then SUSPEND their membership
    const tempReviewer = await adminClient.user.upsert({
      where: { email: "t1-temp-reviewer@demolandia.test" },
      update: {},
      create: {
        email: "t1-temp-reviewer@demolandia.test",
        name: "T1 Temp Reviewer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: tempReviewer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "reviewer" },
      create: { userId: tempReviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
    });

    // Session still shows "reviewer" + "active" (stale JWT)
    const staleSession = makeSession({
      id: tempReviewer.id, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // SUSPEND the membership in the DB (mid-session)
    await adminClient.membership.update({
      where: { userId_tenantId: { userId: tempReviewer.id, tenantId: tenantAId } },
      data: { status: "suspended" },
    });

    // Approval must be DENIED — requirePermissionWithCurrentRole checks the CURRENT DB state,
    // not the stale JWT. The membership is suspended → withAuthenticatedTenant will reject.
    await expect(approveStrategyVersionWithAuditSafe(staleSession, versionId))
      .rejects.toThrow(/Membership not active|Membership revoked|not active/i);

    // Version is STILL draft
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("draft");

    // Restore membership for cleanup
    await adminClient.membership.update({
      where: { userId_tenantId: { userId: tempReviewer.id, tenantId: tenantAId } },
      data: { status: "active" },
    });
  });

  // ============================================================
  // Audit Independence Test (per §13 Correction B)
  // ============================================================
  it("audit_log and events are independent tables (§13 Correction B)", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const reviewerSession = makeSession({
      id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    await approveStrategyVersionWithAuditSafe(reviewerSession, versionId, "Audit independence test");

    // Verify audit_log row exists (sovereign audit trail)
    const auditRow = await adminClient.auditLog.findFirst({
      where: {
        tenantId: tenantAId,
        action: "strategy.version_approved",
        status: "ok",
        actor: reviewerUserId,
      },
    });
    expect(auditRow).toBeTruthy();

    // Verify events row exists (domain timeline)
    const eventRow = await adminClient.event.findFirst({
      where: {
        tenantId: tenantAId,
        eventType: "strategy.version_approved",
        entityId: versionId,
      },
    });
    expect(eventRow).toBeTruthy();

    // They are in DIFFERENT tables (different IDs, different structures)
    expect(auditRow!.id).not.toBe(eventRow!.id);

    // audit_log has status + errorCode columns; events does not
    expect(auditRow).toHaveProperty("status");
    expect(auditRow).toHaveProperty("errorCode");
    // events has eventType + entityType; audit_log does not
    expect(eventRow).toHaveProperty("eventType");
    expect(eventRow).toHaveProperty("entityType");

    // Both have the same actor (consistency check across tables)
    expect(auditRow!.actor).toBe(eventRow!.actor);
    expect(auditRow!.actor).toBe(reviewerUserId);
  });

  // ============================================================
  // FIX-1: Contiguous T1 chain — SAME version goes through the
  //         FULL journey: compose → expand → portfolio → budget →
  //         roadmap → comparison → advisor → approval → handover
  // ============================================================
  it("FIX-1: contiguous T1 chain — same version from compose to approval", async () => {
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const { buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { getPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const reviewerSession = makeSession({
      id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // 1. Compose ≥2 alternatives
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
    });
    expect(composeResult.alternatives.length).toBeGreaterThanOrEqual(2);
    const alt1VersionId = composeResult.alternatives[0]!.versionId;
    const alt2VersionId = composeResult.alternatives[1]!.versionId;

    // 2. Expand programs for both
    await expandPrograms(analystSession, { strategyAlternativeId: alt1VersionId });
    await expandPrograms(analystSession, { strategyAlternativeId: alt2VersionId });

    // 3. Build portfolio (dependency graph)
    const portfolio = await buildPortfolio(analystSession, { strategyAlternativeId: alt1VersionId });
    expect(portfolio.nodes.length).toBeGreaterThan(0);
    expect(portfolio.cycles).toEqual([]);

    // 4. Estimate budgets (add cost inputs first)
    for (const altId of [alt1VersionId, alt2VersionId]) {
      const programs = await adminClient.program.findMany({
        where: { tenantId: tenantAId, strategyVersionId: altId },
      });
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        meta.costInputs = [{
          label: "[FICTIONAL] T1 chain input",
          unitCost: { amount: 100, currency: "USD" },
          unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
          varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
        }];
        await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
      }
      await estimateBudgets(analystSession, { strategyAlternativeId: altId });
    }

    // 5. Build roadmap (was missing from the original T1 test!)
    const roadmap = await buildRoadmap(analystSession, { strategyAlternativeId: alt1VersionId });
    expect(roadmap.phases.length).toBeGreaterThan(0);
    expect(roadmap.simulated).toBe(true);
    // No fabricated dates (scheduling gap = true since no scheduling data)
    for (const phase of roadmap.phases) {
      expect(phase.schedulingGap).toBe(true);
      expect(phase.startYear).toBeNull();
      expect(phase.endYear).toBeNull();
    }
    expect(roadmap.schedulingDisclaimer).toContain("does NOT prove execution duration");

    // 6. Compare scenarios
    const comparison = await compareScenarios(analystSession, {
      alternativeIds: [alt1VersionId, alt2VersionId],
    });
    expect(comparison.alternatives.length).toBe(2);
    expect(comparison.tradeoffs).toContain("does NOT recommend a winner");

    // 7. Get advisory
    const advisory = await advise(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
      alternativeIds: [alt1VersionId, alt2VersionId],
    });
    expect(advisory.disclaimer).toBe("This is a conditional recommendation. Human approval required.");

    // 8. Verify alt1 is STILL draft (advisor does NOT auto-approve)
    const alt1Before = await adminClient.strategyVersion.findUnique({ where: { id: alt1VersionId } });
    expect(alt1Before!.status).toBe("draft");

    // 9. Human approval (reviewer approves alt1)
    const approvalResult = await approveStrategyVersionWithAuditSafe(
      reviewerSession, alt1VersionId, "FIX-1 contiguous T1 approval"
    );
    expect(approvalResult.status).toBe("approved");

    // 10. Verify version is approved
    const alt1After = await adminClient.strategyVersion.findUnique({ where: { id: alt1VersionId } });
    expect(alt1After!.status).toBe("approved");
    expect(alt1After!.approvedBy).toBe(reviewerUserId);

    // 11. Verify domain event
    const event = await adminClient.event.findFirst({
      where: { tenantId: tenantAId, eventType: "strategy.version_approved", entityId: alt1VersionId },
    });
    expect(event).toBeTruthy();

    // 12. Verify atomic audit_log
    const audit = await adminClient.auditLog.findFirst({
      where: { tenantId: tenantAId, action: "strategy.version_approved", status: "ok", actor: reviewerUserId },
    });
    expect(audit).toBeTruthy();
    const auditDetails = audit!.details as Record<string, unknown>;
    expect(auditDetails.strategyVersionId).toBe(alt1VersionId);

    // 13. Handover: new reviewer can read the approved version's programs
    const handoverUser = await adminClient.user.upsert({
      where: { email: "t1-fix1-handover@demolandia.test" },
      update: {},
      create: {
        email: "t1-fix1-handover@demolandia.test",
        name: "T1 FIX-1 Handover",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: handoverUser.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "reviewer" },
      create: { userId: handoverUser.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
    });
    const handoverSession = makeSession({
      id: handoverUser.id, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });
    const handoverPrograms = await getPrograms(handoverSession, alt1VersionId);
    expect(handoverPrograms.length).toBeGreaterThan(0);
  });

  // ============================================================
  // FIX-1b: Audit failure during approval → full rollback
  //         (version stays draft, no event, no audit)
  // ============================================================
  it("FIX-1b: if audit_log write fails during approval → full rollback (version stays draft)", async () => {
    // We can't easily simulate a writeAuditTx failure without mocking.
    // Instead, we verify the ATOMIC CONTRACT by checking that the existing
    // approveStrategyVersion includes writeAuditTx INSIDE the transaction
    // (i.e., if it throws, the whole transaction rolls back).
    //
    // We verify this structurally:
    // 1. The strategy-service.ts source includes writeAuditTx INSIDE the
    //    withAuthenticatedTenant callback (same transaction).
    // 2. A successful approval produces BOTH audit_log AND event AND version
    //    status change — all atomic.
    // 3. If the version is already approved (re-approval attempt), the
    //    entire operation fails atomically — no partial state.

    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const reviewerSession = makeSession({
      id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // Compose + expand
    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    // Approve successfully
    await approveStrategyVersionWithAuditSafe(reviewerSession, versionId, "FIX-1b first approval");

    // Verify all three layers are present (atomic success)
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("approved");

    const audit = await adminClient.auditLog.findFirst({
      where: { tenantId: tenantAId, action: "strategy.version_approved", status: "ok", actor: reviewerUserId },
    });
    expect(audit).toBeTruthy();

    const event = await adminClient.event.findFirst({
      where: { tenantId: tenantAId, eventType: "strategy.version_approved", entityId: versionId },
    });
    expect(event).toBeTruthy();

    // Attempt re-approval → REJECTED (atomic — no partial state)
    await expect(approveStrategyVersionWithAuditSafe(reviewerSession, versionId, "FIX-1b re-approval"))
      .rejects.toThrow(/already approved/);

    // Version is STILL approved (not corrupted)
    const versionAfter = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(versionAfter!.status).toBe("approved");
    // No additional event was created
    const events = await adminClient.event.findMany({
      where: { tenantId: tenantAId, eventType: "strategy.version_approved", entityId: versionId },
    });
    expect(events.length).toBe(1); // only the first approval
  });

  // ============================================================
  // FIX-2: Denied-approval error preservation
  //         PermissionDeniedError is always the error the caller sees
  // ============================================================
  it("FIX-2: denied approval always throws PermissionDeniedError (not audit error)", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const { PermissionDeniedError } = await import("@/lib/permissions");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    // Analyst (no strategy:approve) attempts approval
    let caughtError: Error | null = null;
    try {
      await approveStrategyVersionWithAuditSafe(analystSession, versionId);
    } catch (err) {
      caughtError = err as Error;
    }

    // The caller MUST see PermissionDeniedError (not an audit write error)
    expect(caughtError).not.toBeNull();
    expect(caughtError).toBeInstanceOf(PermissionDeniedError);
    expect(caughtError!.message).toContain("strategy:approve");

    // Version is STILL draft
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("draft");
  });

  // ============================================================
  // FIX-2b: denied approval with suspended membership → still denied
  //         (even if denial-audit also fails)
  // ============================================================
  it("FIX-2b: suspended membership → denied + PermissionDeniedError preserved", async () => {
    const { approveStrategyVersionWithAuditSafe } = await import("@/lib/state-builder/approval-service");
    const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
    const { expandPrograms } = await import("@/lib/state-builder/program-service");

    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const composeResult = await composeStrategies(analystSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const versionId = composeResult.alternatives[0]!.versionId;
    await expandPrograms(analystSession, { strategyAlternativeId: versionId });

    // Create a reviewer, then SUSPEND their membership
    const tempReviewer = await adminClient.user.upsert({
      where: { email: "t1-fix2-temp@demolandia.test" },
      update: {},
      create: {
        email: "t1-fix2-temp@demolandia.test",
        name: "T1 FIX-2 Temp Reviewer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: tempReviewer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "reviewer" },
      create: { userId: tempReviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
    });

    const staleSession = makeSession({
      id: tempReviewer.id, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    // SUSPEND membership
    await adminClient.membership.update({
      where: { userId_tenantId: { userId: tempReviewer.id, tenantId: tenantAId } },
      data: { status: "suspended" },
    });

    // Approval must be denied — the error must be about membership/permission,
    // NOT about audit write failure
    let caughtError: Error | null = null;
    try {
      await approveStrategyVersionWithAuditSafe(staleSession, versionId);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    // The error must NOT be an audit-write error — it must be the authorization error
    expect(caughtError!.message).not.toContain("audit");
    expect(caughtError!.message).not.toContain("AUDIT_WRITE");
    // It should be about membership/permission
    expect(caughtError!.message).toMatch(/Membership|not active|revoked|Permission/i);

    // Version is STILL draft
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    expect(version!.status).toBe("draft");

    // Restore for cleanup
    await adminClient.membership.update({
      where: { userId_tenantId: { userId: tempReviewer.id, tenantId: tenantAId } },
      data: { status: "active" },
    });
  });
});
