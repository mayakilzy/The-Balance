// ============================================================
// g01-baseline.integration.test.ts
// ------------------------------------------------------------
// Integration tests for Mission 01-01: State Baseline & Observability Modes.
//
// Runs in CI against the `pgvector/pgvector:pg16` service container.
// Skips locally when RUN_INTEGRATION_TESTS is not set.
//
// Per ADR-0014 + mission pack §3 (Acceptance Tests):
//   1. Country with no evidence for a sector → LOW + "unknown"
//   2. Partial evidence → PARTIAL
//   3. Sufficient evidence (≥2 independent + ≥1 verified) → FULL
//   4. Contradictory evidence → both sides shown, no silent selection
//   5. Duplicate/non-independent sources → not counted as independent
//   6. Cross-tenant isolation: Tenant B cannot read Tenant A's baseline
//   7. Task crash mid-computation → reclaim → no duplicate output
//   8. baseline:compute required (observer rejected)
//   9. baseline:read required for reading
// ============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  setTenantContext,
  clearTenantContext,
} from "@/lib/security/tenant-context";
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
let adminUserId: string;
let analystUserId: string;

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
// 1. COMPUTE BASELINE — FULL / PARTIAL / LOW classification
// ============================================================
describeIntegration("Baseline observability modes (FULL / PARTIAL / LOW)", () => {
  beforeEach(async () => {
    // Clean up baseline tasks from previous runs (both tenants)
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute" },
    });
  });

  it("Tenant A: agriculture = FULL (≥2 independent sources + ≥1 verified)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { taskId, report } = await computeBaseline(session, { countryId });

    expect(taskId).toBeTruthy();
    expect(report.countryId).toBe(countryId);
    expect(report.honesty.fictional).toBe(true);

    // Find the agriculture dimension
    const agriculture = report.dimensions.find((d) => d.sector === "agriculture");
    expect(agriculture).toBeTruthy();
    expect(agriculture!.observabilityMode).toBe("FULL");
    expect(agriculture!.independentSourceCount).toBeGreaterThanOrEqual(2);
    expect(agriculture!.evidenceCount).toBeGreaterThanOrEqual(2);

    // Verify the report includes the indicators (no silent selection)
    expect(agriculture!.indicators.length).toBeGreaterThanOrEqual(2);

    // Summary should list agriculture under strongSectors
    expect(report.summary.strongSectors).toContain("agriculture");
  });

  it("Tenant A: finance = PARTIAL (1 source, unverified)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    const finance = report.dimensions.find((d) => d.sector === "finance");
    expect(finance).toBeTruthy();
    expect(finance!.observabilityMode).toBe("PARTIAL");
    expect(finance!.independentSourceCount).toBe(1);
    expect(finance!.gaps.length).toBeGreaterThan(0);
    expect(finance!.gaps.some((g) => g.includes("independent source"))).toBe(true);

    expect(report.summary.weakSectors).toContain("finance");
  });

  it("sectors with no evidence are NOT in the report (LOW = absent, not listed)", async () => {
    // Per ADR-0014: sectors with 0 evidence → not in dimensions[] (only sectors with
    // tagged evidence appear). The "unknown" is the ABSENCE of the sector from the report.
    // This is documented in the sourceNote.
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    // FIX-1 (01-01-FIX): Education + health have no evidence but appear as LOW
    // (they're in CountryPackConfig.sectors). They are NOT absent — they show "unknown".
    const education = report.dimensions.find((d) => d.sector === "education");
    const health = report.dimensions.find((d) => d.sector === "health");
    expect(education).toBeTruthy();
    expect(education!.observabilityMode).toBe("LOW");
    expect(education!.indicators).toEqual([]);
    expect(health).toBeTruthy();
    expect(health!.observabilityMode).toBe("LOW");
    expect(health!.indicators).toEqual([]);

    // unknownSectors should include education + health
    expect(report.summary.unknownSectors).toContain("education");
    expect(report.summary.unknownSectors).toContain("health");

    // The sourceNote should mention LOW/unknown sectors
    expect(report.honesty.sourceNote).toContain("LOW");
  });

  it("Tenant B: finance = FULL (2 independent + verified) + counter-evidence shown", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");

    // Create a dedicated user for Tenant B (don't reuse adminUserId to avoid state leakage)
    const tenantBUser = await adminClient.user.create({
      data: {
        email: "baseline-tenantb-01-01@demolandia.test",
        name: "Baseline Tenant B User",
        passwordHash: await hashPassword("test_baseline_tenantb"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: {
        userId: tenantBUser.id,
        tenantId: tenantBId,
        roleCode: "analyst",
        status: "active",
      },
    });

    const sessionB = makeSession({
      id: tenantBUser.id,
      tenantId: tenantBId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    try {
      const { report } = await computeBaseline(sessionB, { countryId });

      const finance = report.dimensions.find((d) => d.sector === "finance");
      expect(finance).toBeTruthy();
      expect(finance!.observabilityMode).toBe("FULL");
      expect(finance!.independentSourceCount).toBeGreaterThanOrEqual(2);

      // Counter-evidence must be present and visible (no silent selection)
      expect(finance!.counterEvidenceCount).toBeGreaterThanOrEqual(1);
      const counterIndicators = finance!.indicators.filter((i) => i.supportStance === "contradicts");
      expect(counterIndicators.length).toBeGreaterThanOrEqual(1);

      // The gaps should mention the contradiction
      expect(finance!.gaps.some((g) => g.includes("counter-evidence"))).toBe(true);
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: tenantBUser.id, tenantId: tenantBId } },
      });
      await adminClient.user.delete({ where: { id: tenantBUser.id } });
    }
  });
});

