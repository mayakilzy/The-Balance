// ============================================================
// g01-budget.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-06: Budget & Financing Estimates (Conditional).
//
// 14 acceptance tests per mission pack §7:
//   1.  Program without cost data → insufficient data
//   2.  Reliable/simulated cost inputs → reproducible min/max range
//   3.  Never a point estimate (always min/max)
//   4.  No cost from program name/sector alone
//   5.  Reject invalid range (min > max caught)
//   6.  Currency + horizon handling
//   7.  No fabricated financing sources
//   8.  Assumptions + input provenance documented
//   9.  modelVersion recorded
//  10.  simulated: true always
//  11.  Tenant + alternative isolation
//  12.  Idempotent re-run (no duplicates)
//  13.  Concurrency (no partial storage)
//  14.  No G00/G01 regression (CI verifies)
//
// Plus Demolandia Case A (missing data) + Case B (simulated inputs) examples.
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

// Helper: compose strategies + expand programs + return a version ID + programs.
async function setupAlternativeWithPrograms(
  session: Session,
  objectiveIds: string[]
): Promise<{ versionId: string; programs: Array<{ programId: string; title: string; sector: string }> }> {
  const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
  const result = await composeStrategies(session, { countryId, objectiveIds });
  const best = result.alternatives.reduce(
    (best, a) => a.programs.length > best.programs.length ? a : best,
    result.alternatives[0]!
  );
  const versionId = best.versionId;
  const { expandPrograms } = await import("@/lib/state-builder/program-service");
  const expanded = await expandPrograms(session, { strategyAlternativeId: versionId });
  return {
    versionId,
    programs: expanded.programs.map((p) => ({ programId: p.programId, title: p.title, sector: p.sector })),
  };
}

// Helper: write costInputs into a program's metadata (simulating analyst input).
async function setProgramCostInputs(
  programId: string,
  costInputs: unknown,
  financingSources?: unknown
): Promise<void> {
  const program = await adminClient.program.findUnique({ where: { id: programId } });
  if (!program) throw new Error(`Program ${programId} not found`);
  const meta = (program.metadata ?? {}) as Record<string, unknown>;
  if (costInputs !== undefined) meta.costInputs = costInputs;
  if (financingSources !== undefined) meta.financingSources = financingSources;
  await adminClient.program.update({
    where: { id: programId },
    data: { metadata: meta as never },
  });
}

// Helper: clear costInputs from a program's metadata.
async function clearProgramCostInputs(programId: string): Promise<void> {
  await setProgramCostInputs(programId, []);
}

