// ============================================================
// g01-gap-analysis.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-02: Gap Analysis Engine.
//
// Per ADR-0015 + mission pack §4 (Acceptance Tests):
//   1. Baseline LOW → Gap unknown
//   2. Unparsed indicator → no fabricated numeric gap
//   3. Reliable indicator + matching units → correctly computed gap
//   4. Unit mismatch → unknown (incomparable)
//   5. Multiple objectives in same sector → organized report
//   6. Contradictory evidence → shown + restricts conclusion
//   7. Cross-tenant isolation
//   8. Unauthorized access rejected
//   9. Task integrity after crash/restore (idempotency)
//   10. Recompute when inputs change
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

// Objective IDs (fetched from seed)
let objectiveAgricultureId: string; // measurable gap (FULL + matching)
let objectiveInflationId: string; // partial gap (PARTIAL + matching)
let objectiveEducationId: string; // unknown gap (LOW baseline)
let objectiveUnemploymentId: string; // unknown gap (no matching indicator)

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

  // Fetch objective IDs by title
  const agObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Increase agricultural GDP growth to 6% annually" },
  });
  const infObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Maintain inflation below 5% annually" },
  });
  const eduObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Achieve 95% primary school enrollment" },
  });
  const unempObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Reduce unemployment to 10% within 5 years" },
  });
  if (!agObj || !infObj || !eduObj || !unempObj) throw new Error("Objectives not seeded");
  objectiveAgricultureId = agObj.id;
  objectiveInflationId = infObj.id;
  objectiveEducationId = eduObj.id;
  objectiveUnemploymentId = unempObj.id;
});

afterAll(async () => {
  if (adminClient) await adminClient.$disconnect();
});

// Helper: ensure a baseline exists for Tenant A before gap tests
async function ensureBaseline(session: Session) {
  const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
  await computeBaseline(session, { countryId });
}

// ============================================================
// 1. GAP CLASSIFICATION — measurable / partial / unknown
// ============================================================
describeIntegration("Gap classification (measurable / partial / unknown)", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
  });

  it("agriculture objective → partial gap (FULL baseline + matching indicator + counter-evidence)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    const gap = report.gaps.find((g) => g.objectiveId === objectiveAgricultureId);
    expect(gap).toBeTruthy();
    // FIX-3: agriculture has counter-evidence (Reuters + AP about crop yield decline)
    // → FULL observability but counter-evidence for the metric → downgraded to 'partial'
    // FINAL CLOSURE: gapSize is null (no arbitrary number from disputed value)
    expect(gap!.gapType).toBe("partial");
    expect(gap!.gapSize).toBeNull(); // FINAL CLOSURE: no arbitrary gap from counter-evidence
    expect(gap!.gapDirection).toBeNull(); // direction also unknown when disputed
    expect(gap!.unitMatch).toBe(true);
    expect(gap!.currentValue).toContain("4.2%");
    // Notes should explain the downgrade
    expect(gap!.notes.some((n) => n.includes("Counter-evidence") || n.includes("counter"))).toBe(true);
    expect(report.summary.structuralGaps).toContain(objectiveAgricultureId);
  });

  it("inflation objective → partial gap (PARTIAL baseline + matching indicator)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveInflationId],
    });

    const gap = report.gaps.find((g) => g.objectiveId === objectiveInflationId);
    expect(gap).toBeTruthy();
    expect(gap!.gapType).toBe("partial");
    expect(gap!.gapSize).toBeTruthy();
    // Current 7.2% vs target 5% → gap = 2.2 pp above target
    expect(gap!.gapDirection).toBe("above");
    expect(gap!.notes.some((n) => n.includes("PARTIAL"))).toBe(true);
    expect(report.summary.structuralGaps).toContain(objectiveInflationId);
  });

  it("education objective → unknown gap (LOW baseline, no evidence)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveEducationId],
    });

    const gap = report.gaps.find((g) => g.objectiveId === objectiveEducationId);
    expect(gap).toBeTruthy();
    expect(gap!.gapType).toBe("unknown");
    expect(gap!.gapSize).toBeNull();
    expect(gap!.currentMode).toBe("LOW");
    expect(gap!.notes.some((n) => n.includes("unknown") || n.includes("LOW"))).toBe(true);
    expect(report.summary.unknownGaps).toContain(objectiveEducationId);
  });

  it("unemployment objective → unknown gap (no matching indicator in finance sector)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveUnemploymentId],
    });

    const gap = report.gaps.find((g) => g.objectiveId === objectiveUnemploymentId);
    expect(gap).toBeTruthy();
    expect(gap!.gapType).toBe("unknown");
    expect(gap!.gapSize).toBeNull();
    // The objective targets "unemployment_rate" but finance sector has "inflation_rate"
    expect(gap!.notes.some((n) => n.includes("No indicator") || n.includes("matches"))).toBe(true);
  });
});

