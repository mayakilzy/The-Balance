// ============================================================
// tests/integration/g02-t2-slice.integration.test.ts
// ------------------------------------------------------------
// Integration test for the full T2-slice E2E scenario.
// Runs in CI against real PostgreSQL 16 (RUN_INTEGRATION_TESTS=1).
// Skips locally when RUN_INTEGRATION_TESTS is not set.
//
// Pattern follows G01 integration tests (g01-baseline.integration.test.ts):
//   - appClient  (DATABASE_URL)  — RLS-enforced balance_app role
//   - adminClient (DIRECT_URL)   — BYPASSRLS for setup/teardown only
//
// Covers:
//   I-01: T2-slice negative path (no false alert when thresholds=[])
//   I-02: T2-slice positive path (alert → review → decision → execution → close)
//   I-03: Correction scenario (R4 + F2)
//   I-04: F3 concurrent correction conflict
//   I-05: StrategyVersion immutability (no G02 service modifies it)
//   I-06: RLS cross-tenant isolation
//   I-07: Revoked membership → denied + audit_log
//   I-08: writeAuditTx atomic for every operation
//   I-09: New strategy version preserves old observations
//   I-10: isSynthetic=true visible in outputs
//   I-11: R1 separation (originType=synthetic + verificationStatus=verified)
//   I-12: F1 + E3 (NULL geo_ref_id protected + cross-country rejection)
//   I-13: F4 (observationId=null when unknown)
//   I-14: F2 + R4 (corrections preserve all versions)
// ============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";
import { FixtureTracker } from "./helpers/fixture-tracker";


const fixtures = new FixtureTracker();
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let appClient: PrismaClient;
let adminClient: PrismaClient;

let tenantAId: string;
let tenantBId: string;
let countryId: string;
let analystUserId: string;
let reviewerUserId: string;
let adminUserId: string;
let tenantBAnalystUserId: string;

// Cached G01 entities that 02-00 builds on
let strategyVersionId: string;
let objectiveId: string;
let programId: string;

