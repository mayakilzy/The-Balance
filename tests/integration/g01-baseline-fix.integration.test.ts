// ============================================================
// g01-baseline-fix.integration.test.ts
// ------------------------------------------------------------
// 01-01-FIX: Baseline Integrity Closure
// Tests for the 4 fixes requested by ChatGPT's review:
//
// FIX-1: Explicit LOW/Unknown Dimensions
//   - Sectors from CountryPackConfig appear even with 0 evidence
//   - LOW mode + empty indicators + gaps with "unknown"
//   - unknownSectors includes them
//
// FIX-2: Country-Specific Evidence Scoping
//   - Evidence scoped by metadata.countryId
//   - Unattributed evidence (no countryId) excluded + counted
//   - Other-country evidence excluded + counted
//   - Tenant with 2 countries: baseline for country A doesn't include country B's evidence
//
// FIX-3: Indicator Value Integrity
//   - Years (2024) NOT extracted as indicator values
//   - Percentages (4.2%) extracted safely
//   - Structured metadata.indicatorValue used with highest confidence
//   - Unparsable claims → "unparsed" with confidence="unparsed"
//
// FIX-4: Durable Task Contract
//   - claimTaskById respects lease (no stealing active tasks)
//   - Dynamic idempotency: new evidence → new task → fresh report
//   - Re-compute after adding evidence returns updated report
// ============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";

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

  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  await appClient.$queryRaw`SELECT 1`;
  await adminClient.$queryRaw`SELECT 1`;

  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia (DML) not seeded.");
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("Test tenants not seeded.");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const adminUser = await adminClient.user.findUnique({ where: { email: "admin@demolandia.test" } });
  const analystUser = await adminClient.user.findUnique({ where: { email: "analyst@demolandia.test" } });
  if (!adminUser || !analystUser) throw new Error("Test users not seeded.");
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;
});

afterAll(async () => {
  if (adminClient) await adminClient.$disconnect();
  if (appClient) await appClient.$disconnect();
});

// ============================================================
// FIX-1: Explicit LOW/Unknown Dimensions
// ============================================================
describeIntegration("FIX-1: Explicit LOW/Unknown Dimensions", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
  });

  it("sectors from CountryPackConfig appear in the report even with 0 evidence", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    // Tenant A's CountryPackConfig.sectors = ["agriculture","finance","education","health"]
    // Education + health have NO evidence → must appear as LOW (FIX-1)
    const education = report.dimensions.find((d) => d.sector === "education");
    const health = report.dimensions.find((d) => d.sector === "health");

    expect(education).toBeTruthy();
    expect(education!.observabilityMode).toBe("LOW");
    expect(education!.indicators).toEqual([]);
    expect(education!.evidenceCount).toBe(0);
    expect(education!.gaps.some((g) => g.includes("unknown"))).toBe(true);

    expect(health).toBeTruthy();
    expect(health!.observabilityMode).toBe("LOW");
    expect(health!.indicators).toEqual([]);
    expect(health!.evidenceCount).toBe(0);

    // unknownSectors must include education + health
    expect(report.summary.unknownSectors).toContain("education");
    expect(report.summary.unknownSectors).toContain("health");
  });

  it("LOW sector gaps explicitly say 'unknown'", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    const education = report.dimensions.find((d) => d.sector === "education");
    expect(education).toBeTruthy();
    // The gap must include the word "unknown" explicitly
    const hasUnknownGap = education!.gaps.some((g) => g.toLowerCase().includes("unknown"));
    expect(hasUnknownGap).toBe(true);
  });

  it("sectorsFilter restricts which sectors appear (but filtered-out sectors don't appear as LOW)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // Only compute agriculture
    const { report } = await computeBaseline(session, { countryId, sectors: ["agriculture"] });

    // Only agriculture should appear
    expect(report.dimensions.length).toBe(1);
    expect(report.dimensions[0]!.sector).toBe("agriculture");
    // Education/health should NOT appear (filtered out, not LOW)
    expect(report.dimensions.find((d) => d.sector === "education")).toBeUndefined();
  });
});

