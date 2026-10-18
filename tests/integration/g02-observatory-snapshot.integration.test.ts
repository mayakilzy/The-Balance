// ============================================================
// tests/integration/g02-observatory-snapshot.integration.test.ts
// ------------------------------------------------------------
// Integration tests for getObservatorySnapshot on real PostgreSQL 16.
// Covers H-06..H-12 per Mission 02-02 spec + owner corrections.
// ============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

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
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const analyst = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  if (!analyst) throw new Error("analyst not seeded");
  analystUserId = analyst.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g02-02-snap-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g02-02-snap-reviewer@demolandia.test",
      name: "G02-02 Snap Reviewer",
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
      data: { tenantId: tenantAId, title: "G02-02 Snap Strategy", createdBy: analystUserId },
    });
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
      data: { tenantId: tenantAId, countryId, title: "G02-02 Snap Objective", targetMetric: "test", targetValue: "5.0", horizon: 5, status: "active", createdBy: analystUserId },
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
    await adminClient.alert.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.varianceRecord.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.observation.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.observationPeriod.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.indicatorDefinition.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient?.$disconnect();
    await appClient?.$disconnect();
  }
});

beforeEach(async () => {
  if (!RUN_INTEGRATION) return;
  await adminClient.alert.deleteMany({ where: { tenantId: tenantAId } });
  await adminClient.varianceRecord.deleteMany({ where: { tenantId: tenantAId } });
  await adminClient.observation.deleteMany({ where: { tenantId: tenantAId } });
  await adminClient.observationPeriod.deleteMany({ where: { tenantId: tenantAId } });
  await adminClient.indicatorDefinition.deleteMany({ where: { tenantId: tenantAId } });
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

// H-06: Snapshot 4-layer structure
describeIntegration("H-06: snapshot structure", () => {
  it("returns valid 4-layer structure for indicator with obs + variance + alert", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { computeVariance } = await import("@/lib/state-observatory/variance-service");
    const { evaluateAndRaise } = await import("@/lib/state-observatory/alert-service");
    const { getObservatorySnapshot } = await import("@/lib/state-observatory/observatory-query-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_SNAP_H06",
      displayName: "Indicator H-06",
      unit: "percent",
      preferredDirection: "decrease",
      defaultTargetValue: 5.0,
      targetTimeHorizon: "multi_year",
      periodMilestones: [{ periodId, targetValue: 7.0, sourceRef: "synthetic:demolandia-test-policy-2026-001" }],
      alertThresholds: [{ metric: "varianceAbsolute", operator: "gt", value: 1.5, severity: "warning", rationale: "Demo threshold for H-06", sourceRef: "synthetic:demolandia-test-policy-2026-001" }],
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
    });
    const vrs = await computeVariance(reviewerSession, { strategyVersionId, observationPeriodId: periodId, indicatorId: indicator.id });
    await evaluateAndRaise(reviewerSession, vrs[0]!.id);

    const snapshot = await getObservatorySnapshot(reviewerSession, {
      strategyVersionId,
      observationPeriodId: periodId,
    });

    expect(snapshot.indicators).toHaveLength(1);
    const ind = snapshot.indicators[0]!;
    expect(ind.observedFacts.currentObservation).not.toBeNull();
    expect(ind.calculatedComparisons.varianceRecord).not.toBeNull();
    expect(ind.interpretations.alerts.length).toBeGreaterThan(0);
    expect(ind.uncertainties.observabilityMode).toBeDefined();
    // B12: 4 layers present
    expect(ind).toHaveProperty("observedFacts");
    expect(ind).toHaveProperty("calculatedComparisons");
    expect(ind).toHaveProperty("uncertainties");
    expect(ind).toHaveProperty("interpretations");
  });
});

// H-07: Snapshot preserves refuted evidence
describeIntegration("H-07: refuted evidence preserved in snapshot", () => {
  it("refuted evidence appears in linkedEvidence.refuted (not deleted)", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { getObservatorySnapshot } = await import("@/lib/state-observatory/observatory-query-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_SNAP_H07",
      displayName: "Indicator H-07",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // Verified direct evidence
    const directEv = await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "Direct verified", type: "supporting", verificationStatus: "verified", metadata: { countryId } },
    });
    // Refuted related evidence
    await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "Refuted related", type: "counter", verificationStatus: "refuted", relatedEvidenceId: directEv.id, metadata: { countryId } },
    });

    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      evidenceId: directEv.id,
      isSynthetic: true,
    });

    const snapshot = await getObservatorySnapshot(reviewerSession, { strategyVersionId, observationPeriodId: periodId });
    const ind = snapshot.indicators[0]!;
    expect(ind.linkedEvidence.refuted.length).toBe(1);
    expect(ind.linkedEvidence.refuted[0]!.verificationStatus).toBe("refuted");
  });
});