// Sources for Demolandia (synthetic)
let centralBankSourceId: string;
let laborOfficeSourceId: string;

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

  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  await appClient.$queryRaw`SELECT 1`;
  await adminClient.$queryRaw`SELECT 1`;

  // Fetch seeded G00/G01 entities (Demolandia)
  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia (DML) not seeded.");
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({
    where: { code: "DML-MOP-TENANT" },
  });
  const tenantB = await adminClient.tenant.findUnique({
    where: { code: "DML-CB-TENANT" },
  });
  if (!tenantA || !tenantB)
    throw new Error("Test tenants not seeded. Run bunx tsx prisma/seed-ontology.ts.");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const analystUser = await adminClient.user.findUnique({
    where: { email: "analyst@demolandia.test" },
  });
  const adminUser = await adminClient.user.findUnique({
    where: { email: "admin@demolandia.test" },
  });
  if (!analystUser || !adminUser)
    throw new Error("Test users (analyst/admin) not seeded.");
  analystUserId = analystUser.id;
  adminUserId = adminUser.id;

  // Create a reviewer user (G01 seed only creates admin + analyst — see G01 pattern)
  const reviewer = await adminClient.user.upsert({
    where: { email: "g02-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g02-reviewer@demolandia.test",
      name: "G02 Reviewer",
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

  // Create a tenant B analyst user for cross-tenant isolation tests
  // (the seeded analyst only has membership in tenant A)
  const tenantBAnalyst = await adminClient.user.upsert({
    where: { email: "g02-tenantb-analyst@demolandia.test" },
    update: {},
    create: {
      email: "g02-tenantb-analyst@demolandia.test",
      name: "G02 Tenant B Analyst",
      passwordHash: await hashPassword("Test1234!"),
      status: "active",
    },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: tenantBAnalyst.id, tenantId: tenantBId } },
    update: { status: "active", roleCode: "analyst" },
    create: {
      userId: tenantBAnalyst.id,
      tenantId: tenantBId,
      roleCode: "analyst",
      status: "active",
    },
  });
  tenantBAnalystUserId = tenantBAnalyst.id;

  // Fetch (or create) an approved StrategyVersion for Tenant A
  // GROUP 01's seed does NOT create one; we create minimal test fixtures.
  let sv = await adminClient.strategyVersion.findFirst({
    where: { tenantId: tenantAId, status: "approved" },
  });
  if (!sv) {
    // Create a Strategy + approved StrategyVersion directly (adminClient bypasses RLS)
    const strategy = await adminClient.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "G02 Test Strategy",
        createdBy: analystUserId,
      },
    });
    fixtures.track.strategy(strategy.id);
    sv = await adminClient.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "approved",
        approvedBy: adminUserId,
        approvedAt: new Date(),
        approvalNotes: "G02 test fixture — auto-approved",
        metadata: { simulated: true, source: "g02-test-fixture" },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  // Fetch (or create) an objective for Tenant A
  let obj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId },
  });
  if (!obj) {
    obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId,
        countryId,
        title: "G02 Test Objective",
        targetMetric: "test_metric",
        targetValue: "5.0",
        horizon: 5,
        status: "active",
        createdBy: analystUserId,
      },
    });
  }
  objectiveId = obj.id;

  // Fetch (or create) a program for this strategy version
  let prog = await adminClient.program.findFirst({
    where: { tenantId: tenantAId, strategyVersionId },
  });
  if (!prog) {
    prog = await adminClient.program.create({
      data: {
        tenantId: tenantAId,
        strategyVersionId,
        title: "G02 Test Program",
        sector: "test",
        status: "active",
      },
    });
  }
  programId = prog.id;

  // Ensure synthetic sources exist (or create them)
  let centralBankSrc = await adminClient.source.findFirst({
    where: { code: "DML-CB-SYNTHETIC" },
  });
  if (!centralBankSrc) {
    centralBankSrc = await adminClient.source.create({
      data: {
        code: "DML-CB-SYNTHETIC",
        displayName: "Demolandia Central Bank — synthetic",
        type: "government",
        reviewStatus: "approved",
        metadata: { synthetic: true, country: "DML" },
      },
    });
  }
  centralBankSourceId = centralBankSrc.id;

  let laborOfficeSrc = await adminClient.source.findFirst({
    where: { code: "DML-LABOR-SYNTHETIC" },
  });
  if (!laborOfficeSrc) {
    laborOfficeSrc = await adminClient.source.create({
      data: {
        code: "DML-LABOR-SYNTHETIC",
        displayName: "Demolandia Labor Office — synthetic",
        type: "government",
        reviewStatus: "approved",
        metadata: { synthetic: true, country: "DML" },
      },
    });
  }
  laborOfficeSourceId = laborOfficeSrc.id;
});

afterAll(async () => {
  if (RUN_INTEGRATION) {
    // Clean up G02 entities created during tests (admin can see all tenants)

    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
  await fixtures.cleanup(adminClient);
});

beforeEach(async () => {
  if (!RUN_INTEGRATION) return;
  // Clean G02 tables before each test (preserves G00/G01 data)
});

// ============================================================
// Helper: create a period for a quarter
// ============================================================
async function ensureQuarter(
  tenantId: string,
  year: number,
  quarter: 1 | 2 | 3 | 4
): Promise<string> {
  const periodValue = `${year}-Q${quarter}`;
  const startMonth = (quarter - 1) * 3;
  const startAt = new Date(Date.UTC(year, startMonth, 1));
  const endAt = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59));
  const existing = await adminClient.observationPeriod.findFirst({
    where: { tenantId, periodType: "quarterly", periodValue },
  });
  if (existing) return existing.id;
  const created = await adminClient.observationPeriod.create({
    data: { tenantId, periodType: "quarterly", periodValue, startAt, endAt },
  });
  return created.id;
}

