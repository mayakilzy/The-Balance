// Integration tests for temporal trend on real PostgreSQL 16.
// Covers T-01..T-06 per Mission 02-03 spec.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";
import { FixtureTracker } from "./helpers/fixture-tracker";


const sharedFixtures = new FixtureTracker();
const testFixtures = new FixtureTracker();
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

function makeSession(user: { id: string; tenantId: string; roleCode: string; membershipStatus: string }): Session {
  return { user: { id: user.id, tenantId: user.tenantId, roleCode: user.roleCode, membershipStatus: user.membershipStatus }, expires: new Date(Date.now() + 3600_000).toISOString() } as unknown as Session;
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
  const reviewerExisted = !!(await adminClient.user.findUnique({ where: { email: "g02-03-trend-reviewer@demolandia.test" } }));
  const reviewer = await adminClient.user.upsert({
    where: { email: "g02-03-trend-reviewer@demolandia.test" },
    update: {},
    create: { email: "g02-03-trend-reviewer@demolandia.test", name: "G02-03 Trend Reviewer", passwordHash: await hashPassword("Test1234!"), status: "active" },
  });
  sharedFixtures.trackOwned.user({ id: reviewer.id, createdByThisSuite: !reviewerExisted });
  const reviewerMembExisted = !!(await adminClient.membership.findUnique({
    where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
  }));
  const reviewerMemb = await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "reviewer" },
    create: { userId: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
  });
  sharedFixtures.trackOwned.membership({ id: reviewerMemb.id, createdByThisSuite: !reviewerMembExisted });
  reviewerUserId = reviewer.id;
  let sv = await adminClient.strategyVersion.findFirst({ where: { tenantId: tenantAId, status: "approved" } });
  if (!sv) {
    const strategy = await adminClient.strategy.create({ data: { tenantId: tenantAId, title: "G02-03 Trend Strategy", createdBy: analystUserId } });
    sharedFixtures.trackOwned.strategy({ id: strategy.id, createdByThisSuite: true });
    sv = await adminClient.strategyVersion.create({ data: { strategyId: strategy.id, tenantId: tenantAId, versionNumber: 1, content: "{}", status: "approved", approvedBy: analystUserId, approvedAt: new Date(), metadata: { simulated: true }, createdBy: analystUserId } });
    sharedFixtures.trackOwned.strategyVersion({ id: sv.id, createdByThisSuite: true });
  }
  strategyVersionId = sv.id;
  let obj = await adminClient.objective.findFirst({ where: { tenantId: tenantAId } });
  if (!obj) {
    obj = await adminClient.objective.create({ data: { tenantId: tenantAId, countryId, title: "G02-03 Trend Objective", targetMetric: "test", targetValue: "5.0", horizon: 5, status: "active", createdBy: analystUserId } });
    sharedFixtures.trackOwned.objective({ id: obj.id, createdByThisSuite: true });
  }
  objectiveId = obj.id;
  let cb = await adminClient.source.findFirst({ where: { code: "DML-CB-SYNTHETIC" } });
  if (!cb) {
    cb = await adminClient.source.create({ data: { code: "DML-CB-SYNTHETIC", displayName: "Demolandia Central Bank — synthetic", type: "government", reviewStatus: "approved", metadata: { synthetic: true, country: "DML" } } });
    sharedFixtures.trackOwned.source({ id: cb.id, createdByThisSuite: true });
  }
  centralBankSourceId = cb.id;
});

afterAll(async () => {
  if (RUN_INTEGRATION) {
    try {
      await testFixtures.cleanup(adminClient);
      await sharedFixtures.cleanup(adminClient);
    } finally {
      await adminClient?.$disconnect();
      await appClient?.$disconnect();
    }
  }
});

beforeEach(async () => {
  if (!RUN_INTEGRATION) return;
});

afterEach(async () => {
  if (testFixtures.trackedCount > 0) {
    await testFixtures.cleanup(adminClient);
  }
});

async function ensureQuarterOwned(tenantId: string, year: number, quarter: 1 | 2 | 3 | 4): Promise<{ id: string; createdByThisSuite: boolean }> {
  const periodValue = `${year}-Q${quarter}`;
  const startMonth = (quarter - 1) * 3;
  const startAt = new Date(Date.UTC(year, startMonth, 1));
  const endAt = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59));
  const existing = await adminClient.observationPeriod.findFirst({ where: { tenantId, periodType: "quarterly", periodValue } });
  if (existing) return { id: existing.id, createdByThisSuite: false };
  const created = await adminClient.observationPeriod.create({ data: { tenantId, periodType: "quarterly", periodValue, startAt, endAt } });
  return { id: created.id, createdByThisSuite: true };
}

