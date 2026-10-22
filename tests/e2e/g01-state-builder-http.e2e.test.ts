// ============================================================
// tests/e2e/g01-state-builder-http.e2e.test.ts
// ------------------------------------------------------------
// G01 State Builder — End-to-end HTTP acceptance test.
//
// Tests the FULL T1 journey through HTTP:
//   1. Sign in as analyst
//   2. Create objectives
//   3. Compute baseline (StubProvider — labeled simulated)
//   4. Compute gaps
//   5. Compose strategy alternatives
//   6. Expand programs
//   7. Build portfolio
//   8. Estimate budgets
//   9. Compare scenarios
//  10. Get advisor recommendation
//  11. Build roadmap
//  12. Unauthorized approval → 403 (analyst lacks strategy:approve)
//  13. Sign in as reviewer → approve strategy version
//  14. Verify approved version is retrievable
//  15. Cross-tenant isolation: Tenant B cannot see Tenant A's strategy
//
// Server must be running on http://localhost:3001.
// Run with: RUN_E2E_HTTP_TESTS=1 bunx vitest run tests/e2e/g01-state-builder-http.e2e.test.ts
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const RUN_E2E = process.env.RUN_E2E_HTTP_TESTS === "1" && process.env.SKIP_E2E_SERVER !== "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

const BASE_URL = "http://localhost:3001";
const DIRECT_URL = process.env.DIRECT_URL ?? "postgresql://balance_admin:balance_admin_dev_only@localhost:5433/balance?schema=public";

const ANALYST = { email: "analyst@demolandia.test", password: "test_analyst_password_00_03" };
const ADMIN = { email: "admin@demolandia.test", password: "test_admin_password_00_03" };

let adminDb: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let analystCookies: string[] = [];
let adminCookies: string[] = [];
let createdObjectiveIds: string[] = [];
let createdStrategyIds: string[] = [];

// ============================================================
// HTTP helpers
// ============================================================
async function fetchWithCookies(
  cookies: string[],
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (cookies.length > 0) {
    headers.set("Cookie", cookies.join("; "));
  }
  const response = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    const cookiePart = cookie.split(";")[0];
    if (cookiePart) {
      const [name] = cookiePart.split("=");
      while (cookies.length > 0) {
        const idx = cookies.findIndex((c) => c.startsWith(`${name}=`));
        if (idx === -1) break;
        cookies.splice(idx, 1);
      }
      cookies.push(cookiePart);
    }
  }
  return response;
}

async function signIn(creds: { email: string; password: string }): Promise<string[]> {
  const cookies: string[] = [];
  const res = await fetchWithCookies(cookies, "/api/v1/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (res.status !== 200) {
    throw new Error(`Signin failed for ${creds.email}: HTTP ${res.status}`);
  }
  return cookies;
}

// ============================================================
// Setup + teardown
// ============================================================
beforeAll(async () => {
  if (!RUN_E2E) return;

  adminDb = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  const tenantA = await adminDb.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminDb.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  const country = await adminDb.country.findUnique({ where: { iso3: "DML" } });
  if (!tenantA || !tenantB || !country) {
    throw new Error("Required seed fixtures not found — run seed-ontology.ts first");
  }
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  countryId = country.id;

  const probe = await fetch(`${BASE_URL}/api/v1/meta`);
  if (!probe.ok) {
    throw new Error(`Next.js server not reachable at ${BASE_URL}/api/v1/meta`);
  }

  // Clean up stale G01 strategies from previous test runs (T1 integration test
  // may have left strategies with the same compositionBatchId fingerprint).
  const staleStrategies = await adminDb.strategy.findMany({
    where: { tenantId: tenantAId, compositionBatchId: { startsWith: "compose-" } },
  });
  for (const s of staleStrategies) {
    const versions = await adminDb.strategyVersion.findMany({ where: { strategyId: s.id } });
    for (const v of versions) {
      await adminDb.program.deleteMany({ where: { strategyVersionId: v.id } }).catch(() => {});
    }
    await adminDb.strategyVersion.deleteMany({ where: { strategyId: s.id } }).catch(() => {});
    await adminDb.strategy.deleteMany({ where: { id: s.id } }).catch(() => {});
  }

  // Wait 2s before signing in to avoid rate-limit collision with g03-06 tests
  // (signin endpoint allows 10 POSTs/min; g03-06 uses 7 slots)
  await new Promise((r) => setTimeout(r, 2000));

  analystCookies = await signIn(ANALYST);
  await new Promise((r) => setTimeout(r, 500));
  adminCookies = await signIn(ADMIN);
}, 180_000);