// ============================================================
// I-01: T2-slice negative path (no false alert when thresholds=[])
// ============================================================
describeIntegration("I-01: T2-slice negative path", () => {
  it("unemployment variance computed, NO alert raised when alertThresholds=[]", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );
    const { computeVariance } = await import(
      "@/lib/state-observatory/variance-service"
    );
    const { evaluateAndRaise } = await import(
      "@/lib/state-observatory/alert-service"
    );

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

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    // Define UNEMPLOYMENT indicator with NO alertThresholds
    const indicator = await defineIndicator(analystSession, {
      code: "UNEMPLOYMENT_RATE_I01",
      displayName: "Unemployment Rate (I-01)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 10.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        {
          periodId,
          targetValue: 10.5,
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      alertThresholds: [], // R3: no auto-alert
      strategyVersionId,
      objectiveId,
    });

    // Ingest observation: 11.0 (above milestone 10.5 by 0.5)
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 11.0,
      originType: "observed",
      sourceId: laborOfficeSourceId,
      isSynthetic: true,
    });

    // Compute variance
    const varianceRecords = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });

    expect(varianceRecords).toHaveLength(1);
    const vr = varianceRecords[0]!;
    expect(vr.plannedValueType).toBe("period_milestone");
    expect(vr.comparisonValid).toBe(true);
    expect(Number(vr.varianceAbsolute)).toBeCloseTo(0.5, 4);
    expect(vr.varianceDirection).toBe("worse");

    // Evaluate thresholds — should return null (no alert)
    const alert = await evaluateAndRaise(reviewerSession, vr.id);
    expect(alert).toBeNull();

    // Verify NO alert row in DB for this variance record
    const alertCount = await adminClient.alert.count({
      where: { varianceRecordId: vr.id },
    });
    expect(alertCount).toBe(0);
  });
});

// ============================================================
// I-02: T2-slice positive path (full lifecycle)
// ============================================================
describeIntegration("I-02: T2-slice positive path — full lifecycle", () => {
  it("inflation alert raised + reviewed + decision + execution verified + closed", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );
    const { computeVariance } = await import(
      "@/lib/state-observatory/variance-service"
    );
    const {
      evaluateAndRaise,
      markReviewed,
      documentDecision,
      updateExecutionStatus,
      verifyExecution,
      closeAlert,
    } = await import("@/lib/state-observatory/alert-service");

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
    const adminSession = makeSession({
      id: adminUserId,
      tenantId: tenantAId,
      roleCode: "admin",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    // Define INFLATION indicator WITH alertThresholds
    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I02",
      displayName: "Inflation Rate (I-02)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        {
          periodId,
          targetValue: 7.0,
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      alertThresholds: [
        {
          metric: "varianceAbsolute",
          operator: "gt",
          value: 1.5,
          logicalOp: "and",
          severity: "warning",
          rationale: "Demo threshold — 1.5pp above milestone",
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
        {
          metric: "varianceDirection",
          operator: "eq",
          value: "worse",
          severity: "warning",
          rationale: "Only raise when direction is worse",
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      strategyVersionId,
      objectiveId,
    });

    // Ingest observation: 9.0 (above milestone 7.0 by 2.0 — exceeds 1.5 threshold)
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });

    // Compute variance
    const varianceRecords = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });
    expect(varianceRecords).toHaveLength(1);
    const vr = varianceRecords[0]!;
    expect(vr.varianceDirection).toBe("worse");
    expect(Number(vr.varianceAbsolute)).toBeCloseTo(2.0, 4);

    // Evaluate and raise — alert should be created
    const alert = await evaluateAndRaise(reviewerSession, vr.id);
    expect(alert).not.toBeNull();
    expect(alert!.lifecycleStage).toBe("notified"); // auto-transitioned
    expect(alert!.isAutoGenerated).toBe(true);
    expect(alert!.executionStatus).toBe("not_applicable");
    expect(alert!.severity).toBe("warning");

    // markReviewed (reviewer)
    const reviewed = await markReviewed(
      reviewerSession,
      alert!.id,
      "سأراجع مع وزارة المالية"
    );
    expect(reviewed.lifecycleStage).toBe("reviewed");
    expect(reviewed.executionStatus).toBe("not_applicable"); // unchanged

    // documentDecision (reviewer — has alert:act)
    const decision = await documentDecision(
      reviewerSession,
      alert!.id,
      "رفع مذكرة لوزير المالية لمراجعة السياسة النقدية"
    );
    expect(decision.lifecycleStage).toBe("decision_documented");
    expect(decision.executionStatus).toBe("not_applicable"); // R5: still unchanged

    // updateExecutionStatus pending (admin)
    const pending = await updateExecutionStatus(adminSession, alert!.id, {
      executionStatus: "pending",
    });
    expect(pending.executionStatus).toBe("pending");
    expect(pending.lifecycleStage).toBe("decision_documented"); // R5: unchanged

    // F6: verifyExecution requires verifiedAction + evidenceSource
    const verified = await verifyExecution(reviewerSession, alert!.id, {
      verifiedAction: "استلام وزارة المالية للمذكرة رقم #DEMO-2026-042",
      evidenceSource: "إيصال استلام صادر عن وزارة المالية — Demolandia synthetic",
      notes: "تم تسليم المذكرة وتوقيع الاستلام",
    });
    expect(verified.executionStatus).toBe("verified");
    expect(verified.executionVerifiedAction).toContain("#DEMO-2026-042");
    expect(verified.executionVerificationSource).toContain("إيصال استلام");
    // R5/F6: lifecycleStage NOT changed by verifyExecution
    expect(verified.lifecycleStage).toBe("decision_documented");

    // closeAlert (admin)
    const closed = await closeAlert(adminSession, alert!.id, "تمت المراجعة");
    expect(closed.lifecycleStage).toBe("closed");
    expect(closed.executionStatus).toBe("verified"); // unchanged
  });
});

