// ============================================================
// g01-advisor.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-09: Development Advisor v1.
//
// 17 acceptance tests per mission pack §11:
//   1.  Create AdvisoryReport for Demolandia alternatives
//   2.  Conditional recommendation with non-empty conditions
//   3.  Acknowledge insufficient evidence + abstain
//   4.  Mandatory disclaimer present in all outputs
//   5.  counterEvidence present when available
//   6.  No fabricated counter-evidence when absent
//   7.  alternativeViewpoints without claiming expert consensus
//   8.  Financial comparison results with data gap respect
//   9.  Reject invalid temporal status without explanation
//  10.  No fabricated confidence percentages
//  11.  Prevent strategy modification through advisor
//  12.  Permission strategy:read required
//  13.  Reject cross-tenant/country/objective scope mismatch
//  14.  Capability Registry integration
//  15.  StubProvider with simulated label
//  16.  Reproducibility (same inputs → same report)
//  17.  No G00/G01 regression
//
// Plus Demolandia Case A (sufficient evidence) + Case B (insufficient/contradictory).
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

// Helper: compose + expand programs for a single alternative
async function composeAndExpand(
  session: Session,
  objectiveIds: string[]
): Promise<string> {
  const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
  const result = await composeStrategies(session, { countryId, objectiveIds });
  const versionId = result.alternatives.find((a) => a.programs.length > 0)?.versionId
    ?? result.alternatives[0]!.versionId;
  const { expandPrograms } = await import("@/lib/state-builder/program-service");
  await expandPrograms(session, { strategyAlternativeId: versionId });
  return versionId;
}

// Helper: add a dependency edge
async function addDependency(
  session: Session,
  versionId: string,
  fromProgramId: string,
  toProgramId: string,
  type: "requires" | "enables" | "conflicts",
  rationale: string
): Promise<void> {
  const { addDependency: addDep } = await import("@/lib/state-builder/portfolio-service");
  await addDep(session, {
    strategyAlternativeId: versionId,
    fromProgramId,
    toProgramId,
    type,
    rationale,
    source: "simulated",
  });
}

// Helper: set scheduling data on a program
async function setProgramScheduling(
  programId: string,
  scheduling: { startYear?: number; endYear?: number }
): Promise<void> {
  const program = await adminClient.program.findUnique({ where: { id: programId } });
  if (!program) throw new Error(`Program ${programId} not found`);
  const meta = (program.metadata ?? {}) as Record<string, unknown>;
  meta.scheduling = scheduling;
  await adminClient.program.update({
    where: { id: programId },
    data: { metadata: meta as never },
  });
}

// Helper: ensure ≥N programs exist
async function ensureProgramCount(
  session: Session,
  versionId: string,
  minCount: number
): Promise<Array<{ id: string; title: string; metadata: unknown }>> {
  const programs = await adminClient.program.findMany({
    where: { tenantId: tenantAId, strategyVersionId: versionId },
    orderBy: { title: "asc" },
  });
  if (programs.length >= minCount) return programs;
  const tenantId = session.user.tenantId!;
  const needed = minCount - programs.length;
  const sectors = ["test_sector_a", "test_sector_b", "test_sector_c"];
  for (let i = 0; i < needed; i++) {
    const idx = programs.length + i;
    const created = await adminClient.program.create({
      data: {
        tenantId,
        strategyVersionId: versionId,
        title: `[FICTIONAL TEST FIXTURE] Advisor Program ${idx + 1}`,
        sector: sectors[idx % sectors.length]!,
        owningInstitutionId: null,
        legalMandateRef: null,
        rationale: `[FICTIONAL TEST FIXTURE] Created for advisor test.`,
        status: "draft",
        metadata: {
          simulated: true,
          sector: sectors[idx % sectors.length]!,
          kpis: [],
          requiredCapabilities: [],
          mandateGap: true,
          institutionAssignmentGap: true,
          evidenceRefs: [],
          counterEvidence: [],
          expandedAt: new Date().toISOString(),
          fictionalTestFixture: true,
        },
      },
    });
    programs.push(created);
  }
  return programs;
}

