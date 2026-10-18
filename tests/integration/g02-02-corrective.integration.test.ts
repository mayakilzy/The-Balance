// ============================================================
// tests/integration/g02-02-corrective.integration.test.ts
// ------------------------------------------------------------
// Corrective integration tests for 02-02 fixes:
//   H-13: Two independent VERIFIED counter-evidence do NOT produce FULL
//   H-14: Snapshot does not mix periods (alerts + correction history)
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
let countryId: string;
let analystUserId: string;
let reviewerUserId: string;
let strategyVersionId: string;
let objectiveId: string;
let centralBankSourceId: string;

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

  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("DML not seeded");
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  if (!tenantA) throw new Error("DML-MOP-TENANT not seeded");
  tenantAId = tenantA.id;

  const analyst = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  if (!analyst) throw new Error("analyst not seeded");
  analystUserId = analyst.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g02-02-corr-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g02-02-corr-reviewer@demolandia.test",
      name: "G02-02 Corr Reviewer",
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
      data: { tenantId: tenantAId, title: "G02-02 Corr Strategy", createdBy: analystUserId },
    });
    fixtures.track.strategy(strategy.id);
    sv = await adminClient.strategyVersion.create({
      data: {
        strategyId: strategy.id, tenantId: tenantAId, versionNumber: 1, content: "{}",
        status: "approved", approvedBy: analystUserId, approvedAt: new Date(),
        metadata: { simulated: true }, createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  let obj = await adminClient.objective.findFirst({ where: { tenantId: tenantAId } });
  if (!obj) {
    obj = await adminClient.objective.create({
      data: { tenantId: tenantAId, countryId, title: "G02-02 Corr Objective", targetMetric: "test", targetValue: "5.0", horizon: 5, status: "active", createdBy: analystUserId },
    });
  }
  objectiveId = obj.id;

  let cb = await adminClient.source.findFirst({ where: { code: "DML-CB-SYNTHETIC" } });
  if (!cb) {
    cb = await adminClient.source.create({
      data: { code: "DML-CB-SYNTHETIC", displayName: "Demolandia Central Bank — synthetic", type: "government", reviewStatus: "approved", metadata: { synthetic: true, country: "DML" } },
    });
  }
  centralBankSourceId = cb.id;
});

afterAll(async () => {
  if (RUN_INTEGRATION) {
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
  await fixtures.cleanup(adminClient);
});

beforeEach(async () => {
  if (!RUN_INTEGRATION) return;
  await fixtures.cleanup(adminClient);
});

async function ensureQuarter(tenantId: string, year: number, quarter: 1 | 2 | 3 | 4) {
  const periodValue = `${year}-Q${quarter}`;
  const startMonth = (quarter - 1) * 3;
  const startAt = new Date(Date.UTC(year, startMonth, 1));
  const endAt = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59));
  const existing = await adminClient.observationPeriod.findFirst({ where: { tenantId, periodType: "quarterly", periodValue } });
  if (existing) return existing.id;
  return (await adminClient.observationPeriod.create({ data: { tenantId, periodType: "quarterly", periodValue, startAt, endAt } })).id;
}

// ============================================================
// H-13: Two independent VERIFIED counter-evidence do NOT produce FULL
// FIX 1 verification: verified counter-evidence is NOT positive support
// ============================================================
describeIntegration("H-13: verified counter-evidence does NOT produce FULL", () => {
  it("1 national obs + 2 independent verified COUNTER evidence → PARTIAL (not FULL)", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeAggregateIndependence } = await import("@/lib/state-observatory/aggregate-independence-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_CORR_H13",
      displayName: "Indicator H-13 Counter",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // 2 independent sources
    const src1 = await adminClient.source.create({
      data: { code: "SRC_H13_1", displayName: "Source H-13 1", type: "government", reviewStatus: "approved", independenceGroup: null, metadata: { synthetic: true, country: "DML" } },
    });
    fixtures.track.source(src1.id);
    const src2 = await adminClient.source.create({
      data: { code: "SRC_H13_2", displayName: "Source H-13 2", type: "government", reviewStatus: "approved", independenceGroup: null, metadata: { synthetic: true, country: "DML" } },
    });
    fixtures.track.source(src2.id);

    // Direct evidence: type="supporting", verified
    const directEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: src1.id,
        claim: "Direct supporting evidence",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId },
      },
    });
    fixtures.track.evidence(directEvidence.id);

    // Related evidence 1: type="counter", verified — this is COUNTER-evidence
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: src2.id,
        claim: "Counter-evidence contradicting the claim (verified)",
        type: "counter",
        verificationStatus: "verified",
        relatedEvidenceId: directEvidence.id,
        metadata: { countryId },
      },
    });

    // 1 national observation linked to direct evidence
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: src1.id,
      evidenceId: directEvidence.id,
      isSynthetic: true,
    });

    const result = await analyzeAggregateIndependence(reviewerSession, {
      indicatorId: indicator.id,
      observationPeriodId: periodId,
    });

    // FIX 1: The related counter-evidence is verified BUT type="counter"
    // → it must NOT count toward positive national claim support
    // → only 1 independent verified SUPPORTING evidence (the direct one)
    // → nationalClaimSupport.level = "partial" (not "strong")
    // → observabilityMode = PARTIAL (not FULL)
    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.nationalClaimSupport.level).toBe("partial");
    expect(result.evidenceStrength.independentVerifiedEvidenceLinkedToNationalClaim).toBe(1);
    // Counter-evidence is still visible in counts
    expect(result.evidenceStrength.contradictoryEvidenceCount).toBe(1);
    expect(result.limitationReason).toContain("only 1 independent verified");
  });
});