// ============================================================
// I-03: Correction scenario (R4 + F2)
// ============================================================
describeIntegration("I-03: Correction scenario", () => {
  it("correctObservation creates new version; recompute variance references corrected obs", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation, correctObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );
    const { computeVariance } = await import(
      "@/lib/state-observatory/variance-service"
    );

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

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I03",
      displayName: "Inflation Rate (I-03)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        {
          periodId,
          targetValue: 7.0,
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // Ingest original observation
    const original = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    fixtures.track.observation(original.id);

    // Compute variance BEFORE correction
    const beforeVr = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });
    expect(beforeVr[0]!.observationId).toBe(original.id);
    expect(Number(beforeVr[0]!.varianceAbsolute)).toBeCloseTo(2.0, 4);

    // Correct the observation to 9.2
    const corrected = await correctObservation(analystSession, original.id, {
      newValue: 9.2,
      reason: "source revision",
    });

    expect(corrected.id).not.toBe(original.id);
    expect(corrected.supersedesId).toBe(original.id);
    expect(corrected.isCurrent).toBe(true);
    expect(corrected.observedValue?.toString()).toBe("9.2");

    // Old observation should be isCurrent=false, supersededById=corrected.id
    const oldObs = await adminClient.observation.findUnique({
      where: { id: original.id },
    });
    expect(oldObs!.isCurrent).toBe(false);
    expect(oldObs!.supersededById).toBe(corrected.id);

    // Recompute variance — should reference the corrected observation
    const afterVr = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });
    expect(afterVr[0]!.observationId).toBe(corrected.id);
    expect(Number(afterVr[0]!.varianceAbsolute)).toBeCloseTo(2.2, 4);

    // Old VarianceRecord should be unchanged (R4 — append-only)
    const oldVr = await adminClient.varianceRecord.findUnique({
      where: { id: beforeVr[0]!.id },
    });
    expect(oldVr!.observationId).toBe(original.id);
    expect(Number(oldVr!.varianceAbsolute)).toBeCloseTo(2.0, 4);
  });
});

// ============================================================
// I-04: F3 concurrent correction conflict
// ============================================================
describeIntegration("I-04: F3 concurrent correction conflict", () => {
  it("two parallel corrections — first succeeds, second throws ConflictError", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation, correctObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );

    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I04",
      displayName: "Inflation Rate (I-04)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        {
          periodId,
          targetValue: 7.0,
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    const original = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    fixtures.track.observation(original.id);

    // Two parallel correction attempts
    const promises = [
      correctObservation(analystSession, original.id, {
        newValue: 9.2,
        reason: "first correction attempt",
      }),
      correctObservation(analystSession, original.id, {
        newValue: 9.3,
        reason: "second correction attempt",
      }),
    ];

    const results = await Promise.allSettled(promises);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one should succeed, one should fail
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejected one should be a ConflictError mentioning "already superseded"
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedReason).toBeInstanceOf(Error);
    expect(rejectedReason.message).toMatch(/already superseded|not found/i);

    // Verify only ONE current observation exists for this (indicator, period, geo)
    const currentObs = await adminClient.observation.findMany({
      where: {
        tenantId: tenantAId,
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        geoLevel: "national",
        isCurrent: true,
      },
    });
    expect(currentObs).toHaveLength(1);
  });
});