// ============================================================
// 2. UNPARSED INDICATOR → no fabricated gap
// ============================================================
describeIntegration("Unparsed indicator → no fabricated numeric gap", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[GAP-UNPARSED-TEST]" } },
    });
    await adminClient.objective.deleteMany({
      where: { title: { contains: "[GAP-UNPARSED-TEST]" } },
    });
  });

  it("indicator with unparsed value → gap is unknown (no fabricated number)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Add evidence with a claim that has NO percentage and NO qualitative word
    // → extractIndicatorValue returns "unparsed"
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[GAP-UNPARSED-TEST] Demolandia's governance index was documented in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: {
          countryId, sector: "governance_unparsed_test",
          indicatorName: "governance_index", fictional: true,
        },
      } as never,
    });

    // Add CountryPackConfig sector for the test sector
    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "governance_unparsed_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["governance_unparsed_test"] as never,
        observability: {} as never, planningAssumptions: {} as never,
        metadata: {} as never,
      },
    });

    // Create a test objective with targetValue = "85%"
    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-UNPARSED-TEST] Achieve governance index of 85%",
        targetMetric: "governance_index",
        targetValue: "85%",
        horizon: 5,
        status: "active",
        createdBy: adminUserId,
        metadata: { sector: "governance_unparsed_test", fictional: true },
      } as never,
    });

    // Add a second evidence from a different source to make the sector FULL
    // (so the only reason for unknown is the unparsed indicator value)
    const testSource = await adminClient.source.upsert({
      where: { code: "GAP-UNPARSED-SRC" },
      update: {},
      create: {
        code: "GAP-UNPARSED-SRC",
        displayName: "Gap Unparsed Test Source",
        type: "academic",
        independenceGroup: "gap-unparsed-group",
      },
    });
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: testSource.id,
        claim: "[GAP-UNPARSED-TEST] Another governance observation was noted in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: {
          countryId, sector: "governance_unparsed_test",
          indicatorName: "governance_index", fictional: true,
        },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();
    expect(gap!.gapType).toBe("unknown");
    expect(gap!.gapSize).toBeNull();
    // The value must NOT be a fabricated number
    expect(gap!.currentValue).toContain("unparsed");
    expect(gap!.notes.some((n) => n.includes("unparsed") || n.includes("unknown"))).toBe(true);

    // Clean up
    await adminClient.source.deleteMany({ where: { code: "GAP-UNPARSED-SRC" } });
  });
});

