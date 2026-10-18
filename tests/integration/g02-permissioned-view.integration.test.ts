// Integration tests for 02-05 permissioned view on real PostgreSQL 16.
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
let tenantBId: string;
let countryId: string;
let analystUserId: string;
let adminUserId: string;
let reviewerUserId: string;
let observerUserId: string;
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
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const analyst = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  const admin = await adminClient.user.findUnique({ where: { email: "admin@demolandia.test" } });
  if (!analyst || !admin) throw new Error("users not seeded");
  analystUserId = analyst.id;
  adminUserId = admin.id;

  // Create reviewer + observer for this test
  const reviewer = await adminClient.user.upsert({
    where: { email: "g02-05-rev@demolandia.test" },
    update: {}, create: { email: "g02-05-rev@demolandia.test", name: "G02-05 Rev", passwordHash: await hashPassword("Test1234!"), status: "active" },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "reviewer" },
    create: { userId: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
  });
  reviewerUserId = reviewer.id;

  const observer = await adminClient.user.upsert({
    where: { email: "g02-05-obs@demolandia.test" },
    update: {}, create: { email: "g02-05-obs@demolandia.test", name: "G02-05 Obs", passwordHash: await hashPassword("Test1234!"), status: "active" },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: observer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "observer" },
    create: { userId: observer.id, tenantId: tenantAId, roleCode: "observer", status: "active" },
  });
  observerUserId = observer.id;

  let sv = await adminClient.strategyVersion.findFirst({ where: { tenantId: tenantAId, status: "approved" } });
  if (!sv) {
    const strategy = await adminClient.strategy.create({ data: { tenantId: tenantAId, title: "G02-05 Strategy", createdBy: analystUserId } });
    sharedFixtures.track.strategy(strategy.id);
    sv = await adminClient.strategyVersion.create({ data: { strategyId: strategy.id, tenantId: tenantAId, versionNumber: 1, content: "{}", status: "approved", approvedBy: adminUserId, approvedAt: new Date(), metadata: { simulated: true }, createdBy: analystUserId } });
  }
  strategyVersionId = sv.id;

  let obj = await adminClient.objective.findFirst({ where: { tenantId: tenantAId } });
  if (!obj) {
    obj = await adminClient.objective.create({ data: { tenantId: tenantAId, countryId, title: "G02-05 Obj", targetMetric: "test", targetValue: "5.0", horizon: 5, status: "active", createdBy: analystUserId } });
  }
  objectiveId = obj.id;

  let cb = await adminClient.source.findFirst({ where: { code: "DML-CB-SYNTHETIC" } });
  if (!cb) {
    cb = await adminClient.source.create({ data: { code: "DML-CB-SYNTHETIC", displayName: "CB synthetic", type: "government", reviewStatus: "approved", metadata: { synthetic: true, country: "DML" } } });
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
  // CORRECTION 4: scoped by tenantId, not unrestricted
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

// P-09: government tier (admin) returns data
describeIntegration("P-09: government tier returns indicators", () => {
  it("admin sees indicators with public evidence", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { getPermissionedView } = await import("@/lib/state-observatory/permissioned-view-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const adminSession = makeSession({ id: adminUserId, tenantId: tenantAId, roleCode: "admin", membershipStatus: "active" });

    const _periodId_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const periodId = _periodId_owned.id;
    testFixtures.trackOwned.observationPeriod(_periodId_owned);
    testFixtures.track.observationPeriod(periodId);
    testFixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_PERM_P09", displayName: "P-09", unit: "percent",
      preferredDirection: "decrease", alertThresholds: [], strategyVersionId, objectiveId,
    });
    testFixtures.track.indicator(indicator.id);
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id, observationPeriodId: periodId,
      observedValue: 9.0, originType: "observed", sourceId: centralBankSourceId, isSynthetic: true,
    });

    const result = await getPermissionedView(adminSession, { strategyVersionId, observationPeriodId: periodId });
    expect(result.tier).toBe("government");
    expect(result.indicators.length).toBeGreaterThan(0);
    expect(result.honesty.publicationGap).toBe(false);
  });
});

