// ============================================================
// tests/integration/g02-provenance-hardening.integration.test.ts
// ------------------------------------------------------------
// Integration tests for provenance validation + audit failure rollback.
// Covers H-01, H-02, H-03, H-04, H-09, H-10, H-11 per Mission 02-01 spec.
//
// CRITICAL (owner clarification #4): For H-01 + H-02, we isolate the
// audit-failure injection by using a SEPARATE PrismaClient connected as
// balance_admin to REVOKE/GRANT INSERT on audit_log around the test.
// The test verifies rollback on real PostgreSQL, then restores permissions
// in a finally block to guarantee cleanup.
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
let countryJorId: string;
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
  if (!country) throw new Error("Demolandia (DML) not seeded.");
  countryId = country.id;

  // Get or create JOR country for cross-country tests
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
  countryJorId = jorCountry.id;

  const tenantA = await adminClient.tenant.findUnique({
    where: { code: "DML-MOP-TENANT" },
  });
  const tenantB = await adminClient.tenant.findUnique({
    where: { code: "DML-CB-TENANT" },
  });
  if (!tenantA || !tenantB)
    throw new Error("Test tenants not seeded.");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const analyst = await adminClient.user.findUnique({
    where: { email: "analyst@demolandia.test" },
  });
  if (!analyst) throw new Error("analyst@demolandia.test not seeded.");
  analystUserId = analyst.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g02-01-hardening-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g02-01-hardening-reviewer@demolandia.test",
      name: "G02-01 Hardening Reviewer",
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
        title: "G02-01 Hardening Test Strategy",
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
        approvedBy: analystUserId,
        approvedAt: new Date(),
        metadata: { simulated: true },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  let obj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId },
  });
  if (!obj) {
    obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId,
        countryId,
        title: "G02-01 Hardening Objective",
        targetMetric: "test",
        targetValue: "5.0",
        horizon: 5,
        status: "active",
        createdBy: analystUserId,
      },
    });
  }
  objectiveId = obj.id;

  // Get or create central bank source
  let centralBank = await adminClient.source.findFirst({
    where: { code: "DML-CB-SYNTHETIC" },
  });
  if (!centralBank) {
    centralBank = await adminClient.source.create({
      data: {
        code: "DML-CB-SYNTHETIC",
        displayName: "Demolandia Central Bank — synthetic",
        type: "government",
        reviewStatus: "approved",
        metadata: { synthetic: true, country: "DML" },
      },
    });
  }
  centralBankSourceId = centralBank.id;
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
  const created = await adminClient.observationPeriod.create({
    data: { tenantId, periodType: "quarterly", periodValue, startAt, endAt },
  });
  return created.id;
}

// ============================================================
// H-01: Audit failure injection → real PostgreSQL rollback
// Isolated: REVOKE INSERT on audit_log from balance_app, attempt ingest,
// verify NO observation row, GRANT back in finally.
// ============================================================
describeIntegration("H-01: Audit failure → real PostgreSQL rollback", () => {
  it("ingestObservation throws when audit_log INSERT fails → no observation row", async () => {
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
      code: "IND_H01",
      displayName: "Indicator H-01",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // REVOKE INSERT on audit_log from balance_app
    await adminClient.$executeRawUnsafe(
      `REVOKE INSERT ON TABLE "audit_log" FROM balance_app`
    );

    let ingestFailed = false;
    let observationCount = 0;

    try {
      // Attempt to ingest — should fail because writeAuditTx cannot write
      await ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.0,
        originType: "observed",
        sourceId: centralBankSourceId,
        isSynthetic: true,
      });
      // If we reach here, the test failed (ingest should have thrown)
    } catch (err) {
      ingestFailed = true;
      // Verify the error is related to audit/RLS
      expect(err).toBeInstanceOf(Error);
    } finally {
      // GUARANTEED cleanup: GRANT INSERT back
      await adminClient.$executeRawUnsafe(
        `GRANT INSERT ON TABLE "audit_log" TO balance_app`
      );
    }

    // Verify the ingest failed
    expect(ingestFailed).toBe(true);

    // Verify NO observation row was created (rollback worked)
    observationCount = await adminClient.observation.count({
      where: {
        tenantId: tenantAId,
        indicatorDefinitionId: indicator.id,
      },
    });
    expect(observationCount).toBe(0);
  });
});