// ============================================================
// 3. UNIT MISMATCH → unknown (incomparable)
// ============================================================
describeIntegration("Unit mismatch → unknown (incomparable)", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[GAP-UNIT-TEST]" } },
    });
    await adminClient.objective.deleteMany({
      where: { title: { contains: "[GAP-UNIT-TEST]" } },
    });
  });

  it("current value is % but target value is plain number → unknown", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Add evidence with a percentage value
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[GAP-UNIT-TEST] Demolandia's exports_test grew 12.5% in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: {
          countryId, sector: "exports_unit_test",
          indicatorName: "exports_growth_rate", fictional: true,
        },
      } as never,
    });
    // Add a second source for FULL
    const testSource = await adminClient.source.upsert({
      where: { code: "GAP-UNIT-SRC" },
      update: {},
      create: {
        code: "GAP-UNIT-SRC", displayName: "Gap Unit Test Source",
        type: "academic", independenceGroup: "gap-unit-group",
      },
    });
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        sourceId: testSource.id,
        claim: "[GAP-UNIT-TEST] Exports_test confirmed at 12.3% growth.",
        type: "supporting", verificationStatus: "corroborated",
        metadata: {
          countryId, sector: "exports_unit_test",
          indicatorName: "exports_growth_rate", fictional: true,
        },
      } as never,
    });

    // Add config sector
    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "exports_unit_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["exports_unit_test"] as never,
        observability: {} as never, planningAssumptions: {} as never, metadata: {} as never,
      },
    });

    // Create objective with targetValue = "5000" (plain number, NOT %)
    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-UNIT-TEST] Reach 5000 exports",
        targetMetric: "exports_growth_rate",
        targetValue: "5000", // plain number — NOT a percentage
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "exports_unit_test", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();
    expect(gap!.gapType).toBe("unknown");
    expect(gap!.gapSize).toBeNull();
    expect(gap!.unitMatch).toBe(false);
    // FINAL CLOSURE: bare number "5000" without metadata.unit → "unverified"
    // (percentage "12.5%" vs plain-number-unverified "5000" → unknown)
    expect(gap!.notes.some((n) => n.includes("Unit mismatch") || n.includes("unverified") || n.includes("Unit"))).toBe(true);

    // Clean up
    await adminClient.source.deleteMany({ where: { code: "GAP-UNIT-SRC" } });
  });
});

// ============================================================
// 4. MULTIPLE OBJECTIVES IN SAME SECTOR → organized report
// ============================================================
describeIntegration("Multiple objectives in same sector → organized report", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    await adminClient.objective.deleteMany({
      where: { title: { contains: "[GAP-MULTI-TEST]" } },
    });
  });

  it("two objectives in finance sector → separate gap items, no mixing", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Create two objectives in the finance sector
    const obj1 = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-MULTI-TEST] Reduce inflation to 4%",
        targetMetric: "inflation_rate",
        targetValue: "4%",
        horizon: 2, status: "active", createdBy: adminUserId,
        metadata: { sector: "finance", fictional: true },
      } as never,
    });
    const obj2 = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-MULTI-TEST] Reduce inflation to 3%",
        targetMetric: "inflation_rate",
        targetValue: "3%",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "finance", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj1.id, obj2.id],
    });

    // Both objectives should appear as separate gap items
    expect(report.gaps.length).toBe(2);
    const gap1 = report.gaps.find((g) => g.objectiveId === obj1.id);
    const gap2 = report.gaps.find((g) => g.objectiveId === obj2.id);
    expect(gap1).toBeTruthy();
    expect(gap2).toBeTruthy();

    // Both in finance sector
    expect(gap1!.sector).toBe("finance");
    expect(gap2!.sector).toBe("finance");

    // Different gap sizes (4% vs 3% targets, current 7.2%)
    // finance sector has no counter-evidence → gapSize is computed (PARTIAL baseline)
    expect(gap1!.gapSize).toContain("3.2");
    expect(gap2!.gapSize).toContain("4.2");

    // Different objective IDs (no mixing)
    expect(gap1!.objectiveId).not.toBe(gap2!.objectiveId);
  });
});