// ============================================================
// 2. COUNTER-EVIDENCE — no silent selection (Blueprint §2)
// ============================================================
describeIntegration("Counter-evidence handling (no silent selection)", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
  });

  it("agriculture sector shows both supporting AND counter evidence", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    const agriculture = report.dimensions.find((d) => d.sector === "agriculture");
    expect(agriculture).toBeTruthy();

    // Should have supporting indicators
    const supporting = agriculture!.indicators.filter((i) => i.supportStance === "supports");
    expect(supporting.length).toBeGreaterThanOrEqual(1);

    // Should have counter indicators (Reuters + AP syndicated)
    const counter = agriculture!.indicators.filter((i) => i.supportStance === "contradicts");
    expect(counter.length).toBeGreaterThanOrEqual(1);

    // Both supporting + counter should be in the SAME dimension (not filtered out)
    expect(agriculture!.indicators.length).toBe(supporting.length + counter.length + agriculture!.indicators.filter((i) => i.supportStance === "neutral" || i.supportStance === "uncertain").length);
  });
});

// ============================================================
// 3. INDEPENDENCE GROUPING — syndicated sources not double-counted
// ============================================================
describeIntegration("Independence grouping (syndicated sources)", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
  });

  it("Reuters + AP (same independence_group) count as 1 independent source", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    const agriculture = report.dimensions.find((d) => d.sector === "agriculture");
    expect(agriculture).toBeTruthy();

    // The agriculture sector has 4+ evidence items from 3+ sources:
    //   - World Bank (independence_group: "world-bank")
    //   - IMF (independence_group: "imf")
    //   - Reuters (independence_group: "reuters-syndicate")
    //   - AP (independence_group: "reuters-syndicate" — SAME as Reuters)
    // Reuters + AP share a group → independentSourceCount < evidenceCount (deduplication).
    // We verify the deduplication concept rather than hardcoding exact counts,
    // because other test files may add evidence to the agriculture sector.
    expect(agriculture!.evidenceCount).toBeGreaterThanOrEqual(4);
    expect(agriculture!.independentSourceCount).toBeLessThan(agriculture!.evidenceCount);

    // Verify at least one pair shares an independence group (Reuters + AP)
    const groups = agriculture!.indicators.map((i) => i.independenceGroup);
    const uniqueGroups = new Set(groups.filter((g) => g !== null));
    expect(uniqueGroups.size).toBeLessThan(agriculture!.indicators.length);

    // Verify the indicators preserve the independence_group info
    const reutersIndicator = agriculture!.indicators.find(
      (i) => i.independenceGroup === "reuters-syndicate"
    );
    expect(reutersIndicator).toBeTruthy();
  });
});

