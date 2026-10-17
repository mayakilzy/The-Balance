// ============================================================
// g01-gap-analysis-fix.integration.test.ts
// ------------------------------------------------------------
// 01-02-FIX: Gap Integrity Closure
// Tests for the 3 fixes requested by ChatGPT's review:
//
// FIX-1: Country/Objectives Integrity
//   - Objectives from a different country are rejected (not silently included)
//   - Non-existent objective IDs are rejected (not silently dropped)
//
// FIX-2: Fresh Baseline Dependency
//   - Gap analysis uses a fresh baseline (not stale)
//   - Adding evidence after baseline → gap analysis recomputes baseline → fresh gaps
//   - Changing CountryPackConfig → fresh baseline → fresh gaps
//
// FIX-3: Scientific Gap Calculation Integrity
//   - Conflicting indicator readings → partial (not measurable)
//   - Counter-evidence for same metric → partial (FULL ≠ undisputed)
//   - Non-% values with units (e.g., "42 units") → incomparable
//   - Strict numeric parsing (no extracting 2024 from mixed strings)
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
let objectiveAgricultureId: string;

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

  const agObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Increase agricultural GDP growth to 6% annually" },
  });
  if (!agObj) throw new Error("Agriculture objective not seeded");
  objectiveAgricultureId = agObj.id;
});

afterAll(async () => {
  if (adminClient) await adminClient.$disconnect();
});

// ============================================================
// FIX-1: Country/Objectives Integrity
// ============================================================
describeIntegration("FIX-1: Country/Objectives Integrity", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    await adminClient.objective.deleteMany({
      where: { title: { contains: "[GAP-FIX1-TEST]" } },
    });
  });

  it("rejects objectives from a different country (no silent inclusion)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Create a second fictional country
    const otherCountry = await adminClient.country.upsert({
      where: { iso3: "FX1" },
      update: {},
      create: {
        iso3: "FX1", iso2: "F1",
        displayName: "Fix1Testlandia (fictional)",
        status: "active",
      },
    });

    // Create an objective for the OTHER country (same tenant)
    const otherObj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId: otherCountry.id,
        title: "[GAP-FIX1-TEST] Objective for other country",
        targetMetric: "test_metric", targetValue: "50%",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "test_sector", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });

    // Try to compute gaps for Demolandia (country A) but include an objective
    // from the other country → must be rejected
    await expect(
      computeGaps(session, {
        countryId,
        objectiveIds: [objectiveAgricultureId, otherObj.id],
      })
    ).rejects.toThrow(/Country mismatch|different country/i);

    // Clean up
    await adminClient.objective.delete({ where: { id: otherObj.id } });
    await adminClient.country.delete({ where: { id: otherCountry.id } });
  });

  it("rejects non-existent objective IDs (no silent dropping)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    await computeBaseline(session, { countryId });

    // Use a fake objective ID that doesn't exist
    const fakeId = "cmv_nonexistent_objective_id_000";
    await expect(
      computeGaps(session, {
        countryId,
        objectiveIds: [objectiveAgricultureId, fakeId],
      })
    ).rejects.toThrow(/not found in tenant scope|integrity violation/i);
  });
});

// ============================================================
// FIX-2: Fresh Baseline Dependency
// ============================================================
describeIntegration("FIX-2: Fresh Baseline Dependency", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[GAP-FIX2-TEST]" } },
    });
  });

  it("gap analysis recomputes baseline when new evidence is added", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // 1. Compute baseline + gaps (initial state)
    await computeBaseline(session, { countryId });
    const result1 = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    // 2. Add NEW evidence for agriculture sector (changes the baseline fingerprint)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[GAP-FIX2-TEST] Demolandia agricultural GDP grew 5.0% in 2024 (new evidence).",
        type: "supporting",
        verificationStatus: "verified",
        metadata: {
          countryId, sector: "agriculture",
          indicatorName: "agricultural_gdp_growth_rate", fictional: true,
        },
      } as never,
    });

    // 3. Compute gaps again — FIX-2 should trigger a fresh baseline (new evidence → new fingerprint)
    //    The gap report should reflect the updated baseline
    const result2 = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    // The baseline task IDs should be different (fresh baseline was computed)
    expect(result2.report.baselineTaskId).not.toBe(result1.report.baselineTaskId);
    // The gap task IDs should also be different
    expect(result2.taskId).not.toBe(result1.taskId);
  });

  it("gap analysis with unchanged inputs reuses cached baseline + gap task (idempotent)", async () => {
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

    // No changes → same baseline + same gap task
    const result2 = await computeGaps(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
    });

    expect(result2.report.baselineTaskId).toBe(result1.report.baselineTaskId);
    expect(result2.taskId).toBe(result1.taskId);
  });
});