// ============================================================
// FIX-2: Country-Specific Evidence Scoping
// ============================================================
describeIntegration("FIX-2: Country-Specific Evidence Scoping", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute" },
    });
    // Clean up test evidence from previous runs
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[FIX-2-TEST]" } },
    });
  });

  it("evidence without metadata.countryId is excluded (unattributed)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // Add unattributed evidence (no metadata.countryId)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-2-TEST] Unattributed evidence without countryId",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { sector: "agriculture", fictional: true }, // NO countryId
      } as never,
    });

    const { report } = await computeBaseline(session, { countryId });

    // The unattributed evidence must NOT appear in agriculture indicators
    const agriculture = report.dimensions.find((d) => d.sector === "agriculture");
    const hasUnattributed = agriculture?.indicators.some(
      (i) => i.claim.includes("[FIX-2-TEST]")
    );
    expect(hasUnattributed).toBe(false);

    // The report must track unattributed evidence count
    expect(report.honesty.unattributedEvidenceCount).toBeGreaterThanOrEqual(1);
  });

  it("evidence from a different country is excluded (other country)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // Create a second fictional country
    const otherCountry = await adminClient.country.upsert({
      where: { iso3: "TST" },
      update: {},
      create: {
        iso3: "TST",
        iso2: "TS",
        displayName: "Testlandia (FIX-2 fixture)",
        status: "active",
      },
    });

    // Add evidence attributed to the OTHER country
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-2-TEST] Evidence for Testlandia, not Demolandia",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId: otherCountry.id, sector: "agriculture", fictional: true },
      } as never,
    });

    const { report } = await computeBaseline(session, { countryId });

    // The other-country evidence must NOT appear in Demolandia's agriculture
    const agriculture = report.dimensions.find((d) => d.sector === "agriculture");
    const hasOtherCountry = agriculture?.indicators.some(
      (i) => i.claim.includes("[FIX-2-TEST]") && i.claim.includes("Testlandia")
    );
    expect(hasOtherCountry).toBe(false);

    // The report must track other-country evidence count
    expect(report.honesty.otherCountryEvidenceCount).toBeGreaterThanOrEqual(1);
  });

  it("tenant with 2 countries: baseline for country A excludes country B's evidence", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // Create a second fictional country + add evidence for it (attributed to Tenant A)
    const otherCountry = await adminClient.country.upsert({
      where: { iso3: "TST2" },
      update: {},
      create: {
        iso3: "TST2",
        iso2: "T2",
        displayName: "Testlandia2 (FIX-2 fixture)",
        status: "active",
      },
    });

    // Add country pack config for the second country (so it has known sectors)
    await adminClient.countryPackConfig.upsert({
      where: { tenantId_countryId: { tenantId: tenantAId, countryId: otherCountry.id } },
      update: {},
      create: {
        tenantId: tenantAId,
        countryId: otherCountry.id,
        sectors: ["tourism"] as never,
        observability: {} as never,
        planningAssumptions: {} as never,
        metadata: { seededBy: "[FIX-2-TEST]" } as never,
      },
    });

    // Add evidence for the second country (tourism sector)
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-2-TEST] Testlandia2 tourism grew 12% in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId: otherCountry.id, sector: "tourism", fictional: true },
      } as never,
    });

    // Compute baseline for Demolandia (country A)
    const { report: reportA } = await computeBaseline(session, { countryId });

    // Demolandia's baseline must NOT include tourism sector
    const tourism = reportA.dimensions.find((d) => d.sector === "tourism");
    expect(tourism).toBeUndefined();

    // Demolandia's baseline must NOT include the Testlandia2 evidence
    const hasTestlandiaEvidence = reportA.dimensions.some((d) =>
      d.indicators.some((i) => i.claim.includes("Testlandia2"))
    );
    expect(hasTestlandiaEvidence).toBe(false);

    // Clean up
    await adminClient.countryPackConfig.deleteMany({
      where: { metadata: { path: ["seededBy"], equals: "[FIX-2-TEST]" } as never },
    });
    await adminClient.country.deleteMany({ where: { iso3: { in: ["TST", "TST2"] } } });
  });
});