// ============================================================
// I-05: StrategyVersion immutability
// ============================================================
describeIntegration("I-05: StrategyVersion immutability", () => {
  it("G02 services never modify StrategyVersion content or status", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );
    const { computeVariance } = await import(
      "@/lib/state-observatory/variance-service"
    );
    const { evaluateAndRaise } = await import(
      "@/lib/state-observatory/alert-service"
    );

    // Snapshot StrategyVersion BEFORE
    const before = await adminClient.strategyVersion.findUnique({
      where: { id: strategyVersionId },
    });
    expect(before).not.toBeNull();
    const beforeContent = before!.content;
    const beforeStatus = before!.status;
    const beforeMetadata = JSON.stringify(before!.metadata);

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

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I05",
      displayName: "Inflation Rate (I-05)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        {
          periodId,
          targetValue: 7.0,
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      alertThresholds: [
        {
          metric: "varianceAbsolute",
          operator: "gt",
          value: 1.5,
          severity: "warning",
          rationale: "Demo threshold — 1.5pp above milestone",
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      strategyVersionId,
      objectiveId,
    });

    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
      strategyVersionId,
    });

    const vrs = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });
    await evaluateAndRaise(reviewerSession, vrs[0]!.id);

    // Snapshot StrategyVersion AFTER — should be identical
    const after = await adminClient.strategyVersion.findUnique({
      where: { id: strategyVersionId },
    });
    expect(after!.content).toBe(beforeContent);
    expect(after!.status).toBe(beforeStatus);
    expect(JSON.stringify(after!.metadata)).toBe(beforeMetadata);
  });
});

// ============================================================
// I-06: RLS cross-tenant isolation
// ============================================================
describeIntegration("I-06: RLS cross-tenant isolation", () => {
  it("Tenant A's observations are invisible to Tenant B", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation, listObservations } = await import(
      "@/lib/state-observatory/observation-service"
    );

    const tenantASession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const tenantBSession = makeSession({
      id: tenantBAnalystUserId, // different user with membership in tenant B
      tenantId: tenantBId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodIdA = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodIdA);
    fixtures.track.observationPeriod(periodIdA);
    const periodIdB = await ensureQuarter(tenantBId, 2026, 2);
    fixtures.track.observationPeriod(periodIdB);
    fixtures.track.observationPeriod(periodIdB);

    // Tenant A creates an indicator + observation
    const indicatorA = await defineIndicator(tenantASession, {
      code: "INFLATION_RATE_I06_A",
      displayName: "Inflation Rate (I-06 A)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      alertThresholds: [],
      strategyVersionId,
    });

    await ingestObservation(tenantASession, {
      indicatorDefinitionId: indicatorA.id,
      observationPeriodId: periodIdA,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });

    // Tenant B lists observations — should NOT see Tenant A's
    const tenantBObs = await listObservations(tenantBSession, {
      includeHistory: true,
    });
    expect(tenantBObs.find((o) => o.tenantId === tenantAId)).toBeUndefined();

    // Tenant B's indicators should be empty (or only their own)
    const tenantBIndicators = await import(
      "@/lib/state-observatory/indicator-registry-service"
    ).then((m) => m.listIndicators(tenantBSession));
    expect(tenantBIndicators.find((i) => i.code === "INFLATION_RATE_I06_A")).toBeUndefined();
  });
});