// ============================================================
// FIX-3: Scientific Gap Calculation Integrity
// ============================================================
describeIntegration("FIX-3: Scientific Gap Calculation Integrity", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[GAP-FIX3-TEST]" } },
    });
    await adminClient.objective.deleteMany({
      where: { title: { contains: "[GAP-FIX3-TEST]" } },
    });
    await adminClient.source.deleteMany({
      where: { code: { contains: "GAP-FIX3-SRC" } },
    });
  });

  it("conflicting indicator readings → partial (not measurable)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Create 2 sources for FULL observability
    const src1 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-1", displayName: "Fix3 Source 1",
        type: "academic", independenceGroup: "fix3-group-1",
      },
    });
    const src2 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-2", displayName: "Fix3 Source 2",
        type: "academic", independenceGroup: "fix3-group-2",
      },
    });

    // Add 2 evidence with the SAME metric but DIFFERENT values (4.2% vs 5.5%)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src1.id,
        claim: "[GAP-FIX3-TEST] Fix3 conflict metric was 4.2% in 2024.",
        type: "supporting", verificationStatus: "verified",
        metadata: {
          countryId, sector: "fix3_conflict_test",
          indicatorName: "fix3_conflict_metric", fictional: true,
        },
      } as never,
    });
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src2.id,
        claim: "[GAP-FIX3-TEST] Fix3 conflict metric was 5.5% in 2024.",
        type: "supporting", verificationStatus: "corroborated",
        metadata: {
          countryId, sector: "fix3_conflict_test",
          indicatorName: "fix3_conflict_metric", fictional: true,
        },
      } as never,
    });

    // Add config sector
    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "fix3_conflict_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["fix3_conflict_test"] as never,
        observability: {} as never, planningAssumptions: {} as never, metadata: {} as never,
      },
    });

    // Create an objective targeting the conflicting metric
    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-FIX3-TEST] Achieve fix3 conflict metric of 6%",
        targetMetric: "fix3_conflict_metric", targetValue: "6%",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "fix3_conflict_test", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();

    // FIX-3: Even though baseline is FULL (2 independent + verified), conflicting
    // readings (4.2% vs 5.5%) should downgrade to 'partial', not 'measurable'
    expect(gap!.gapType).toBe("partial");
    expect(gap!.notes.some((n) => n.includes("CONFLICT DETECTED") || n.includes("conflicting"))).toBe(true);
    // The gap size should still be computed (using the primary value) but with uncertainty
    expect(gap!.gapSize).toBeTruthy();
  });

  it("counter-evidence for same metric → partial (FULL ≠ undisputed)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Create 2 sources for FULL observability
    const src1 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-3", displayName: "Fix3 Source 3",
        type: "academic", independenceGroup: "fix3-group-3",
      },
    });
    const src2 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-4", displayName: "Fix3 Source 4",
        type: "academic", independenceGroup: "fix3-group-4",
      },
    });

    // Add supporting evidence (verified)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src1.id,
        claim: "[GAP-FIX3-TEST] Fix3 counter metric was 3.0% in 2024.",
        type: "supporting", verificationStatus: "verified",
        metadata: {
          countryId, sector: "fix3_counter_test",
          indicatorName: "fix3_counter_metric", fictional: true,
        },
      } as never,
    });
    // Add COUNTER evidence with the SAME metric name (directly contradicts)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src2.id,
        claim: "[GAP-FIX3-TEST] Fix3 counter metric actually declined, disputing the 3.0% figure.",
        type: "counter", verificationStatus: "disputed",
        metadata: {
          countryId, sector: "fix3_counter_test",
          indicatorName: "fix3_counter_metric", fictional: true,
        },
      } as never,
    });

    // Add config sector
    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "fix3_counter_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["fix3_counter_test"] as never,
        observability: {} as never, planningAssumptions: {} as never, metadata: {} as never,
      },
    });

    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-FIX3-TEST] Achieve fix3 counter metric of 5%",
        targetMetric: "fix3_counter_metric", targetValue: "5%",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "fix3_counter_test", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();

    // FIX-3: Counter-evidence for the same metric → partial, not measurable
    // (FULL observability means coverage, not that the value is undisputed)
    expect(gap!.gapType).toBe("partial");
    expect(gap!.notes.some((n) => n.includes("Counter-evidence") || n.includes("counter"))).toBe(true);
  });

  it("non-% values with text (e.g., '42 units') → incomparable", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const src1 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-5", displayName: "Fix3 Source 5",
        type: "academic", independenceGroup: "fix3-group-5",
      },
    });
    const src2 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-6", displayName: "Fix3 Source 6",
        type: "academic", independenceGroup: "fix3-group-6",
      },
    });

    // Evidence with a value that has units text ("42 units") — not a clean number
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src1.id,
        claim: "[GAP-FIX3-TEST] Fix3 units metric was 42 units in 2024.",
        type: "supporting", verificationStatus: "verified",
        metadata: {
          countryId, sector: "fix3_units_test",
          indicatorName: "fix3_units_metric",
          indicatorValue: "42 units", // structured value with units text
          fictional: true,
        },
      } as never,
    });
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src2.id,
        claim: "[GAP-FIX3-TEST] Fix3 units metric confirmed at 42 units.",
        type: "supporting", verificationStatus: "corroborated",
        metadata: {
          countryId, sector: "fix3_units_test",
          indicatorName: "fix3_units_metric",
          indicatorValue: "42 units",
          fictional: true,
        },
      } as never,
    });

    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "fix3_units_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["fix3_units_test"] as never,
        observability: {} as never, planningAssumptions: {} as never, metadata: {} as never,
      },
    });

    // Objective with a plain number target (50) — current value is "42 units" (not a clean number)
    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-FIX3-TEST] Achieve fix3 units metric of 50",
        targetMetric: "fix3_units_metric", targetValue: "50",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "fix3_units_test", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();

    // FIX-3: "42 units" is not a clean number → incomparable → unknown
    expect(gap!.gapType).toBe("unknown");
    expect(gap!.gapSize).toBeNull();
    expect(gap!.unitMatch).toBe(false);
    expect(gap!.notes.some((n) => n.includes("incomparable") || n.includes("Unit"))).toBe(true);
  });

  it("strict numeric parsing: '4.2%' → 4.2, '4.2 percent' → null (not 4.2)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const src1 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-7", displayName: "Fix3 Source 7",
        type: "academic", independenceGroup: "fix3-group-7",
      },
    });
    const src2 = await adminClient.source.create({
      data: {
        code: "GAP-FIX3-SRC-8", displayName: "Fix3 Source 8",
        type: "academic", independenceGroup: "fix3-group-8",
      },
    });

    // Evidence with structured value "4.2 percent" (not "4.2%" — no % sign)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src1.id,
        claim: "[GAP-FIX3-TEST] Fix3 parse metric was 4.2 percent in 2024.",
        type: "supporting", verificationStatus: "verified",
        metadata: {
          countryId, sector: "fix3_parse_test",
          indicatorName: "fix3_parse_metric",
          indicatorValue: "4.2 percent", // NOT "4.2%" — should be incomparable
          fictional: true,
        },
      } as never,
    });
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src2.id,
        claim: "[GAP-FIX3-TEST] Fix3 parse metric confirmed.",
        type: "supporting", verificationStatus: "corroborated",
        metadata: {
          countryId, sector: "fix3_parse_test",
          indicatorName: "fix3_parse_metric",
          indicatorValue: "4.2 percent",
          fictional: true,
        },
      } as never,
    });

    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "fix3_parse_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["fix3_parse_test"] as never,
        observability: {} as never, planningAssumptions: {} as never, metadata: {} as never,
      },
    });

    // Target is "5%" (clean percentage)
    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[GAP-FIX3-TEST] Achieve fix3 parse metric of 5%",
        targetMetric: "fix3_parse_metric", targetValue: "5%",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "fix3_parse_test", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();

    // FIX-3: "4.2 percent" is NOT "4.2%" → incomparable (different unit representation)
    // Target is "5%" (percentage), current is "4.2 percent" (incomparable — not clean %)
    expect(gap!.gapType).toBe("unknown");
    expect(gap!.gapSize).toBeNull();
    expect(gap!.notes.some((n) => n.includes("incomparable") || n.includes("Unit"))).toBe(true);
  });
});