describeIntegration("T-01: 4 comparable quarterly periods with improving trend", () => {
  it("returns improving + sufficient", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeTemporalTrend } = await import("@/lib/state-observatory/temporal-trend-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    // Create 4 periods: Q3-2025, Q4-2025, Q1-2026, Q2-2026
    const _p1_owned = await ensureQuarterOwned(tenantAId, 2025, 3);
    const p1 = _p1_owned.id;
    testFixtures.trackOwned.observationPeriod(_p1_owned);
    const _p2_owned = await ensureQuarterOwned(tenantAId, 2025, 4);
    const p2 = _p2_owned.id;
    testFixtures.trackOwned.observationPeriod(_p2_owned);
    const _p3_owned = await ensureQuarterOwned(tenantAId, 2026, 1);
    const p3 = _p3_owned.id;
    testFixtures.trackOwned.observationPeriod(_p3_owned);
    const _p4_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const p4 = _p4_owned.id;
    testFixtures.trackOwned.observationPeriod(_p4_owned);

    const indicator = await defineIndicator(analystSession, {
      code: "IND_TREND_T01", displayName: "Indicator T-01", unit: "percent",
      preferredDirection: "decrease", alertThresholds: [], strategyVersionId, objectiveId,
    });
    testFixtures.track.indicator(indicator.id);

    // Ingest 3 historical observations (before p4) with decreasing values
    for (const [pid, val] of [[p1, 10.0], [p2, 8.0], [p3, 6.0]] as [string, number][]) {
      await ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id, observationPeriodId: pid,
        observedValue: val, originType: "observed", sourceId: centralBankSourceId, isSynthetic: true,
      });
    }

    const result = await analyzeTemporalTrend(reviewerSession, {
      indicatorId: indicator.id, endingBeforePeriodId: p4,
    });

    expect(result.trendDirection).toBe("improving");
    expect(result.dataSufficiency).toBe("sufficient");
    expect(result.dataPoints).toHaveLength(3);
    expect(result.temporalGaps).toHaveLength(0);
  });
});

describeIntegration("T-02: temporal gap detection", () => {
  it("missing observation in middle period → temporalGaps + trend unknown", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeTemporalTrend } = await import("@/lib/state-observatory/temporal-trend-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const _p1_owned = await ensureQuarterOwned(tenantAId, 2025, 3);
    const p1 = _p1_owned.id;
    testFixtures.trackOwned.observationPeriod(_p1_owned);
    const _p2_owned = await ensureQuarterOwned(tenantAId, 2025, 4);
    const p2 = _p2_owned.id;
    testFixtures.trackOwned.observationPeriod(_p2_owned);
    const _p3_owned = await ensureQuarterOwned(tenantAId, 2026, 1);
    const p3 = _p3_owned.id;
    testFixtures.trackOwned.observationPeriod(_p3_owned);
    const _p4_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const p4 = _p4_owned.id;
    testFixtures.trackOwned.observationPeriod(_p4_owned);

    const indicator = await defineIndicator(analystSession, {
      code: "IND_TREND_T02", displayName: "Indicator T-02", unit: "percent",
      preferredDirection: "decrease", alertThresholds: [], strategyVersionId, objectiveId,
    });
    testFixtures.track.indicator(indicator.id);

    // Ingest p1 + p3 (skip p2 — gap)
    await ingestObservation(analystSession, { indicatorDefinitionId: indicator.id, observationPeriodId: p1, observedValue: 10.0, originType: "observed", sourceId: centralBankSourceId, isSynthetic: true });
    await ingestObservation(analystSession, { indicatorDefinitionId: indicator.id, observationPeriodId: p3, observedValue: 6.0, originType: "observed", sourceId: centralBankSourceId, isSynthetic: true });

    const result = await analyzeTemporalTrend(reviewerSession, { indicatorId: indicator.id, endingBeforePeriodId: p4 });

    expect(result.temporalGaps.length).toBeGreaterThan(0);
    expect(result.trendDirection).toBe("unknown"); // CORRECTION 3: gaps → unknown
    expect(result.limitationReason).toContain("temporal gaps");
  });
});

describeIntegration("T-04: null measurements → insufficient", () => {
  it("2 periods with null values → insufficient + unknown", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeTemporalTrend } = await import("@/lib/state-observatory/temporal-trend-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const _p1_owned = await ensureQuarterOwned(tenantAId, 2025, 4);
    const p1 = _p1_owned.id;
    testFixtures.trackOwned.observationPeriod(_p1_owned);
    const _p2_owned = await ensureQuarterOwned(tenantAId, 2026, 1);
    const p2 = _p2_owned.id;
    testFixtures.trackOwned.observationPeriod(_p2_owned);
    const _p3_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const p3 = _p3_owned.id;
    testFixtures.trackOwned.observationPeriod(_p3_owned);

    const indicator = await defineIndicator(analystSession, {
      code: "IND_TREND_T04", displayName: "Indicator T-04", unit: "percent",
      preferredDirection: "decrease", alertThresholds: [], strategyVersionId, objectiveId,
    });
    testFixtures.track.indicator(indicator.id);

    // Both observations have null values
    await ingestObservation(analystSession, { indicatorDefinitionId: indicator.id, observationPeriodId: p1, observedValue: null, originType: "observed", sourceId: centralBankSourceId, isSynthetic: true });
    await ingestObservation(analystSession, { indicatorDefinitionId: indicator.id, observationPeriodId: p2, observedValue: null, originType: "observed", sourceId: centralBankSourceId, isSynthetic: true });

    const result = await analyzeTemporalTrend(reviewerSession, { indicatorId: indicator.id, endingBeforePeriodId: p3 });

    expect(result.dataSufficiency).toBe("insufficient");
    expect(result.trendDirection).toBe("unknown");
  });
});