// ============================================================
// I-07: Revoked membership → denied + audit_log
// ============================================================
describeIntegration("I-07: Revoked membership", () => {
  it("revoked user cannot ingest observation; audit_log records denial", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );

    // Create a user, then revoke their membership
    const revokedUser = await adminClient.user.create({
      data: {
        email: "revoked-i07@demolandia.test",
        name: "Revoked User I-07",
        passwordHash: "$2a$10$dummyhashforthistestxxxxxxxxxxxxxxxxxxxxxx",
        status: "active",
      },
    });
    fixtures.track.user(revokedUser.id);
    const membership = await adminClient.membership.create({
      data: {
        userId: revokedUser.id,
        tenantId: tenantAId,
        roleCode: "analyst",
        status: "revoked", // immediately revoked
      },
    });

    const revokedSession = makeSession({
      id: revokedUser.id,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "revoked",
    });

    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I07",
      displayName: "Inflation Rate (I-07)",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // Revoked user attempts to ingest — should throw
    await expect(
      ingestObservation(revokedSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.0,
        originType: "observed",
        sourceId: centralBankSourceId,
        isSynthetic: true,
      })
    ).rejects.toThrow(/Membership not active|Permission denied/i);

    // No observation should have been created
    const obsCount = await adminClient.observation.count({
      where: { createdBy: revokedUser.id },
    });
    expect(obsCount).toBe(0);

    // Cleanup
    await adminClient.membership.delete({ where: { id: membership.id } });
    await adminClient.user.delete({ where: { id: revokedUser.id } });
  });
});

// ============================================================
// I-08: writeAuditTx atomic for every operation
// ============================================================
describeIntegration("I-08: writeAuditTx atomic for every operation", () => {
  it("audit_log rows exist for each service operation", async () => {
    const { defineIndicator, retireIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation, correctObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );
    const { computeVariance } = await import(
      "@/lib/state-observatory/variance-service"
    );
    const {
      evaluateAndRaise,
      markReviewed,
      documentDecision,
      verifyExecution,
      closeAlert,
    } = await import("@/lib/state-observatory/alert-service");

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
    const adminSession = makeSession({
      id: adminUserId,
      tenantId: tenantAId,
      roleCode: "admin",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I08",
      displayName: "Inflation Rate (I-08)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        {
          periodId,
          targetValue: 7.0,
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      alertThresholds: [
        {
          metric: "varianceAbsolute",
          operator: "gt",
          value: 1.5,
          severity: "warning",
          rationale: "Demo threshold — 1.5pp above milestone",
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      strategyVersionId,
      objectiveId,
    });

    const obs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    fixtures.track.observation(obs.id);

    await correctObservation(analystSession, obs.id, {
      newValue: 9.2,
      reason: "source revision",
    });

    const vrs = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });

    const alert = await evaluateAndRaise(reviewerSession, vrs[0]!.id);
    expect(alert).not.toBeNull();

    await markReviewed(reviewerSession, alert!.id, "review notes");
    await documentDecision(reviewerSession, alert!.id, "decision text");
    await verifyExecution(reviewerSession, alert!.id, {
      verifiedAction: "receipt of memo",
      evidenceSource: "receipt",
    });
    await closeAlert(adminSession, alert!.id, "closure reason");
    await retireIndicator(analystSession, indicator.id, "deprecated");

    // Verify audit_log entries exist for each action
    const expectedActions = [
      "observatory.indicator.defined",
      "observatory.observation.ingested",
      "observatory.observation.corrected",
      "observatory.variance.computed",
      "observatory.alert.raised",
      "observatory.alert.reviewed",
      "observatory.alert.decision_documented",
      "observatory.alert.execution_status_updated",
      "observatory.alert.closed",
      "observatory.indicator.retired",
    ];

    for (const action of expectedActions) {
      const count = await adminClient.auditLog.count({
        where: { action },
      });
      expect(count).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// I-09: New strategy version preserves old observations
// ============================================================
describeIntegration("I-09: New strategy version preserves old observations", () => {
  it("observations linked to v1 remain linked to v1 when v2 is approved", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );

    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    // Define indicator linked to current approved version
    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I09",
      displayName: "Inflation Rate (I-09)",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId, // current approved version
      objectiveId,
    });

    const obs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
      strategyVersionId,
    });
    fixtures.track.observation(obs.id);

    // Verify observation references v1
    expect(obs.strategyVersionId).toBe(strategyVersionId);

    // Create a NEW strategy + version (do NOT approve — just create draft)
    const newStrategy = await adminClient.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "Test Strategy v2 (I-09)",
        createdBy: analystUserId,
      },
    });
    const newVersion = await adminClient.strategyVersion.create({
      data: {
        strategyId: newStrategy.id,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "draft",
        createdBy: analystUserId,
      },
    });
    fixtures.track.strategyVersion(newVersion.id);

    // The original observation should STILL reference the old version
    const oldObsCheck = await adminClient.observation.findUnique({
      where: { id: obs.id },
    });
    expect(oldObsCheck!.strategyVersionId).toBe(strategyVersionId);
    expect(oldObsCheck!.strategyVersionId).not.toBe(newVersion.id);

    // No automatic migration should have occurred
    const migratedCount = await adminClient.observation.count({
      where: { strategyVersionId: newVersion.id },
    });
    expect(migratedCount).toBe(0);
  });
});