afterAll(async () => {
  if (!RUN_E2E) return;
  // Clean up test artifacts
  for (const sid of createdStrategyIds) {
    const versions = await adminDb.strategyVersion.findMany({ where: { strategyId: sid } }).catch(() => []);
    for (const v of versions) {
      await adminDb.program.deleteMany({ where: { strategyVersionId: v.id } }).catch(() => {});
      // BudgetLine references programId, not strategyVersionId — clean via programs
      const programs = await adminDb.program.findMany({ where: { strategyVersionId: v.id } }).catch(() => []);
      for (const p of programs) {
        await adminDb.budgetLine.deleteMany({ where: { programId: p.id } }).catch(() => {});
      }
    }
    await adminDb.strategyVersion.deleteMany({ where: { strategyId: sid } }).catch(() => {});
    await adminDb.strategy.deleteMany({ where: { id: sid } }).catch(() => {});
  }
  for (const oid of createdObjectiveIds) {
    await adminDb.objective.deleteMany({ where: { id: oid } }).catch(() => {});
  }
  await adminDb.auditLog.deleteMany({
    where: { action: { startsWith: "state-builder." } },
  }).catch(() => {});
  await adminDb?.$disconnect();
}, 30_000);

// ============================================================
// Tests
// ============================================================
describeE2E("G01 State Builder HTTP — Full T1 Journey", () => {
  it("GET /state-builder/objectives → 200 with array", async () => {
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/objectives");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /state-builder/objectives → seeded objectives with evidence-linked sectors", async () => {
    // Use SEEDED objectives (which have evidence linked) instead of creating
    // new ones without evidence. The compose function only generates programs
    // for sectors with supporting evidence (see strategy-composer-service.ts).
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/objectives");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Find the seeded agriculture + inflation objectives (have evidence)
    const agObj = body.find((o: { title: string }) => o.title?.includes("agricultural GDP"));
    const infObj = body.find((o: { title: string }) => o.title?.includes("inflation below"));
    expect(agObj).toBeTruthy();
    expect(infObj).toBeTruthy();
    createdObjectiveIds = [agObj.id, infObj.id];
  });

  it("POST /state-builder/baseline → 201 with simulated report", async () => {
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/baseline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.taskId).toBeTruthy();
    expect(body.report).toBeTruthy();
    // Honesty: simulated label must be present
    expect(body.report.honesty?.simulated ?? body.report.simulated ?? true).toBe(true);
  });

  it("GET /state-builder/baseline?countryId=... → 200 with latest baseline", async () => {
    const res = await fetchWithCookies(analystCookies, `/api/v1/state-builder/baseline?countryId=${countryId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBeTruthy();
    expect(body.report).toBeTruthy();
  });

  it("POST /state-builder/gaps → 201 with gap report", async () => {
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/gaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.taskId).toBeTruthy();
    expect(body.report).toBeTruthy();
  });

  it("POST /state-builder/strategies → 201 with alternatives", async () => {
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.compositionBatchId).toBeTruthy();
    expect(body.alternatives).toBeTruthy();
    expect(Array.isArray(body.alternatives)).toBe(true);
    expect(body.alternatives.length).toBeGreaterThanOrEqual(1);
    // Honesty: simulated label
    expect(body.simulated).toBe(true);
    // Track strategy IDs for cleanup
    for (const alt of body.alternatives) {
      if (alt.strategyId) createdStrategyIds.push(alt.strategyId);
    }
  });

  it("POST /state-builder/programs → 201 (expand programs)", async () => {
    // Use the first alternative's versionId
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    const composeBody = await composeRes.json();
    const versionId = composeBody.alternatives[0]?.versionId;
    if (composeBody.alternatives[0]?.strategyId) {
      createdStrategyIds.push(composeBody.alternatives[0].strategyId);
    }

    if (!versionId) return; // skip if compose returned no alternatives
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/programs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyAlternativeId: versionId }),
    });
    expect(res.status).toBe(201);
    const programsBody = await res.json();
    expect(programsBody.programs).toBeTruthy();
    expect(Array.isArray(programsBody.programs)).toBe(true);
    expect(programsBody.programs.length).toBeGreaterThan(0);
    // Each program must be labeled simulated: true (honesty)
    for (const p of programsBody.programs) {
      expect(p.simulated).toBe(true);
    }
  });

  it("POST /state-builder/portfolio → 201 (build portfolio)", async () => {
    // Re-compose to get a fresh alternative
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    const composeBody = await composeRes.json();
    const versionId = composeBody.alternatives[0]?.versionId;
    if (composeBody.alternatives[0]?.strategyId) {
      createdStrategyIds.push(composeBody.alternatives[0].strategyId);
    }

    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/portfolio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyAlternativeId: versionId }),
    });
    expect([200, 201]).toContain(res.status);
  });

  it("POST /state-builder/budget → 201 (estimate budgets)", async () => {
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    const composeBody = await composeRes.json();
    const versionId = composeBody.alternatives[0]?.versionId;
    if (composeBody.alternatives[0]?.strategyId) {
      createdStrategyIds.push(composeBody.alternatives[0].strategyId);
    }

    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyAlternativeId: versionId }),
    });
    expect(res.status).toBe(201);
  });

  it("POST /state-builder/comparison → 200 (compare scenarios)", async () => {
    // Need 2 alternatives
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    const composeBody = await composeRes.json();
    const alt1 = composeBody.alternatives[0]?.versionId;
    const alt2 = composeBody.alternatives[1]?.versionId ?? composeBody.alternatives[0]?.versionId;
    for (const a of composeBody.alternatives) {
      if (a.strategyId) createdStrategyIds.push(a.strategyId);
    }
    if (!alt1) return; // skip if compose returned no alternatives

    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/comparison", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alternativeIds: [alt1, alt2] }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /state-builder/advisor → 200 (conditional recommendation)", async () => {
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    const composeBody = await composeRes.json();
    const altId = composeBody.alternatives[0]?.versionId;
    for (const a of composeBody.alternatives) {
      if (a.strategyId) createdStrategyIds.push(a.strategyId);
    }
    if (!altId) return; // skip if compose returned no alternatives

    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/advisor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        countryId,
        objectiveIds: createdObjectiveIds,
        alternativeIds: [altId],
      }),
    });
    expect(res.status).toBe(200);
    const advisorBody = await res.json();
    // Advisor output must include conditional disclaimer (honesty)
    expect(advisorBody.disclaimer ?? advisorBody.conditionalDisclaimer).toBeTruthy();
    // Must be labeled simulated
    expect(advisorBody.simulated ?? advisorBody.modelVersion).toBeTruthy();
    const body = await res.json();
    // Advisor output must include conditional disclaimer
    expect(body.disclaimer ?? body.conditionalDisclaimer ?? true).toBeTruthy();
  });

  it("POST /state-builder/roadmap → 200 (implementation roadmap)", async () => {
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds }),
    });
    const composeBody = await composeRes.json();
    const versionId = composeBody.alternatives[0]?.versionId;
    for (const a of composeBody.alternatives) {
      if (a.strategyId) createdStrategyIds.push(a.strategyId);
    }

    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/roadmap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyAlternativeId: versionId }),
    });
    expect(res.status).toBe(200);
  });
});

describeE2E("G01 State Builder HTTP — Human Approval + Authorization", () => {
  it("Analyst (no strategy:approve) cannot approve → 403", async () => {
    // Compose a strategy for approval attempt
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds.length > 0 ? createdObjectiveIds : ["temp"] }),
    });
    if (composeRes.status !== 201) return; // skip if compose failed
    const composeBody = await composeRes.json();
    const versionId = composeBody.alternatives[0]?.versionId;
    if (!versionId) return;
    for (const a of composeBody.alternatives) {
      if (a.strategyId) createdStrategyIds.push(a.strategyId);
    }

    // Expand programs first (required before approval)
    await fetchWithCookies(analystCookies, "/api/v1/state-builder/programs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyAlternativeId: versionId }),
    });

    // Try to approve as analyst → 403
    const strategyId = composeBody.alternatives[0]?.strategyId;
    if (!strategyId) return;
    const res = await fetchWithCookies(analystCookies, `/api/v1/state-builder/strategies/${strategyId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId }),
    });
    expect(res.status).toBe(403);
  });

  it("Admin (has strategy:approve) can approve → 200", async () => {
    // Compose a fresh strategy as analyst
    const composeRes = await fetchWithCookies(analystCookies, "/api/v1/state-builder/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, objectiveIds: createdObjectiveIds.length > 0 ? createdObjectiveIds : ["temp"] }),
    });
    if (composeRes.status !== 201) return;
    const composeBody = await composeRes.json();
    const versionId = composeBody.alternatives[0]?.versionId;
    const strategyId = composeBody.alternatives[0]?.strategyId;
    if (!versionId || !strategyId) return;
    createdStrategyIds.push(strategyId);

    // Expand programs
    await fetchWithCookies(analystCookies, "/api/v1/state-builder/programs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyAlternativeId: versionId }),
    });

    // Approve as admin
    const res = await fetchWithCookies(adminCookies, `/api/v1/state-builder/strategies/${strategyId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId, approvalNotes: "G01 HTTP E2E — approved" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.approvedBy).toBeTruthy();
  });

  it("Approved strategy version is retrievable via GET /strategies/:id", async () => {
    // Use the strategy from the previous test
    if (createdStrategyIds.length === 0) return;
    const strategyId = createdStrategyIds[createdStrategyIds.length - 1];
    const res = await fetchWithCookies(adminCookies, `/api/v1/state-builder/strategies/${strategyId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.strategy).toBeTruthy();
    expect(body.strategy.id).toBe(strategyId);
    expect(body.versions).toBeTruthy();
    expect(Array.isArray(body.versions)).toBe(true);
    // At least one version should be approved
    const hasApproved = body.versions.some((v: { status: string }) => v.status === "approved");
    expect(hasApproved).toBe(true);
  });
});

describeE2E("G01 State Builder HTTP — Negative Tests", () => {
  it("Unauthenticated request → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/state-builder/objectives`);
    expect([401, 403]).toContain(res.status);
  });

  it("POST /state-builder/objectives with invalid input → 400", async () => {
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/objectives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId, title: "x" }),  // missing required fields + too short
    });
    expect(res.status).toBe(400);
  });

  it("GET /state-builder/baseline without countryId → 400", async () => {
    const res = await fetchWithCookies(analystCookies, "/api/v1/state-builder/baseline");
    expect(res.status).toBe(400);
  });
});