// ============================================================
// 5. CONTRADICTORY EVIDENCE → shown + restricts conclusion
// ============================================================
describeIntegration("Contradictory evidence → shown + restricts conclusion", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
  });

  it("agriculture objective shows counter-evidence as blocker + notes the contradiction", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    const gap = report.gaps.find((g) => g.objectiveId === objectiveAgricultureId);
    expect(gap).toBeTruthy();

    // Agriculture sector has counter-evidence (Reuters + AP about crop yield decline)
    expect(gap!.counterEvidence.length).toBeGreaterThanOrEqual(1);

    // Counter-evidence should appear as a blocker
    const evidenceBackedBlockers = gap!.blockers.filter((b) => !b.isAssumption && b.evidenceId !== null);
    expect(evidenceBackedBlockers.length).toBeGreaterThanOrEqual(1);

    // Notes should mention that no causal relationship is asserted
    expect(gap!.notes.some((n) => n.includes("causal") || n.includes("correlation"))).toBe(true);
  });
});

// ============================================================
// 6. CROSS-TENANT ISOLATION
// ============================================================
describeIntegration("Cross-tenant gap analysis isolation", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] } },
    });
  });

  it("Tenant B cannot read Tenant A's gap analysis task", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps, getGapTask } = await import("@/lib/state-builder/gap-analysis-service");

    // Tenant A computes baseline + gaps
    const sessionA = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    await computeBaseline(sessionA, { countryId });
    const { taskId } = await computeGaps(sessionA, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    // Tenant B creates a user + tries to read Tenant A's task
    const tenantBUser = await adminClient.user.create({
      data: {
        email: "gap-xtenant-01-02@demolandia.test",
        name: "Gap Cross-Tenant User",
        passwordHash: await hashPassword("test_gap_xtenant"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: { userId: tenantBUser.id, tenantId: tenantBId, roleCode: "analyst", status: "active" },
    });
    const sessionB = makeSession({
      id: tenantBUser.id, tenantId: tenantBId, roleCode: "analyst", membershipStatus: "active",
    });

    try {
      await expect(getGapTask(sessionB, taskId)).rejects.toThrow(/not found in tenant scope/i);
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: tenantBUser.id, tenantId: tenantBId } },
      });
      await adminClient.user.delete({ where: { id: tenantBUser.id } });
    }
  });

  it("Tenant A's gap report contains ONLY Tenant A's objectives (not Tenant B's)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });

    // Fetch ALL of Tenant A's objectives
    const objectives = await adminClient.objective.findMany({
      where: { tenantId: tenantAId },
    });
    const objectiveIds = objectives.map((o) => o.id);

    const { report } = await computeGaps(session, { countryId, objectiveIds });

    // All gap items should reference Tenant A's objectives only
    for (const gap of report.gaps) {
      expect(objectiveIds).toContain(gap.objectiveId);
    }

    // Tenant B has 2 objectives (FX reserves, monetary base) — they must NOT appear
    const tenantBObjectives = await adminClient.objective.findMany({
      where: { tenantId: tenantBId },
    });
    const tenantBIds = tenantBObjectives.map((o) => o.id);
    for (const gap of report.gaps) {
      expect(tenantBIds).not.toContain(gap.objectiveId);
    }
  });
});

// ============================================================
// 7. PERMISSIONS
// ============================================================
describeIntegration("Gap analysis permissions", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
  });

  it("computeGaps rejects observer (no baseline:compute)", async () => {
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");

    const observerUser = await adminClient.user.create({
      data: {
        email: "gap-observer-01-02@demolandia.test",
        name: "Gap Observer",
        passwordHash: await hashPassword("test_gap_observer"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: { userId: observerUser.id, tenantId: tenantAId, roleCode: "observer", status: "active" },
    });
    const session = makeSession({
      id: observerUser.id, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active",
    });

    try {
      await expect(
        computeGaps(session, { countryId, objectiveIds: [objectiveAgricultureId] })
      ).rejects.toThrow(/Permission denied: baseline:compute/);
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: observerUser.id, tenantId: tenantAId } },
      });
      await adminClient.user.delete({ where: { id: observerUser.id } });
    }
  });

  it("getGapTask rejects observer (no gap:read)", async () => {
    const { getGapTask } = await import("@/lib/state-builder/gap-analysis-service");

    const observerUser = await adminClient.user.create({
      data: {
        email: "gap-reader-01-02@demolandia.test",
        name: "Gap Reader Observer",
        passwordHash: await hashPassword("test_gap_reader"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: { userId: observerUser.id, tenantId: tenantAId, roleCode: "observer", status: "active" },
    });
    const session = makeSession({
      id: observerUser.id, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active",
    });

    try {
      await expect(
        getGapTask(session, "any-task-id")
      ).rejects.toThrow(/Permission denied: gap:read/);
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: observerUser.id, tenantId: tenantAId } },
      });
      await adminClient.user.delete({ where: { id: observerUser.id } });
    }
  });
});