// ============================================================
// FIX-3: Indicator Value Integrity
// ============================================================
describeIntegration("FIX-3: Indicator Value Integrity", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[FIX-3-TEST]" } },
    });
  });

  it("year (2024) is NOT extracted as an indicator value", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // Add evidence with a year but no percentage
    // "Production fell in 2024" — the year 2024 must NOT be the indicator value
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-3-TEST] Demolandia's manufacturing production fell in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId, sector: "manufacturing", fictional: true },
      } as never,
    });

    const { report } = await computeBaseline(session, { countryId, sectors: ["manufacturing"] });

    const manufacturing = report.dimensions.find((d) => d.sector === "manufacturing");
    expect(manufacturing).toBeTruthy();

    // The indicator value must NOT be "2024"
    const indicator = manufacturing!.indicators.find((i) => i.claim.includes("[FIX-3-TEST]"));
    expect(indicator).toBeTruthy();
    expect(indicator!.value).not.toBe("2024");
    expect(indicator!.value).not.toContain("2024");

    // It should be "declined (qualitative)" or "unparsed"
    expect(
      indicator!.value === "declined (qualitative)" || indicator!.value === "unparsed (no reliable value extracted)"
    ).toBe(true);
  });

  it("percentage (4.2%) is extracted safely", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-3-TEST] Demolandia's exports grew 4.2% in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId, sector: "exports_test", fictional: true },
      } as never,
    });

    const { report } = await computeBaseline(session, { countryId, sectors: ["exports_test"] });

    const exportsDim = report.dimensions.find((d) => d.sector === "exports_test");
    expect(exportsDim).toBeTruthy();

    const indicator = exportsDim!.indicators.find((i) => i.claim.includes("[FIX-3-TEST]"));
    expect(indicator).toBeTruthy();
    expect(indicator!.value).toBe("4.2%");
    expect(indicator!.valueConfidence).toBe("extracted");
  });

  it("structured metadata.indicatorValue is used with highest confidence", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-3-TEST] Demolandia's employment was stable in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: {
          countryId,
          sector: "employment_test",
          fictional: true,
          indicatorName: "employment rate",
          indicatorValue: "94.2%",
        },
      } as never,
    });

    const { report } = await computeBaseline(session, { countryId, sectors: ["employment_test"] });

    const employment = report.dimensions.find((d) => d.sector === "employment_test");
    expect(employment).toBeTruthy();

    const indicator = employment!.indicators.find((i) => i.claim.includes("[FIX-3-TEST]"));
    expect(indicator).toBeTruthy();
    // The structured value must be used (not the text-extracted one)
    expect(indicator!.value).toBe("94.2%");
    expect(indicator!.valueConfidence).toBe("structured");
    expect(indicator!.name).toBe("employment rate"); // structured indicatorName
  });

  it("unparsable claim (no %, no qualitative word) → 'unparsed' confidence", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // Claim with a number that's NOT a percentage and NOT a qualitative word
    // "5 ministries reported data" — 5 must NOT be the indicator value
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-3-TEST] Demolandia has 5 ministries reporting data.",
        type: "supporting",
        verificationStatus: "unverified",
        metadata: { countryId, sector: "governance_test", fictional: true },
      } as never,
    });

    const { report } = await computeBaseline(session, { countryId, sectors: ["governance_test"] });

    const governance = report.dimensions.find((d) => d.sector === "governance_test");
    expect(governance).toBeTruthy();

    const indicator = governance!.indicators.find((i) => i.claim.includes("[FIX-3-TEST]"));
    expect(indicator).toBeTruthy();
    // The value must NOT be "5"
    expect(indicator!.value).not.toBe("5");
    expect(indicator!.valueConfidence).toBe("unparsed");
  });
});