// ============================================================
// 4. CROSS-TENANT ISOLATION — Tenant B cannot read Tenant A's baseline
// ============================================================
describeIntegration("Cross-tenant baseline isolation", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute" },
    });
  });

  it("Tenant B cannot read Tenant A's baseline task", async () => {
    const { computeBaseline, getBaselineTask } = await import("@/lib/state-builder/baseline-service");

    // Tenant A computes a baseline
    const sessionA = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { taskId } = await computeBaseline(sessionA, { countryId });

    // Tenant B creates a dedicated user + tries to read Tenant A's task
    const tenantBUser = await adminClient.user.create({
      data: {
        email: "baseline-xtenant-01-01@demolandia.test",
        name: "Baseline Cross-Tenant User",
        passwordHash: await hashPassword("test_xbaseline"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: {
        userId: tenantBUser.id,
        tenantId: tenantBId,
        roleCode: "analyst",
        status: "active",
      },
    });

    const sessionB = makeSession({
      id: tenantBUser.id,
      tenantId: tenantBId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    try {
      // Tenant B tries to read Tenant A's task → should fail (RLS blocks)
      await expect(
        getBaselineTask(sessionB, taskId)
      ).rejects.toThrow(/not found in tenant scope/i);
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: tenantBUser.id, tenantId: tenantBId } },
      });
      await adminClient.user.delete({ where: { id: tenantBUser.id } });
    }
  });

  it("Tenant A's baseline report contains ONLY Tenant A's evidence", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const sessionA = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(sessionA, { countryId });

    // Tenant A has agriculture (FULL) + finance (PARTIAL)
    // Tenant B has finance (FULL) + external (PARTIAL)
    // Tenant A's baseline should NOT include "external" (Tenant B's sector)
    const external = report.dimensions.find((d) => d.sector === "external");
    expect(external).toBeUndefined();

    // And Tenant A's finance should have only 1 evidence (Tenant A's), not Tenant B's 3
    const finance = report.dimensions.find((d) => d.sector === "finance");
    if (finance) {
      expect(finance.evidenceCount).toBe(1); // Tenant A has 1 finance evidence
    }
  });
});

// ============================================================
// 5. PERMISSIONS — baseline:compute + baseline:read
// ============================================================
describeIntegration("Baseline permissions", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
  });

  it("computeBaseline rejects observer (no baseline:compute)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");

    // Create a dedicated observer user
    const observerUser = await adminClient.user.create({
      data: {
        email: "baseline-observer-01-01@demolandia.test",
        name: "Baseline Observer User",
        passwordHash: await hashPassword("test_baseline_observer"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: {
        userId: observerUser.id,
        tenantId: tenantAId,
        roleCode: "observer",
        status: "active",
      },
    });

    const session = makeSession({
      id: observerUser.id,
      tenantId: tenantAId,
      roleCode: "observer",
      membershipStatus: "active",
    });

    try {
      await expect(
        computeBaseline(session, { countryId })
      ).rejects.toThrow(/Permission denied: baseline:compute/);
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: observerUser.id, tenantId: tenantAId } },
      });
      await adminClient.user.delete({ where: { id: observerUser.id } });
    }
  });

  it("getBaselineTask rejects unauthenticated session", async () => {
    const { getBaselineTask } = await import("@/lib/state-builder/baseline-service");

    // requirePermissionWithCurrentRole throws PermissionDeniedError for null session,
    // which has message "Permission denied: baseline:read".
    await expect(
      getBaselineTask(null as unknown as Session, "any-task-id")
    ).rejects.toThrow(/Permission denied|Unauthenticated|no session/i);
  });

  it("observer CAN read baseline (baseline:read) but cannot compute", async () => {
    const { computeBaseline, getBaselineTask } = await import("@/lib/state-builder/baseline-service");

    // First, analyst computes a baseline
    const analystSession = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });
    const { taskId } = await computeBaseline(analystSession, { countryId });

    // Observer reads it → should succeed (baseline:read)
    const observerUser = await adminClient.user.create({
      data: {
        email: "baseline-reader-01-01@demolandia.test",
        name: "Baseline Reader Observer",
        passwordHash: await hashPassword("test_baseline_reader"),
        status: "active",
      },
    });
    await adminClient.membership.create({
      data: {
        userId: observerUser.id,
        tenantId: tenantAId,
        roleCode: "observer",
        status: "active",
      },
    });

    const observerSession = makeSession({
      id: observerUser.id,
      tenantId: tenantAId,
      roleCode: "observer",
      membershipStatus: "active",
    });

    try {
      const result = await getBaselineTask(observerSession, taskId);
      expect(result.taskId).toBe(taskId);
      expect(result.status).toBe("completed");
      expect(result.report).toBeTruthy();
    } finally {
      await adminClient.membership.delete({
        where: { userId_tenantId: { userId: observerUser.id, tenantId: tenantAId } },
      });
      await adminClient.user.delete({ where: { id: observerUser.id } });
    }
  });
});

