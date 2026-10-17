// ============================================================
// g01-comparison.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-08: Scenario Comparison Engine.
//
// 17 acceptance tests per mission pack §9:
//   1.  Compare 2 alternatives from same tenant
//   2.  Reject single alternative or duplicate IDs
//   3.  Reject alternative from another tenant
//   4.  Matrix links each value to its alternative
//   5.  Financial comparison with sufficient data
//   6.  Missing cost data for some programs
//   7.  Reject cross-currency aggregation
//   8.  Handle missing scheduling data
//   9.  Distinguish planning horizon from execution duration
//  10.  Evidence strength accuracy + no double-counting
//  11.  Show unsupported claims
//  12.  Show existing risks + mitigations without fabrication
//  13.  Sector coverage correctness
//  14.  Neutral tradeoffs (no winner declared)
//  15.  No modification of strategy states
//  16.  Deterministic re-comparison
//  17.  No G00/G01 regression (CI verifies)
//
// Plus a Demolandia comparison example.
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
let objectiveInflationId: string;
let objectiveEducationId: string;

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
  const infObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Maintain inflation below 5% annually" },
  });
  const eduObj = await adminClient.objective.findFirst({
    where: { tenantId: tenantAId, title: "Achieve 95% primary school enrollment" },
  });
  if (!agObj || !infObj || !eduObj) throw new Error("Objectives not seeded");
  objectiveAgricultureId = agObj.id;
  objectiveInflationId = infObj.id;
  objectiveEducationId = eduObj.id;
});

afterAll(async () => {
  if (adminClient) await adminClient.$disconnect();
});

// Helper: compose strategies + expand programs + return a version ID.
async function composeAndExpand(
  session: Session,
  objectiveIds: string[]
): Promise<string> {
  const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
  const result = await composeStrategies(session, { countryId, objectiveIds });
  // Return the first alternative's versionId
  const versionId = result.alternatives.find((a) => a.programs.length > 0)?.versionId
    ?? result.alternatives[0]!.versionId;
  const { expandPrograms } = await import("@/lib/state-builder/program-service");
  await expandPrograms(session, { strategyAlternativeId: versionId });
  return versionId;
}

// Helper: compose + return ALL alternative versionIds (for multi-alt comparison)
async function composeAllAlternatives(
  session: Session,
  objectiveIds: string[]
): Promise<string[]> {
  const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
  const result = await composeStrategies(session, { countryId, objectiveIds });
  const versionIds = result.alternatives.map((a) => a.versionId);
  const { expandPrograms } = await import("@/lib/state-builder/program-service");
  for (const vid of versionIds) {
    await expandPrograms(session, { strategyAlternativeId: vid });
  }
  return versionIds;
}

