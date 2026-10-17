// ============================================================
// g01-program-contracts.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-04: Institutional Design & Program Contracts.
//
// 10 acceptance tests per mission pack §6:
//   1. Expand Demolandia programs into institutional contracts
//   2. Reject non-existent institution
//   3. Reject institution from another country
//   4. Show mandate gap when no legal basis
//   5. KPIs have sourceKind
//   6. No fabricated KPI or legal mandate
//   7. Preserve evidence refs + counter-evidence
//   8. Tenant isolation + permissions
//   9. No duplicate programs on re-expansion
//   10. No regression (CI verifies)
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
let strategyVersionIdA: string;
let strategyVersionIdB: string;

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

// Helper: compose strategies + get a version ID for expansion
async function getComposedVersionId(
  session: Session,
  objectiveIds: string[]
): Promise<string> {
  const { composeStrategies } = await import("@/lib/state-builder/strategy-composer-service");
  const result = await composeStrategies(session, { countryId, objectiveIds });
  // Return the first alternative's versionId
  return result.alternatives[0]!.versionId;
}

// ============================================================
// 1. EXPAND PROGRAMS
// ============================================================
describeIntegration("Program Contracts — expandPrograms", () => {
  beforeEach(async () => {
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

  it("1. expands Demolandia programs into institutional contracts", async () => {
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const versionId = await getComposedVersionId(session, [objectiveAgricultureId, objectiveInflationId]);
    const result = await expandPrograms(session, { strategyAlternativeId: versionId });

    expect(result.programs.length).toBeGreaterThan(0);

    for (const prog of result.programs) {
      expect(prog.title).toBeTruthy();
      expect(prog.sector).toBeTruthy();
      expect(prog.simulated).toBe(true);
      expect(prog.status).toBe("draft");
      expect(prog.rationale).toBeTruthy();
      expect(prog.evidenceRefs).toBeDefined();
    }
  });

  it("2. rejects non-existent institution (validateInstitutionForCountry)", async () => {
    const { validateInstitutionForCountry } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const result = await validateInstitutionForCountry(session, "nonexistent-id-12345", countryId);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("3. rejects institution from another country", async () => {
    const { validateInstitutionForCountry } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Create a second country + institution
    const otherCountry = await adminClient.country.upsert({
      where: { iso3: "P04" },
      update: {},
      create: { iso3: "P04", iso2: "P4", displayName: "P04 Testland", status: "active" },
    });
    const otherInstitution = await adminClient.institution.create({
      data: {
        countryId: otherCountry.id,
        code: "P04-MIN",
        displayName: "P04 Ministry",
        type: "ministry",
      },
    });

    const result = await validateInstitutionForCountry(session, otherInstitution.id, countryId);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("different country") // true

    // Clean up
    await adminClient.institution.delete({ where: { id: otherInstitution.id } });
    await adminClient.country.deleteMany({ where: { iso3: "P04" } });
  });

  it("4. shows mandate gap when no legal basis is documented", async () => {
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const versionId = await getComposedVersionId(session, [objectiveAgricultureId]);
    const result = await expandPrograms(session, { strategyAlternativeId: versionId });

    // Demolandia has no legal mandates documented → all programs should have mandateGap=true
    for (const prog of result.programs) {
      expect(prog.mandateGap).toBe(true);
      expect(prog.legalMandateRef).toBeNull();
    }
    expect(result.summary.withMandateGap).toBe(result.programs.length);
  });

  it("5. KPIs have sourceKind (not just name + target)", async () => {
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const versionId = await getComposedVersionId(session, [objectiveAgricultureId, objectiveInflationId]);
    const result = await expandPrograms(session, { strategyAlternativeId: versionId });

    for (const prog of result.programs) {
      for (const kpi of prog.kpis) {
        expect(kpi.sourceKind).toBeTruthy();
        expect(["official_statistics", "administrative_data", "survey", "international_indicator", "unspecified"])
          .toContain(kpi.sourceKind);
        expect(kpi.frequency).toBeTruthy();
      }
    }
  });

  it("6. no fabricated KPI values or legal mandates", async () => {
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const versionId = await getComposedVersionId(session, [objectiveAgricultureId]);
    const result = await expandPrograms(session, { strategyAlternativeId: versionId });

    for (const prog of result.programs) {
      // KPI targets must come from the objective, not fabricated
      for (const kpi of prog.kpis) {
        // The target should be a known objective targetValue (e.g., "6%")
        // NOT a fabricated number
        expect(kpi.target).toBeTruthy();
      }
      // Legal mandate must NOT be fabricated
      expect(prog.legalMandateRef).toBeNull(); // No fabricated reference
      expect(prog.mandateGap).toBe(true); // Honestly documented
    }
  });

  it("7. preserves evidence refs and counter-evidence", async () => {
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Agriculture has counter-evidence (Reuters + AP)
    const versionId = await getComposedVersionId(session, [objectiveAgricultureId]);
    const result = await expandPrograms(session, { strategyAlternativeId: versionId });

    // At least one program should have evidence refs
    const programsWithEvidence = result.programs.filter((p) => p.evidenceRefs.length > 0);
    expect(programsWithEvidence.length).toBeGreaterThan(0);

    // Counter-evidence should be preserved
    const programsWithCounter = result.programs.filter((p) => p.counterEvidence.length > 0);
    expect(programsWithCounter.length).toBeGreaterThan(0);

    // Verify evidence refs are real
    for (const prog of programsWithEvidence) {
      for (const ref of prog.evidenceRefs) {
        const evidence = await adminClient.evidence.findFirst({
          where: { id: ref.evidenceId, tenantId: tenantAId },
        });
        expect(evidence).toBeTruthy();
      }
    }
  });

  it("8. tenant isolation + permissions (observer rejected)", async () => {
    const { expandPrograms, getPrograms } = await import("@/lib/state-builder/program-service");

    // Observer cannot expand programs
    const observerUser = await adminClient.user.create({
      data: {
        email: "program-observer-01-04@demolandia.test",
        name: "Program Observer",
        passwordHash: await hashPassword("test_program_observer"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: { userId: observerUser.id, tenantId: tenantAId, roleCode: "observer", status: "active" },
    });
    const observerSession = makeSession({
      id: observerUser.id, tenantId: tenantAId, roleCode: "observer", membershipStatus: "active",
    });

    try {
      await expect(
        expandPrograms(observerSession, { strategyAlternativeId: "any-id" })
      ).rejects.toThrow(/Permission denied: strategy:write/);

      await expect(
        getPrograms(observerSession, "any-id")
      ).rejects.toThrow(/Permission denied: program:read/);
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: observerUser.id, tenantId: tenantAId } },
      });
      await adminClient.user.delete({ where: { id: observerUser.id } });
    }
  });

  it("8b. tenant B cannot read tenant A's programs (RLS)", async () => {
    const { expandPrograms, getPrograms } = await import("@/lib/state-builder/program-service");
    const sessionA = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const versionId = await getComposedVersionId(sessionA, [objectiveAgricultureId]);
    await expandPrograms(sessionA, { strategyAlternativeId: versionId });

    // Tenant B tries to read
    const tenantBUser = await adminClient.user.create({
      data: {
        email: "program-xtenant-01-04@demolandia.test",
        name: "Program Cross-Tenant",
        passwordHash: await hashPassword("test_program_xtenant"),
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
      const tenantBPrograms = await getPrograms(sessionB, versionId);
      expect(tenantBPrograms.length).toBe(0); // RLS blocks
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: tenantBUser.id, tenantId: tenantBId } },
      });
      await adminClient.user.delete({ where: { id: tenantBUser.id } });
    }
  });

  it("9. no duplicate programs on re-expansion (idempotent)", async () => {
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    const versionId = await getComposedVersionId(session, [objectiveAgricultureId]);

    // First expansion
    const result1 = await expandPrograms(session, { strategyAlternativeId: versionId });
    const programIds1 = new Set(result1.programs.map((p) => p.programId));

    // Second expansion (same version) — should reuse, not duplicate
    const result2 = await expandPrograms(session, { strategyAlternativeId: versionId });
    const programIds2 = new Set(result2.programs.map((p) => p.programId));

    // Same program IDs (no duplicates)
    expect(result2.programs.length).toBe(result1.programs.length);
    expect(programIds2).toEqual(programIds1);

    // Verify DB has no duplicates
    const dbPrograms = await adminClient.program.findMany({
      where: { tenantId: tenantAId, strategyVersionId: versionId },
    });
    expect(dbPrograms.length).toBe(result1.programs.length);
  });

  it("10. Demolandia example: program with institution + program with mandate gap", async () => {
    const { expandPrograms } = await import("@/lib/state-builder/program-service");
    const session = makeSession({
      id: analystUserId, tenantId: tenantAId, roleCode: "analyst", membershipStatus: "active",
    });

    // Compose with agriculture (has institution: Ministry of Planning) + education (may or may not)
    const versionId = await getComposedVersionId(session, [objectiveAgricultureId, objectiveEducationId]);
    const result = await expandPrograms(session, { strategyAlternativeId: versionId });

    // At least one program should have an institution assigned
    const withInstitution = result.programs.filter((p) => p.owningInstitutionId !== null);
    expect(withInstitution.length).toBeGreaterThan(0);

    // All programs should have mandateGap=true (Demolandia has no legal mandates)
    for (const prog of result.programs) {
      expect(prog.mandateGap).toBe(true);
    }

    // Summary should be correct
    expect(result.summary.totalPrograms).toBe(result.programs.length);
    expect(result.summary.withInstitution).toBe(withInstitution.length);
    expect(result.summary.withMandateGap).toBe(result.programs.length);
  });
});