// P-10: government tier excludes restricted evidence
describeIntegration("P-10: restricted evidence excluded from government projection", () => {
  it("evidence with classification='restricted' does NOT appear in projection", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { getPermissionedView } = await import("@/lib/state-observatory/permissioned-view-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const adminSession = makeSession({ id: adminUserId, tenantId: tenantAId, roleCode: "admin", membershipStatus: "active" });

    const _periodId_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const periodId = _periodId_owned.id;
    testFixtures.trackOwned.observationPeriod(_periodId_owned);
    testFixtures.track.observationPeriod(periodId);
    testFixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_PERM_P10", displayName: "P-10", unit: "percent",
      preferredDirection: "decrease", alertThresholds: [], strategyVersionId, objectiveId,
    });
    testFixtures.track.indicator(indicator.id);

    // Create RESTRICTED evidence
    const restrictedEv = await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "Restricted claim", type: "supporting", verificationStatus: "verified", classification: "restricted", metadata: { countryId } },
    });
    testFixtures.track.evidence(restrictedEv.id);

    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id, observationPeriodId: periodId,
      observedValue: 9.0, originType: "observed", sourceId: centralBankSourceId,
      evidenceId: restrictedEv.id, isSynthetic: true,
    });

    const result = await getPermissionedView(adminSession, { strategyVersionId, observationPeriodId: periodId });
    const ind = result.indicators.find((i) => i.code === "IND_PERM_P10");
    expect(ind).toBeDefined();
    // CORRECTION 1+3: restricted evidence excluded even for admin
    expect(ind!.linkedEvidence.supporting).toHaveLength(0);
  });
});

// P-11: research tier (observer) returns publication_unavailable
describeIntegration("P-11: research tier fail-closed", () => {
  it("observer gets publication_unavailable", async () => {
    const { getPermissionedView } = await import("@/lib/state-observatory/permissioned-view-service");
    const observerSession = makeSession({ id: observerUserId, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active" });
    const _periodId_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const periodId = _periodId_owned.id;
    testFixtures.trackOwned.observationPeriod(_periodId_owned);
    testFixtures.track.observationPeriod(periodId);
    testFixtures.track.observationPeriod(periodId);

    const result = await getPermissionedView(observerSession, { strategyVersionId, observationPeriodId: periodId });
    expect(result.tier).toBe("research");
    expect(result.indicators).toEqual([]);
    expect(result.honesty.publicationGap).toBe(true);
  });
});

// P-12: anonymous returns publication_unavailable without touching RLS
describeIntegration("P-12: anonymous fail-closed", () => {
  it("null session returns publication_unavailable", async () => {
    const { getPermissionedView } = await import("@/lib/state-observatory/permissioned-view-service");
    const result = await getPermissionedView(null, { strategyVersionId, observationPeriodId: "any" });
    expect(result.tier).toBe("public");
    expect(result.indicators).toEqual([]);
    expect(result.honesty.publicationGap).toBe(true);
  });
});

// P-13: no tier escalation via request parameters
describeIntegration("P-13: no tier escalation", () => {
  it("observer cannot escalate to government by any means", async () => {
    const { getPermissionedView } = await import("@/lib/state-observatory/permissioned-view-service");
    const observerSession = makeSession({ id: observerUserId, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active" });
    // getPermissionedView does NOT accept a tier parameter — it derives from session
    const result = await getPermissionedView(observerSession, { strategyVersionId, observationPeriodId: "any" });
    expect(result.tier).not.toBe("government");
  });
});

// P-16: restricted evidence doesn't leak through counts
describeIntegration("P-16: no indirect disclosure", () => {
  it("restricted evidence count does not appear in any field", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { ingestObservation } = await import("@/lib/state-observatory/observation-service");
    const { getPermissionedView } = await import("@/lib/state-observatory/permissioned-view-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const adminSession = makeSession({ id: adminUserId, tenantId: tenantAId, roleCode: "admin", membershipStatus: "active" });

    const _periodId_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const periodId = _periodId_owned.id;
    testFixtures.trackOwned.observationPeriod(_periodId_owned);
    testFixtures.track.observationPeriod(periodId);
    testFixtures.track.observationPeriod(periodId);
    const indicator = await defineIndicator(analystSession, {
      code: "IND_PERM_P16", displayName: "P-16", unit: "percent",
      preferredDirection: "decrease", alertThresholds: [], strategyVersionId, objectiveId,
    });
    testFixtures.track.indicator(indicator.id);

    // Create 1 public + 1 restricted evidence
    const publicEv = await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "Public claim", type: "supporting", verificationStatus: "verified", classification: "public", metadata: { countryId } },
    });
    testFixtures.track.evidence(publicEv.id);
    const restrictedEv = await adminClient.evidence.create({
      data: { tenantId: tenantAId, sourceId: centralBankSourceId, claim: "Secret claim", type: "supporting", verificationStatus: "verified", classification: "restricted", metadata: { countryId } },
    });
    testFixtures.track.evidence(restrictedEv.id);

    // Link both to observation via direct + related
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id, observationPeriodId: periodId,
      observedValue: 9.0, originType: "observed", sourceId: centralBankSourceId,
      evidenceId: publicEv.id, isSynthetic: true,
    });
    // Add restricted as related evidence
    await adminClient.evidence.update({
      where: { id: restrictedEv.id },
      data: { relatedEvidenceId: publicEv.id },
    });

    const result = await getPermissionedView(adminSession, { strategyVersionId, observationPeriodId: periodId });
    const ind = result.indicators.find((i) => i.code === "IND_PERM_P16");
    expect(ind).toBeDefined();
    // Only public evidence in supporting
    expect(ind!.linkedEvidence.supporting).toHaveLength(1);
    expect(ind!.linkedEvidence.supporting[0]!.claim).toBe("Public claim");
    // Restricted claim must NOT appear anywhere
    const allClaims = [
      ...ind!.linkedEvidence.supporting,
      ...ind!.linkedEvidence.contradictory,
      ...ind!.linkedEvidence.disputed,
      ...ind!.linkedEvidence.refuted,
    ].map((e) => e.claim);
    expect(allClaims).not.toContain("Secret claim");
  });
});