// ============================================================
// 01-06: Budget & Financing Estimates
// ============================================================
describeIntegration("01-06: Budget & Financing Estimates", () => {
  beforeEach(async () => {
    // Clean up: budget lines, dependencies, programs, tasks, strategies
    await adminClient.budgetLine.deleteMany({ where: { tenantId: tenantAId } });
    await adminClient.dependency.deleteMany({ where: { tenantId: tenantAId } });
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
  // 1. PROGRAM WITHOUT COST DATA → INSUFFICIENT DATA
  // ============================================================
  it("1. program with no cost inputs returns 'insufficient data for estimate'", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    expect(programs.length).toBeGreaterThan(0);

    // No costInputs written to any program — default state
    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });

    // ALL programs should be in insufficientData (no cost inputs anywhere)
    expect(result.estimates.length).toBe(0);
    expect(result.insufficientData.length).toBe(programs.length);
    expect(result.summary.estimated).toBe(0);
    expect(result.summary.insufficient).toBe(programs.length);

    // Each insufficient entry has a clear reason + gaps list
    for (const entry of result.insufficientData) {
      expect(entry.programId).toBeTruthy();
      expect(entry.programTitle).toBeTruthy();
      expect(entry.reason).toBeTruthy();
      expect(entry.gaps.length).toBeGreaterThan(0);
      expect(entry.gaps[0]).toContain("no costInputs");
    }

    // NO budget line should be stored for insufficient-data programs
    const dbLines = await adminClient.budgetLine.findMany({
      where: { tenantId: tenantAId },
    });
    expect(dbLines.length).toBe(0);
  });

  // ============================================================
  // 2. EXPLICIT SIMULATED COST INPUTS → REPRODUCIBLE min/max RANGE
  // ============================================================
  it("2. explicit cost inputs produce a reproducible min/max range", async () => {
    const { estimateBudgets, validateCostInputs } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    expect(programs.length).toBeGreaterThan(0);

    // Write explicit cost inputs to the first program
    const targetProgram = programs[0]!;
    const costInputs = [
      {
        label: "extension services training",
        unitCost: { amount: 500, currency: "USD" },
        unitCount: 1000,
        horizonYears: 3,
        source: "[FICTIONAL FIXTURE] analyst-supplied test input",
        note: "1000 farmers × $500 training cost",
      },
      {
        label: "irrigation infrastructure",
        unitCost: { amount: 2000, currency: "USD" },
        unitCount: 50,
        horizonYears: 3,
        source: "[FICTIONAL FIXTURE] analyst-supplied test input",
        note: "50 irrigation units × $2000",
      },
    ];
    await setProgramCostInputs(targetProgram.programId, costInputs);

    // Verify the inputs validate cleanly
    const validationErrors = validateCostInputs(costInputs);
    expect(validationErrors.length).toBe(0);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });

    // The target program should have an estimate; others insufficient
    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();
    expect(estimate!.simulated).toBe(true);
    expect(estimate!.modelVersion).toBe("v1-deterministic");

    // Reproducible computation:
    //   Input 1: 500 * 1000 = 500000 base; min=500000*0.9=450000, max=500000*1.15=575000
    //   Input 2: 2000 * 50 = 100000 base; min=100000*0.9=90000, max=100000*1.15=115000
    //   Total: min=540000.00, max=690000.00
    expect(estimate!.costRange.min).toBe("540000.00");
    expect(estimate!.costRange.max).toBe("690000.00");
    expect(estimate!.costRange.currency).toBe("USD");
    expect(estimate!.costRange.horizonYears).toBe(3);

    // min <= max (ALWAYS — also enforced by DB CHECK)
    expect(parseFloat(estimate!.costRange.min)).toBeLessThanOrEqual(parseFloat(estimate!.costRange.max));
  });

  // ============================================================
  // 3. NEVER A POINT ESTIMATE (always min/max)
  // ============================================================
  it("3. cost range is always {min, max} — never a single point", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    // Even with a single cost input, variance multipliers ensure min < max
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "single line item",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();

    // min < max (variance multipliers produce a real range)
    expect(parseFloat(estimate!.costRange.min)).toBeLessThan(parseFloat(estimate!.costRange.max));

    // Even if the analyst overrides varianceLow=1, varianceHigh=1 (degenerate case),
    // we still store min AND max (both equal). We never return a single number.
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "degenerate line item",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
        varianceLow: 1,
        varianceHigh: 1,
      },
    ]);
    const result2 = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const estimate2 = result2.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate2).toBeDefined();
    expect(estimate2!.costRange.min).toBe(estimate2!.costRange.max); // both "1000.00"
    // Still a {min, max} object — never undefined
    expect(estimate2!.costRange.min).toBeDefined();
    expect(estimate2!.costRange.max).toBeDefined();
  });

  // ============================================================
  // 4. NO COST FROM PROGRAM NAME/SECTOR ALONE
  // ============================================================
  it("4. does not produce cost from program name or sector alone", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    expect(programs.length).toBeGreaterThan(0);

    // Programs have titles + sectors but NO costInputs — must not produce estimates
    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });

    expect(result.estimates.length).toBe(0);
    expect(result.insufficientData.length).toBe(programs.length);

    // The sector "agriculture" or title "Incremental reform program for agriculture"
    // must NOT trigger any fabricated estimate.
    for (const entry of result.insufficientData) {
      expect(entry.gaps[0]).toContain("no costInputs");
    }
  });

  // ============================================================
  // 5. REJECT INVALID RANGE (min > max prevented)
  // ============================================================
  it("5. rejects cost inputs where varianceLow > varianceHigh", async () => {
    const { validateCostInputs } = await import("@/lib/state-builder/budget-service");

    // varianceLow=1.2 > varianceHigh=0.8 — invalid
    const errors = validateCostInputs([
      {
        label: "invalid variance",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
        varianceLow: 1.2,
        varianceHigh: 0.8,
      },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("varianceLow") && e.includes("varianceHigh"))).toBe(true);
  });

  it("5b. rejects negative cost inputs", async () => {
    const { validateCostInputs } = await import("@/lib/state-builder/budget-service");

    const errors = validateCostInputs([
      {
        label: "negative cost",
        unitCost: { amount: -100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("non-negative"))).toBe(true);
  });

  it("5c. rejects invalid currency code", async () => {
    const { validateCostInputs } = await import("@/lib/state-builder/budget-service");

    const errors = validateCostInputs([
      {
        label: "bad currency",
        unitCost: { amount: 100, currency: "DOLLARS" }, // not 3-letter
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("ISO 4217"))).toBe(true);
  });

  it("5d. rejects zero or negative horizonYears", async () => {
    const { validateCostInputs } = await import("@/lib/state-builder/budget-service");

    const errors = validateCostInputs([
      {
        label: "zero horizon",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 0,
        source: "[FICTIONAL] test",
      },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("horizonYears"))).toBe(true);
  });

  // ============================================================
  // 6. CURRENCY + HORIZON HANDLING (no cross-currency aggregation)
  // ============================================================
  it("6. refuses to aggregate costs in different currencies", async () => {
    const { estimateBudgets, validateCostInputs } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    // Two inputs with different currencies — must be rejected
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "USD input",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
      {
        label: "EUR input",
        unitCost: { amount: 100, currency: "EUR" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    const errors = validateCostInputs([
      {
        label: "USD input",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
      {
        label: "EUR input",
        unitCost: { amount: 100, currency: "EUR" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);
    expect(errors.some((e) => e.includes("multiple currencies"))).toBe(true);

    // estimateBudgets should put this program in insufficientData
    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const entry = result.insufficientData.find((e) => e.programId === targetProgram.programId);
    expect(entry).toBeDefined();
    expect(entry!.gaps.some((g) => g.includes("currencies"))).toBe(true);
  });

  it("6b. refuses to aggregate costs with different horizonYears", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "input 1",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 2,
        source: "[FICTIONAL] test",
      },
      {
        label: "input 2",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 5,
        source: "[FICTIONAL] test",
      },
    ]);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const entry = result.insufficientData.find((e) => e.programId === targetProgram.programId);
    expect(entry).toBeDefined();
    expect(entry!.gaps.some((g) => g.includes("horizonYears"))).toBe(true);
  });

  // ============================================================
  // 7. NO FABRICATED FINANCING SOURCES
  // ============================================================
  it("7. does not fabricate financing sources", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    // Cost inputs but NO financing sources
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "test input",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();

    // financingSources must be empty (we don't fabricate)
    expect(estimate!.financingSources.length).toBe(0);

    // And an assumption surfaces the financing data gap
    const financingGapAssumption = estimate!.assumptions.find(
      (a) => a.source.includes("financing-data-gap")
    );
    expect(financingGapAssumption).toBeDefined();
    expect(financingGapAssumption!.description).toContain("No financing sources");
  });

  it("7b. accepts analyst-supplied financing sources with confidence + rationale", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    await setProgramCostInputs(
      targetProgram.programId,
      [
        {
          label: "test input",
          unitCost: { amount: 100, currency: "USD" },
          unitCount: 10,
          horizonYears: 1,
          source: "[FICTIONAL] test",
        },
      ],
      [
        {
          type: "treasury",
          description: "[FICTIONAL] Hypothetical treasury allocation",
          confidence: "low",
          confidenceRationale: "No real treasury commitment — fictional test fixture",
        },
      ]
    );

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();
    expect(estimate!.financingSources.length).toBe(1);
    expect(estimate!.financingSources[0]!.type).toBe("treasury");
    expect(estimate!.financingSources[0]!.confidence).toBe("low");
    expect(estimate!.financingSources[0]!.confidenceRationale).toBeTruthy();
  });

  // ============================================================
  // 8. ASSUMPTIONS + INPUT PROVENANCE DOCUMENTED
  // ============================================================
  it("8. assumptions document every input + model defaults for reproducibility", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "training",
        unitCost: { amount: 500, currency: "USD" },
        unitCount: 100,
        horizonYears: 2,
        source: "[FICTIONAL] analyst-supplied input #1",
      },
      {
        label: "infrastructure",
        unitCost: { amount: 2000, currency: "USD" },
        unitCount: 10,
        horizonYears: 2,
        source: "[FICTIONAL] analyst-supplied input #2",
      },
    ]);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();

    // At least N+3 assumptions: 2 per-input + model-default aggregation +
    // variance defaults + simulated-label. Each assumption has a source.
    expect(estimate!.assumptions.length).toBeGreaterThanOrEqual(5);
    for (const a of estimate!.assumptions) {
      expect(a.description).toBeTruthy();
      expect(a.source).toBeTruthy();
    }

    // Per-input assumptions reference the analyst-supplied source
    const inputAssumptions = estimate!.assumptions.filter(
      (a) => a.source.includes("analyst-supplied")
    );
    expect(inputAssumptions.length).toBe(2);

    // Model-default assumptions are present
    const modelDefaults = estimate!.assumptions.filter(
      (a) => a.source.includes("model-default")
    );
    expect(modelDefaults.length).toBeGreaterThanOrEqual(2);

    // At least one assumption mentions the variance multipliers (reproducibility)
    const varianceAssumption = estimate!.assumptions.find(
      (a) => a.description.includes("varianceLow") && a.description.includes("varianceHigh")
    );
    expect(varianceAssumption).toBeDefined();
  });

  // ============================================================
  // 9. modelVersion RECORDED
  // ============================================================
  it("9. modelVersion is recorded as v1-deterministic for reproducibility", async () => {
    const { estimateBudgets, BUDGET_MODEL_VERSION } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "test",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 1,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    expect(result.modelVersion).toBe("v1-deterministic");
    expect(BUDGET_MODEL_VERSION).toBe("v1-deterministic");

    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();
    expect(estimate!.modelVersion).toBe("v1-deterministic");

    // DB row also has the model version
    const dbLine = await adminClient.budgetLine.findFirst({
      where: { tenantId: tenantAId, programId: targetProgram.programId },
    });
    expect(dbLine).toBeDefined();
    expect(dbLine!.modelVersion).toBe("v1-deterministic");
  });

  // ============================================================
  // 10. simulated: true ALWAYS
  // ============================================================
  it("10. simulated: true is always set — never presented as real market data", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "test",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 1,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();
    expect(estimate!.simulated).toBe(true);

    // The simulated flag is also in the DB metadata
    const dbLine = await adminClient.budgetLine.findFirst({
      where: { tenantId: tenantAId, programId: targetProgram.programId },
    });
    const meta = (dbLine!.metadata ?? {}) as Record<string, unknown>;
    expect(meta.simulated).toBe(true);

    // And an assumption explicitly says the estimate is simulated
    const simulatedAssumption = estimate!.assumptions.find(
      (a) => a.description.includes("simulated") && a.description.includes("no real market data")
    );
    expect(simulatedAssumption).toBeDefined();
  });

  // ============================================================
  // 11. TENANT + ALTERNATIVE ISOLATION
  // ============================================================
  it("11. rejects estimateBudgets for a strategy version in a different tenant", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const sessionA = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose in tenant A
    const setupA = await setupAlternativeWithPrograms(sessionA, [objectiveAgricultureId]);

    // Try to estimate budgets for tenant A's strategy version using tenant B's session
    // (Need a tenant B analyst — create one if not exists)
    const tenantBAnalyst = await adminClient.user.upsert({
      where: { email: "tenant-b-budget-analyst@demolandia.test" },
      update: {},
      create: {
        email: "tenant-b-budget-analyst@demolandia.test",
        name: "Tenant B Budget Analyst",
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
    const sessionB = makeSession({
      id: tenantBAnalyst.id, tenantId: tenantBId, roleCode: "analyst", membershipStatus: "active",
    });

    // Tenant B's RLS will not see tenant A's strategy version → must throw
    await expect(estimateBudgets(sessionB, { strategyAlternativeId: setupA.versionId }))
      .rejects.toThrow(/not found in tenant scope/);
  });

  it("11b. observer cannot compute budgets (permission denied)", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const { versionId } = await setupAlternativeWithPrograms(session, [objectiveAgricultureId]);

    // Create an observer user
    const observer = await adminClient.user.upsert({
      where: { email: "budget-observer@demolandia.test" },
      update: {},
      create: {
        email: "budget-observer@demolandia.test",
        name: "Budget Observer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: observer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "observer" },
      create: {
        userId: observer.id,
        tenantId: tenantAId,
        roleCode: "observer",
        status: "active",
      },
    });
    const observerSession = makeSession({
      id: observer.id, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active",
    });

    await expect(estimateBudgets(observerSession, { strategyAlternativeId: versionId }))
      .rejects.toThrow(/Permission denied/);
  });

  // ============================================================
  // 12. IDEMPOTENT RE-RUN (no duplicates)
  // ============================================================
  it("12. re-running estimateBudgets does not create duplicate budget lines", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "test",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    // First run
    const result1 = await estimateBudgets(session, { strategyAlternativeId: versionId });
    expect(result1.estimates.length).toBe(1);

    // Second run (same version)
    const result2 = await estimateBudgets(session, { strategyAlternativeId: versionId });
    expect(result2.estimates.length).toBe(1);

    // DB has exactly ONE budget line for this program
    const dbLines = await adminClient.budgetLine.findMany({
      where: { tenantId: tenantAId, programId: targetProgram.programId },
    });
    expect(dbLines.length).toBe(1);

    // The line was updated (not duplicated) — same id
    expect(dbLines[0]!.id).toBeDefined();
  });

  // ============================================================
  // 13. CONCURRENCY (no partial storage)
  // ============================================================
  it("13. concurrent estimateBudgets calls do not create duplicates or partials", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "test",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    // Launch two concurrent estimateBudgets calls
    const [result1, result2] = await Promise.all([
      estimateBudgets(session, { strategyAlternativeId: versionId }),
      estimateBudgets(session, { strategyAlternativeId: versionId }),
    ]);

    // Both should return the same estimate (idempotent upsert)
    expect(result1.estimates.length).toBe(1);
    expect(result2.estimates.length).toBe(1);
    expect(result1.estimates[0]!.costRange.min).toBe(result2.estimates[0]!.costRange.min);

    // DB has exactly ONE budget line (upsert on unique key)
    const dbLines = await adminClient.budgetLine.findMany({
      where: { tenantId: tenantAId, programId: targetProgram.programId },
    });
    expect(dbLines.length).toBe(1);
  });

  // ============================================================
  // 14. NO G00/G01 REGRESSION — getBudgets read path
  // ============================================================
  it("14. getBudgets returns stored estimates (read path + permissions)", async () => {
    const { estimateBudgets, getBudgets } = await import("@/lib/state-builder/budget-service");
    const analystSession = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      analystSession, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "test",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10,
        horizonYears: 1,
        source: "[FICTIONAL] test",
      },
    ]);

    await estimateBudgets(analystSession, { strategyAlternativeId: versionId });

    // Analyst can read (budget:read permission)
    const readResult = await getBudgets(analystSession, versionId);
    expect(readResult.length).toBe(1);
    expect(readResult[0]!.programId).toBe(targetProgram.programId);
    expect(readResult[0]!.costRange.min).toBe("900.00"); // 100*10*0.9
    expect(readResult[0]!.costRange.max).toBe("1150.00"); // 100*10*1.15
    expect(readResult[0]!.simulated).toBe(true);

    // Reviewer can read (budget:read)
    const reviewer = await adminClient.user.upsert({
      where: { email: "budget-reviewer@demolandia.test" },
      update: {},
      create: {
        email: "budget-reviewer@demolandia.test",
        name: "Budget Reviewer",
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
    const reviewerRead = await getBudgets(reviewerSession, versionId);
    expect(reviewerRead.length).toBe(1);

    // Observer cannot read (no budget:read permission)
    const observer = await adminClient.user.upsert({
      where: { email: "budget-observer-2@demolandia.test" },
      update: {},
      create: {
        email: "budget-observer-2@demolandia.test",
        name: "Budget Observer 2",
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
    await expect(getBudgets(observerSession, versionId)).rejects.toThrow(/Permission denied/);
  });

  // ============================================================
  // 15. DEMOLANDIA CASE A — Missing Data (no fabrication)
  // ============================================================
  it("15. Demolandia Case A: real program with no cost inputs → insufficient data, no fabricated number", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    expect(programs.length).toBeGreaterThan(0);

    // NO cost inputs written — Demolandia's natural state
    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });

    // Every program is in insufficientData
    expect(result.estimates.length).toBe(0);
    expect(result.insufficientData.length).toBe(programs.length);

    // The summary clearly states "insufficient"
    expect(result.summary.estimated).toBe(0);
    expect(result.summary.insufficient).toBe(programs.length);
    expect(result.summary.currencies.length).toBe(0);

    // No budget lines stored
    const dbLines = await adminClient.budgetLine.findMany({ where: { tenantId: tenantAId } });
    expect(dbLines.length).toBe(0);

    // Each insufficient entry clearly explains what's missing
    for (const entry of result.insufficientData) {
      expect(entry.gaps.some((g) => g.includes("no costInputs"))).toBe(true);
    }
  });

  // ============================================================
  // 16. DEMOLANDIA CASE B — Explicit Simulated Inputs (reproducible range)
  // ============================================================
  it("16. Demolandia Case B: explicit simulated inputs → reproducible range, labeled simulated", async () => {
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    // Explicit simulated cost inputs — the analyst documents every input.
    // These are FICTIONAL test fixtures, labeled simulated: true.
    await setProgramCostInputs(targetProgram.programId, [
      {
        label: "[FICTIONAL] extension training",
        unitCost: { amount: 500, currency: "USD" },
        unitCount: 200,
        horizonYears: 3,
        source: "[FICTIONAL FIXTURE] Demolandia Case B test input",
        note: "200 farmers × $500 training",
      },
      {
        label: "[FICTIONAL] seed distribution",
        unitCost: { amount: 50, currency: "USD" },
        unitCount: 5000,
        horizonYears: 3,
        source: "[FICTIONAL FIXTURE] Demolandia Case B test input",
        note: "5000 seed kits × $50",
      },
    ]);

    const result = await estimateBudgets(session, { strategyAlternativeId: versionId });
    const estimate = result.estimates.find((e) => e.programId === targetProgram.programId);
    expect(estimate).toBeDefined();

    // Reproducible computation:
    //   Input 1: 500 * 200 = 100000; min=90000, max=115000
    //   Input 2: 50 * 5000 = 250000; min=225000, max=287500
    //   Total: min=315000.00, max=402500.00
    expect(estimate!.costRange.min).toBe("315000.00");
    expect(estimate!.costRange.max).toBe("402500.00");
    expect(estimate!.costRange.currency).toBe("USD");
    expect(estimate!.costRange.horizonYears).toBe(3);

    // Explicitly labeled simulated — not presented as real
    expect(estimate!.simulated).toBe(true);

    // Assumptions document every input + the model
    expect(estimate!.assumptions.length).toBeGreaterThanOrEqual(4);

    // The estimate surfaces the institution + mandate gaps as limitations
    // (Demolandia programs have institutionAssignmentGap=true + mandateGap=true
    // from 01-04 FIX-1)
    expect(estimate!.institutionAssignmentGap).toBe(true);
    expect(estimate!.mandateGap).toBe(true);

    // The DB row is stored
    const dbLine = await adminClient.budgetLine.findFirst({
      where: { tenantId: tenantAId, programId: targetProgram.programId },
    });
    expect(dbLine).toBeDefined();
    expect(dbLine!.minAmount.toString()).toBe("315000.00");
    expect(dbLine!.maxAmount.toString()).toBe("402500.00");
    expect(dbLine!.currency).toBe("USD");
    expect(dbLine!.horizonYears).toBe(3);
  });
});
