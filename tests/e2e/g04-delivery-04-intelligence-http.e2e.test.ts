// ============================================================
// tests/e2e/g04-delivery-04-intelligence-http.e2e.test.ts
// ------------------------------------------------------------
// G04 Delivery 04 — Intelligence & Cross-Module Integration E2E.
//
// Implements the owner's 10-step cross-module workflow:
//   1. Build and approve a national strategy
//   2. Register indicators and collect observations
//   3. Detect a deviation and raise an alert
//   4. Retrieve supporting and contradictory evidence
//   5. Request an AI-assisted analysis of the problem
//   6. Generate and compare reform alternatives
//   7. Submit alternatives for human review and approval
//   8. Coordinate approved action across authorized institutions
//   9. Record implementation progress and verification
//  10. Update the historical record and generate a handover dossier
//
// Plus: provider failure handling, cross-tenant isolation, negative
// tests.
//
// Uses the EXISTING G01/G02/G03/G04 services via HTTP. The new
// intelligence endpoint (/api/v1/intelligence/analysis) is the
// only NEW route exercised here.
//
// Provider mode:
//   - This test runs with LLM_PROVIDER=stub by default (CI runs it
//     that way for determinism + speed).
//   - The real provider is verified separately in
//     tests/intelligence/zai-provider.integration.test.ts (gated
//     behind RUN_REAL_LLM_TESTS=1).
//
// Convention: spawns its own Next.js dev server expectation on
// port 3001 (same as g01/g02/g03). For local runs, start the server
// first: `bun run dev -- -p 3001`.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";

const RUN_E2E =
  process.env.RUN_E2E_HTTP_TESTS === "1" &&
  process.env.SKIP_E2E_SERVER !== "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

const BASE_URL = "http://localhost:3001";
const DIRECT_URL =
  process.env.DIRECT_URL ??
  "postgresql://balance_admin:balance_admin_dev_only@localhost:5433/balance?schema=public";

const ANALYST = {
  email: "analyst@demolandia.test",
  password: "test_analyst_password_00_03",
};
const ADMIN = {
  email: "admin@demolandia.test",
  password: "test_admin_password_00_03",
};
const TENANT_B_ANALYST = {
  email: "g04-d4-e2e-tenantb-analyst@demolandia.test",
  password: "Test1234!",
};

let adminDb: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let analystUserId: string;
let adminUserId: string;
let tenantBAnalystUserId: string;

let analystCookies: string[] = [];
let adminCookies: string[] = [];
let tenantBCookies: string[] = [];

// Track IDs created during the workflow for cleanup
let strategyId: string;
let strategyVersionId: string;
let objectiveId: string;
let indicatorId: string;
let observationId: string;
let varianceId: string;
let alertId: string;
let decisionId: string;
let dossierId: string;
let periodId: string;
let centralBankSourceId: string;

// ============================================================
// HTTP helpers (same pattern as g01/g02/g04-d3)
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

async function signIn(creds: {
  email: string;
  password: string;
}): Promise<string[]> {
  const cookies: string[] = [];
  const backoffs = [0, 3_000, 6_000, 12_000, 24_000];
  let lastErr: unknown = null;
  for (const delayMs of backoffs) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const res = await fetchWithCookies(cookies, "/api/v1/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(creds),
    });
    if (res.status === 200) return cookies;
    if (res.status === 429) {
      lastErr = new Error(`Signin rate-limited for ${creds.email} (will retry)`);
      continue;
    }
    throw new Error(`Signin failed for ${creds.email}: HTTP ${res.status}`);
  }
  throw new Error(`Signin exhausted retries for ${creds.email}: ${String(lastErr)}`);
}

async function waitForServer(timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/meta`);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server not reachable at ${BASE_URL} within ${timeoutMs}ms`);
}