// ============================================================
// FINAL SCIENTIFIC CLOSURE (01-02 Final)
// ============================================================
// Two final scientific fixes:
//   1. Conflicting readings must NOT produce an arbitrary gapSize
//   2. Bare numbers without explicit unit must NOT be assumed compatible
describeIntegration("Final Scientific Closure (01-02 Final)", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: { in: ["gap-analysis", "baseline-compute"] }, tenantId: tenantAId },
    });
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[FINAL-CLOSURE-TEST]" } },
    });
    await adminClient.objective.deleteMany({
      where: { title: { contains: "[FINAL-CLOSURE-TEST]" } },
    });
    await adminClient.source.deleteMany({
      where: { code: { contains: "FINAL-CLOSURE-SRC" } },
    });
  });

  it("1. conflicting readings do NOT produce an arbitrary gapSize (null instead)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Create 2 independent sources for FULL observability
    const src1 = await adminClient.source.create({
      data: {
        code: "FINAL-CLOSURE-SRC-1", displayName: "Final Closure Source 1",
        type: "academic", independenceGroup: "final-group-1",
      },
    });
    const src2 = await adminClient.source.create({
      data: {
        code: "FINAL-CLOSURE-SRC-2", displayName: "Final Closure Source 2",
        type: "academic", independenceGroup: "final-group-2",
      },
    });

    // Add 2 evidence with the SAME metric but DIFFERENT values (4.2% vs 5.5%)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src1.id,
        claim: "[FINAL-CLOSURE-TEST] Final conflict metric was 4.2% in 2024.",
        type: "supporting", verificationStatus: "verified",
        metadata: {
          countryId, sector: "final_conflict_test",
          indicatorName: "final_conflict_metric", fictional: true,
        },
      } as never,
    });
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src2.id,
        claim: "[FINAL-CLOSURE-TEST] Final conflict metric was 5.5% in 2024.",
        type: "supporting", verificationStatus: "corroborated",
        metadata: {
          countryId, sector: "final_conflict_test",
          indicatorName: "final_conflict_metric", fictional: true,
        },
      } as never,
    });

    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "final_conflict_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["final_conflict_test"] as never,
        observability: {} as never, planningAssumptions: {} as never, metadata: {} as never,
      },
    });

    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[FINAL-CLOSURE-TEST] Achieve final conflict metric of 6%",
        targetMetric: "final_conflict_metric", targetValue: "6%",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "final_conflict_test", fictional: true },
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();

    // FINAL CLOSURE FIX-1: conflicting readings → partial + gapSize=null
    expect(gap!.gapType).toBe("partial");
    expect(gap!.gapSize).toBeNull(); // No arbitrary number from a silent selection
    expect(gap!.gapDirection).toBeNull(); // Direction also unknown
    // Notes must explain the conflict + that no value was chosen
    expect(gap!.notes.some((n) => n.includes("CONFLICT DETECTED"))).toBe(true);
    expect(gap!.notes.some((n) => n.includes("gapSize is null") || n.includes("No single value"))).toBe(true);
  });

  it("2. bare numbers without explicit unit do NOT prove compatibility → unknown", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const { computeGaps } = await import("@/lib/state-builder/gap-analysis-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const src1 = await adminClient.source.create({
      data: {
        code: "FINAL-CLOSURE-SRC-3", displayName: "Final Closure Source 3",
        type: "academic", independenceGroup: "final-group-3",
      },
    });
    const src2 = await adminClient.source.create({
      data: {
        code: "FINAL-CLOSURE-SRC-4", displayName: "Final Closure Source 4",
        type: "academic", independenceGroup: "final-group-4",
      },
    });

    // Evidence with a bare number "42" (no %, no unit declared in metadata)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src1.id,
        claim: "[FINAL-CLOSURE-TEST] Final bare metric was 42 in 2024.",
        type: "supporting", verificationStatus: "verified",
        metadata: {
          countryId, sector: "final_bare_test",
          indicatorName: "final_bare_metric",
          indicatorValue: "42", // bare number — NO unit declared
          fictional: true,
        },
      } as never,
    });
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, sourceId: src2.id,
        claim: "[FINAL-CLOSURE-TEST] Final bare metric confirmed at 42.",
        type: "supporting", verificationStatus: "corroborated",
        metadata: {
          countryId, sector: "final_bare_test",
          indicatorName: "final_bare_metric",
          indicatorValue: "42",
          fictional: true,
        },
      } as never,
    });

    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId } },
      update: { sectors: ["agriculture", "finance", "education", "health", "final_bare_test"] as never },
      create: {
        tenantId: tenantAId, countryId,
        sectors: ["final_bare_test"] as never,
        observability: {} as never, planningAssumptions: {} as never, metadata: {} as never,
      },
    });

    // Target is also a bare number "50" (no unit)
    const obj = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId,
        title: "[FINAL-CLOSURE-TEST] Achieve final bare metric of 50",
        targetMetric: "final_bare_metric", targetValue: "50",
        horizon: 3, status: "active", createdBy: adminUserId,
        metadata: { sector: "final_bare_test", fictional: true }, // NO unit declared
      } as never,
    });

    await computeBaseline(session, { countryId });
    const { report } = await computeGaps(session, {
      countryId,
      objectiveIds: [obj.id],
    });

    const gap = report.gaps.find((g) => g.objectiveId === obj.id);
    expect(gap).toBeTruthy();

    // FINAL CLOSURE FIX-2: bare numbers without explicit unit → unknown
    // "42" and "50" are both plain numbers, but without metadata.unit we cannot
    // prove they're in the same unit — result must be 'unknown'
    expect(gap!.gapType).toBe("unknown");
    expect(gap!.gapSize).toBeNull();
    expect(gap!.notes.some((n) => n.includes("unverified") || n.includes("Bare numbers"))).toBe(true);
  });
});
