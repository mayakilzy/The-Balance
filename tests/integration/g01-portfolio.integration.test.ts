// ============================================================
// g01-portfolio.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-05: Portfolio & Dependency Graph.
//
// 12 acceptance tests per mission pack §7:
//   1.  Create Portfolio from Demolandia programs
//   2.  Correct nodes + edges representation
//   3.  Accept valid `requires` relation
//   4.  Reject edge with non-existent reference
//   5.  Reject cross-tenant relation (RLS)
//   6.  Reject relation connecting program outside allowed alternative
//   7.  Detect cycle and prevent storage
//   8.  Compute longest chain (UNWEIGHTED) + temporal disclaimer
//   9.  Show `conflicts` relations without treating them as cycles
//   10. Don't invent dependencies when no evidence
//   11. Don't duplicate edges on rebuild (idempotent)
//   12. Concurrency: prevent cycle from race between two operations
//
// Plus a Demolandia Fictional fixture example (test 13) that shows
// a valid `requires` + `conflicts` relation, explicitly labeled as
// `simulated: true` because Demolandia has no real documented
// cross-program relations.
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
// Picks the alternative with the MOST programs (Alternative B typically
// produces one program per objective; Alternative A only produces programs
// for sectors with supporting evidence).
async function setupAlternativeWithPrograms(
  session: Session,
  objectiveIds: string[]
): Promise<{ versionId: string; programs: Array<{ programId: string; title: string; sector: string }> }> {
  const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
  const result = await composeStrategies(session, { countryId, objectiveIds });
  // Pick the alternative with the most programs (for tests that need N programs).
  // Fall back to the first alternative if all have zero programs.
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

// Helper: ensure at least N programs exist for a strategy version by directly
// creating extra test programs if the composer didn't produce enough.
// Used by tests that need a specific program count for chain/cycle testing.
async function ensureProgramCount(
  session: Session,
  versionId: string,
  minCount: number
): Promise<Array<{ programId: string; title: string; sector: string }>> {
  const { getPrograms } = await import("@/lib/state-builder/program-service");
  const programs = await getPrograms(session, versionId);
  const mapped = programs.map((p) => ({ programId: p.programId, title: p.title, sector: p.sector }));

  // If we already have enough, return.
  if (mapped.length >= minCount) return mapped;

  // Otherwise create additional test programs directly.
  // These are explicitly labeled as FICTIONAL test fixtures.
  const tenantId = session.user.tenantId!;
  const needed = minCount - mapped.length;
  const sectors = ["test_sector_a", "test_sector_b", "test_sector_c", "test_sector_d"];
  for (let i = 0; i < needed; i++) {
    const idx = mapped.length + i;
    const created = await adminClient.program.create({
      data: {
        tenantId,
        strategyVersionId: versionId,
        title: `[FICTIONAL TEST FIXTURE] Program ${idx + 1}`,
        sector: sectors[idx % sectors.length]!,
        owningInstitutionId: null,
        legalMandateRef: null,
        rationale: `[FICTIONAL TEST FIXTURE] Created directly to satisfy portfolio test program-count requirements. ` +
          `Not produced by the strategy composer. Labeled simulated=true.`,
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
    mapped.push({
      programId: created.id,
      title: created.title,
      sector: created.sector,
    });
  }
  return mapped;
}

// ============================================================
// 01-05: Portfolio & Dependency Graph
// ============================================================
describeIntegration("01-05: Portfolio & Dependency Graph", () => {
  beforeEach(async () => {
    // Clean up: tasks, programs, dependencies, strategies from previous test runs
    await adminClient.dependency.deleteMany({
      where: { tenantId: tenantAId },
    });
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
  // 1. CREATE PORTFOLIO FROM DEMOLANDIA PROGRAMS
  // ============================================================
  it("1. builds a Portfolio from Demolandia programs", async () => {
    const { buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );

    const portfolio = await buildPortfolio(session, { strategyAlternativeId: versionId });

    expect(portfolio.strategyAlternativeId).toBe(versionId);
    expect(portfolio.nodes.length).toBe(programs.length);
    // No edges yet — buildPortfolio doesn't invent dependencies
    expect(portfolio.edges.length).toBe(0);
    expect(portfolio.cycles).toEqual([]);
    expect(portfolio.temporalDisclaimer).toBeTruthy();
    expect(portfolio.temporalDisclaimer).toContain("UNWEIGHTED");
  });

  // ============================================================
  // 2. CORRECT NODES + EDGES REPRESENTATION
  // ============================================================
  it("2. represents nodes and edges with the correct contract", async () => {
    const { buildPortfolio, addDependency } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );

    // Need at least 2 programs to add an edge
    expect(programs.length).toBeGreaterThanOrEqual(2);

    // Add one edge to verify the edge contract.
    // FIX-2 direction convention: fromProgramId (p1) is the PREREQUISITE,
    // toProgramId (p2) is the DEPENDENT. So edge p1 → p2 (requires) means
    // p1 must be done before p2; "p2 requires p1's outputs".
    const [p1, p2] = programs;
    const edge = await addDependency(session, {
      strategyAlternativeId: versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[FICTIONAL TEST FIXTURE] p1 is a prerequisite for p2 — p2 requires p1's outputs before it can proceed.",
      source: "simulated",
    });

    // Edge contract
    expect(edge.id).toBeTruthy();
    expect(edge.fromProgramId).toBe(p1!.programId);
    expect(edge.toProgramId).toBe(p2!.programId);
    expect(edge.type).toBe("requires");
    expect(edge.rationale).toBeTruthy();
    expect(edge.source).toBe("simulated");
    expect(edge.simulated).toBe(true);
    expect(edge.evidenceRef).toBeNull(); // FIX-1: simulated edges have no evidenceRef
    expect(edge.createdAt).toBeInstanceOf(Date);

    // Rebuild portfolio and verify nodes + edges
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: versionId });

    // Nodes: each PortfolioNode has the full contract
    for (const node of portfolio.nodes) {
      expect(node.programId).toBeTruthy();
      expect(node.title).toBeTruthy();
      expect(node.sector).toBeTruthy();
      expect(node.strategyVersionId).toBe(versionId);
      expect(node.status).toBe("draft");
      expect(typeof node.simulated).toBe("boolean");
    }

    // Edges: exactly one, with the full contract
    expect(portfolio.edges.length).toBe(1);
    expect(portfolio.edges[0]!.id).toBe(edge.id);
    expect(portfolio.edges[0]!.fromProgramId).toBe(p1!.programId);
    expect(portfolio.edges[0]!.toProgramId).toBe(p2!.programId);
    expect(portfolio.edges[0]!.type).toBe("requires");
  });

  // ============================================================
  // 3. ACCEPT VALID `requires` RELATION
  // ============================================================
  it("3. accepts a valid `requires` relation", async () => {
    const { addDependency, getDependencies } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // Ensure at least 2 programs for the edge test
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    expect(programs.length).toBeGreaterThanOrEqual(2);

    const [p1, p2] = programs;
    const edge = await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[FICTIONAL] p1 is a prerequisite for p2 — p2 requires p1's irrigation outputs before expanding cultivation.",
      source: "simulated",
    });

    expect(edge.type).toBe("requires");
    expect(edge.fromProgramId).toBe(p1!.programId);
    expect(edge.toProgramId).toBe(p2!.programId);

    // Verify it's persisted
    const deps = await getDependencies(session, setup.versionId);
    expect(deps.length).toBe(1);
    expect(deps[0]!.id).toBe(edge.id);
  });

  // ============================================================
  // 4. REJECT EDGE WITH NON-EXISTENT REFERENCE
  // ============================================================
  it("4. rejects an edge with a non-existent program reference", async () => {
    const { addDependency } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    expect(programs.length).toBeGreaterThanOrEqual(1);

    await expect(addDependency(session, {
      strategyAlternativeId: versionId,
      fromProgramId: "nonexistent-program-id-12345",
      toProgramId: programs[0]!.programId,
      type: "requires",
      rationale: "should fail — fromProgram doesn't exist",
      source: "simulated",
    })).rejects.toThrow(/not found in tenant/);

    // Also test non-existent toProgramId
    await expect(addDependency(session, {
      strategyAlternativeId: versionId,
      fromProgramId: programs[0]!.programId,
      toProgramId: "nonexistent-program-id-67890",
      type: "requires",
      rationale: "should fail — toProgram doesn't exist",
      source: "simulated",
    })).rejects.toThrow(/not found in tenant/);
  });

  // ============================================================
  // 5. REJECT CROSS-TENANT RELATION (RLS)
  // ============================================================
  it("5. rejects a cross-tenant dependency (RLS + service validation)", async () => {
    const { addDependency } = await import("@/lib/state-builder/portfolio-service");
    const sessionA = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Set up programs in tenant A
    const setupA = await setupAlternativeWithPrograms(
      sessionA, [objectiveAgricultureId]
    );

    // Set up a program in tenant B (need an analyst in tenant B)
    // Demolandia's CB tenant has the same analyst? Let's check by creating a
    // dedicated test user in tenant B if needed.
    const tenantBAnalyst = await adminClient.user.upsert({
      where: { email: "tenant-b-analyst@demolandia.test" },
      update: {},
      create: {
        email: "tenant-b-analyst@demolandia.test",
        name: "Tenant B Analyst",
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

    // Tenant B's objectives: we need to seed at least one for tenant B to compose.
    // The CB tenant may not have objectives — check first.
    const tenantBObjective = await adminClient.objective.findFirst({
      where: { tenantId: tenantBId },
    });

    let tenantBProgramId: string;
    if (tenantBObjective) {
      const setupB = await setupAlternativeWithPrograms(sessionB, [tenantBObjective.id]);
      tenantBProgramId = setupB.programs[0]!.programId;
    } else {
      // Skip — no tenant B objectives; the cross-tenant attempt will fail at the
      // program-not-found level which still demonstrates the protection.
      // Try to add an edge where toProgramId is a tenant B program — but we
      // don't have one. Just verify the fromProgramId check rejects.
      await expect(addDependency(sessionA, {
        strategyAlternativeId: setupA.versionId,
        fromProgramId: setupA.programs[0]!.programId,
        toProgramId: "fake-tenant-b-program-id",
        type: "requires",
        rationale: "should fail",
        source: "simulated",
      })).rejects.toThrow(/not found in tenant/);
      return;
    }

    // Try to add an edge from a tenant A program to a tenant B program.
    // Tenant A's RLS will not see the tenant B program → validation fails.
    await expect(addDependency(sessionA, {
      strategyAlternativeId: setupA.versionId,
      fromProgramId: setupA.programs[0]!.programId,
      toProgramId: tenantBProgramId,
      type: "requires",
      rationale: "should fail — cross-tenant edge rejected",
      source: "simulated",
    })).rejects.toThrow(/not found in tenant/);
  });

  // ============================================================
  // 6. REJECT RELATION CONNECTING PROGRAM OUTSIDE ALLOWED ALTERNATIVE
  // ============================================================
  it("6. rejects a dependency connecting programs from two different alternatives", async () => {
    const { addDependency } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose + expand TWO different alternatives (different objectives)
    const alt1 = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId]
    );
    const alt2 = await setupAlternativeWithPrograms(
      session, [objectiveInflationId]
    );

    // The two alternatives have different versionIds
    expect(alt1.versionId).not.toBe(alt2.versionId);

    // Try to add an edge from a program in alt1 to a program in alt2,
    // declaring strategyAlternativeId = alt1.versionId.
    // The toProgram is NOT in alt1 → validation must reject.
    await expect(addDependency(session, {
      strategyAlternativeId: alt1.versionId,
      fromProgramId: alt1.programs[0]!.programId,
      toProgramId: alt2.programs[0]!.programId,
      type: "requires",
      rationale: "should fail — toProgram is in a different alternative",
      source: "simulated",
    })).rejects.toThrow(/not found in tenant.*for strategy version/);

    // Also test the reverse: declaring strategyAlternativeId = alt2.versionId,
    // fromProgram is in alt1 → also rejected
    await expect(addDependency(session, {
      strategyAlternativeId: alt2.versionId,
      fromProgramId: alt1.programs[0]!.programId,
      toProgramId: alt2.programs[0]!.programId,
      type: "requires",
      rationale: "should fail — fromProgram is in a different alternative",
      source: "simulated",
    })).rejects.toThrow(/not found in tenant.*for strategy version/);
  });

  // ============================================================
  // 7. DETECT CYCLE AND PREVENT STORAGE
  // ============================================================
  it("7. detects a cycle and prevents storage (requires)", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    expect(programs.length).toBeGreaterThanOrEqual(2);

    const [p1, p2] = programs;

    // Add p1 → p2 (requires) — should succeed.
    // FIX-2: edge p1 → p2 means p1 is prerequisite, p2 depends on p1.
    await addDependency(session, {
      strategyAlternativeId: versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[FICTIONAL] p1 is a prerequisite for p2 — p2 depends on p1's outputs.",
      source: "simulated",
    });

    // Now try p2 → p1 (requires) — should fail (would close a cycle).
    // This edge would assert "p2 is a prerequisite for p1", but p1 is already
    // a prerequisite for p2. Adding it creates a circular dependency.
    await expect(addDependency(session, {
      strategyAlternativeId: versionId,
      fromProgramId: p2!.programId,
      toProgramId: p1!.programId,
      type: "requires",
      rationale: "[FICTIONAL] p2 is a prerequisite for p1 — but this would create a cycle (p1 → p2 → p1).",
      source: "simulated",
    })).rejects.toThrow(/cycle/i);

    // Verify the cycle-creating edge was NOT stored
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: versionId });
    expect(portfolio.edges.length).toBe(1); // only the first edge
    expect(portfolio.cycles).toEqual([]);
  });

  // ============================================================
  // 8. COMPUTE LONGEST CHAIN (UNWEIGHTED) + TEMPORAL DISCLAIMER
  // ============================================================
  it("8. computes the longest dependency chain (UNWEIGHTED) and surfaces a temporal disclaimer", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // The composer may only produce 2 programs for 2 objectives.
    // We need 3 for a 3-node chain — directly create a third FICTIONAL test program.
    const programs = await ensureProgramCount(session, setup.versionId, 3);
    expect(programs.length).toBeGreaterThanOrEqual(3);

    // Build a chain p1 → p2 → p3 (requires).
    // FIX-2 direction convention: each edge A → B means A is prerequisite, B is dependent.
    // So p1 precedes p2, p2 precedes p3, in execution order.
    const [p1, p2, p3] = programs;
    await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[FICTIONAL] p1 is a prerequisite for p2 (p1 precedes p2 in execution order).",
      source: "simulated",
    });
    await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p2!.programId,
      toProgramId: p3!.programId,
      type: "requires",
      rationale: "[FICTIONAL] p2 is a prerequisite for p3 (p2 precedes p3 in execution order).",
      source: "simulated",
    });

    const portfolio = await buildPortfolio(session, { strategyAlternativeId: setup.versionId });

    // Critical path should be the longest chain: p1 → p2 → p3 (topological order).
    // p1 is first (no prerequisites), p2 depends on p1, p3 depends on p2.
    expect(portfolio.criticalPath.length).toBe(3);
    expect(portfolio.criticalPath[0]).toBe(p1!.programId);
    expect(portfolio.criticalPath[1]).toBe(p2!.programId);
    expect(portfolio.criticalPath[2]).toBe(p3!.programId);

    // The temporal disclaimer MUST be present and explicitly state
    // that the path is UNWEIGHTED (no temporal/duration data).
    expect(portfolio.temporalDisclaimer).toBeTruthy();
    expect(portfolio.temporalDisclaimer.toLowerCase()).toContain("unweighted");
    expect(portfolio.temporalDisclaimer).toContain("01-07");
  });

  // ============================================================
  // 9. SHOW `conflicts` RELATIONS WITHOUT TREATING THEM AS CYCLES
  // ============================================================
  it("9. allows bidirectional `conflicts` (not treated as cycles)", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    expect(programs.length).toBeGreaterThanOrEqual(2);

    const [p1, p2] = programs;

    // Add p1 → p2 (conflicts) — should succeed
    const e1 = await addDependency(session, {
      strategyAlternativeId: versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "conflicts",
      rationale: "[FICTIONAL] p1 and p2 compete for the same water resources.",
      source: "simulated",
    });
    expect(e1.type).toBe("conflicts");

    // Add p2 → p1 (conflicts) — should ALSO succeed (mutual exclusion, NOT a cycle)
    const e2 = await addDependency(session, {
      strategyAlternativeId: versionId,
      fromProgramId: p2!.programId,
      toProgramId: p1!.programId,
      type: "conflicts",
      rationale: "[FICTIONAL] p2 and p1 compete for the same water resources (reverse direction).",
      source: "simulated",
    });
    expect(e2.type).toBe("conflicts");
    expect(e2.id).not.toBe(e1.id); // different edges (different direction)

    // Portfolio should have NO cycles (conflicts don't count)
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: versionId });
    expect(portfolio.cycles).toEqual([]);
    expect(portfolio.edges.length).toBe(2);

    // Critical path should NOT include conflicts edges — only requires+enables.
    // With no requires/enables edges, critical path is a single node.
    expect(portfolio.criticalPath.length).toBe(1);
  });

  // ============================================================
  // 10. DON'T INVENT DEPENDENCIES WHEN NO EVIDENCE
  // ============================================================
  it("10. does not invent dependencies when no edges have been added", async () => {
    const { buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    expect(programs.length).toBeGreaterThan(0);

    // Freshly built portfolio — no edges added by us, no edges invented by the service.
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: versionId });
    expect(portfolio.edges.length).toBe(0);
    expect(portfolio.nodes.length).toBe(programs.length);
    expect(portfolio.cycles).toEqual([]);
    expect(portfolio.criticalPath.length).toBe(1); // single node — no edges

    // Verify the DB has zero dependencies for these programs
    const dbDeps = await adminClient.dependency.findMany({
      where: {
        tenantId: tenantAId,
        OR: [
          { fromProgramId: { in: programs.map((p) => p.programId) } },
          { toProgramId: { in: programs.map((p) => p.programId) } },
        ],
      },
    });
    expect(dbDeps.length).toBe(0);
  });

  // ============================================================
  // 11. DON'T DUPLICATE EDGES ON REBUILD (idempotent)
  // ============================================================
  it("11. does not duplicate edges on re-add (idempotent addDependency)", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // Ensure at least 2 programs for the edge test
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    expect(programs.length).toBeGreaterThanOrEqual(2);

    const [p1, p2] = programs;

    // Add the same edge twice
    const edge1 = await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[FICTIONAL] p1 → p2",
      source: "simulated",
    });

    const edge2 = await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[FICTIONAL] p1 → p2 (second call — should be idempotent)",
      source: "simulated",
    });

    // Same edge id — no duplicate
    expect(edge2.id).toBe(edge1.id);

    // Portfolio shows exactly one edge
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: setup.versionId });
    expect(portfolio.edges.length).toBe(1);

    // DB has exactly one row
    const dbDeps = await adminClient.dependency.findMany({
      where: {
        tenantId: tenantAId,
        fromProgramId: p1!.programId,
        toProgramId: p2!.programId,
        type: "requires",
      },
    });
    expect(dbDeps.length).toBe(1);
  });

  // ============================================================
  // 12. CONCURRENCY: PREVENT CYCLE FROM RACE BETWEEN TWO OPERATIONS
  // ============================================================
  it("12. concurrent addDependency calls do not allow a cycle from a race", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const { versionId, programs } = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    expect(programs.length).toBeGreaterThanOrEqual(2);

    const [p1, p2] = programs;

    // Launch TWO concurrent addDependency calls that together form a cycle:
    //   Worker A: p1 → p2 (requires)
    //   Worker B: p2 → p1 (requires)
    //
    // Without serialization, both could pass cycle detection and commit, leaving a cycle.
    // With pg_advisory_xact_lock, they serialize — one wins, the other sees the
    // first's edge and is rejected for cycle.
    const results = await Promise.allSettled([
      addDependency(session, {
        strategyAlternativeId: versionId,
        fromProgramId: p1!.programId,
        toProgramId: p2!.programId,
        type: "requires",
        rationale: "[FICTIONAL] p1 → p2 (concurrent worker A)",
        source: "simulated",
      }),
      addDependency(session, {
        strategyAlternativeId: versionId,
        fromProgramId: p2!.programId,
        toProgramId: p1!.programId,
        type: "requires",
        rationale: "[FICTIONAL] p2 → p1 (concurrent worker B)",
        source: "simulated",
      }),
    ]);

    // Exactly one must succeed, the other must fail with a cycle error.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejectedReason.message.toLowerCase()).toContain("cycle");

    // The portfolio must NOT have a cycle — the cycle-creating edge was rejected.
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: versionId });
    expect(portfolio.cycles).toEqual([]);
    expect(portfolio.edges.length).toBe(1); // only one edge — the winner

    // The DB has exactly one edge
    const dbDeps = await adminClient.dependency.findMany({
      where: { tenantId: tenantAId },
    });
    expect(dbDeps.length).toBe(1);
  });

  // ============================================================
  // 13. DEMOLANDIA FICTIONAL FIXTURE EXAMPLE
  // ------------------------------------------------------------
  // Demolandia has no REAL documented cross-program relations.
  // We explicitly mark the example as `simulated: true` (FICTIONAL)
  // rather than pretending the relations are proven facts.
  // This satisfies the mission requirement to "provide a clear
  // Demolandia example showing a valid `requires` relation and a
  // `conflicts` relation, distinguished from assumptions/simulated".
  // ============================================================
  it("13. Demolandia Fictional fixture: one `requires` + one `conflicts` (labeled simulated)", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // Ensure at least 2 programs for the example
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    expect(programs.length).toBeGreaterThanOrEqual(2);

    const [p1, p2] = programs;

    // FICTIONAL `requires` example.
    // FIX-2 direction convention: edge p1 → p2 (requires) means p1 is the
    // PREREQUISITE and p2 is the DEPENDENT. So "p2 requires p1's outputs".
    // This is simulated — Demolandia does not have documented cross-program
    // dependency relations. The rationale explicitly says so.
    const requiresEdge = await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale:
        "[FICTIONAL FIXTURE] Simulated: program '" + p1!.title + "' is assumed to be a prerequisite " +
        "for program '" + p2!.title + "' — p2 is assumed to require p1's outputs before it can scale. " +
        "Direction: fromProgramId (p1) is the prerequisite, toProgramId (p2) is the dependent. " +
        "No real-world documentation supports this relation — it is a placeholder " +
        "for testing the portfolio engine and would be replaced by evidence-grounded " +
        "relations in a real deployment.",
      source: "simulated",
    });
    expect(requiresEdge.simulated).toBe(true);
    expect(requiresEdge.source).toBe("simulated");
    expect(requiresEdge.evidenceRef).toBeNull(); // FIX-1: simulated edges have no evidenceRef

    // FICTIONAL `conflicts` example: p2 and p1 conflict (resource competition).
    // For conflicts, direction is informational only — both directions are
    // allowed and do NOT participate in cycle detection.
    const conflictsEdge = await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p2!.programId,
      toProgramId: p1!.programId,
      type: "conflicts",
      rationale:
        "[FICTIONAL FIXTURE] Simulated: programs '" + p2!.title + "' and '" + p1!.title + "' " +
        "are assumed to compete for the same resource pool. No real-world documentation " +
        "supports this conflict — it is a placeholder for testing the conflicts edge type. " +
        "Direction is informational for conflicts; bidirectional conflict edges are allowed.",
      source: "simulated",
    });
    expect(conflictsEdge.simulated).toBe(true);
    expect(conflictsEdge.source).toBe("simulated");
    expect(conflictsEdge.type).toBe("conflicts");
    expect(conflictsEdge.evidenceRef).toBeNull(); // FIX-1: simulated edges have no evidenceRef

    // Verify the portfolio reflects both edges correctly.
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: setup.versionId });
    expect(portfolio.edges.length).toBe(2);

    const reqEdge = portfolio.edges.find((e) => e.type === "requires");
    const confEdge = portfolio.edges.find((e) => e.type === "conflicts");
    expect(reqEdge).toBeDefined();
    expect(confEdge).toBeDefined();
    expect(reqEdge!.simulated).toBe(true);
    expect(confEdge!.simulated).toBe(true);

    // No cycles — conflicts don't create cycles, and there's no requires/enables cycle.
    expect(portfolio.cycles).toEqual([]);

    // Critical path uses only the requires edge — length 2.
    expect(portfolio.criticalPath.length).toBe(2);
    expect(portfolio.criticalPath[0]).toBe(p1!.programId);
    expect(portfolio.criticalPath[1]).toBe(p2!.programId);
  });

  // ============================================================
  // 14. FIX-2: CHAIN ORDERING — A → B → C means A precedes B, B precedes C
  // ------------------------------------------------------------
  // Explicit verification of the direction convention. This test
  // documents the semantic contract: in a requires/enables chain
  // A → B → C, A is the earliest prerequisite and C is the latest
  // dependent. The critical path returns programIds in topological
  // order (earliest first).
  // ============================================================
  it("14. FIX-2: chain A → B → C means A precedes B, B precedes C (topological order)", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    // Need 3 programs for a 3-node chain
    const programs = await ensureProgramCount(session, setup.versionId, 3);
    expect(programs.length).toBeGreaterThanOrEqual(3);

    const [A, B, C] = programs;

    // Build chain A → B → C using `enables` (alternative ordering type).
    // FIX-2: A → B (enables) means A's outputs enable B. A is the enabler
    // (prerequisite), B is enabled (dependent). Same direction convention
    // as `requires`.
    await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: A!.programId,
      toProgramId: B!.programId,
      type: "enables",
      rationale: "[FICTIONAL FIX-2] A's outputs enable B — A is the enabler, B is enabled by A.",
      source: "simulated",
    });
    await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: B!.programId,
      toProgramId: C!.programId,
      type: "enables",
      rationale: "[FICTIONAL FIX-2] B's outputs enable C — B is the enabler, C is enabled by B.",
      source: "simulated",
    });

    const portfolio = await buildPortfolio(session, { strategyAlternativeId: setup.versionId });

    // The critical path MUST be [A, B, C] — topological order, earliest first.
    // This is the FIX-2 contract: A precedes B, B precedes C.
    expect(portfolio.criticalPath).toEqual([A!.programId, B!.programId, C!.programId]);

    // The reverse direction (C → B → A) would be WRONG and indicates a bug.
    expect(portfolio.criticalPath).not.toEqual([C!.programId, B!.programId, A!.programId]);

    // No cycles in a clean chain.
    expect(portfolio.cycles).toEqual([]);

    // Now verify that adding C → A (which would close a cycle A → B → C → A)
    // is rejected. This confirms the direction convention is enforced: C is
    // the LATEST dependent, it cannot be a prerequisite for A (the earliest).
    await expect(addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: C!.programId,
      toProgramId: A!.programId,
      type: "requires",
      rationale: "[FICTIONAL FIX-2] C as prerequisite for A — would close cycle A → B → C → A.",
      source: "simulated",
    })).rejects.toThrow(/cycle/i);

    // Verify the cycle-creating edge was NOT stored — portfolio still has 2 edges.
    const portfolio2 = await buildPortfolio(session, { strategyAlternativeId: setup.versionId });
    expect(portfolio2.edges.length).toBe(2);
    expect(portfolio2.cycles).toEqual([]);
  });

  // ============================================================
  // 15. FIX-1: source="documented" REQUIRES an evidenceRef
  // ------------------------------------------------------------
  // Rejects documented edges with no evidence, empty evidenceId,
  // or empty claim. A rationale text alone does not constitute
  // documentation.
  // ============================================================
  it("15. FIX-1: rejects source='documented' without a valid evidenceRef", async () => {
    const { addDependency } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [p1, p2] = programs;

    // 15a. No evidenceRef at all
    await expect(addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "documented relation without evidence — should be rejected",
      source: "documented",
      // evidenceRef omitted
    })).rejects.toThrow(/source="documented" requires an evidenceRef/i);

    // 15b. evidenceRef with empty evidenceId
    await expect(addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "documented relation with empty evidenceId — should be rejected",
      source: "documented",
      evidenceRef: { evidenceId: "", claim: "some claim", sourceCode: null },
    })).rejects.toThrow(/source="documented" requires an evidenceRef/i);

    // 15c. evidenceRef with empty claim
    await expect(addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "documented relation with empty claim — should be rejected",
      source: "documented",
      evidenceRef: { evidenceId: "some-id", claim: "  ", sourceCode: null },
    })).rejects.toThrow(/source="documented" requires an evidenceRef/i);
  });

  // ============================================================
  // 16. FIX-1: source="human" / "simulated" must NOT carry evidenceRef
  // ------------------------------------------------------------
  // Allowing evidenceRef on non-documented edges would blur the
  // provenance distinction.
  // ============================================================
  it("16. FIX-1: rejects evidenceRef on source='human' or 'simulated' edges", async () => {
    const { addDependency } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [p1, p2] = programs;

    // 16a. source="human" with evidenceRef — rejected
    await expect(addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "human assertion with evidence — should be rejected (use source=documented)",
      source: "human",
      evidenceRef: { evidenceId: "fake-id", claim: "fake claim", sourceCode: null },
    })).rejects.toThrow(/source="human" must not include an evidenceRef/i);

    // 16b. source="simulated" with evidenceRef — rejected
    await expect(addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "simulated relation with evidence — should be rejected",
      source: "simulated",
      evidenceRef: { evidenceId: "fake-id", claim: "fake claim", sourceCode: null },
    })).rejects.toThrow(/source="simulated" must not include an evidenceRef/i);

    // 16c. source="human" WITHOUT evidenceRef — accepted (human assertion, no evidence)
    const humanEdge = await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[FICTIONAL] human assertion — p1 is a prerequisite for p2 (no evidence cited).",
      source: "human",
    });
    expect(humanEdge.source).toBe("human");
    expect(humanEdge.simulated).toBe(false);
    expect(humanEdge.evidenceRef).toBeNull();
  });

  // ============================================================
  // 17. FIX-1: source="documented" with non-existent evidence is rejected
  // ============================================================
  it("17. FIX-1: rejects source='documented' with non-existent evidenceId", async () => {
    const { addDependency } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [p1, p2] = programs;

    await expect(addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "documented relation citing non-existent evidence — should be rejected",
      source: "documented",
      evidenceRef: {
        evidenceId: "nonexistent-evidence-id-12345",
        claim: "this evidence does not exist",
        sourceCode: null,
      },
    })).rejects.toThrow(/not found in tenant/i);
  });

  // ============================================================
  // 18. FIX-1: source="documented" with out-of-scope (cross-country) evidence is rejected
  // ============================================================
  it("18. FIX-1: rejects source='documented' with cross-country evidence", async () => {
    const { addDependency } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [p1, p2] = programs;

    // Create evidence in a DIFFERENT country (P04 Testland from test 3 pattern)
    const otherCountry = await adminClient.country.upsert({
      where: { iso3: "P04" },
      update: {},
      create: { iso3: "P04", iso2: "P4", displayName: "P04 Testland", status: "active" },
    });
    const otherEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantAId, // same tenant!
        claim: "Cross-country evidence for FIX-1 test",
        type: "neutral",
        verificationStatus: "unverified",
        metadata: {
          countryId: otherCountry.id, // different country!
          sector: "agriculture",
          fictional: true,
          seededBy: "01-05-FIX-1-test",
        } as never,
      },
    });

    try {
      // The strategy version is for Demolandia (countryId from inputSnapshot),
      // but the evidence is for P04 Testland. Must be rejected.
      await expect(addDependency(session, {
        strategyAlternativeId: setup.versionId,
        fromProgramId: p1!.programId,
        toProgramId: p2!.programId,
        type: "requires",
        rationale: "documented relation citing cross-country evidence — should be rejected",
        source: "documented",
        evidenceRef: {
          evidenceId: otherEvidence.id,
          claim: "this evidence belongs to a different country",
          sourceCode: null,
        },
      })).rejects.toThrow(/Cross-country evidence references are not allowed/i);
    } finally {
      await adminClient.evidence.delete({ where: { id: otherEvidence.id } });
      await adminClient.country.deleteMany({ where: { iso3: "P04" } });
    }
  });

  // ============================================================
  // 19. FIX-1: source="documented" with valid in-scope evidence is ACCEPTED
  //            and the evidenceRef is stored + exposed on the edge
  // ============================================================
  it("19. FIX-1: accepts source='documented' with valid in-scope evidence + stores evidenceRef", async () => {
    const { addDependency, buildPortfolio } = await import("@/lib/state-builder/portfolio-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const setup = await setupAlternativeWithPrograms(
      session, [objectiveAgricultureId, objectiveInflationId]
    );
    const programs = await ensureProgramCount(session, setup.versionId, 2);
    const [p1, p2] = programs;

    // Fetch a real Demolandia evidence (same tenant + same country).
    // The strategy version's countryId comes from metadata.inputSnapshot.countryId,
    // which the composer sets to the Demolandia countryId.
    const realEvidence = await adminClient.evidence.findFirst({
      where: { tenantId: tenantAId },
    });
    if (!realEvidence) {
      throw new Error("Test setup failed: no evidence seeded for tenantA");
    }
    // Verify the evidence has a countryId in metadata (it should — seed sets it)
    const evMeta = (realEvidence.metadata ?? {}) as Record<string, unknown>;
    expect(typeof evMeta.countryId).toBe("string");

    // Add a documented edge citing this real evidence.
    // FIX-2 direction: p1 → p2 means p1 is prerequisite, p2 depends on p1.
    const edge = await addDependency(session, {
      strategyAlternativeId: setup.versionId,
      fromProgramId: p1!.programId,
      toProgramId: p2!.programId,
      type: "requires",
      rationale: "[DOCUMENTED] p1 is a prerequisite for p2 — evidence cited as examinable support.",
      source: "documented",
      evidenceRef: {
        evidenceId: realEvidence.id,
        claim: "This evidence supports the documented prerequisite relation between p1 and p2.",
        sourceCode: null,
      },
    });

    // The edge MUST expose the validated evidenceRef
    expect(edge.source).toBe("documented");
    expect(edge.simulated).toBe(false);
    expect(edge.evidenceRef).not.toBeNull();
    expect(edge.evidenceRef!.evidenceId).toBe(realEvidence.id);
    expect(edge.evidenceRef!.claim).toBeTruthy();

    // Rebuild portfolio and verify the evidenceRef survives the round-trip
    const portfolio = await buildPortfolio(session, { strategyAlternativeId: setup.versionId });
    const portEdge = portfolio.edges.find((e) => e.id === edge.id);
    expect(portEdge).toBeDefined();
    expect(portEdge!.source).toBe("documented");
    expect(portEdge!.simulated).toBe(false);
    expect(portEdge!.evidenceRef).not.toBeNull();
    expect(portEdge!.evidenceRef!.evidenceId).toBe(realEvidence.id);

    // Verify the evidenceRef is also persisted in the DB metadata
    const dbDep = await adminClient.dependency.findUnique({ where: { id: edge.id } });
    const dbMeta = (dbDep!.metadata ?? {}) as Record<string, unknown>;
    expect(dbMeta.source).toBe("documented");
    expect(dbMeta.evidenceRef).toBeDefined();
    const dbEvRef = dbMeta.evidenceRef as Record<string, unknown>;
    expect(dbEvRef.evidenceId).toBe(realEvidence.id);
  });
});