// P-17: G02-L21 sentinel — unrelated record survives cleanup
describeIntegration("P-17: G02-L21 sentinel survives cleanup", () => {
  it("a sentinel indicator in the SAME tenant survives suite cleanup", async () => {
    const { defineIndicator } = await import("@/lib/state-observatory/indicator-registry-service");
    const { getPermissionedView } = await import("@/lib/state-observatory/permissioned-view-service");

    const analystSession = makeSession({ id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active" });
    const adminSession = makeSession({ id: adminUserId, tenantId: tenantAId, roleCode: "admin", membershipStatus: "active" });

    // Create a SENTINEL indicator that the test does NOT track
    // (simulates a record owned by another suite)
    const sentinel = await adminClient.indicatorDefinition.create({
      data: {
        tenantId: tenantAId, code: "SENTINEL_G02L21", displayName: "Sentinel",
        unit: "count", preferredDirection: "increase", status: "draft",
        createdBy: analystUserId, strategyVersionId,
      },
    });

    const _periodId_owned = await ensureQuarterOwned(tenantAId, 2026, 2);
    const periodId = _periodId_owned.id;
    testFixtures.trackOwned.observationPeriod(_periodId_owned);

    // Create a tracked indicator (this one should be cleaned up)
    const tracked = await defineIndicator(analystSession, {
      code: "IND_PERM_P17", displayName: "P-17", unit: "percent",
      preferredDirection: "decrease", alertThresholds: [], strategyVersionId, objectiveId,
    });
    testFixtures.track.indicator(tracked.id);

    // Run the view
    const result = await getPermissionedView(adminSession, { strategyVersionId, observationPeriodId: periodId });
    expect(result.tier).toBe("government");

    // Cleanup tracked fixtures
    await testFixtures.cleanup(adminClient);

    // SENTINEL must still exist — it was NOT tracked
    const sentinelAfter = await adminClient.indicatorDefinition.findUnique({ where: { id: sentinel.id } });
    expect(sentinelAfter).not.toBeNull();

    // Tracked indicator must be deleted
    const trackedAfter = await adminClient.indicatorDefinition.findUnique({ where: { id: tracked.id } });
    expect(trackedAfter).toBeNull();

    // Clean up sentinel manually (it's not tracked)
    await adminClient.indicatorDefinition.delete({ where: { id: sentinel.id } });
  });
});