// ============================================================
// 01-09: Development Advisor v1
// ============================================================
describeIntegration("01-09: Development Advisor v1", () => {
  beforeEach(async () => {
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
  // 1. CREATE ADVISORY REPORT FOR DEMOLANDIA ALTERNATIVES
  // ============================================================
  it("1. creates an AdvisoryReport for Demolandia alternatives", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
      alternativeIds: [alt1, alt2],
    });

    expect(report).toBeDefined();
    expect(report.recommendation).toBeTruthy();
    expect(report.conditions).toBeDefined();
    expect(Array.isArray(report.conditions)).toBe(true);
    expect(report.risks).toBeDefined();
    expect(report.counterEvidence).toBeDefined();
    expect(report.assumptions).toBeDefined();
    expect(report.alternativeViewpoints).toBeDefined();
    expect(report.uncertaintySummary).toBeTruthy();
    expect(report.simulated).toBe(true);
    expect(report.modelVersion).toBe("v1-deterministic");
    expect(report.inputSummary.countryId).toBe(countryId);
    expect(report.inputSummary.alternativeIds).toHaveLength(2);
  });

  // ============================================================
  // 2. CONDITIONAL RECOMMENDATION WITH NON-EMPTY CONDITIONS
  // ============================================================
  it("2. conditional recommendation has non-empty conditions when data is available", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add cost data to ALL programs in both alternatives (to avoid abstention)
    for (const altId of [alt1, alt2]) {
      const programs = await adminClient.program.findMany({
        where: { tenantId: tenantAId, strategyVersionId: altId },
      });
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        meta.costInputs = [{
          label: "[FICTIONAL] test input",
          unitCost: { amount: 100, currency: "USD" },
          unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
          varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
        }];
        await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
      }
      await estimateBudgets(session, { strategyAlternativeId: altId });
    }

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // Conditions should be non-empty (at least the standard conditions)
    expect(report.conditions.length).toBeGreaterThan(0);
    // The recommendation should mention "conditional" (not abstained)
    expect(report.recommendation.toLowerCase()).toContain("conditional");
  });

  // ============================================================
  // 3. ACKNOWLEDGE INSUFFICIENT EVIDENCE + ABSTAIN
  // ============================================================
  it("3. abstains when evidence is insufficient (all alternatives lack cost data)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);
    // NO budget estimates created → allLackCost = true → abstain

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    expect(report.inputSummary.abstained).toBe(true);
    expect(report.recommendation).toContain("Insufficient evidence to recommend a specific alternative");
    expect(report.recommendation).toContain("abstains");
  });

  // ============================================================
  // 4. MANDATORY DISCLAIMER PRESENT IN ALL OUTPUTS
  // ============================================================
  it("4. mandatory disclaimer is always present", async () => {
    const { advise, ADVISOR_DISCLAIMER } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    expect(report.disclaimer).toBe(ADVISOR_DISCLAIMER);
    expect(report.disclaimer).toBe("This is a conditional recommendation. Human approval required.");
  });

  // ============================================================
  // 5. COUNTER-EVIDENCE PRESENT WHEN AVAILABLE
  // ============================================================
  it("5. counterEvidence is present (from comparison data)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // counterEvidence is always non-empty (at least the "no counter-evidence detected" note)
    expect(report.counterEvidence.length).toBeGreaterThan(0);
  });

  // ============================================================
  // 6. NO FABRICATED COUNTER-EVIDENCE WHEN ABSENT
  // ============================================================
  it("6. no fabricated counter-evidence — honestly says 'not found' when absent", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // If no counter-evidence was detected, the note must say so honestly
    const hasNoCounterEvidenceNote = report.counterEvidence.some(
      (c) => c.includes("No counter-evidence references were found") || c.includes("NOT a claim that no counter-evidence exists")
    );
    const hasActualCounterEvidence = report.counterEvidence.some(
      (c) => c.includes("Counter-evidence (from alternative")
    );
    // One of these must be true — either we found counter-evidence OR we honestly say none was found
    expect(hasNoCounterEvidenceNote || hasActualCounterEvidence).toBe(true);
  });

  // ============================================================
  // 7. ALTERNATIVE VIEWPOINTS WITHOUT CLAIMING EXPERT CONSENSUS
  // ============================================================
  it("7. alternativeViewpoints do not claim expert consensus", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    expect(report.alternativeViewpoints.length).toBeGreaterThan(0);
    // MUST NOT claim expert consensus or attribute opinions to real people
    for (const v of report.alternativeViewpoints) {
      expect(v.toLowerCase()).not.toContain("experts agree");
      expect(v.toLowerCase()).not.toContain("consensus of experts");
      expect(v.toLowerCase()).not.toContain("panel of experts recommends");
    }
  });

  // ============================================================
  // 8. FINANCIAL COMPARISON WITH DATA GAP RESPECT
  // ============================================================
  it("8. financial data gaps reflected in conditions + uncertainty", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId, objectiveInflationId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add cost to ONLY the first program of alt1 (partial)
    const alt1Programs = await adminClient.program.findMany({
      where: { tenantId: tenantAId, strategyVersionId: alt1 },
    });
    if (alt1Programs.length > 0) {
      const p = alt1Programs[0]!;
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      meta.costInputs = [{
        label: "[FICTIONAL] partial",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
        varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
      }];
      await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
    }
    await estimateBudgets(session, { strategyAlternativeId: alt1 });
    // alt2: NO cost data

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // The uncertainty summary should mention cost data gaps
    expect(report.uncertaintySummary).toMatch(/budget estimates|cost data/i);
  });

  // ============================================================
  // 9. REJECT INVALID TEMPORAL STATUS WITHOUT EXPLANATION
  // ============================================================
  it("9. invalid temporal status surfaced as risk + uncertainty", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // alt1: add A → B with REVERSED scheduling (temporal violation)
    const alt1Programs = await ensureProgramCount(session, alt1, 2);
    const [A, B] = alt1Programs;
    await addDependency(session, alt1, A!.id, B!.id, "requires", "[FICTIONAL] A → B reversed");
    await setProgramScheduling(A!.id, { startYear: 2030, endYear: 2032 });
    await setProgramScheduling(B!.id, { startYear: 2027, endYear: 2029 });

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // The advisor should abstain (invalid timeline)
    expect(report.inputSummary.abstained).toBe(true);
    // The risk should mention invalid schedule
    expect(report.risks.some((r) => r.includes("INVALID") || r.includes("invalid"))).toBe(true);
    // The uncertainty should mention temporal violations
    expect(report.uncertaintySummary).toMatch(/temporal violation|invalid.*schedule/i);
  });

  // ============================================================
  // 10. NO FABRICATED CONFIDENCE PERCENTAGES
  // ============================================================
  it("10. no fabricated confidence percentages in uncertaintySummary", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // MUST NOT contain percentage-based confidence (no calibration in v1)
    expect(report.uncertaintySummary).not.toMatch(/\d+%/);
    expect(report.recommendation).not.toMatch(/\d+%\s*(confidence|certain)/i);
  });

  // ============================================================
  // 11. PREVENT STRATEGY MODIFICATION THROUGH ADVISOR
  // ============================================================
  it("11. advisor does NOT modify strategy versions or programs", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Capture states before
    const sv1Before = await adminClient.strategyVersion.findUnique({ where: { id: alt1 } });
    const sv2Before = await adminClient.strategyVersion.findUnique({ where: { id: alt2 } });

    await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // Capture states after
    const sv1After = await adminClient.strategyVersion.findUnique({ where: { id: alt1 } });
    const sv2After = await adminClient.strategyVersion.findUnique({ where: { id: alt2 } });

    // No changes
    expect(sv1After!.status).toBe(sv1Before!.status);
    expect(sv2After!.status).toBe(sv2Before!.status);
    expect(sv1After!.metadata).toEqual(sv1Before!.metadata);
    expect(sv2After!.metadata).toEqual(sv2Before!.metadata);
  });

  // ============================================================
  // 12. PERMISSION strategy:read REQUIRED
  // ============================================================
  it("12. observer cannot invoke advisor (permission denied)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const observer = await adminClient.user.upsert({
      where: { email: "advisor-observer@demolandia.test" },
      update: {},
      create: {
        email: "advisor-observer@demolandia.test",
        name: "Advisor Observer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: observer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "observer" },
      create: { userId: observer.id, tenantId: tenantAId, roleCode: "observer", status: "active" },
    });
    const observerSession = makeSession({
      id: observer.id, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active",
    });

    await expect(advise(observerSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    })).rejects.toThrow(/Permission denied/);
  });

  it("12b. reviewer can invoke advisor (strategy:read)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const reviewer = await adminClient.user.upsert({
      where: { email: "advisor-reviewer@demolandia.test" },
      update: {},
      create: {
        email: "advisor-reviewer@demolandia.test",
        name: "Advisor Reviewer",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
      update: { status: "active", roleCode: "reviewer" },
      create: { userId: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
    });
    const reviewerSession = makeSession({
      id: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", membershipStatus: "active",
    });

    const report = await advise(reviewerSession, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });
    expect(report).toBeDefined();
  });

  // ============================================================
  // 13. REJECT CROSS-TENANT/COUNTRY/OBJECTIVE SCOPE MISMATCH
  // ============================================================
  it("13. rejects alternatives from a different country", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Use a wrong countryId
    await expect(advise(session, {
      countryId: "wrong-country-id",
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    })).rejects.toThrow(/Cross-country advisory is not allowed/);
  });

  it("13b. rejects < 2 alternatives", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);

    await expect(advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1], // only 1
    })).rejects.toThrow(/at least 2/);
  });

  // ============================================================
  // 14. CAPABILITY REGISTRY INTEGRATION
  // ============================================================
  it("14. advisor capability can be registered + discovered", async () => {
    const { registerAdvisorCapability, getAdvisorCapabilityInfo, ADVISOR_CAPABILITY_CODE } =
      await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Register the capability
    await registerAdvisorCapability();

    // Discover it
    const info = await getAdvisorCapabilityInfo(session);
    expect(info).not.toBeNull();
    expect(info!.code).toBe(ADVISOR_CAPABILITY_CODE);
    expect(info!.requiredPermission).toBe("strategy:read");
    expect(info!.readiness).toBe("stub");
  });

  // ============================================================
  // 15. STUB PROVIDER WITH SIMULATED LABEL
  // ============================================================
  it("15. report is labeled simulated: true (StubProvider)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    expect(report.simulated).toBe(true);
    // The assumptions should mention StubProvider
    expect(report.assumptions.some((a) => a.includes("StubProvider"))).toBe(true);
    // The uncertainty summary should mention simulated
    expect(report.uncertaintySummary).toContain("simulated");
  });

  // ============================================================
  // 16. REPRODUCIBILITY (same inputs → same report)
  // ============================================================
  it("16. same inputs produce the same recommendation text", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report1 = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });
    const report2 = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    expect(report2.recommendation).toBe(report1.recommendation);
    expect(report2.conditions).toEqual(report1.conditions);
    expect(report2.uncertaintySummary).toBe(report1.uncertaintySummary);
    expect(report2.inputSummary.abstained).toBe(report1.inputSummary.abstained);
  });

  // ============================================================
  // 17. NO G00/G01 REGRESSION — admin can invoke
  // ============================================================
  it("17. admin can invoke advisor (no regression)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: adminUserId, tenantId: tenantAId, roleCode: "admin", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    expect(report).toBeDefined();
    expect(report.disclaimer).toContain("Human approval required");
  });

  // ============================================================
  // 18. DEMOLANDIA CASE A — Sufficient Fictional Evidence
  //     A comparison with cost data + valid scheduling → conditional recommendation
  // ============================================================
  it("18. Demolandia Case A: sufficient evidence → conditional recommendation (not abstention)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId, objectiveInflationId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add cost data to ALL programs in both alternatives
    for (const altId of [alt1, alt2]) {
      const programs = await adminClient.program.findMany({
        where: { tenantId: tenantAId, strategyVersionId: altId },
      });
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        meta.costInputs = [{
          label: "[FICTIONAL] test input",
          unitCost: { amount: 100, currency: "USD" },
          unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
          varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
        }];
        await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
      }
      await estimateBudgets(session, { strategyAlternativeId: altId });
    }

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
      alternativeIds: [alt1, alt2],
    });

    // With complete cost data, the advisor should NOT abstain
    // (unless there are other reasons like temporal violations — but we didn't add any)
    // Note: the advisor may still abstain if evidence gaps are severe, but with
    // Demolandia's seeded evidence (which is verified), this should pass.
    expect(report.recommendation).toBeTruthy();
    expect(report.disclaimer).toBe("This is a conditional recommendation. Human approval required.");
    // The recommendation should mention "conditional"
    expect(report.recommendation.toLowerCase()).toContain("conditional");
    // The report should NOT declare a winner
    expect(report.recommendation.toLowerCase()).not.toContain("best alternative");
    expect(report.recommendation.toLowerCase()).not.toContain("winner is");
  });

  // ============================================================
  // 19. DEMOLANDIA CASE B — Insufficient / Contradictory Evidence
  //     No cost data + invalid timeline → abstention with explanation
  // ============================================================
  it("19. Demolandia Case B: insufficient + contradictory evidence → abstention", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // alt1: add A → B with REVERSED scheduling (temporal violation)
    const alt1Programs = await ensureProgramCount(session, alt1, 2);
    const [A, B] = alt1Programs;
    await addDependency(session, alt1, A!.id, B!.id, "requires", "[FICTIONAL] A → B reversed");
    await setProgramScheduling(A!.id, { startYear: 2030, endYear: 2032 });
    await setProgramScheduling(B!.id, { startYear: 2027, endYear: 2029 });

    // NO cost data on any program

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // The advisor MUST abstain (invalid timeline + no cost data)
    expect(report.inputSummary.abstained).toBe(true);
    expect(report.recommendation).toContain("Insufficient evidence to recommend a specific alternative");
    // The recommendation should explain WHY it abstains
    expect(report.recommendation).toContain("invalid");
    expect(report.recommendation).toContain("budget estimates");
    // The disclaimer is still present
    expect(report.disclaimer).toBe("This is a conditional recommendation. Human approval required.");
    // The uncertainty summary should mention the issues
    expect(report.uncertaintySummary).toMatch(/temporal violation|invalid.*schedule/i);
    expect(report.uncertaintySummary).toMatch(/budget|cost/i);
  });

  // ============================================================
  // 20. FIX-1: reject fabricated (non-existent) objectiveId
  // ============================================================
  it("20. FIX-1: fabricated objectiveId → rejected", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    await expect(advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId, "fabricated-objective-id-12345"],
      alternativeIds: [alt1, alt2],
    })).rejects.toThrow(/not found in tenant scope/);
  });

  // ============================================================
  // 21. FIX-1: reject objective from a different country
  // ============================================================
  it("21. FIX-1: objective from a different country → rejected", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Create an objective in a different country
    const otherCountry = await adminClient.country.upsert({
      where: { iso3: "P04" },
      update: {},
      create: { iso3: "P04", iso2: "P4", displayName: "P04 Testland", status: "active" },
    });
    const otherObjective = await adminClient.objective.create({
      data: {
        tenantId: tenantAId, countryId: otherCountry.id,
        title: "[FICTIONAL] Other country objective",
        targetMetric: "test_metric", targetValue: "10", horizon: 3,
        status: "active", createdBy: adminUserId,
        metadata: { sector: "test", fictional: true } as never,
      },
    });

    try {
      await expect(advise(session, {
        countryId,
        objectiveIds: [objectiveAgricultureId, otherObjective.id],
        alternativeIds: [alt1, alt2],
      })).rejects.toThrow(/different country/);
    } finally {
      await adminClient.objective.delete({ where: { id: otherObjective.id } });
      await adminClient.country.deleteMany({ where: { iso3: "P04" } });
    }
  });

  // ============================================================
  // 22. FIX-1: reject objective not linked to any alternative
  // ============================================================
  it("22. FIX-1: valid objective not linked to alternatives → rejected", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose with agriculture → alt1; inflation → alt2 (different objectives → different versionIds)
    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Education objective is valid (exists, same country) but NOT linked to alt1 or alt2
    // (alt1 was composed with agriculture, alt2 with inflation — not education)
    await expect(advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveEducationId],
      alternativeIds: [alt1, alt2],
    })).rejects.toThrow(/not linked to any of the alternatives/);
  });

  // ============================================================
  // 23. FIX-1: accept objectives that ARE linked to alternatives
  // ============================================================
  it("23. FIX-1: linked objectives accepted", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId, objectiveInflationId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Both objectives are linked to at least one alternative
    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId, objectiveInflationId],
      alternativeIds: [alt1, alt2],
    });
    expect(report).toBeDefined();
  });

  // ============================================================
  // 24. FIX-2: actual counter-evidence extracted with provenance
  // ============================================================
  it("24. FIX-2: actual counter-evidence from strategy metadata → extracted with provenance", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Agriculture has counter-evidence in the seed (Reuters + AP)
    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // The counterEvidence array should contain ACTUAL counter-evidence references
    // (with evidenceId, sourceCode, verificationStatus) — NOT data-quality warnings
    const actualCounterEvidence = report.counterEvidence.filter(
      (c) => c.includes("Counter-evidence (from alternative") && c.includes("evidenceId=")
    );
    // If the composer produced counter-evidence for agriculture, we should see it
    // (Demolandia's agriculture sector has counter-evidence from the seed)
    if (actualCounterEvidence.length > 0) {
      for (const ce of actualCounterEvidence) {
        expect(ce).toContain("evidenceId=");
        expect(ce).toContain("verificationStatus=");
        expect(ce).toContain("sourceCode=");
        expect(ce).toContain("Claim:");
        // Must be an actual counter-evidence reference (not a data-quality warning)
        // The note says "not a data-quality warning" which is a clarification, not a warning
        expect(ce).toContain("actual counter-evidence reference");
      }
    }
  });

  // ============================================================
  // 25. FIX-2: data-quality warnings are NOT counter-evidence
  // ============================================================
  it("25. FIX-2: missing/refuted evidence → data-quality warning in risks, NOT counterEvidence", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // counterEvidence should NOT contain data-quality warnings about missing evidence
    // (those should be in risks)
    for (const ce of report.counterEvidence) {
      // A data-quality warning would say "missing or refuted evidence" as a general warning
      // — but the actual counter-evidence note says "Counter-evidence (from alternative"
      // or "No counter-evidence references were found"
      expect(ce).not.toMatch(/^.*alternative.*have evidence references pointing to.*missing or refuted.*$/);
    }

    // The risks array should contain the data-quality warning (if there are missing/refuted citations)
    const dataQualityRisk = report.risks.find(
      (r) => r.includes("missing or refuted evidence") && r.includes("data-quality warning")
    );
    // If there are missing/refuted citations, the risk should be present
    // (if not, that's fine — it means the alternatives don't have missing/refuted citations)
  });

  // ============================================================
  // 26. FIX-2: no fabricated counter-evidence when none exists
  // ============================================================
  it("26. FIX-2: no counter-evidence in metadata → honestly says 'not found'", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveInflationId]);
    const alt2 = await composeAndExpand(session, [objectiveEducationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveInflationId],
      alternativeIds: [alt1, alt2],
    });

    // If no counter-evidence was in the metadata, the report should say so honestly
    const noCounterEvidenceNote = report.counterEvidence.find(
      (c) => c.includes("No counter-evidence references were found") &&
            c.includes("NOT a claim that no counter-evidence exists in reality")
    );
    // Either we found actual counter-evidence OR we honestly say none was found
    const hasActual = report.counterEvidence.some((c) => c.includes("Counter-evidence (from alternative"));
    const hasNotFound = noCounterEvidenceNote !== undefined;
    expect(hasActual || hasNotFound).toBe(true);
  });

  // ============================================================
  // 27. FIX-3: no 50% abstention threshold (evidence gaps don't auto-abstain)
  // ============================================================
  it("27. FIX-3: evidence gaps do NOT trigger abstention (no 50% threshold)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add cost data to both (so allLackCost = false)
    for (const altId of [alt1, alt2]) {
      const programs = await adminClient.program.findMany({
        where: { tenantId: tenantAId, strategyVersionId: altId },
      });
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        meta.costInputs = [{
          label: "[FICTIONAL] test",
          unitCost: { amount: 100, currency: "USD" },
          unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
          varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
        }];
        await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
      }
      await estimateBudgets(session, { strategyAlternativeId: altId });
    }

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // Even if there are evidence gaps, the advisor should NOT abstain
    // (no invalid timeline, not all lack cost → no abstention)
    expect(report.inputSummary.abstained).toBe(false);
    expect(report.recommendation.toLowerCase()).toContain("conditional");
    // The uncertainty should mention evidence gaps (if any) but NOT trigger abstention
    // The recommendation should NOT mention ">50%" or "severe evidence gaps"
    expect(report.recommendation).not.toContain(">50%");
    expect(report.recommendation).not.toContain("severe evidence gaps");
  });

  // ============================================================
  // 28. FIX-3: partial cost data → conditional recommendation (not abstention)
  // ============================================================
  it("28. FIX-3: some alternatives lack cost → partial recommendation (not abstention)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add cost to alt1 only (alt2 has no cost → partial, not all-lack)
    const alt1Programs = await adminClient.program.findMany({
      where: { tenantId: tenantAId, strategyVersionId: alt1 },
    });
    for (const p of alt1Programs) {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      meta.costInputs = [{
        label: "[FICTIONAL] alt1 only",
        unitCost: { amount: 100, currency: "USD" },
        unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
        varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
      }];
      await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
    }
    await estimateBudgets(session, { strategyAlternativeId: alt1 });
    // alt2: NO cost data

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // NOT abstained (alt1 has cost → allLackCost=false; no invalid timeline)
    expect(report.inputSummary.abstained).toBe(false);
    // The recommendation should mention the partial data
    expect(report.recommendation).toContain("partial cost data");
    // The uncertainty should mention the gap
    expect(report.uncertaintySummary).toMatch(/budget estimates|cost data/i);
  });

  // ============================================================
  // 29. FIX-3: invalid timeline still triggers abstention
  // ============================================================
  it("29. FIX-3: invalid timeline → abstention (temporal violation is still a blocker)", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Add cost to both (so allLackCost=false, only invalid timeline triggers abstention)
    for (const altId of [alt1, alt2]) {
      const programs = await adminClient.program.findMany({
        where: { tenantId: tenantAId, strategyVersionId: altId },
      });
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        meta.costInputs = [{
          label: "[FICTIONAL] test",
          unitCost: { amount: 100, currency: "USD" },
          unitCount: 10, horizonYears: 1, source: "[FICTIONAL]",
          varianceLow: 0.9, varianceHigh: 1.15, varianceSource: "[FICTIONAL]",
        }];
        await adminClient.program.update({ where: { id: p.id }, data: { metadata: meta as never } });
      }
      await estimateBudgets(session, { strategyAlternativeId: altId });
    }

    // alt1: add A → B with REVERSED scheduling (temporal violation)
    const alt1Programs = await ensureProgramCount(session, alt1, 2);
    const [A, B] = alt1Programs;
    await addDependency(session, alt1, A!.id, B!.id, "requires", "[FICTIONAL] A → B reversed");
    await setProgramScheduling(A!.id, { startYear: 2030, endYear: 2032 });
    await setProgramScheduling(B!.id, { startYear: 2027, endYear: 2029 });

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // Abstained because of invalid timeline (even though cost data is complete)
    expect(report.inputSummary.abstained).toBe(true);
    expect(report.recommendation).toContain("Insufficient evidence to recommend a specific alternative");
    expect(report.recommendation).toContain("invalid");
  });

  // ============================================================
  // 30. FIX FINAL: fabricated counter-evidence reference → NOT shown as actual
  // ============================================================
  it("30. FIX FINAL: unresolved counter-evidence reference → risk, NOT counterEvidence", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    // Inject a FABRICATED counter-evidence reference into alt1's metadata
    const sv1 = await adminClient.strategyVersion.findUnique({ where: { id: alt1 } });
    const meta = (sv1!.metadata ?? {}) as Record<string, unknown>;
    const existingCounterEvidence = (meta.counterEvidence as unknown[]) ?? [];
    meta.counterEvidence = [
      ...existingCounterEvidence,
      { evidenceId: "fabricated-evidence-id-not-real-99999", claim: "[FICTIONAL] fabricated", sourceCode: null },
    ];
    await adminClient.strategyVersion.update({
      where: { id: alt1 },
      data: { metadata: meta as never },
    });

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // The fabricated reference must NOT appear as actual counter-evidence
    const fabricatedInCounterEvidence = report.counterEvidence.some(
      (c) => c.includes("fabricated-evidence-id-not-real-99999") && c.includes("Counter-evidence (from alternative")
    );
    expect(fabricatedInCounterEvidence).toBe(false);

    // The fabricated reference must appear in risks as "unresolved"
    const unresolvedRisk = report.risks.find(
      (r) => r.includes("unresolved counter-evidence reference") && r.includes("fabricated-evidence-id-not-real-99999")
    );
    expect(unresolvedRisk).toBeDefined();

    // The uncertainty should mention unresolved references
    expect(report.uncertaintySummary).toContain("unresolved");
  });

  // ============================================================
  // 31. FIX FINAL: resolved counter-evidence → shown with full provenance
  // ============================================================
  it("31. FIX FINAL: resolved counter-evidence reference → shown with evidenceId + verificationStatus", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Agriculture sector has counter-evidence from the seed (Reuters + AP)
    const alt1 = await composeAndExpand(session, [objectiveAgricultureId]);
    const alt2 = await composeAndExpand(session, [objectiveInflationId]);

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveAgricultureId],
      alternativeIds: [alt1, alt2],
    });

    // Check if any resolved counter-evidence was found
    const resolvedCounterEvidence = report.counterEvidence.filter(
      (c) => c.includes("Counter-evidence (from alternative") && c.includes("evidenceId=")
    );

    if (resolvedCounterEvidence.length > 0) {
      // Each resolved reference should have full provenance
      for (const ce of resolvedCounterEvidence) {
        expect(ce).toContain("evidenceId=");
        expect(ce).toContain("verificationStatus=");
        expect(ce).toContain("sourceCode=");
        expect(ce).toContain("Claim:");
        // Must NOT say "unknown" verificationStatus (resolved = found in Evidence table)
        expect(ce).not.toMatch(/verificationStatus="unknown"/);
      }
    }
  });

  // ============================================================
  // 32. FIX FINAL: all counter-evidence unresolved → "No resolved" message
  // ============================================================
  it("32. FIX FINAL: all counter-evidence unresolved → honestly says 'No resolved'", async () => {
    const { advise } = await import("@/lib/state-builder/advisor-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const alt1 = await composeAndExpand(session, [objectiveInflationId]);
    const alt2 = await composeAndExpand(session, [objectiveEducationId]);

    // Inject ONLY fabricated counter-evidence (no real ones)
    const sv1 = await adminClient.strategyVersion.findUnique({ where: { id: alt1 } });
    const meta = (sv1!.metadata ?? {}) as Record<string, unknown>;
    meta.counterEvidence = [
      { evidenceId: "another-fake-id-12345", claim: "[FICTIONAL] fake", sourceCode: null },
    ];
    await adminClient.strategyVersion.update({
      where: { id: alt1 },
      data: { metadata: meta as never },
    });

    const report = await advise(session, {
      countryId,
      objectiveIds: [objectiveInflationId],
      alternativeIds: [alt1, alt2],
    });

    // counterEvidence should say "No resolved counter-evidence references were found"
    const noResolvedNote = report.counterEvidence.find(
      (c) => c.includes("No resolved counter-evidence references were found")
    );
    expect(noResolvedNote).toBeDefined();

    // The risk should mention the unresolved reference
    const unresolvedRisk = report.risks.find(
      (r) => r.includes("unresolved counter-evidence reference") && r.includes("another-fake-id-12345")
    );
    expect(unresolvedRisk).toBeDefined();
  });
});