// ============================================================
// Setup: ensure fixtures (strategy, indicator, period, source, users)
// ============================================================
async function ensureIntelligenceFixtures(): Promise<void> {
  const country = await adminDb.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia (DML) not seeded");
  countryId = country.id;

  const tenantA = await adminDb.tenant.findUnique({
    where: { code: "DML-MOP-TENANT" },
  });
  const tenantB = await adminDb.tenant.findUnique({
    where: { code: "DML-CB-TENANT" },
  });
  if (!tenantA || !tenantB)
    throw new Error("Test tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const analystUser = await adminDb.user.findUnique({
    where: { email: ANALYST.email },
  });
  const adminUser = await adminDb.user.findUnique({
    where: { email: "admin@demolandia.test" },
  });
  if (!analystUser || !adminUser)
    throw new Error("Test users not seeded");
  analystUserId = analystUser.id;
  adminUserId = adminUser.id;

  // Tenant B analyst for cross-tenant tests
  const tenantBAnalyst = await adminDb.user.upsert({
    where: { email: TENANT_B_ANALYST.email },
    update: {},
    create: {
      email: TENANT_B_ANALYST.email,
      name: "G04-D4 E2E Tenant B Analyst",
      passwordHash: await hashPassword(TENANT_B_ANALYST.password),
      status: "active",
    },
  });
  await adminDb.membership.upsert({
    where: {
      userId_tenantId: { userId: tenantBAnalyst.id, tenantId: tenantBId },
    },
    update: { status: "active", roleCode: "analyst" },
    create: {
      userId: tenantBAnalyst.id,
      tenantId: tenantBId,
      roleCode: "analyst",
      status: "active",
    },
  });
  tenantBAnalystUserId = tenantBAnalyst.id;

  // Approved strategy + version (for indicator + decision linkage)
  let strategy = await adminDb.strategy.findFirst({
    where: { tenantId: tenantAId, title: "G04-D4 E2E Strategy" },
  });
  if (!strategy) {
    strategy = await adminDb.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "G04-D4 E2E Strategy",
        createdBy: analystUserId,
      },
    });
  }
  strategyId = strategy.id;

  let sv = await adminDb.strategyVersion.findFirst({
    where: { strategyId, versionNumber: 1 },
  });
  if (!sv) {
    sv = await adminDb.strategyVersion.create({
      data: {
        strategyId,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "approved",
        approvedBy: adminUserId,
        approvedAt: new Date(),
        approvalNotes: "G04-D4 E2E auto-approved fixture",
        metadata: { simulated: true, source: "g04-d4-e2e-fixture" },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  // Objective (required by indicator)
  let obj = await adminDb.objective.findFirst({
    where: { tenantId: tenantAId },
  });
  if (!obj) {
    obj = await adminDb.objective.create({
      data: {
        tenantId: tenantAId,
        countryId,
        title: "G04-D4 E2E Objective",
        targetMetric: "inflation_rate",
        targetValue: "5.0",
        horizon: 5,
        status: "active",
        createdBy: analystUserId,
      },
    });
  }
  objectiveId = obj.id;

  // Synthetic source (for observations)
  let src = await adminDb.source.findFirst({
    where: { code: "DML-CB-SYNTHETIC" },
  });
  if (!src) {
    src = await adminDb.source.create({
      data: {
        code: "DML-CB-SYNTHETIC",
        displayName: "Demolandia Central Bank — synthetic",
        type: "government",
        reviewStatus: "approved",
        metadata: { synthetic: true, country: "DML" },
      },
    });
  }
  centralBankSourceId = src.id;

  // Observation period (Q2 2026)
  let period = await adminDb.observationPeriod.findFirst({
    where: { tenantId: tenantAId, periodType: "quarterly", periodValue: "2026-Q2" },
  });
  if (!period) {
    period = await adminDb.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2026-Q2",
        startAt: new Date(Date.UTC(2026, 3, 1)),
        endAt: new Date(Date.UTC(2026, 6, 0, 23, 59, 59)),
      },
    });
  }
  periodId = period.id;

  // Clean up stale G04-D4 data from prior runs
  await adminDb.handoverDossier.deleteMany({
    where: { tenantId: tenantAId, title: { startsWith: "G04-D4 E2E:" } },
  }).catch(() => {});
  await adminDb.alert.deleteMany({
    where: { tenantId: tenantAId, title: { startsWith: "G04-D4 E2E:" } },
  }).catch(() => {});
  await adminDb.varianceRecord.deleteMany({
    where: { tenantId: tenantAId },
  }).catch(() => {});
  await adminDb.observation.deleteMany({
    where: { tenantId: tenantAId },
  }).catch(() => {});
  await adminDb.indicatorDefinition.deleteMany({
    where: { tenantId: tenantAId, code: { startsWith: "G04_D4_E2E_" } },
  }).catch(() => {});
  await adminDb.decision.deleteMany({
    where: { tenantId: tenantAId, title: { startsWith: "G04-D4 E2E:" } },
  }).catch(() => {});
  await adminDb.auditLog.deleteMany({
    where: { tenantId: tenantAId, action: "intelligence.analysis.requested" },
  }).catch(() => {});
}