// ============================================================
// FIX-4: Durable Task Contract
// ============================================================
describeIntegration("FIX-4: Durable Task Contract", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
    await adminClient.evidence.deleteMany({
      where: { claim: { contains: "[FIX-4-TEST]" } },
    });
  });

  it("re-computing baseline after adding new evidence produces a FRESH report (not cached)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // 1. Compute baseline with current evidence
    const result1 = await computeBaseline(session, { countryId });
    const task1Id = result1.taskId;
    const report1 = result1.report;

    // 2. Add new evidence for a NEW sector
    await adminClient.evidence.create({
      data: {
        tenantId: tenantAId,
        claim: "[FIX-4-TEST] Demolandia's energy capacity was 2.5 GW in 2024.",
        type: "supporting",
        verificationStatus: "verified",
        metadata: { countryId, sector: "energy_test", fictional: true },
      } as never,
    });

    // 3. Re-compute baseline — should produce a NEW task (different idempotency key)
    //    because the evidence state changed
    const result2 = await computeBaseline(session, { countryId });

    // The task IDs should be DIFFERENT (new evidence → new task)
    expect(result2.taskId).not.toBe(task1Id);

    // The new report should include the energy sector
    const energyInReport2 = result2.report.dimensions.find((d) => d.sector === "energy_test");
    expect(energyInReport2).toBeTruthy();

    // The old report should NOT include the energy sector
    const energyInReport1 = report1.dimensions.find((d) => d.sector === "energy_test");
    expect(energyInReport1).toBeUndefined();
  });

  it("re-computing baseline WITHOUT evidence change returns the SAME task (idempotent)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // 1. Compute baseline
    const result1 = await computeBaseline(session, { countryId });

    // 2. Re-compute immediately (no evidence change)
    const result2 = await computeBaseline(session, { countryId });

    // Same task (idempotent — evidence state didn't change)
    expect(result2.taskId).toBe(result1.taskId);
    expect(result2.report.dimensions.length).toBe(result1.report.dimensions.length);
  });

  it("claimTaskById does not steal a task with a valid lease (held by active worker)", async () => {
    const { claimTaskById, createTask } = await import("@/lib/task-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // Create a task
    const { taskId } = await createTask(session, {
      type: "test-claim-by-id",
      goal: "Test claimTaskById lease respect",
    });

    // First worker claims it
    const claim1 = await claimTaskById(session, taskId, "worker-1", 60_000);
    expect(claim1).toBeTruthy();
    expect(claim1!.claimGeneration).toBe(1);

    // Second worker tries to claim the SAME task while worker-1's lease is valid
    const claim2 = await claimTaskById(session, taskId, "worker-2", 60_000);
    // Must return null — the task is held by worker-1 with a valid lease
    expect(claim2).toBeNull();

    // Clean up
    await adminClient.task.delete({ where: { id: taskId } }).catch(() => {});
  });

  it("claimTaskById CAN reclaim a task after lease expires", async () => {
    const { claimTaskById, createTask } = await import("@/lib/task-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { taskId } = await createTask(session, {
      type: "test-claim-reclaim",
      goal: "Test claimTaskById reclaim after lease expiry",
    });

    // First worker claims with a SHORT lease (1 second)
    const claim1 = await claimTaskById(session, taskId, "worker-1", 1_000);
    expect(claim1).toBeTruthy();

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // Second worker reclaims after lease expired
    const claim2 = await claimTaskById(session, taskId, "worker-2", 60_000);
    expect(claim2).toBeTruthy();
    expect(claim2!.claimGeneration).toBe(2); // incremented from 1

    // Clean up
    await adminClient.task.delete({ where: { id: taskId } }).catch(() => {});
  });

  it("claimTaskById returns null for a completed task", async () => {
    const { claimTaskById, createTask, startTask, completeTask } = await import("@/lib/task-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { taskId } = await createTask(session, {
      type: "test-claim-completed",
      goal: "Test claimTaskById on completed task",
    });

    // Claim + start + complete the task
    const claim = await claimTaskById(session, taskId, "worker-1", 60_000);
    await startTask(session, taskId, "worker-1", claim!.claimGeneration);
    await completeTask(session, taskId, { result: "done" } as never, "worker-1", claim!.claimGeneration);

    // Try to claim the completed task → should return null
    const claim2 = await claimTaskById(session, taskId, "worker-2", 60_000);
    expect(claim2).toBeNull();

    // Clean up
    await adminClient.task.delete({ where: { id: taskId } }).catch(() => {});
  });
});