// ============================================================
// 8. IDEMPOTENCY + RECOMPUTE WHEN INPUTS CHANGE
// ============================================================
describeIntegration("Gap analysis idempotency + recompute", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
  });

  it("re-computing gaps with same inputs returns the same task (idempotent)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });

    const result1 = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });
    const result2 = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    expect(result2.taskId).toBe(result1.taskId);
    expect(result2.report.gaps.length).toBe(result1.report.gaps.length);
  });

  it("re-computing gaps after objective change produces a new report", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });

    // First computation
    const result1 = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    // Modify the objective (change targetValue)
    await adminClient.objective.update({
      where: { id: objectiveAgricultureId },
      data: { targetValue: "7%" }, // was "6%"
    });

    // Second computation — should produce a NEW task (fingerprint changed)
    const result2 = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    expect(result2.taskId).not.toBe(result1.taskId);

    // The new report should reflect the updated target
    const gap2 = result2.report.gaps.find((g) => g.objectiveId === objectiveAgricultureId);
    expect(gap2!.targetValue).toBe("7%");
    // FINAL CLOSURE: agriculture has counter-evidence → gapSize is null (no arbitrary number)
    expect(gap2!.gapSize).toBeNull();

    // Restore the objective
    await adminClient.objective.update({
      where: { id: objectiveAgricultureId },
      data: { targetValue: "6%" },
    });
  });

  it("FIX-2: gap analysis computes a fresh baseline if none exists (no failure)", async () => {
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // FIX-2: computeGaps now calls computeBaseline() internally — if no baseline
    // exists, it computes one on-the-fly instead of failing.
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    // Should succeed (baseline was computed automatically)
    expect(report).toBeTruthy();
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(report.baselineTaskId).toBeTruthy();
  });
});

// ============================================================
// 9. REPORT STRUCTURE + HONESTY
// ============================================================
describeIntegration("Gap report structure + honesty", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
  });

  it("report includes honesty block + baseline reference", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveEducationId],
    });

    expect(report.honesty).toBeTruthy();
    expect(report.honesty.fictional).toBe(true);
    expect(report.honesty.computedBy).toBe("gap-engine-v1");
    expect(report.honesty.rulesVersion).toBe("adr-0015-v1");
    expect(report.baselineTaskId).toBeTruthy();
  });

  it("Demolandia example: partial gap (agriculture, counter-evidence) + unknown gap (education)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveEducationId],
    });

    // Agriculture: partial gap (FINAL CLOSURE: counter-evidence → gapSize=null)
    const agGap = report.gaps.find((g) => g.objectiveId === objectiveAgricultureId);
    expect(agGap!.gapType).toBe("partial");
    expect(agGap!.gapSize).toBeNull(); // FINAL CLOSURE: no arbitrary number
    expect(agGap!.currentValue).toContain("4.2%");

    // Education: unknown gap
    const eduGap = report.gaps.find((g) => g.objectiveId === objectiveEducationId);
    expect(eduGap!.gapType).toBe("unknown");
    expect(eduGap!.gapSize).toBeNull();
    expect(eduGap!.currentMode).toBe("LOW");

    // Summary
    expect(report.summary.structuralGaps).toContain(objectiveAgricultureId);
    expect(report.summary.unknownGaps).toContain(objectiveEducationId);
  });
});