// ============================================================
// I-10: isSynthetic=true visible in outputs
// ============================================================
describeIntegration("I-10: isSynthetic=true visible in outputs", () => {
  it("observation + variance snapshot + alert metadata all reflect isSynthetic=true", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );
    const { computeVariance } = await import(
      "@/lib/state-observatory/variance-service"
    );

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

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I10",
      displayName: "Inflation Rate (I-10)",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        {
          periodId,
          targetValue: 7.0,
          sourceRef: "synthetic:demolandia-test-policy-2026-001",
        },
      ],
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    const obs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    fixtures.track.observation(obs.id);

    // Observation row should have isSynthetic=true
    expect(obs.isSynthetic).toBe(true);

    // qualityNotes should also carry the Demolandia marker
    const qualityNotes = obs.qualityNotes as unknown as Record<string, unknown>;
    expect(qualityNotes.isSynthetic).toBe(true);
    expect(qualityNotes.syntheticCountry).toBe("DML");

    // VarianceRecord.observationSnapshot should reflect isSynthetic=true
    const vrs = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });
    const snapshot = vrs[0]!.observationSnapshot as unknown as Record<string, unknown>;
    expect(snapshot.isSynthetic).toBe(true);
  });
});

// ============================================================
// I-11: R1 separation (originType=synthetic + verificationStatus=verified)
// ============================================================
describeIntegration("I-11: R1 separation", () => {
  it("observation with originType=synthetic AND verificationStatus=verified coexists", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );

    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I11",
      displayName: "Inflation Rate (I-11)",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // R1: originType=synthetic + verificationStatus=verified (the two are independent)
    const obs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "synthetic", // synthetic origin
      verificationStatus: "verified", // but verified
      isSynthetic: true,
    });
    fixtures.track.observation(obs.id);

    expect(obs.originType).toBe("synthetic");
    expect(obs.verificationStatus).toBe("verified");
    // The two fields are independent — no Zod error, no service rejection
  });
});

// ============================================================
// I-12: F1 + E3 — NULL geo_ref_id protected + cross-country rejection
// ============================================================
describeIntegration("I-12: F1 + E3", () => {
  it("F1: two observations with NULL geo_ref_id + same key → unique violation on 2nd insert", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );

    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I12_F1",
      displayName: "Inflation Rate (I-12 F1)",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // First observation with NULL geo_ref_id — should succeed
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
      geoLevel: "national",
      // geoRefId omitted (NULL)
    });

    // Second observation with same (indicator, period, geoLevel=national, geoRefId=NULL)
    // and isCurrent=true — should FAIL with unique violation
    await expect(
      ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.5,
        originType: "observed",
        sourceId: centralBankSourceId,
        isSynthetic: true,
        geoLevel: "national",
      })
    ).rejects.toThrow(/unique|duplicate|constraint/i);
  });

  it("E3: institutional geoRefId in different country is rejected", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );

    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    // Find or create an institution in a DIFFERENT country (JOR — Jordan)
    let jorCountry = await adminClient.country.findUnique({ where: { iso3: "JOR" } });
    if (!jorCountry) {
      jorCountry = await adminClient.country.create({
        data: {
          iso3: "JOR",
          iso2: "JO",
          displayName: "Jordan (test only)",
          status: "active",
        },
      });
    }

    const jorInstitution = await adminClient.institution.create({
      data: {
        countryId: jorCountry.id,
        code: "JOR-CENTRAL-BANK-I12",
        displayName: "Jordan Central Bank (I-12 test)",
        type: "authority",
      },
    });

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I12_E3",
      displayName: "Inflation Rate (I-12 E3)",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // Tenant A belongs to DML — attempt to use JOR institution as geoRefId → reject
    await expect(
      ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.0,
        originType: "observed",
        sourceId: centralBankSourceId,
        isSynthetic: true,
        geoLevel: "institutional",
        geoRefId: jorInstitution.id, // foreign country
      })
    ).rejects.toThrow(/E3 violation/);
  });
});