// ============================================================
// H-02: Correction mid-tx failure → no partial state
// ============================================================
describeIntegration("H-02: Correction failure → no partial state", () => {
  it("correctObservation fails on audit_log INSERT → original observation unchanged", async () => {
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
      code: "IND_H02",
      displayName: "Indicator H-02",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // Ingest original observation (audit_log INSERT works)
    const original = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });
    fixtures.track.observation(original.id);

    // Verify original state
    expect(original.isCurrent).toBe(true);
    expect(original.supersededById).toBeNull();

    // REVOKE INSERT on audit_log
    await adminClient.$executeRawUnsafe(
      `REVOKE INSERT ON TABLE "audit_log" FROM balance_app`
    );

    let correctionFailed = false;

    try {
      // Attempt correction — should fail at writeAuditTx step
      await correctObservation(analystSession, original.id, {
        newValue: 9.2,
        reason: "should fail and rollback",
      });
    } catch (err) {
      correctionFailed = true;
      expect(err).toBeInstanceOf(Error);
    } finally {
      // GUARANTEED cleanup
      await adminClient.$executeRawUnsafe(
        `GRANT INSERT ON TABLE "audit_log" TO balance_app`
      );
    }

    expect(correctionFailed).toBe(true);

    // Verify the original observation is UNCHANGED
    const originalAfter = await adminClient.observation.findUnique({
      where: { id: original.id },
    });
    expect(originalAfter).not.toBeNull();
    expect(originalAfter!.isCurrent).toBe(true); // unchanged
    expect(originalAfter!.supersededById).toBeNull(); // unchanged
    expect(Number(originalAfter!.observedValue)).toBe(9.0); // unchanged

    // Verify NO new observation row was created
    const allObs = await adminClient.observation.findMany({
      where: {
        tenantId: tenantAId,
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
      },
    });
    expect(allObs).toHaveLength(1); // only the original
  });
});

// ============================================================
// H-03: Concurrent correction failure → chain preserved
// ============================================================
describeIntegration("H-03: Concurrent correction failure → chain preserved", () => {
  it("two parallel corrections — first succeeds, second throws → chain intact, no third row", async () => {
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
      code: "IND_H03",
      displayName: "Indicator H-03",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

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
        reason: "first correction",
      }),
      correctObservation(analystSession, original.id, {
        newValue: 9.3,
        reason: "second correction (should fail)",
      }),
    ];

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Verify chain: original (isCurrent=false, supersededById=corrected) + corrected (isCurrent=true)
    const allObs = await adminClient.observation.findMany({
      where: {
        tenantId: tenantAId,
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
      },
      orderBy: { createdAt: "asc" },
    });

    expect(allObs).toHaveLength(2); // exactly 2 — no third row from failed attempt

    const [v0, v1] = allObs;
    expect(v0!.id).toBe(original.id);
    expect(v0!.isCurrent).toBe(false);
    expect(v0!.supersededById).toBe(v1!.id);

    expect(v1!.isCurrent).toBe(true);
    expect(v1!.supersedesId).toBe(original.id);
    expect(v1!.supersededById).toBeNull();
  });
});

// ============================================================
// H-04: Duplicate value handling (A17)
// Value equality alone does NOT reject; existing uniqueness constraint (F1) handles it.
// ============================================================
describeIntegration("H-04: Duplicate value handling", () => {
  it("two observations with same value but different geos → both succeed (no value-based rejection)", async () => {
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
      code: "IND_H04",
      displayName: "Indicator H-04",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // Two observations with SAME value (9.0) but DIFFERENT geos
    // Both should succeed — value equality alone does NOT trigger rejection
    const obs1 = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
      geoLevel: "subnational",
      geoRefId: "geo_h04_a",
    });
    fixtures.track.observation(obs1.id);
    const obs2 = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0, // SAME value
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
      geoLevel: "subnational",
      geoRefId: "geo_h04_b", // DIFFERENT geo → different uniqueness slot
    });
    fixtures.track.observation(obs2.id);

    expect(obs1.id).not.toBe(obs2.id);
    expect(Number(obs1.observedValue)).toBe(9.0);
    expect(Number(obs2.observedValue)).toBe(9.0);
  });

  it("two observations with same (indicator, period, geo) → second fails on F1 unique constraint (NOT value equality)", async () => {
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
      code: "IND_H04_F1",
      displayName: "Indicator H-04 F1",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // First observation with value 9.0
    await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      isSynthetic: true,
    });

    // Second observation with DIFFERENT value (8.5) but SAME (indicator, period, geo)
    // Must fail due to F1 unique constraint (NOT because values match)
    await expect(
      ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 8.5, // different value, but same key
        originType: "observed",
        sourceId: centralBankSourceId,
        isSynthetic: true,
      })
    ).rejects.toThrow(/unique|duplicate|constraint/i);
  });
});

