// ============================================================
// tests/integration/g02-aggregate-independence.integration.test.ts
// ------------------------------------------------------------
// Integration tests for analyzeAggregateIndependence on real PostgreSQL 16.
// Covers H-01..H-05 per Mission 02-02 spec + owner corrections.
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
    where: { email: "g02-02-agg-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g02-02-agg-reviewer@demolandia.test",
      name: "G02-02 Agg Reviewer",
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
      data: { tenantId: tenantAId, title: "G02-02 Test Strategy", createdBy: analystUserId },
    });
    fixtures.track.strategy(strategy.id);
    sv = await adminClient.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "approved",
        approvedBy: analystUserId,
        approvedAt: new Date(),
        metadata: { simulated: true },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  let obj = await adminClient.objective.findFirst({ where: { tenantId: tenantAId } });
  if (!obj) {
    obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId,
        countryId,
        title: "G02-02 Objective",
        targetMetric: "test",
        targetValue: "5.0",
        horizon: 5,
        status: "active",
        createdBy: analystUserId,
      },
    });
  }
  objectiveId = obj.id;
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
  const existing = await adminClient.observationPeriod.findFirst({
    where: { tenantId, periodType: "quarterly", periodValue },
  });
  if (existing) return existing.id;
  return (await adminClient.observationPeriod.create({
    data: { tenantId, periodType: "quarterly", periodValue, startAt, endAt },
  })).id;
}

// H-01: Subnational spread never creates FULL
describeIntegration("H-01: subnational spread → PARTIAL (not FULL)", () => {
  it("5 subnational obs from 5 independent sources → PARTIAL + limitationReason", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeAggregateIndependence } = await import("@/lib/state-observatory/aggregate-independence-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_AGG_H01",
      displayName: "Indicator H-01",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // 5 sources, all independent
    const sources = [];
    for (let i = 1; i <= 5; i++) {
      sources.push(await adminClient.source.create({
        data: {
          code: `SRC_H01_${i}`,
          displayName: `Source H-01 ${i}`,
          type: "government",
          reviewStatus: "approved",
          independenceGroup: null,
          metadata: { synthetic: true, country: "DML" },
        },
      }));
    }

    // 5 subnational observations from 5 different geos
    for (let i = 0; i < 5; i++) {
      await ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.0 + i * 0.1,
        originType: "observed",
        sourceId: sources[i]!.id,
        isSynthetic: true,
        geoLevel: "subnational",
        geoRefId: `geo_h01_${i + 1}`,
      });
    }

    const result = await analyzeAggregateIndependence(reviewerSession, {
      indicatorId: indicator.id,
      observationPeriodId: periodId,
    });

    // B4 critical: subnational spread ≠ FULL
    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.nationalClaimSupport.level).toBe("none");
    expect(result.limitationReason).toContain("no national-level observation");
    expect(result.coverage.distinctGeoRefIds).toBe(5);
    expect(result.sourceDiversity.independentSourceCount).toBe(5);
  });
});

// H-02 + H-03: FULL reachable via national obs + 2 independent verified evidence (direct + related)
describeIntegration("H-02/H-03: FULL via national obs + 2 independent verified evidence", () => {
  it("1 national obs + direct verified evidence + 1 related verified evidence (independent sources) → FULL", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeAggregateIndependence } = await import("@/lib/state-observatory/aggregate-independence-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_AGG_H02",
      displayName: "Indicator H-02",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // 2 independent sources
    const src1 = await adminClient.source.create({
      data: { code: "SRC_H02_1", displayName: "Source H-02 1", type: "government", reviewStatus: "approved", independenceGroup: null, metadata: { synthetic: true, country: "DML" } },
    });
    fixtures.track.source(src1.id);
    const src2 = await adminClient.source.create({
      data: { code: "SRC_H02_2", displayName: "Source H-02 2", type: "government", reviewStatus: "approved", independenceGroup: null, metadata: { synthetic: true, country: "DML" } },
    });
    fixtures.track.source(src2.id);

    // Direct evidence (verified, source 1)
    const directEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: src1.id,
        claim: "Direct verified evidence for H-02",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId },
      },
    });
    fixtures.track.evidence(directEvidence.id);

    // Related evidence (verified, source 2) — relatedEvidenceId points to directEvidence
    const relatedEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: src2.id,
        claim: "Related verified evidence for H-02 (independent corroboration)",
        type: "supporting",
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

    expect(result.observabilityMode).toBe("FULL");
    expect(result.nationalClaimSupport.level).toBe("strong");
    expect(result.limitationReason).toBeNull();
    expect(result.evidenceStrength.independentVerifiedEvidenceLinkedToNationalClaim).toBe(2);
  });
});

// H-04: Aggregate with verified evidence + 1 national source → PARTIAL
describeIntegration("H-04: 1 national source + 1 verified evidence → PARTIAL", () => {
  it("only 1 independent verified evidence linked → PARTIAL", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeAggregateIndependence } = await import("@/lib/state-observatory/aggregate-independence-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_AGG_H04",
      displayName: "Indicator H-04",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    const src1 = await adminClient.source.create({
      data: { code: "SRC_H04_1", displayName: "Source H-04 1", type: "government", reviewStatus: "approved", independenceGroup: null, metadata: { synthetic: true, country: "DML" } },
    });
    fixtures.track.source(src1.id);

    // Only 1 verified evidence (no related evidence)
    const directEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: src1.id,
        claim: "Single verified evidence",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId },
      },
    });
    fixtures.track.evidence(directEvidence.id);

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

    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.nationalClaimSupport.level).toBe("partial");
    expect(result.limitationReason).toContain("only 1 independent verified evidence");
  });
});

// H-05: Coverage vs independence separation
describeIntegration("H-05: coverage vs independence separation", () => {
  it("3 subnational obs from 3 different geoRefIds but same source → coverage=3, independentSourceCount=1", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { analyzeAggregateIndependence } = await import("@/lib/state-observatory/aggregate-independence-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    fixtures.track.observationPeriod(periodId);
    fixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_AGG_H05",
      displayName: "Indicator H-05",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    const src = await adminClient.source.create({
      data: { code: "SRC_H05_SINGLE", displayName: "Source H-05", type: "government", reviewStatus: "approved", independenceGroup: null, metadata: { synthetic: true, country: "DML" } },
    });
    fixtures.track.source(src.id);

    // 3 subnational obs from 3 different geos but SAME source
    for (let i = 1; i <= 3; i++) {
      await ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.0,
        originType: "observed",
        sourceId: src.id,
        isSynthetic: true,
        geoLevel: "subnational",
        geoRefId: `geo_h05_${i}`,
      });
    }

    const result = await analyzeAggregateIndependence(reviewerSession, {
      indicatorId: indicator.id,
      observationPeriodId: periodId,
    });

    // B8: coverage=3 (3 distinct geos), independentSourceCount=1 (1 source)
    expect(result.coverage.distinctGeoRefIds).toBe(3);
    expect(result.sourceDiversity.totalSources).toBe(1);
    expect(result.sourceDiversity.independentSourceCount).toBe(1);
    // No national obs → PARTIAL
    expect(result.observabilityMode).toBe("PARTIAL");
  });
});