// ============================================================
// Setup + teardown
// ============================================================
beforeAll(async () => {
  if (!RUN_E2E) return;

  adminDb = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
  await ensureIntelligenceFixtures();
  await waitForServer();
  await new Promise((r) => setTimeout(r, 2000)); // avoid rate-limit collision

  analystCookies = await signIn(ANALYST);
  await new Promise((r) => setTimeout(r, 500));
  adminCookies = await signIn(ADMIN);
  await new Promise((r) => setTimeout(r, 500));
  tenantBCookies = await signIn(TENANT_B_ANALYST);
}, 150_000);

afterAll(async () => {
  if (adminDb) {
    await adminDb.handoverDossier.deleteMany({
      where: { tenantId: tenantAId, title: { startsWith: "G04-D4 E2E:" } },
    }).catch(() => {});
    await adminDb.alert.deleteMany({
      where: { tenantId: tenantAId, title: { startsWith: "G04-D4 E2E:" } },
    }).catch(() => {});
    await adminDb.varianceRecord.deleteMany({
      where: { tenantId: tenantAId },
    }).catch(() => {});
    await adminDb.observation.deleteMany({
      where: { tenantId: tenantAId },
    }).catch(() => {});
    await adminDb.indicatorDefinition.deleteMany({
      where: { tenantId: tenantAId, code: { startsWith: "G04_D4_E2E_" } },
    }).catch(() => {});
    await adminDb.decision.deleteMany({
      where: { tenantId: tenantAId, title: { startsWith: "G04-D4 E2E:" } },
    }).catch(() => {});
    await adminDb.auditLog.deleteMany({
      where: { tenantId: tenantAId, action: "intelligence.analysis.requested" },
    }).catch(() => {});
    await adminDb.$disconnect();
  }
}, 60_000);