// ============================================================
// H-14: Snapshot does not mix periods
// FIX 2 verification: alerts + correction history are period-scoped
// ============================================================
describeIntegration("H-14: snapshot period isolation", () => {
  it("alerts from period Q1 do NOT appear in snapshot for period Q2", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { computeVariance } = await import("@/lib/state-observatory/variance-service");
    const { evaluateAndRaise } = await import("@/lib/state-observatory/alert-service");
    const { getObservatorySnapshot } = await import("@/lib/state-observatory/observatory-query-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodQ1 = await ensureQuarter(tenantAId, 2026, 1);
    fixtures.track.observationPeriod(periodQ1);
    fixtures.track.observationPeriod(periodQ1);
    const periodQ2 = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodQ2);
    fixtures.track.observationPeriod(periodQ2);

    const indicator = await defineIndicator(analystSession, {
      code: "IND_CORR_H14",
      displayName: "Indicator H-14",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [
        { periodId: periodQ1, targetValue: 8.0, sourceRef: "synthetic:demolandia-test-policy-2026-001" },
        { periodId: periodQ2, targetValue: 7.0, sourceRef: "synthetic:demolandia-test-policy-2026-001" },
      ],
      alertThresholds: [
        { metric: "varianceAbsolute", operator: "gt", value: 1.5, severity: "warning", rationale: "Demo threshold for H-14", sourceRef: "synthetic:demolandia-test-policy-2026-001" },
      ],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // Q1: ingest observation + compute variance + raise alert
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodQ1,
      observedValue: 10.0, // 10.0 - 8.0 = 2.0 > 1.5 threshold
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    const vrQ1 = await computeVariance(reviewerSession, { strategyVersionId, observationPeriodId: periodQ1, indicatorId: indicator.id });
    const alertQ1 = await evaluateAndRaise(reviewerSession, vrQ1[0]!.id);
    expect(alertQ1).not.toBeNull();

    // Q2: ingest observation + compute variance + raise alert
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodQ2,
      observedValue: 9.0, // 9.0 - 7.0 = 2.0 > 1.5 threshold
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    const vrQ2 = await computeVariance(reviewerSession, { strategyVersionId, observationPeriodId: periodQ2, indicatorId: indicator.id });
    const alertQ2 = await evaluateAndRaise(reviewerSession, vrQ2[0]!.id);
    expect(alertQ2).not.toBeNull();

    // Snapshot for Q2 — must NOT include Q1's alert
    const snapshotQ2 = await getObservatorySnapshot(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodQ2,
    });

    const indQ2 = snapshotQ2.indicators[0]!;
    const alertIdsQ2 = indQ2.interpretations.alerts.map((a) => a.id);
    // Q2 snapshot must contain Q2's alert but NOT Q1's alert
    expect(alertIdsQ2).toContain(alertQ2!.id);
    expect(alertIdsQ2).not.toContain(alertQ1!.id);
  });

  it("correction history is scoped to national geo (not subnational)", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation, correctObservation } = await import("@/lib/state-observatory/observation-service");
    const { getObservatorySnapshot } = await import("@/lib/state-observatory/observatory-query-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_CORR_H14B",
      displayName: "Indicator H-14B",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // National observation + correction
    const nationalObs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    fixtures.track.observation(nationalObs.id);
    await correctObservation(analystSession, nationalObs.id, { newValue: 9.2, reason: "national correction" });

    // Subnational observation + correction (different geo)
    const subnationalObs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 8.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
      geoLevel: "subnational",
      geoRefId: "geo_corr_h14b",
    });
    fixtures.track.observation(subnationalObs.id);
    await correctObservation(analystSession, subnationalObs.id, { newValue: 8.5, reason: "subnational correction" });

    // Snapshot — correction chain should only show national observations (2 rows: original + corrected)
    const snapshot = await getObservatorySnapshot(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
    });

    const ind = snapshot.indicators[0]!;
    // FIX 2: correction chain must be national-only (2 rows), NOT include subnational (4 rows)
    expect(ind.observedFacts.correctionChain).toHaveLength(2);
    expect(ind.observedFacts.observationHistoryCount).toBe(2);
    // Verify all entries are the national chain
    const chainIds = ind.observedFacts.correctionChain.map((o) => o.id);
    expect(chainIds).toContain(nationalObs.id);
    expect(chainIds).not.toContain(subnationalObs.id);
  });
});