// H-08: Snapshot preserves disputed evidence
describeIntegration("H-08: disputed evidence preserved", () => {
  it("disputed evidence appears in linkedEvidence.disputed", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { getObservatorySnapshot } = await import("@/lib/state-observatory/observatory-query-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_SNAP_H08",
      displayName: "Indicator H-08",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    const directEv = await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "Direct", type: "supporting", verificationStatus: "verified", metadata: { countryId } },
    });
    await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "Disputed related", type: "supporting", verificationStatus: "disputed", relatedEvidenceId: directEv.id, metadata: { countryId } },
    });

    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      evidenceId: directEv.id,
      isSynthetic: true,
    });

    const snapshot = await getObservatorySnapshot(reviewerSession, { strategyVersionId, observationPeriodId: periodId });
    const ind = snapshot.indicators[0]!;
    expect(ind.linkedEvidence.disputed.length).toBe(1);
  });
});

// H-09: Cross-tenant snapshot denied
describeIntegration("H-09: cross-tenant snapshot denied", () => {
  it("Tenant B reviewer cannot see Tenant A's snapshot", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { getObservatorySnapshot } = await import("@/lib/state-observatory/observatory-query-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_SNAP_H09",
      displayName: "Indicator H-09",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
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
    });

    // Create Tenant B reviewer session (Tenant B has no access to Tenant A's strategyVersionId)
    const tenantBReviewer = await adminClient.user.upsert({
      where: { email: "g02-02-tenantb-reviewer@demolandia.test" },
      update: {},
      create: { email: "g02-02-tenantb-reviewer@demolandia.test", name: "Tenant B Reviewer", passwordHash: await hashPassword("Test1234!"), status: "active" },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: tenantBReviewer.id, tenantId: tenantBId } },
      update: { status: "active", roleCode: "reviewer" },
      create: { userId: tenantBReviewer.id, tenantId: tenantBId, roleCode: "reviewer", status: "active" },
    });

    const tenantBSession = makeSession({ id: tenantBReviewer.id, tenantId: tenantBId, roleCode: "reviewer", membershipStatus: "active" });

    // Tenant B attempts to fetch Tenant A's snapshot → strategyVersionId not found in Tenant B
    await expect(
      getObservatorySnapshot(tenantBSession, { strategyVersionId, observationPeriodId: periodId })
    ).rejects.toThrow(/not found or not approved/);
  });
});

// H-10: Country-scope warning surfaced in qualityNotes
describeIntegration("H-10: country-scope UNKNOWN warning in provenanceWarnings", () => {
  it("evidence without countryId → warning appears in qualityNotes.provenanceWarnings", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_SNAP_H10",
      displayName: "Indicator H-10",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // Evidence with NO countryId
    const evNoCountry = await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "No country", type: "supporting", verificationStatus: "verified", metadata: { someOther: "value" } },
    });

    const obs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      evidenceId: evNoCountry.id,
      isSynthetic: true,
    });

    const qn = obs.qualityNotes as unknown as Record<string, unknown>;
    const warnings = qn.provenanceWarnings as string[];
    expect(warnings).toBeDefined();
    expect(warnings.some((w) => w.includes("country scope unknown"))).toBe(true);
  });
});

// H-11: Source mismatch warning explanatory
describeIntegration("H-11: source mismatch warning explanatory", () => {
  it("observation.sourceId ≠ evidence.sourceId → warning includes 'acceptable' explanation", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_SNAP_H11",
      displayName: "Indicator H-11",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });

    // Two different sources
    const src1 = await adminClient.source.create({
      data: { code: "SRC_H11_A", displayName: "Source A", type: "government", reviewStatus: "approved", metadata: { synthetic: true, country: "DML" } },
    });
    const src2 = await adminClient.source.create({
      data: { code: "SRC_H11_B", displayName: "Source B", type: "government", reviewStatus: "approved", metadata: { synthetic: true, country: "DML" } },
    });

    // Evidence citing src2, but observation cites src1 (mismatch)
    const ev = await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: src2.id, claim: "Evidence from src2", type: "supporting", verificationStatus: "verified", metadata: { countryId } },
    });

    const obs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: src1.id, // observation's source
      evidenceId: ev.id, // evidence cites src2
      isSynthetic: true,
    });

    const qn = obs.qualityNotes as unknown as Record<string, unknown>;
    const warnings = qn.provenanceWarnings as string[];
    const mismatchWarning = warnings.find((w) => w.includes("differs from evidence.sourceId"));
    expect(mismatchWarning).toBeDefined();
    // B15: warning includes explanation
    expect(mismatchWarning).toContain("acceptable");
    expect(mismatchWarning).toContain("Both sources are preserved");
  });
});

// H-12: Snapshot honesty block
describeIntegration("H-12: snapshot honesty block", () => {
  it("honesty.simulatedData=true for Demolandia + noCausalClaims=true + limitations array", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { getObservatorySnapshot } = await import("@/lib/state-observatory/observatory-query-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const reviewerSession = makeSession({ id: reviewerUserId, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active" });

    const periodId = await ensureQuarter(tenantAId, 2026, 2);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_SNAP_H12",
      displayName: "Indicator H-12",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
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
    });

    const snapshot = await getObservatorySnapshot(reviewerSession, { strategyVersionId, observationPeriodId: periodId });
    expect(snapshot.honesty.simulatedData).toBe(true);
    expect(snapshot.honesty.noCausalClaims).toBe(true);
    expect(Array.isArray(snapshot.honesty.limitations)).toBe(true);
  });
});