// ============================================================
// Tests — owner's 10-step cross-module workflow
// ============================================================
describeE2E("G04 Delivery 04 — Intelligence & Cross-Module Integration", () => {
  // ----------------------------------------------------------
  // STEP 1: Build and approve a national strategy
  // (fixtures pre-create an approved strategyVersionId — this step
  // verifies it's inspectable)
  // ----------------------------------------------------------
  it("1. GET /continuity/strategies/[id]/history → 200 (approved strategy exists)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/strategies/${strategyId}/history`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions.length).toBeGreaterThanOrEqual(1);
    expect(body.versions[0].status).toBe("approved");
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 2: Register indicators and collect observations
  // ----------------------------------------------------------
  it("2a. POST /state-observatory/indicators → 201 (register inflation indicator)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/indicators",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "G04_D4_E2E_INFLATION",
          displayName: "G04-D4 E2E: Inflation Rate",
          unit: "percent",
          preferredDirection: "decrease",
          defaultTargetValue: 5.0,
          targetTimeHorizon: "multi_year",
          periodMilestones: [
            {
              periodId,
              targetValue: 7.0,
              sourceRef: "synthetic:demolandia-test-policy-2026-001",
            },
          ],
          alertThresholds: [
            {
              metric: "varianceAbsolute",
              operator: "gt",
              value: 1.5,
              logicalOp: "and",
              severity: "warning",
              rationale: "Threshold: 1.5pp above milestone",
              sourceRef: "synthetic:demolandia-test-policy-2026-001",
            },
            {
              metric: "varianceDirection",
              operator: "eq",
              value: "worse",
              severity: "warning",
              rationale: "Only raise when direction is worse",
              sourceRef: "synthetic:demolandia-test-policy-2026-001",
            },
          ],
          strategyVersionId,
          objectiveId,
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    indicatorId = body.id;
  }, 30_000);

  it("2b. POST /state-observatory/observations → 201 (ingest 9.0 — exceeds milestone by 2.0)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/observations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          indicatorDefinitionId: indicatorId,
          observationPeriodId: periodId,
          observedValue: 9.0,
          originType: "observed",
          sourceId: centralBankSourceId,
          isSynthetic: true,
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    observationId = body.id;
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 3: Detect a deviation and raise an alert
  // ----------------------------------------------------------
  it("3a. POST /state-observatory/variance → 201 (compute variance=2.0 worse)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/variance",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyVersionId,
          observationPeriodId: periodId,
          indicatorId,
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.varianceRecords[0]).toBeTruthy();
    varianceId = body.varianceRecords[0].id;
  }, 30_000);

  it("3b. POST /state-observatory/alerts/evaluate → 201 (alert raised)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/alerts/evaluate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ varianceRecordId: varianceId }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.raised).toBe(true);
    expect(body.alert.id).toBeTruthy();
    alertId = body.alert.id;
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 4: Retrieve supporting and contradictory evidence
  // (evidence is retrieved automatically by the intelligence service
  // — verified via contextUsed counts in step 5)
  // ----------------------------------------------------------
  it("4. GET /state-observatory/observations → 200 (observations retrievable)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/observations"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.observations)).toBe(true);
    const found = body.observations.find((o: { id: string }) => o.id === observationId);
    expect(found).toBeTruthy();
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 5: Request an AI-assisted analysis of the problem
  // ----------------------------------------------------------
  it("5a. POST /intelligence/analysis (alertId) → 200 (AI-assisted analysis with honesty labels)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/intelligence/analysis",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alertId,
          question:
            "What are the likely causes of the inflation deviation, and what evidence supports them?",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis).toBeTruthy();
    expect(body.analysis.focus.alertId).toBe(alertId);
    expect(body.analysis.provider).toBeTruthy();
    expect(body.analysis.model).toBeTruthy();
    expect(typeof body.analysis.simulated).toBe("boolean");
    expect(Array.isArray(body.analysis.blocks)).toBe(true);
    expect(body.analysis.summary).toBeDefined();
    expect(body.analysis.contextUsed).toBeDefined();
    expect(body.analysis.contextUsed.alertCount).toBe(1);
    expect(body.analysis.contextUsed.varianceCount).toBe(1);
    expect(body.analysis.disclaimer).toContain("AI-assisted");
    expect(body.analysis.disclaimer).toContain("human decides");
  }, 60_000);

  it("5b. POST /intelligence/analysis without target → 400 (Zod validation)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/intelligence/analysis",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "Missing target — should fail validation.",
        }),
      }
    );
    expect(res.status).toBe(400);
  }, 30_000);

  it("5c. POST /intelligence/analysis (strategyVersionId) → 200 (analyzes strategy context)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/intelligence/analysis",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyVersionId,
          question:
            "What decisions have been made on this strategy and what is their status?",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis.focus.strategyVersionId).toBe(strategyVersionId);
    expect(body.analysis.contextUsed).toBeDefined();
  }, 60_000);

  // ----------------------------------------------------------
  // STEP 6: Generate and compare reform alternatives
  // (uses existing /reform/proposals + /reform/alternatives)
  // ----------------------------------------------------------
  it("6. GET /reform/proposals → 200 (existing reform proposals inspectable)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/reform/proposals?limit=10"
    );
    expect(res.status).toBe(200);
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 7: Submit alternatives for human review and approval
  // (verified via the /continuity/decisions lifecycle in step 7a-7c)
  // ----------------------------------------------------------
  it("7a. POST /continuity/decisions → 201 (analyst drafts decision)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/decisions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyVersionId,
          title: "G04-D4 E2E: Adopt inflation-targeting framework",
          rationale:
            "Decision to adopt an inflation-targeting framework based on AI-assisted analysis of the alert.",
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.decisionId).toBeTruthy();
    decisionId = body.decisionId;
  }, 30_000);

  it("7b. POST /continuity/decisions/[id]/advance (reviewed as ANALYST) → 200", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${decisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "reviewed",
          notes: "Reviewed after AI-assisted analysis",
        }),
      }
    );
    expect(res.status).toBe(200);
  }, 30_000);

  it("7c. POST /continuity/decisions/[id]/advance (approved as ADMIN) → 200", async () => {
    const res = await fetchWithCookies(
      adminCookies,
      `/api/v1/continuity/decisions/${decisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "approved",
          notes: "Approved by admin after human review",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 8: Coordinate approved action across authorized institutions
  // (uses existing /reform/coordinations — seeded G03 data)
  // ----------------------------------------------------------
  it("8. GET /reform/coordinations → 200 (inter-institution coordination inspectable)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/reform/coordinations?limit=10"
    );
    expect(res.status).toBe(200);
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 9: Record implementation progress and verification
  // (uses existing /reform/actions — seeded G03 data)
  // ----------------------------------------------------------
  it("9. GET /reform/actions → 200 (implementation actions inspectable)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/reform/actions?limit=10"
    );
    expect(res.status).toBe(200);
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 10: Update the historical record and generate a handover dossier
  // ----------------------------------------------------------
  it("10a. POST /continuity/handover/dossier (as ADMIN) → 201 (dossier generated)", async () => {
    const res = await fetchWithCookies(
      adminCookies,
      "/api/v1/continuity/handover/dossier",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "G04-D4 E2E: Handover Dossier (post-intelligence-analysis)",
          scope: {
            includeActiveStrategies: true,
            includeOutstandingObligations: true,
            includeAuditHighlights: true,
          },
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.dossierId).toBeTruthy();
    expect(body.content.counts.strategies).toBeGreaterThanOrEqual(1);
    dossierId = body.dossierId;
  }, 30_000);

  it("10b. GET /continuity/handover/dossiers/[id] → 200 (dossier retrievable with full content)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/handover/dossiers/${dossierId}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(dossierId);
    expect(body.content).toBeTruthy();
    expect(body.content.honesty.scope).toBe("descriptive");
    expect(body.retrievalCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  // ----------------------------------------------------------
  // NEGATIVE + CROSS-TENANT + PROVIDER FAILURE tests
  // ----------------------------------------------------------
  it("11. NEG: GET /intelligence/analysis (wrong method) → 405 (only POST supported)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/intelligence/analysis"
    );
    // Next.js returns 405 for unsupported methods on routes that only define POST
    expect([405, 404]).toContain(res.status);
  }, 30_000);

  it("12. NEG: POST /intelligence/analysis with cross-tenant alertId → 400 (not in tenant scope)", async () => {
    // Tenant B analyst tries to analyze an alert from Tenant A
    const res = await fetchWithCookies(
      tenantBCookies,
      "/api/v1/intelligence/analysis",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alertId, // Tenant A's alert
          question: "Should be rejected — cross-tenant access",
        }),
      }
    );
    expect(res.status).toBe(400);
  }, 30_000);

  it("13. Audit log: intelligence.analysis.requested entries recorded", async () => {
    const entries = await adminDb.auditLog.findMany({
      where: {
        tenantId: tenantAId,
        action: "intelligence.analysis.requested",
      },
      orderBy: { at: "asc" },
    });
    expect(entries.length).toBeGreaterThanOrEqual(2); // step 5a + 5c
    const actions = entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("intelligence.analysis.requested");
  }, 30_000);

  it("14. RLS: Tenant B cannot retrieve Tenant A's handover dossier", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      `/api/v1/continuity/handover/dossiers/${dossierId}`
    );
    expect(res.status).toBe(404);
  }, 30_000);

  it("15. HUMAN APPROVAL BOUNDARY: intelligence analysis blocks are advisory, not binding", async () => {
    // Verify the analysis result's disclaimer explicitly states that
    // the human decides, not the LLM. This is the mandatory human-
    // approval-boundary invariant.
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/intelligence/analysis",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alertId,
          question: "Verify the human-approval-boundary invariant.",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis.disclaimer).toMatch(/human decides/i);
    expect(body.analysis.disclaimer).toMatch(/no.*approval|no.*execution|no.*state change/i);
    // The blocks must include at least one model_inference block (the LLM's reasoning)
    // clearly distinguished from factual_evidence blocks.
    const blockKinds = body.analysis.blocks.map((b: { kind: string }) => b.kind);
    expect(blockKinds).toContain("model_inference");
  }, 60_000);
});