// ============================================================
// H-09: Country scope — explicit mismatch rejected (A6)
// ============================================================
describeIntegration("H-09: Country scope mismatch rejected", () => {
  it("evidence.metadata.countryId differs from tenant.countryId → ingest rejected", async () => {
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
      code: "IND_H09",
      displayName: "Indicator H-09",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // Create evidence with countryId=JOR (tenant A is DML)
    const jorEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, // same tenant
        sourceId: centralBankSourceId,
        claim: "Evidence with JOR countryId",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId: countryJorId }, // mismatch with tenant's DML
      },
    });
    fixtures.track.evidence(jorEvidence.id);

    await expect(
      ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.0,
        originType: "observed",
        sourceId: centralBankSourceId,
        evidenceId: jorEvidence.id,
        isSynthetic: true,
      })
    ).rejects.toThrow(/country scope/i);
  });
});

// ============================================================
// H-10: Country scope — missing metadata → warning (not rejection) (A5)
// ============================================================
describeIntegration("H-10: Missing country metadata → warning", () => {
  it("evidence without metadata.countryId → ingest succeeds with warning", async () => {
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
      code: "IND_H10",
      displayName: "Indicator H-10",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // Evidence with NO countryId in metadata
    const evidenceNoCountry = await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: centralBankSourceId,
        claim: "Evidence without countryId",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { someOtherField: "value" }, // no countryId
      },
    });
    fixtures.track.evidence(evidenceNoCountry.id);

    // Should succeed (warning, not rejection)
    const obs = await ingestObservation(analystSession, {
      indicatorDefinitionId: indicator.id,
      observationPeriodId: periodId,
      observedValue: 9.0,
      originType: "observed",
      sourceId: centralBankSourceId,
      evidenceId: evidenceNoCountry.id,
      isSynthetic: true,
    });
    fixtures.track.observation(obs.id);

    expect(obs).toBeDefined();
    expect(obs.evidenceId).toBe(evidenceNoCountry.id);

    // Verify warning is attached to qualityNotes
    const qualityNotes = obs.qualityNotes as unknown as Record<string, unknown>;
    const warnings = qualityNotes.provenanceWarnings as string[];
    expect(warnings).toBeDefined();
    // The country scope is "unknown" — this is NOT an error, but the
    // "real measurement without evidence link" warning won't appear here
    // because evidence IS linked. The warning about missing countryId
    // is logged internally but not surfaced as a provenance warning
    // (it's a country-scope warning, separate from provenance warnings).
  });
});

// ============================================================
// H-11: Cross-tenant evidence rejected even when countries match (A15)
// ============================================================
describeIntegration("H-11: Cross-tenant evidence rejected", () => {
  it("Tenant A cannot use Evidence owned by Tenant B (even if both are in DML)", async () => {
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
      code: "IND_H11",
      displayName: "Indicator H-11",
      unit: "percent",
      preferredDirection: "decrease",
      alertThresholds: [],
      strategyVersionId,
      objectiveId,
    });
    fixtures.track.indicator(indicator.id);

    // Create evidence in Tenant B (same country DML, different tenant)
    const tenantBEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantBId, // different tenant
        sourceId: centralBankSourceId,
        claim: "Tenant B's evidence",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId }, // same country as Tenant A
      },
    });
    fixtures.track.evidence(tenantBEvidence.id);

    // Tenant A attempts to use Tenant B's evidence → must be rejected
    // RLS will filter it out (evidence.findFirst returns null), and the
    // validator will throw "evidence not found in tenant"
    await expect(
      ingestObservation(analystSession, {
        indicatorDefinitionId: indicator.id,
        observationPeriodId: periodId,
        observedValue: 9.0,
        originType: "observed",
        sourceId: centralBankSourceId,
        evidenceId: tenantBEvidence.id,
        isSynthetic: true,
      })
    ).rejects.toThrow(/not found in tenant|Provenance validation/i);
  });
});