// ============================================================
// 6. IDEMPOTENCY — re-computing returns the same task (no duplicate)
// ============================================================
describeIntegration("Baseline idempotency + task reuse", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
  });

  it("re-computing baseline for the same country returns the existing task", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // First computation
    const result1 = await computeBaseline(session, { countryId });
    expect(result1.taskId).toBeTruthy();

    // Second computation — should return the SAME task (idempotent)
    const result2 = await computeBaseline(session, { countryId });
    expect(result2.taskId).toBe(result1.taskId);

    // The reports should be identical
    expect(result2.report.dimensions.length).toBe(result1.report.dimensions.length);
    expect(result2.report.summary.strongSectors).toEqual(result1.report.summary.strongSectors);
  });
});

// ============================================================
// 7. BASELINE REPORT STRUCTURE — honesty + provenance
// ============================================================
describeIntegration("Baseline report structure + honesty", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
  });

  it("report includes honesty block with fictional flag + sourceNote", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    expect(report.honesty).toBeTruthy();
    expect(report.honesty.fictional).toBe(true);
    expect(report.honesty.computedBy).toBe("baseline-engine-v1");
    expect(report.honesty.rulesVersion).toBe("adr-0014-v1");
    expect(report.honesty.sourceNote).toContain("Fictional");
  });

  it("every indicator links to its evidence (evidenceId + sourceCode + verificationStatus)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    for (const dim of report.dimensions) {
      for (const ind of dim.indicators) {
        expect(ind.evidenceId).toBeTruthy();
        expect(ind.claim).toBeTruthy();
        expect(ind.verificationStatus).toBeTruthy();
        expect(ind.supportStance).toBeTruthy();
        // sourceCode may be null (evidence without source), but the field must exist
        expect("sourceCode" in ind).toBe(true);
      }
    }
  });

  it("dimensions are sorted by sector name (deterministic output)", async () => {
    const { computeBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const { report } = await computeBaseline(session, { countryId });

    const sectors = report.dimensions.map((d) => d.sector);
    const sorted = [...sectors].sort();
    expect(sectors).toEqual(sorted);
  });
});

// ============================================================
// 8. GET LATEST BASELINE — convenience API
// ============================================================
describeIntegration("getLatestBaseline", () => {
  beforeEach(async () => {
    await adminClient.task.deleteMany({
      where: { type: "baseline-compute", tenantId: tenantAId },
    });
  });

  it("returns the most recent completed baseline for a country", async () => {
    const { computeBaseline, getLatestBaseline } = await import("@/lib/state-builder/baseline-service");
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    // No baseline yet → null
    const before = await getLatestBaseline(session, countryId);
    expect(before).toBeNull();

    // Compute a baseline
    const { taskId } = await computeBaseline(session, { countryId });

    // Now getLatestBaseline should return it
    const latest = await getLatestBaseline(session, countryId);
    expect(latest).toBeTruthy();
    expect(latest!.taskId).toBe(taskId);
    expect(latest!.report.countryId).toBe(countryId);
  });
});