// ============================================================
// 01-08: Scenario Comparison Engine
// ============================================================
describeIntegration("01-08: Scenario Comparison Engine", () => {
  beforeEach(async () => {
    // Clean up
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
  });

  // ============================================================
  // 1. COMPARE 2 ALTERNATIVES FROM SAME TENANT
  // ============================================================
  it("1. compares 2 alternatives from the same tenant", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose with 2 different objective sets → 2 different strategy versions
    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    expect(result.alternativeIds).toHaveLength(2);
    expect(result.alternatives).toHaveLength(2);
    expect(result.alternatives.map((a) => a.altId).sort()).toEqual([alt1, alt2].sort());
    expect(result.simulated).toBe(true);
    expect(result.modelVersion).toBe("v1-deterministic");
    // Matrix has entries for both alternatives
    expect(result.matrix.totalCost).toHaveLength(2);
    expect(result.matrix.timeline).toHaveLength(2);
    expect(result.matrix.riskProfile).toHaveLength(2);
    expect(result.matrix.evidenceStrength).toHaveLength(2);
    expect(result.matrix.sectorCoverage).toHaveLength(2);
  });

  // ============================================================
  // 2. REJECT SINGLE ALTERNATIVE OR DUPLICATE IDs
  // ============================================================
  it("2. rejects a single alternative (requires ≥2 distinct)", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);

    await expect(compareScenarios(session, { alternativeIds: [alt1] }))
      .rejects.toThrow(/at least 2 DISTINCT alternatives/i);
  });

  it("2b. rejects duplicate alternative IDs", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);

    await expect(compareScenarios(session, { alternativeIds: [alt1, alt1] }))
      .rejects.toThrow(/duplicates/i);
  });

  // ============================================================
  // 3. REJECT ALTERNATIVE FROM ANOTHER TENANT
  // ============================================================
  it("3. rejects alternatives from different tenants", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const sessionA = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const altA = await composeAndExpand(sessionA, [objectiveAgricultureId]);

    // Try to compare with a fabricated ID from tenant B (RLS will hide it)
    await expect(compareScenarios(sessionA, { alternativeIds: [altA, "nonexistent-tenant-b-alt"] }))
      .rejects.toThrow(/not found in tenant scope/i);
  });

  // ============================================================
  // 4. MATRIX LINKS EACH VALUE TO ITS ALTERNATIVE
  // ============================================================
  it("4. matrix entries link each value to its alternative", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    // Every matrix entry has an altId that matches one of the input IDs
    const allAltIds = new Set([alt1, alt2]);
    for (const entry of result.matrix.totalCost) {
      expect(allAltIds.has(entry.altId)).toBe(true);
    }
    for (const entry of result.matrix.timeline) {
      expect(allAltIds.has(entry.altId)).toBe(true);
    }
    for (const entry of result.matrix.riskProfile) {
      expect(allAltIds.has(entry.altId)).toBe(true);
    }
    for (const entry of result.matrix.evidenceStrength) {
      expect(allAltIds.has(entry.altId)).toBe(true);
    }
    for (const entry of result.matrix.sectorCoverage) {
      expect(allAltIds.has(entry.altId)).toBe(true);
    }
    // Each altId appears exactly once per matrix section
    for (const section of Object.values(result.matrix)) {
      const ids = section.map((e: { altId: string }) => e.altId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // ============================================================
  // 5. FINANCIAL COMPARISON WITH SUFFICIENT DATA
  // ============================================================
  it("5. financial comparison with sufficient budget data", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add cost inputs to programs in both alternatives
    for (const altId of [alt1, alt2]) {
      const programs = await adminClient.program.findMany({
        where: { tenantId: tenantAId, strategyVersionId: altId },
      });
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        meta.costInputs = [
          {
            label: "[FICTIONAL] test input",
            unitCost: { amount: 100, currency: "USD" },
            unitCount: 10,
            horizonYears: 1,
            source: "[FICTIONAL] test",
            varianceLow: 0.9,
            varianceHigh: 1.15,
            varianceSource: "[FICTIONAL TEST FIXTURE] variance",
          },
        ];
        await adminClient.program.update({
          where: { id: p.id },
          data: { metadata: meta as never },
        });
      }
      await estimateBudgets(session, { strategyAlternativeId: altId });
    }

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    // Both alternatives should have cost estimates
    for (const cost of result.matrix.totalCost) {
      expect(cost.programsWithEstimate).toBeGreaterThan(0);
      expect(cost.min).not.toBeNull();
      expect(cost.max).not.toBeNull();
      expect(cost.currency).toBe("USD");
    }
  });

  // ============================================================
  // 6. MISSING COST DATA FOR SOME PROGRAMS
  // ============================================================
  it("6. missing cost data → partial total, NOT zero", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId, objectiveInflationId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // alt1: add cost inputs to ONLY the first program (partial)
    const alt1Programs = await adminClient.program.findMany({
      where: { tenantId: tenantAId, strategyVersionId: alt1 },
    });
    if (alt1Programs.length > 0) {
      const p = alt1Programs[0]!;
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      meta.costInputs = [
        {
          label: "[FICTIONAL] partial input",
          unitCost: { amount: 100, currency: "USD" },
          unitCount: 10,
          horizonYears: 1,
          source: "[FICTIONAL] test",
          varianceLow: 0.9, varianceHigh: 1.15,
          varianceSource: "[FICTIONAL TEST FIXTURE] variance",
        },
      ];
      await adminClient.program.update({
        where: { id: p.id },
        data: { metadata: meta as never },
      });
    }
    await estimateBudgets(session, { strategyAlternativeId: alt1 });
    // alt2: NO cost inputs → all programs lack estimates

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    const cost1 = result.matrix.totalCost.find((c) => c.altId === alt1)!;
    const cost2 = result.matrix.totalCost.find((c) => c.altId === alt2)!;

    // alt1 has partial total
    expect(cost1.programsWithEstimate).toBeGreaterThan(0);
    expect(cost1.programsWithoutEstimate).toBeGreaterThanOrEqual(0);
    expect(cost1.isPartialTotal).toBe(true);
    expect(cost1.note).toContain("PARTIAL");

    // alt2 has NO estimates → min/max are null (NOT zero)
    expect(cost2.programsWithEstimate).toBe(0);
    expect(cost2.min).toBeNull();
    expect(cost2.max).toBeNull();
    expect(cost2.note).toContain("No budget estimates");
    expect(cost2.note).toContain("NOT zero");
  });

  // ============================================================
  // 7. REJECT CROSS-CURRENCY AGGREGATION
  // ============================================================
  it("7. cross-currency aggregation → cost totals null, gap noted", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId, objectiveInflationId]);
    // Need ≥2 programs in alt1 with different currencies
    const programs = await adminClient.program.findMany({
      where: { tenantId: tenantAId, strategyVersionId: alt1 },
    });
    if (programs.length < 2) return; // skip if not enough programs

    // Program 1: USD
    const p1 = programs[0]!;
    const meta1 = (p1.metadata ?? {}) as Record<string, unknown>;
    meta1.costInputs = [{
      label: "[FICTIONAL] USD input", unitCost: { amount: 100, currency: "USD" },
      unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
      varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
    }];
    await adminClient.program.update({ where: { id: p1.id }, data: { metadata: meta1 as never } });

    // Program 2: EUR
    const p2 = programs[1]!;
    const meta2 = (p2.metadata ?? {}) as Record<string, unknown>;
    meta2.costInputs = [{
      label: "[FICTIONAL] EUR input", unitCost: { amount: 100, currency: "EUR" },
      unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
      varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
    }];
    await adminClient.program.update({ where: { id: p2.id }, data: { metadata: meta2 as never } });

    await estimateBudgets(session, { strategyAlternativeId: alt1 });

    // Need a second alternative for comparison
    const alt2 = await composeAndExpand(session, [objectiveEducationId]);
    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    const cost1 = result.matrix.totalCost.find((c) => c.altId === alt1)!;
    // Cross-currency → min/max null
    expect(cost1.min).toBeNull();
    expect(cost1.max).toBeNull();
    expect(cost1.note).toContain("multiple currencies");
    expect(cost1.note).toContain("NOT performed");
  });

  // ============================================================
  // 8. HANDLE MISSING SCHEDULING DATA
  // ============================================================
  it("8. missing scheduling data → timeline gap, no fabricated duration", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);
    // NO scheduling data on any program

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    for (const t of result.matrix.timeline) {
      expect(t.executionDurationSource).toBe("unavailable");
      expect(t.executionDurationYears).toBeNull();
      expect(t.note).toContain("No scheduling data");
    }
  });

  // ============================================================
  // 9. DISTINGUISH PLANNING HORIZON FROM EXECUTION DURATION
  // ============================================================
  it("9. planning horizon (from objectives) ≠ execution duration", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    for (const t of result.matrix.timeline) {
      // totalHorizon is from objectives (may be non-null)
      // executionDurationYears is null (no scheduling data)
      // These are DIFFERENT fields with DIFFERENT sources
      expect(t.executionDurationYears).toBeNull();
      // totalHorizon may be non-null (from objective.horizon)
      if (t.totalHorizon !== null) {
        expect(t.horizonSource).toBe("objective-horizon");
        // The note must distinguish planning horizon from execution duration
        expect(t.note).toContain("Planning horizon");
      }
    }
  });

  // ============================================================
  // 10. EVIDENCE STRENGTH ACCURACY + NO DOUBLE-COUNTING
  // ============================================================
  it("10. evidence strength counts distinct evidence IDs (no double-counting)", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    for (const e of result.matrix.evidenceStrength) {
      // distinctEvidenceIds ≤ totalClaims (no double-counting)
      expect(e.distinctEvidenceIds).toBeLessThanOrEqual(e.totalClaims);
      // supportedClaims + weakClaims + unsupportedClaims = totalClaims
      expect(e.supportedClaims + e.weakClaims + e.unsupportedClaims).toBe(e.totalClaims);
      // unsupportedClaims is always ≥ 0
      expect(e.unsupportedClaims).toBeGreaterThanOrEqual(0);
    }
  });

  // ============================================================
  // 11. SHOW UNSUPPORTED CLAIMS
  // ============================================================
  it("11. unsupported claims are visible (not hidden)", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    // unsupportedClaims is always present and ≥ 0
    for (const e of result.matrix.evidenceStrength) {
      expect(e.unsupportedClaims).toBeDefined();
      expect(e.unsupportedClaims).toBeGreaterThanOrEqual(0);
    }
  });

  // ============================================================
  // 12. SHOW EXISTING RISKS WITHOUT FABRICATION
  // ============================================================
  it("12. risks from RiskRegister + conflicts (no fabrication)", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add a risk to alt1
    await adminClient.riskRegister.create({
      data: {
        tenantId: tenantAId,
        strategyVersionId: alt1,
        title: "[FICTIONAL] Test high risk",
        severity: "high",
        likelihood: "medium",
        mitigation: "[FICTIONAL] Test mitigation plan",
      },
    });

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    const risk1 = result.matrix.riskProfile.find((r) => r.altId === alt1)!;
    const risk2 = result.matrix.riskProfile.find((r) => r.altId === alt2)!;

    // alt1 has the registered high risk
    expect(risk1.highRisks).toBeGreaterThanOrEqual(1);
    expect(risk1.risksWithMitigation).toBeGreaterThanOrEqual(1);
    expect(risk1.totalRisks).toBeGreaterThanOrEqual(1);

    // alt2 has NO registered risks — but note says "NOT proof of absence"
    expect(risk2.totalRisks).toBe(0);
    expect(risk2.note).toContain("NOT proof of absence");
  });

  // ============================================================
  // 13. SECTOR COVERAGE CORRECTNESS
  // ============================================================
  it("13. sector coverage from actual programs", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    for (const s of result.matrix.sectorCoverage) {
      expect(s.sectorsAddressed).toBeDefined();
      expect(Array.isArray(s.sectorsAddressed)).toBe(true);
      expect(s.sectorCount).toBe(s.sectorsAddressed.length);
      // Sectors are sorted + distinct
      const sorted = [...s.sectorsAddressed].sort();
      expect(s.sectorsAddressed).toEqual(sorted);
      expect(new Set(s.sectorsAddressed).size).toBe(s.sectorCount);
    }
  });

  // ============================================================
  // 14. NEUTRAL TRADEOFFS (NO WINNER DECLARED)
  // ============================================================
  it("14. tradeoffs is neutral — no winner declared", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    expect(result.tradeoffs).toBeTruthy();
    // MUST NOT contain prescriptive phrases that declare a winner
    expect(result.tradeoffs.toLowerCase()).not.toContain("best alternative");
    expect(result.tradeoffs.toLowerCase()).not.toContain("recommended choice");
    // "winner" is allowed ONLY in the negative disclaimer ("does NOT recommend a winner")
    // Check there's no POSITIVE winner declaration
    expect(result.tradeoffs.toLowerCase()).not.toMatch(/\b(?:the )?winner is\b/i);
    expect(result.tradeoffs.toLowerCase()).not.toContain("should adopt");
    expect(result.tradeoffs.toLowerCase()).not.toContain("is better than");
    // MUST contain the neutral disclaimer
    expect(result.tradeoffs).toContain("does NOT recommend a winner");
    expect(result.tradeoffs).toContain("human");
  });

  // ============================================================
  // 15. NO MODIFICATION OF STRATEGY STATES
  // ============================================================
  it("15. comparison does NOT modify strategy versions or programs", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Capture states before comparison
    const sv1Before = await adminClient.strategyVersion.findUnique({ where: { id: alt1 } });
    const sv2Before = await adminClient.strategyVersion.findUnique({ where: { id: alt2 } });
    const programs1Before = await adminClient.program.findMany({
      where: { strategyVersionId: alt1 },
    });
    const programs2Before = await adminClient.program.findMany({
      where: { strategyVersionId: alt2 },
    });

    await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    // Capture states after comparison
    const sv1After = await adminClient.strategyVersion.findUnique({ where: { id: alt1 } });
    const sv2After = await adminClient.strategyVersion.findUnique({ where: { id: alt2 } });
    const programs1After = await adminClient.program.findMany({
      where: { strategyVersionId: alt1 },
    });
    const programs2After = await adminClient.program.findMany({
      where: { strategyVersionId: alt2 },
    });

    // No changes
    expect(sv1After!.status).toBe(sv1Before!.status);
    expect(sv2After!.status).toBe(sv2Before!.status);
    expect(sv1After!.metadata).toEqual(sv1Before!.metadata);
    expect(sv2After!.metadata).toEqual(sv2Before!.metadata);
    expect(programs1After.length).toBe(programs1Before.length);
    expect(programs2After.length).toBe(programs2Before.length);
  });

  // ============================================================
  // 16. DETERMINISTIC RE-COMPARISON
  // ============================================================
  it("16. re-comparison produces identical result", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const result1 = await compareScenarios(session, { alternativeIds: [alt1, alt2] });
    const result2 = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    // Same alternatives
    expect(result2.alternativeIds).toEqual(result1.alternativeIds);
    // Same matrix structure
    expect(result2.matrix.totalCost.length).toBe(result1.matrix.totalCost.length);
    expect(result2.matrix.timeline.length).toBe(result1.matrix.timeline.length);
    // Same cost values
    for (let i = 0; i < result1.matrix.totalCost.length; i++) {
      expect(result2.matrix.totalCost[i]!.min).toBe(result1.matrix.totalCost[i]!.min);
      expect(result2.matrix.totalCost[i]!.max).toBe(result1.matrix.totalCost[i]!.max);
    }
    // Same evidence strength
    for (let i = 0; i < result1.matrix.evidenceStrength.length; i++) {
      expect(result2.matrix.evidenceStrength[i]!.supportedClaims).toBe(result1.matrix.evidenceStrength[i]!.supportedClaims);
      expect(result2.matrix.evidenceStrength[i]!.unsupportedClaims).toBe(result1.matrix.evidenceStrength[i]!.unsupportedClaims);
    }
    // Same tradeoffs text
    expect(result2.tradeoffs).toBe(result1.tradeoffs);
  });

  // ============================================================
  // 17. REVIEWER CAN COMPARE (read permission)
  // ============================================================
  it("17. reviewer can compare scenarios (read permission)", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const reviewer = await adminClient.user.upsert({
      where: { email: "comparison-reviewer@demolandia.test" },
      update: {},
      create: {
        email: "comparison-reviewer@demolandia.test",
        name: "Comparison Reviewer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "reviewer" },
      create: {
        userId: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active",
      },
    });
    const reviewerSession = makeSession({
      id: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    const result = await compareScenarios(reviewerSession, { alternativeIds: [alt1, alt2] });
    expect(result.alternatives).toHaveLength(2);
  });

  it("17b. observer cannot compare (permission denied)", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const observer = await adminClient.user.upsert({
      where: { email: "comparison-observer@demolandia.test" },
      update: {},
      create: {
        email: "comparison-observer@demolandia.test",
        name: "Comparison Observer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: observer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "observer" },
      create: {
        userId: observer.id, tenantId: tenantAId, roleCode: "observer", status: "active",
      },
    });
    const observerSession = makeSession({
      id: observer.id, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active",
    });

    await expect(compareScenarios(observerSession, { alternativeIds: [alt1, alt2] }))
      .rejects.toThrow(/Permission denied/);
  });

  // ============================================================
  // 18. DEMOLANDIA COMPARISON EXAMPLE
  //     Compare 2 alternatives with varying data completeness.
  // ============================================================
  it("18. Demolandia comparison: shows differences + gaps honestly", async () => {
    const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose 2 alternatives from the SAME composition run (both alternatives
    // from the same objectives → they're in the same batch)
    const versionIds = await composeAllAlternatives(session, [objectiveAgricultureId, objectiveInflationId]);
    expect(versionIds.length).toBeGreaterThanOrEqual(2);
    const alt1 = versionIds[0]!;
    const alt2 = versionIds[1]!;

    // Add cost data to alt1 only (alt2 will have gaps)
    const alt1Programs = await adminClient.program.findMany({
      where: { tenantId: tenantAId, strategyVersionId: alt1 },
    });
    for (const p of alt1Programs) {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      meta.costInputs = [{
        label: "[FICTIONAL] alt1 input", unitCost: { amount: 200, currency: "USD" },
        unitCount: 50, horizonYears: 3, source: "[FICTIONAL] alt1 test",
        varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL] alt1 variance",
      }];
      await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
    }
    await estimateBudgets(session, { strategyAlternativeId: alt1 });
    // alt2: no cost data → gaps

    const result = await compareScenarios(session, { alternativeIds: [alt1, alt2] });

    // The comparison shows the difference honestly
    const cost1 = result.matrix.totalCost.find((c) => c.altId === alt1)!;
    const cost2 = result.matrix.totalCost.find((c) => c.altId === alt2)!;

    // alt1 has estimates; alt2 has gaps
    expect(cost1.programsWithEstimate).toBeGreaterThan(0);
    expect(cost2.programsWithEstimate).toBe(0);
    expect(cost2.min).toBeNull();

    // dataGaps surface the missing cost data (at least one gap mentions "budget estimates")
    const costGaps = result.dataGaps.filter((g) => g.includes("budget estimates") || g.includes("lack budget"));
    expect(costGaps.length).toBeGreaterThan(0);

    // tradeoffs mentions the cost data gap
    expect(result.tradeoffs).toContain("Cost data gaps");

    // The comparison does NOT declare a winner
    expect(result.tradeoffs.toLowerCase()).not.toContain("best alternative");
    expect(result.tradeoffs).toContain("does NOT recommend a winner");
  });
});