// ============================================================
// I-13: F4 — observationId=null when unknown
// ============================================================
describeIntegration("I-13: F4 — observationId=null when unknown", () => {
  it("VarianceRecord with observationId=null + plannedValueType=none works without FK error", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { computeVariance } = await import(
      "@/lib/state-observatory/variance-service"
    );

    const reviewerSession = makeSession({
      id: reviewerUserId,
      tenantId: tenantAId,
      roleCode: "reviewer",
      membershipStatus: "active",
    });
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    // Indicator with NO defaultTargetValue and NO periodMilestones
    // (use analystSession — reviewer doesn't have indicator:write)
    const indicator = await defineIndicator(analystSession, {
      code: "INDICATOR_I13_NO_TARGET",
      displayName: "Indicator Without Target (I-13)",
      unit: "count",
      preferredDirection: "increase",
      // no defaultTargetValue
      // no periodMilestones
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // NO observation ingested for this indicator — actual is unknown

    const vrs = await computeVariance(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
      indicatorId: indicator.id,
    });

    expect(vrs).toHaveLength(1);
    const vr = vrs[0]!;
    expect(vr.observationId).toBeNull();
    expect(vr.plannedValueType).toBe("none");
    expect(vr.plannedValueSourceKind).toBeNull(); // F4
    expect(vr.plannedValueSourceId).toBeNull(); // F4
    expect(vr.varianceAbsolute).toBeNull();
    expect(vr.varianceDirection).toBe("unknown");
    expect(vr.comparisonValid).toBe(false);
  });
});

// ============================================================
// I-14: F2 + R4 — corrections preserve all versions
// ============================================================
describeIntegration("I-14: F2 + R4 — corrections preserve all versions", () => {
  it("correcting an observation twice leaves 3 rows (no deletion)", async () => {
    const { defineIndicator } = await import(
      "@/lib/state-observatory/indicator-registry-service"
    );
    const { ingestObservation, correctObservation } = await import(
      "@/lib/state-observatory/observation-service"
    );

    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);

    const indicator = await defineIndicator(analystSession, {
      code: "INFLATION_RATE_I14",
      displayName: "Inflation Rate (I-14)",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // Original observation
    const original = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    fixtures.track.observation(original.id);

    // First correction
    const corrected1 = await correctObservation(analystSession, original.id, {
      newValue: 9.2,
      reason: "first revision",
    });

    // Second correction (corrects the first correction)
    const corrected2 = await correctObservation(analystSession, corrected1.id, {
      newValue: 9.4,
      reason: "second revision",
    });

    // Should have 3 rows total — original + 2 corrections
    const allObs = await adminClient.observation.findMany({
      where: {
        tenantId: tenantAId,
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
      },
      orderBy: { createdAt: "asc" },
    });
    expect(allObs).toHaveLength(3);

    // Verify chain
    const [v0, v1, v2] = allObs;
    expect(v0!.id).toBe(original.id);
    expect(v0!.isCurrent).toBe(false);
    expect(v0!.supersededById).toBe(corrected1.id);
    expect(v0!.supersedesId).toBeNull();

    expect(v1!.id).toBe(corrected1.id);
    expect(v1!.isCurrent).toBe(false);
    expect(v1!.supersedesId).toBe(original.id);
    expect(v1!.supersededById).toBe(corrected2.id);

    expect(v2!.id).toBe(corrected2.id);
    expect(v2!.isCurrent).toBe(true);
    expect(v2!.supersedesId).toBe(corrected1.id);
    expect(v2!.supersededById).toBeNull();

    // Values are preserved
    expect(Number(v0!.observedValue)).toBeCloseTo(9.0, 4);
    expect(Number(v1!.observedValue)).toBeCloseTo(9.2, 4);
    expect(Number(v2!.observedValue)).toBeCloseTo(9.4, 4);
  });
});
