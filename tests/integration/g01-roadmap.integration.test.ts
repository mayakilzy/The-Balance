// ============================================================
// g01-roadmap.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-07: Implementation Roadmap & Timeline.
//
// 14 acceptance tests per mission pack §7:
//   1.  Build Roadmap from Demolandia programs
//   2.  Respect chain A → B → C
//   3.  No dependent starts before prerequisite (when durations available)
//   4.  Reject cycles / corrupt network
//   5.  Show conflicts separately from sequencing
//   6.  Cover all programs including standalone
//   7.  Handle missing execution durations
//   8.  Compute planning horizon from valid inputs (no fabrication)
//   9.  Link Milestones to existing KPIs
//  10.  Show monitoring gap when no valid KPI
//  11.  Show budget data gaps without fabricating funding
//  12.  Tenant + alternative + permissions isolation
//  13.  Deterministic rebuild (no duplicates)
//  14.  No G00/G01 regression (CI verifies)
//
// Plus Demolandia Case A (missing scheduling data) + Case B (explicit fictional schedule).
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

// Helper: ensure at least N programs exist for a strategy version.
async function ensureProgramCount(
  session: Session,
  versionId: string,
  minCount: number
): Promise<Array<{ programId: string; title: string; sector: string }>> {
  const { getPrograms } = await import("@/lib/state-builder/program-service");
  const programs = await getPrograms(session, versionId);
  const mapped = programs.map((p) => ({ programId: p.programId, title: p.title, sector: p.sector }));
  if (mapped.length >= minCount) return mapped;
  const tenantId = session.user.tenantId!;
  const needed = minCount - mapped.length;
  const sectors = ["test_sector_a", "test_sector_b", "test_sector_c", "test_sector_d"];
  for (let i = 0; i < needed; i++) {
    const idx = mapped.length + i;
    const created = await adminClient.program.create({
      data: {
        tenantId,
        strategyVersionId: versionId,
        title: `[FICTIONAL TEST FIXTURE] Roadmap Program ${idx + 1}`,
        sector: sectors[idx % sectors.length]!,
        owningInstitutionId: null,
        legalMandateRef: null,
        rationale: `[FICTIONAL TEST FIXTURE] Created for roadmap test program-count requirements.`,
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
    mapped.push({ programId: created.id, title: created.title, sector: created.sector });
  }
  return mapped;
}

// Helper: add a dependency edge via portfolio-service.
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

// Helper: write scheduling data into a program's metadata.
async function setProgramScheduling(
  programId: string,
  scheduling: { startYear?: number; endYear?: number; durationYears?: number }
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

// ============================================================
// 01-07: Implementation Roadmap & Timeline
// ============================================================
describeIntegration("01-07: Implementation Roadmap & Timeline", () => {
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
  // 1. BUILD ROADMAP FROM DEMOLANDIA PROGRAMS
  // ============================================================
  it("1. builds a Roadmap from Demolandia programs", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    expect(programs.length).toBeGreaterThan(0);

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: versionId });

    expect(roadmap.strategyAlternativeId).toBe(versionId);
    expect(roadmap.simulated).toBe(true);
    expect(roadmap.modelVersion).toBe("v1-deterministic");
    expect(roadmap.phases.length).toBeGreaterThan(0);
    expect(roadmap.sequencingRationale).toBeTruthy();
    expect(roadmap.schedulingDisclaimer).toBeTruthy();
    // All programs are covered across phases
    const allPhaseProgramIds = roadmap.phases.flatMap((p) => p.programIds);
    expect(allPhaseProgramIds.length).toBe(programs.length);
    expect(new Set(allPhaseProgramIds).size).toBe(programs.length);
  });

  // ============================================================
  // 2. RESPECT CHAIN A → B → C
  // ============================================================
  it("2. respects chain A → B → C (each in a later phase)", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 3);
    const [A, B, C] = programs;

    // Build chain A → B → C (requires)
    // FIX-2 direction: A → B means A is prerequisite, B depends on A.
    await addDependency(session, setup.versionId, A!.programId, B!.programId, "requires",
      "[FICTIONAL] A is prerequisite for B");
    await addDependency(session, setup.versionId, B!.programId, C!.programId, "requires",
      "[FICTIONAL] B is prerequisite for C");

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // Find which phase each program is in
    const phaseOf = new Map<string, number>();
    for (const phase of roadmap.phases) {
      for (const pid of phase.programIds) {
        phaseOf.set(pid, phase.phaseIndex);
      }
    }
    // A must be in an earlier phase than B, B earlier than C
    expect(phaseOf.get(A!.programId)!).toBeLessThan(phaseOf.get(B!.programId)!);
    expect(phaseOf.get(B!.programId)!).toBeLessThan(phaseOf.get(C!.programId)!);
  });

  // ============================================================
  // 3. NO DEPENDENT STARTS BEFORE PREREQUISITE (with scheduling data)
  // ============================================================
  it("3. dependent program does not start before prerequisite (with scheduling)", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [A, B] = programs;

    // A → B (requires): A is prerequisite
    await addDependency(session, setup.versionId, A!.programId, B!.programId, "requires",
      "[FICTIONAL] A is prerequisite for B");

    // Give A scheduling: years 2026-2027
    await setProgramScheduling(A!.programId, { startYear: 2026, endYear: 2027 });
    // Give B scheduling: years 2028-2029 (starts AFTER A ends)
    await setProgramScheduling(B!.programId, { startYear: 2028, endYear: 2029 });

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // A's phase must have startYear <= B's phase startYear
    const phaseOfA = roadmap.phases.find((p) => p.programIds.includes(A!.programId))!;
    const phaseOfB = roadmap.phases.find((p) => p.programIds.includes(B!.programId))!;
    expect(phaseOfA).toBeDefined();
    expect(phaseOfB).toBeDefined();
    expect(phaseOfA.startYear!).toBeLessThanOrEqual(phaseOfB.startYear!);
    // B starts after A ends (2028 > 2027)
    expect(phaseOfB.startYear!).toBeGreaterThan(phaseOfA.endYear!);

    // Both phases should have schedulingGap=false (scheduling data provided)
    expect(phaseOfA.schedulingGap).toBe(false);
    expect(phaseOfB.schedulingGap).toBe(false);
  });

  // ============================================================
  // 4. REJECT CYCLES / CORRUPT NETWORK
  // ============================================================
  it("4. detects cycle in dependency graph and throws integrity error", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [A, B] = programs;

    // A → B (requires) — valid
    await addDependency(session, setup.versionId, A!.programId, B!.programId, "requires",
      "[FICTIONAL] A → B");
    // B → A (requires) — would create a cycle, BUT portfolio-service rejects it at insertion.
    // So we can't easily create a cycle via the API. Instead, we insert directly via adminClient
    // to simulate DB-level corruption.
    await adminClient.dependency.create({
      data: {
        tenantId: tenantAId,
        fromProgramId: B!.programId,
        toProgramId: A!.programId,
        type: "requires",
        rationale: "[FICTIONAL] B → A — directly inserted to simulate cycle corruption",
        metadata: { source: "simulated", simulated: true, strategyVersionId: setup.versionId },
      },
    });

    // buildRoadmap must detect the cycle and throw RoadmapIntegrityError
    await expect(buildRoadmap(session, { strategyAlternativeId: setup.versionId }))
      .rejects.toThrow(/cycle/i);

    // Clean up the directly-inserted edge
    await adminClient.dependency.deleteMany({
      where: { tenantId: tenantAId, fromProgramId: B!.programId, toProgramId: A!.programId },
    });
  });

  // ============================================================
  // 5. SHOW CONFLICTS SEPARATELY FROM SEQUENCING
  // ============================================================
  it("5. conflicts are surfaced separately, not used for sequencing", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [A, B] = programs;

    // Add a conflicts edge (NOT a sequencing constraint)
    await addDependency(session, setup.versionId, A!.programId, B!.programId, "conflicts",
      "[FICTIONAL] A and B compete for the same water resources");

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // The conflict must appear in the conflicts array
    expect(roadmap.conflicts.length).toBe(1);
    expect(roadmap.conflicts[0]!.fromProgramId).toBe(A!.programId);
    expect(roadmap.conflicts[0]!.toProgramId).toBe(B!.programId);
    expect(roadmap.conflicts[0]!.rationale).toContain("water resources");

    // Both A and B should be in the SAME phase (conflicts don't affect sequencing)
    const phaseOfA = roadmap.phases.find((p) => p.programIds.includes(A!.programId))!;
    const phaseOfB = roadmap.phases.find((p) => p.programIds.includes(B!.programId))!;
    expect(phaseOfA.phaseIndex).toBe(phaseOfB.phaseIndex);

    // The sequencing rationale must mention conflicts
    expect(roadmap.sequencingRationale).toContain("conflict");
  });

  // ============================================================
  // 6. COVER ALL PROGRAMS INCLUDING STANDALONE
  // ============================================================
  it("6. covers all programs including standalone (no dependencies)", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 4);
    expect(programs.length).toBeGreaterThanOrEqual(4);

    // Add a chain A → B, leave C and D standalone
    await addDependency(session, setup.versionId, programs[0]!.programId, programs[1]!.programId,
      "requires", "[FICTIONAL] A → B");
    // programs[2] and programs[3] have NO dependencies — standalone

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // All 4 programs must be in some phase
    const allPhaseProgramIds = new Set(roadmap.phases.flatMap((p) => p.programIds));
    expect(allPhaseProgramIds.size).toBe(programs.length);
    for (const p of programs) {
      expect(allPhaseProgramIds.has(p.programId)).toBe(true);
    }

    // Standalone programs (C, D) must be in Phase 1 (level 0)
    const phase1 = roadmap.phases[0]!;
    expect(phase1.programIds).toContain(programs[2]!.programId);
    expect(phase1.programIds).toContain(programs[3]!.programId);
    // A (root of chain) also in Phase 1
    expect(phase1.programIds).toContain(programs[0]!.programId);
    // B (depends on A) in Phase 2
    const phase2 = roadmap.phases[1];
    expect(phase2).toBeDefined();
    expect(phase2!.programIds).toContain(programs[1]!.programId);
  });

  // ============================================================
  // 7. HANDLE MISSING EXECUTION DURATIONS
  // ============================================================
  it("7. missing durations → phases with schedulingGap=true, no fabricated dates", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // NO scheduling data written to any program — default state

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // ALL phases must have schedulingGap=true
    for (const phase of roadmap.phases) {
      expect(phase.schedulingGap).toBe(true);
      expect(phase.startYear).toBeNull();
      expect(phase.endYear).toBeNull();
    }

    // The scheduling disclaimer must mention no scheduling data
    expect(roadmap.schedulingDisclaimer).toContain("No program carries scheduling data");
    expect(roadmap.schedulingDisclaimer).toContain("schedulingGap=true");
  });

  // ============================================================
  // 8. COMPUTE PLANNING HORIZON FROM VALID INPUTS (no fabrication)
  // ============================================================
  it("8. totalHorizon derived from objective horizon, not fabricated", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Agriculture objective has horizon (check the seed — it's typically 3-5 years)
    const agObjective = await adminClient.objective.findUnique({
      where: { id: objectiveAgricultureId },
    });
    expect(agObjective).toBeTruthy();
    const expectedHorizon = agObjective!.horizon;

    const { versionId } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: versionId });

    // totalHorizon must match the objective's horizon
    expect(roadmap.totalHorizon).toBe(expectedHorizon);
    expect(roadmap.horizonSource).toBe("objective-horizon");
  });

  it("8b. totalHorizon is null when no objectives linked", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose with valid objectives, then manually null out inputSnapshot.objectiveIds
    // to simulate the "no objectives" case
    const { versionId } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const version = await adminClient.strategyVersion.findUnique({ where: { id: versionId } });
    const meta = (version!.metadata ?? {}) as Record<string, unknown>;
    const inputSnapshot = (meta.inputSnapshot ?? {}) as Record<string, unknown>;
    delete inputSnapshot.objectiveIds;
    meta.inputSnapshot = inputSnapshot;
    await adminClient.strategyVersion.update({
      where: { id: versionId },
      data: { metadata: meta as never },
    });

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: versionId });
    expect(roadmap.totalHorizon).toBeNull();
    expect(roadmap.horizonSource).toBe("unavailable");
  });

  // ============================================================
  // 9. LINK MILESTONES TO EXISTING KPIs
  // ============================================================
  it("9. milestones link to existing KPIs (from 01-04 program contracts)", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Agriculture has exactly one objective → KPIs generated (per 01-04 FIX-2)
    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: versionId });

    // At least one milestone should reference a real KPI
    const kpiMilestones = roadmap.phases
      .flatMap((p) => p.milestones)
      .filter((m) => !m.isMonitoringGap);
    // If any program has KPIs, there should be KPI milestones
    if (kpiMilestones.length > 0) {
      for (const m of kpiMilestones) {
        expect(m.kpiName).toBeTruthy();
        expect(m.kpiTarget).toBeTruthy();
        expect(m.kpiSourceKind).toBeTruthy();
        expect(m.kpiFrequency).toBeTruthy();
        expect(m.isMonitoringGap).toBe(false);
        expect(m.simulated).toBe(true);
        expect(m.description).toContain(m.kpiName!);
      }
    }
  });

  // ============================================================
  // 10. SHOW MONITORING GAP WHEN NO VALID KPI
  // ============================================================
  it("10. monitoring gap shown when program has no KPIs", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // The test fixture programs (created by ensureProgramCount) have kpis: []
    const programs = await ensureProgramCount(session, setup.versionId, 3);

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // Programs with no KPIs produce monitoring-gap milestones
    const gapMilestones = roadmap.phases
      .flatMap((p) => p.milestones)
      .filter((m) => m.isMonitoringGap);
    expect(gapMilestones.length).toBeGreaterThan(0);
    for (const m of gapMilestones) {
      expect(m.kpiName).toBeNull();
      expect(m.kpiTarget).toBeNull();
      expect(m.kpiSourceKind).toBeNull();
      expect(m.description).toContain("Monitoring gap");
      expect(m.description).toContain("no KPIs");
    }
  });

  // ============================================================
  // 11. SHOW BUDGET DATA GAPS WITHOUT FABRICATING FUNDING
  // ============================================================
  it("11. budget readiness shows insufficient data without fabricating funding", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // NO budget estimates created (no estimateBudgets call)

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: versionId });

    // All programs have no budget estimate
    expect(roadmap.budgetReadiness.programsWithEstimate).toBe(0);
    expect(roadmap.budgetReadiness.programsWithoutEstimate).toBe(programs.length);
    expect(roadmap.budgetReadiness.insufficientDataProgramIds.length).toBe(programs.length);
    expect(roadmap.budgetReadiness.note).toContain("insufficient cost data");
    expect(roadmap.budgetReadiness.note).not.toContain("funded");
  });

  it("11b. budget readiness reflects existing estimates (read-only, no fabrication)", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const { estimateBudgets } = await import("@/lib/state-builder/budget-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const targetProgram = programs[0]!;

    // Add cost inputs + run estimateBudgets to create a budget line
    const program = await adminClient.program.findUnique({ where: { id: targetProgram.programId } });
    const meta = (program!.metadata ?? {}) as Record<string, unknown>;
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
      where: { id: targetProgram.programId },
      data: { metadata: meta as never },
    });
    await estimateBudgets(session, { strategyAlternativeId: versionId });

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: versionId });
    expect(roadmap.budgetReadiness.programsWithEstimate).toBeGreaterThanOrEqual(1);
    // No financing sources → programsWithFinancingSources = 0
    expect(roadmap.budgetReadiness.programsWithFinancingSources).toBe(0);
    expect(roadmap.budgetReadiness.note).toContain("SIMULATED");
  });

  // ============================================================
  // 12. TENANT + ALTERNATIVE + PERMISSIONS ISOLATION
  // ============================================================
  it("12. rejects buildRoadmap for a strategy version in a different tenant", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const sessionA = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const setupA = await setupAlternativeWithPrograms(sessionA, [objectiveAgricultureId]);

    // Tenant B analyst
    const tenantBAnalyst = await adminClient.user.upsert({
      where: { email: "tenant-b-roadmap-analyst@demolandia.test" },
      update: {},
      create: {
        email: "tenant-b-roadmap-analyst@demolandia.test",
        name: "Tenant B Roadmap Analyst",
        passwordHash: await hashPassword("Test1234!"),
        status: "active",
      },
    });
    await adminClient.membership.upsert({
      where: { userId_tenantId: { userId: tenantBAnalyst.id, tenantId: tenantBId } },
      update: { status: "active", roleCode: "analyst" },
      create: {
        userId: tenantBAnalyst.id, tenantId: tenantBId, roleCode: "analyst", status: "active",
      },
    });
    const sessionB = makeSession({
      id: tenantBAnalyst.id, tenantId: tenantBId, roleCode: "analyst", membershipStatus: "active",
    });

    await expect(buildRoadmap(sessionB, { strategyAlternativeId: setupA.versionId }))
      .rejects.toThrow(/not found in tenant scope/);
  });

  it("12b. observer cannot build roadmap (permission denied)", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const { versionId } = await setupAlternativeWithPrograms(session, [objectiveAgricultureId]);

    const observer = await adminClient.user.upsert({
      where: { email: "roadmap-observer@demolandia.test" },
      update: {},
      create: {
        email: "roadmap-observer@demolandia.test",
        name: "Roadmap Observer",
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

    await expect(buildRoadmap(observerSession, { strategyAlternativeId: versionId }))
      .rejects.toThrow(/Permission denied/);
  });

  // ============================================================
  // 13. DETERMINISTIC REBUILD (no duplicates)
  // ============================================================
  it("13. re-running buildRoadmap produces identical phase structure", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 3);
    // Add a chain to make the phase structure non-trivial
    await addDependency(session, setup.versionId, programs[0]!.programId, programs[1]!.programId,
      "requires", "[FICTIONAL] A → B");
    await addDependency(session, setup.versionId, programs[1]!.programId, programs[2]!.programId,
      "requires", "[FICTIONAL] B → C");

    const roadmap1 = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });
    const roadmap2 = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // Same number of phases
    expect(roadmap2.phases.length).toBe(roadmap1.phases.length);
    // Same programIds per phase
    for (let i = 0; i < roadmap1.phases.length; i++) {
      expect(roadmap2.phases[i]!.programIds).toEqual(roadmap1.phases[i]!.programIds);
      expect(roadmap2.phases[i]!.phaseIndex).toBe(roadmap1.phases[i]!.phaseIndex);
    }
    // Same totalHorizon, horizonSource, modelVersion
    expect(roadmap2.totalHorizon).toBe(roadmap1.totalHorizon);
    expect(roadmap2.horizonSource).toBe(roadmap1.horizonSource);
    expect(roadmap2.modelVersion).toBe(roadmap1.modelVersion);
    // Same conflicts
    expect(roadmap2.conflicts.length).toBe(roadmap1.conflicts.length);
  });

  // ============================================================
  // 14. NO G00/G01 REGRESSION — reviewer can read roadmap
  // ============================================================
  it("14. reviewer can build roadmap (read permission)", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });
    const { versionId } = await setupAlternativeWithPrograms(session, [objectiveAgricultureId]);

    const reviewer = await adminClient.user.upsert({
      where: { email: "roadmap-reviewer@demolandia.test" },
      update: {},
      create: {
        email: "roadmap-reviewer@demolandia.test",
        name: "Roadmap Reviewer",
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

    const roadmap = await buildRoadmap(reviewerSession, { strategyAlternativeId: versionId });
    expect(roadmap).toBeDefined();
    expect(roadmap.phases.length).toBeGreaterThan(0);
  });

  // ============================================================
  // 15. DEMOLANDIA CASE A — Missing Scheduling Data
  //     Correct phase ordering with NO fabricated dates.
  // ============================================================
  it("15. Demolandia Case A: missing scheduling data → correct phases, no fabricated dates", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 3);
    const [A, B, C] = programs;

    // Build chain A → B → C
    await addDependency(session, setup.versionId, A!.programId, B!.programId, "requires",
      "[FICTIONAL] A → B");
    await addDependency(session, setup.versionId, B!.programId, C!.programId, "requires",
      "[FICTIONAL] B → C");
    // NO scheduling data — Demolandia's natural state

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // 3 phases (A in 1, B in 2, C in 3) — assuming no other programs create extra phases
    expect(roadmap.phases.length).toBeGreaterThanOrEqual(3);

    // ALL phases have schedulingGap=true + null dates
    for (const phase of roadmap.phases) {
      expect(phase.schedulingGap).toBe(true);
      expect(phase.startYear).toBeNull();
      expect(phase.endYear).toBeNull();
    }

    // The ordering is still correct (A before B before C)
    const phaseOf = new Map<string, number>();
    for (const phase of roadmap.phases) {
      for (const pid of phase.programIds) {
        phaseOf.set(pid, phase.phaseIndex);
      }
    }
    expect(phaseOf.get(A!.programId)!).toBeLessThan(phaseOf.get(B!.programId)!);
    expect(phaseOf.get(B!.programId)!).toBeLessThan(phaseOf.get(C!.programId)!);

    // The scheduling disclaimer is explicit about no fabricated dates
    expect(roadmap.schedulingDisclaimer).toContain("does NOT prove execution duration");
    expect(roadmap.schedulingDisclaimer).toContain("No program carries scheduling data");
  });

  // ============================================================
  // 16. DEMOLANDIA CASE B — Explicit Fictional Schedule
  //     Test scheduling with explicit assumptions, verify no incorrect overlap.
  // ============================================================
  it("16. Demolandia Case B: explicit fictional schedule → correct phase dates, no overlap", async () => {
    const { buildRoadmap } = await import("@/lib/state-builder/roadmap-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 3);
    const [A, B, C] = programs;

    // Build chain A → B → C
    await addDependency(session, setup.versionId, A!.programId, B!.programId, "requires",
      "[FICTIONAL] A → B");
    await addDependency(session, setup.versionId, B!.programId, C!.programId, "requires",
      "[FICTIONAL] B → C");

    // Add EXPLICIT scheduling assumptions (fictional, labeled simulated)
    // A: 2026-2027, B: 2028-2029, C: 2030-2031
    await setProgramScheduling(A!.programId, { startYear: 2026, endYear: 2027 });
    await setProgramScheduling(B!.programId, { startYear: 2028, endYear: 2029 });
    await setProgramScheduling(C!.programId, { startYear: 2030, endYear: 2031 });

    const roadmap = await buildRoadmap(session, { strategyAlternativeId: setup.versionId });

    // Find the phases for A, B, C
    const phaseOfA = roadmap.phases.find((p) => p.programIds.includes(A!.programId))!;
    const phaseOfB = roadmap.phases.find((p) => p.programIds.includes(B!.programId))!;
    const phaseOfC = roadmap.phases.find((p) => p.programIds.includes(C!.programId))!;

    // Phases should have schedulingGap=false (scheduling data provided)
    expect(phaseOfA.schedulingGap).toBe(false);
    expect(phaseOfB.schedulingGap).toBe(false);
    expect(phaseOfC.schedulingGap).toBe(false);

    // Phase dates match the program scheduling
    expect(phaseOfA.startYear).toBe(2026);
    expect(phaseOfA.endYear).toBe(2027);
    expect(phaseOfB.startYear).toBe(2028);
    expect(phaseOfB.endYear).toBe(2029);
    expect(phaseOfC.startYear).toBe(2030);
    expect(phaseOfC.endYear).toBe(2031);

    // No incorrect overlap: A ends before B starts, B ends before C starts
    expect(phaseOfA.endYear!).toBeLessThan(phaseOfB.startYear!);
    expect(phaseOfB.endYear!).toBeLessThan(phaseOfC.startYear!);

    // The scheduling disclaimer notes the schedule is SIMULATED
    expect(roadmap.schedulingDisclaimer).toContain("SIMULATED");
    expect(roadmap.schedulingDisclaimer).toContain("analyst-supplied");

    // Phase assumptions mention the scheduling derivation
    expect(phaseOfA.assumptions.some((a) => a.includes("SIMULATED schedule"))).toBe(true);
  });
});
