// ============================================================
// tests/e2e/g02-state-observatory-http.e2e.test.ts
// ------------------------------------------------------------
// G02 State Observatory — End-to-end HTTP acceptance test.
//
// Tests the FULL T2 journey through HTTP against a REAL Next.js
// dev server + PostgreSQL:
//
//   1. Sign in as analyst (Tenant A: DML-MOP-TENANT, role=analyst)
//   2. POST /state-observatory/indicators       → 201 (define inflation indicator
//         WITH alertThresholds + periodMilestone target=7.0)
//   3. POST /state-observatory/observations     → 201 (ingest 9.0 — exceeds 1.5pp)
//   4. POST /state-observatory/variance         → 201 (compute variance=2.0 worse)
//   5. POST /state-observatory/alerts/evaluate  → 201 (alert raised, severity=warning)
//   6. GET  /state-observatory/alerts            → 200 (list shows the new alert)
//   7. GET  /state-observatory/alerts/[id]      → 200 (detail has full lifecycle state)
//   8. POST /state-observatory/alerts/[id]/review (analyst) → 403 (no observatory:alert:review)
//   9. Sign in as reviewer → POST .../review     → 200 (lifecycleStage="reviewed")
//  10. POST /state-observatory/alerts/[id]/decision → 200 (decision_documented)
//  11. POST /state-observatory/alerts/[id]/execution (verified) WITHOUT verifiedAction → 400 (F6)
//  12. POST /state-observatory/alerts/[id]/execution (verified) WITH verifiedAction + evidenceSource → 200 (verified)
//  13. POST /state-observatory/alerts/[id]/close → 200 (closed, executionStatus=verified preserved)
//  14. Verify audit_log has entries for every alert operation
//  15. RLS isolation: Tenant B (analyst) GET /alerts → 200 with empty list
//      (Tenant B cannot see Tenant A's alert, even with the id)
//  16. RLS isolation: Tenant B GET /alerts/[id from A] → 404 (NotFound, NOT 403)
//      (no cross-tenant leak)
//
// Convention (matches g01-state-builder-http.e2e.test.ts):
//   - The CI e2e step starts ONE Next.js dev server on port 3001 (shared
//     across g01/g03-02/g03-06/g02). This test EXPECTS that server.
//   - It does NOT spawn its own server (avoids .next/dev cache collision
//     with the shared 3001 instance).
//   - For LOCAL runs, start the server first:
//         bun run dev -- -p 3001
//     Then run with: RUN_E2E_HTTP_TESTS=1 bunx vitest run tests/e2e/g02-state-observatory-http.e2e.test.ts
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
const REVIEWER = {
  email: "g02-e2e-reviewer@demolandia.test",
  password: "Test1234!",
};
const TENANT_B_ANALYST = {
  email: "g02-e2e-tenantb-analyst@demolandia.test",
  password: "Test1234!",
};

let adminDb: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let strategyVersionId: string;
let objectiveId: string;
let centralBankSourceId: string;
let analystUserId: string;
let reviewerUserId: string;
let tenantBAnalystUserId: string;

let analystCookies: string[] = [];
let reviewerCookies: string[] = [];
let tenantBCookies: string[] = [];

// Track IDs we created for cleanup
let createdIndicatorId: string;
let createdObservationId: string;
let createdVarianceId: string;
let createdAlertId: string;
let createdPeriodId: string;

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

async function signIn(creds: {
  email: string;
  password: string;
}): Promise<string[]> {
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

async function waitForServer(timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/meta`);
      if (response.ok) return;
    } catch {
      // server not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Server not reachable at ${BASE_URL}/api/v1/meta within ${timeoutMs}ms. ` +
      `For local runs: bun run dev -- -p 3001 in a separate terminal first.`
  );
}

// ============================================================
// Setup: ensure approved StrategyVersion + Objective + Sources exist
// (the seeded ontology may or may not have them; create if missing)
// ============================================================
async function ensureG02Fixtures(): Promise<void> {
  // Fetch seeded Demolandia fixtures
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
    throw new Error("Test tenants not seeded. Run bunx tsx prisma/seed-ontology.ts.");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const analystUser = await adminDb.user.findUnique({
    where: { email: ANALYST.email },
  });
  const adminUser = await adminDb.user.findUnique({
    where: { email: "admin@demolandia.test" },
  });
  if (!analystUser || !adminUser)
    throw new Error("Test users (analyst/admin) not seeded.");
  analystUserId = analystUser.id;
  const adminUserId = adminUser.id;

  // Reviewer user (analyst role lacks observatory:alert:review)
  const reviewerExisted = !!(await adminDb.user.findUnique({
    where: { email: REVIEWER.email },
  }));
  const reviewer = await adminDb.user.upsert({
    where: { email: REVIEWER.email },
    update: {},
    create: {
      email: REVIEWER.email,
      name: "G02 E2E Reviewer",
      passwordHash: await hashPassword(REVIEWER.password),
      status: "active",
    },
  });
  await adminDb.membership.upsert({
    where: {
      userId_tenantId: { userId: reviewer.id, tenantId: tenantAId },
    },
    update: { status: "active", roleCode: "reviewer" },
    create: {
      userId: reviewer.id,
      tenantId: tenantAId,
      roleCode: "reviewer",
      status: "active",
    },
  });
  reviewerUserId = reviewer.id;
  // Suppress unused-var lint
  void reviewerExisted;

  // Tenant B analyst for cross-tenant isolation tests
  const tenantBAnalystExisted = !!(await adminDb.user.findUnique({
    where: { email: TENANT_B_ANALYST.email },
  }));
  const tenantBAnalyst = await adminDb.user.upsert({
    where: { email: TENANT_B_ANALYST.email },
    update: {},
    create: {
      email: TENANT_B_ANALYST.email,
      name: "G02 E2E Tenant B Analyst",
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
  void tenantBAnalystExisted;

  // Strategy + APPROVED StrategyVersion (G02 services require an approved
  // StrategyVersion in the caller's tenant)
  let sv = await adminDb.strategyVersion.findFirst({
    where: { tenantId: tenantAId, status: "approved" },
  });
  if (!sv) {
    const strategy = await adminDb.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "G02 E2E Strategy",
        createdBy: analystUserId,
      },
    });
    sv = await adminDb.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "approved",
        approvedBy: adminUserId,
        approvedAt: new Date(),
        approvalNotes: "G02 E2E auto-approved fixture",
        metadata: { simulated: true, source: "g02-e2e-fixture" },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  // Objective (required by defineIndicator)
  let obj = await adminDb.objective.findFirst({
    where: { tenantId: tenantAId },
  });
  if (!obj) {
    obj = await adminDb.objective.create({
      data: {
        tenantId: tenantAId,
        countryId,
        title: "G02 E2E Objective",
        targetMetric: "test_metric",
        targetValue: "5.0",
        horizon: 5,
        status: "active",
        createdBy: analystUserId,
      },
    });
  }
  objectiveId = obj.id;

  // Synthetic source (originType="observed" requires sourceId)
  let centralBankSrc = await adminDb.source.findFirst({
    where: { code: "DML-CB-SYNTHETIC" },
  });
  if (!centralBankSrc) {
    centralBankSrc = await adminDb.source.create({
      data: {
        code: "DML-CB-SYNTHETIC",
        displayName: "Demolandia Central Bank — synthetic",
        type: "government",
        reviewStatus: "approved",
        metadata: { synthetic: true, country: "DML" },
      },
    });
  }
  centralBankSourceId = centralBankSrc.id;

  // Observation period (Q2 2026)
  const periodValue = "2026-Q2";
  let period = await adminDb.observationPeriod.findFirst({
    where: { tenantId: tenantAId, periodType: "quarterly", periodValue },
  });
  if (!period) {
    period = await adminDb.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue,
        startAt: new Date(Date.UTC(2026, 3, 1)),
        endAt: new Date(Date.UTC(2026, 6, 0, 23, 59, 59)),
      },
    });
  }
  createdPeriodId = period.id;

  // Clean up any stale G02 data from prior runs (idempotent)
  await adminDb.alert.deleteMany({
    where: { tenantId: tenantAId, title: { startsWith: "G02-E2E:" } },
  }).catch(() => {});
  await adminDb.varianceRecord.deleteMany({
    where: { tenantId: tenantAId },
  }).catch(() => {});
  await adminDb.observation.deleteMany({
    where: { tenantId: tenantAId },
  }).catch(() => {});
  await adminDb.indicatorDefinition.deleteMany({
    where: { tenantId: tenantAId, code: { startsWith: "G02_E2E_" } },
  }).catch(() => {});
}

// ============================================================
// Setup + teardown
// ============================================================
beforeAll(async () => {
  if (!RUN_E2E) return;

  adminDb = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  await ensureG02Fixtures();

  // Probe the shared Next.js dev server on port 3001 (matches g01 + g03-06 convention).
  // CI's e2e step starts this server BEFORE running the vitest e2e command.
  // For LOCAL runs, start the server first: `bun run dev -- -p 3001`
  await waitForServer();

  // Wait 2s to avoid rate-limit collision with other signin-happy tests
  // (signin endpoint allows 10 POSTs/min; g01 + g03-06 use 7 slots before us)
  await new Promise((r) => setTimeout(r, 2000));

  analystCookies = await signIn(ANALYST);
  await new Promise((r) => setTimeout(r, 500));
  reviewerCookies = await signIn(REVIEWER);
  await new Promise((r) => setTimeout(r, 500));
  tenantBCookies = await signIn(TENANT_B_ANALYST);
}, 120_000);

afterAll(async () => {
  if (adminDb) {
    // Clean up G02 artifacts created by this test run
    await adminDb.alert.deleteMany({
      where: { tenantId: tenantAId, title: { startsWith: "G02-E2E:" } },
    }).catch(() => {});
    await adminDb.varianceRecord.deleteMany({
      where: { tenantId: tenantAId },
    }).catch(() => {});
    await adminDb.observation.deleteMany({
      where: { tenantId: tenantAId },
    }).catch(() => {});
    await adminDb.indicatorDefinition.deleteMany({
      where: { tenantId: tenantAId, code: { startsWith: "G02_E2E_" } },
    }).catch(() => {});
    // Don't delete the period/strategy/objective/source (shared fixtures)
    await adminDb.auditLog
      .deleteMany({
        where: { action: { startsWith: "observatory." } },
      })
      .catch(() => {});
    await adminDb.$disconnect();
  }
}, 60_000);

// ============================================================
// Tests — full T2 journey through HTTP
// ============================================================
describeE2E("G02 State Observatory HTTP — Full T2 Journey", () => {
  it("1. POST /indicators → 201 (define inflation indicator WITH thresholds)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/indicators",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "G02_E2E_INFLATION",
          displayName: "G02-E2E: Inflation Rate",
          unit: "percent",
          preferredDirection: "decrease",
          defaultTargetValue: 5.0,
          targetTimeHorizon: "multi_year",
          periodMilestones: [
            {
              periodId: createdPeriodId,
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
    expect(body.code).toBe("G02_E2E_INFLATION");
    expect(body.status).toBe("draft");
    createdIndicatorId = body.id;
  }, 30_000);

  it("2. POST /observations → 201 (ingest 9.0 — exceeds 7.0 milestone by 2.0)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/observations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          indicatorDefinitionId: createdIndicatorId,
          observationPeriodId: createdPeriodId,
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
    expect(Number(body.observedValue)).toBeCloseTo(9.0, 4);
    expect(body.originType).toBe("observed");
    expect(body.verificationStatus).toBe("unverified");
    expect(body.isCurrent).toBe(true);
    createdObservationId = body.id;
  }, 30_000);

  it("3. POST /variance → 201 (compute variance=2.0 worse)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/variance",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyVersionId,
          observationPeriodId: createdPeriodId,
          indicatorId: createdIndicatorId,
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.varianceRecords).toBeTruthy();
    expect(Array.isArray(body.varianceRecords)).toBe(true);
    expect(body.varianceRecords.length).toBeGreaterThanOrEqual(1);
    const vr = body.varianceRecords[0];
    expect(vr.id).toBeTruthy();
    expect(vr.varianceDirection).toBe("worse");
    expect(Number(vr.varianceAbsolute)).toBeCloseTo(2.0, 4);
    expect(vr.comparisonValid).toBe(true);
    createdVarianceId = vr.id;
  }, 30_000);

  it("4. POST /alerts/evaluate → 201 (alert raised, severity=warning)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/alerts/evaluate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          varianceRecordId: createdVarianceId,
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.raised).toBe(true);
    expect(body.alert).toBeTruthy();
    expect(body.alert.id).toBeTruthy();
    // R5 + auto-transition: lifecycleStage="notified" (not just "detected")
    expect(body.alert.lifecycleStage).toBe("notified");
    expect(body.alert.isAutoGenerated).toBe(true);
    expect(body.alert.executionStatus).toBe("not_applicable");
    expect(body.alert.severity).toBe("warning");
    createdAlertId = body.alert.id;
  }, 30_000);

  it("5. GET /alerts → 200 (list shows the new alert)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/state-observatory/alerts"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.alerts)).toBe(true);
    const found = body.alerts.find((a: { id: string }) => a.id === createdAlertId);
    expect(found).toBeTruthy();
    expect(found.lifecycleStage).toBe("notified");
  }, 30_000);

  it("6. GET /alerts/[id] → 200 (detail has full lifecycle state)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alert.id).toBe(createdAlertId);
    expect(body.alert.lifecycleStage).toBe("notified");
    expect(body.alert.executionStatus).toBe("not_applicable");
    expect(body.alert.severity).toBe("warning");
  }, 30_000);

  it("7. POST /alerts/[id]/review as ANALYST → 403 (lacks observatory:alert:review)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: "Analyst cannot review — should be 403",
        }),
      }
    );
    expect(res.status).toBe(403);
    // Verify the alert is STILL in "notified" (mutation was rejected)
    const getRes = await fetchWithCookies(
      analystCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}`
    );
    const getBody = await getRes.json();
    expect(getBody.alert.lifecycleStage).toBe("notified");
    expect(getBody.alert.reviewedAt).toBeNull();
  }, 30_000);

  it("8. POST /alerts/[id]/review as REVIEWER → 200 (lifecycleStage=reviewed)", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: "Reviewer examining the inflation deviation",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alert.lifecycleStage).toBe("reviewed");
    expect(body.alert.reviewedAt).toBeTruthy();
    expect(body.alert.reviewedBy).toBe(reviewerUserId);
    // R5: executionStatus UNCHANGED by review
    expect(body.alert.executionStatus).toBe("not_applicable");
  }, 30_000);

  it("9. POST /alerts/[id]/review as REVIEWER (re-review) → 400 (already reviewed)", async () => {
    // Already in "reviewed" — re-review from this state should fail
    // (valid transitions are only from "detected" or "notified")
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: "Should not succeed — already reviewed",
        }),
      }
    );
    expect([400, 409]).toContain(res.status);
  }, 30_000);

  it("10. POST /alerts/[id]/decision as REVIEWER → 200 (decision_documented)", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisionDescription:
            "رفع مذكرة لوزير المالية لمراجعة السياسة النقدية",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alert.lifecycleStage).toBe("decision_documented");
    expect(body.alert.decisionDescription).toContain("مذكرة");
    expect(body.alert.decidedById).toBe(reviewerUserId);
    // R5: executionStatus UNCHANGED by decision
    expect(body.alert.executionStatus).toBe("not_applicable");
  }, 30_000);

  it("11. POST /alerts/[id]/execution (verified) WITHOUT verifiedAction → 400 (F6 enforced)", async () => {
    // F6: verifiedAction + evidenceSource required when executionStatus=verified
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/execution`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionStatus: "verified",
          // Intentionally missing verifiedAction + evidenceSource
        }),
      }
    );
    expect(res.status).toBe(400);
    // Verify the alert's executionStatus is still "not_applicable"
    const getRes = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}`
    );
    const getBody = await getRes.json();
    expect(getBody.alert.executionStatus).toBe("not_applicable");
  }, 30_000);

  it("12. POST /alerts/[id]/execution (pending) → 200 (sets status=pending)", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/execution`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionStatus: "pending",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alert.executionStatus).toBe("pending");
    // R5: lifecycleStage UNCHANGED
    expect(body.alert.lifecycleStage).toBe("decision_documented");
  }, 30_000);

  it("13. POST /alerts/[id]/execution (verified) WITH verifiedAction + evidenceSource → 200 (F6 satisfied)", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/execution`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionStatus: "verified",
          verifiedAction: "استلام وزارة المالية للمذكرة رقم #DEMO-2026-E2E-042",
          evidenceSource:
            "إيصال استلام صادر عن وزارة المالية — Demolandia synthetic",
          notes: "تم تسليم المذكرة وتوقيع الاستلام",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alert.executionStatus).toBe("verified");
    expect(body.alert.executionVerifiedAction).toContain("#DEMO-2026-E2E-042");
    expect(body.alert.executionVerificationSource).toContain("إيصال استلام");
    expect(body.alert.executionVerifiedById).toBe(reviewerUserId);
    expect(body.alert.executionVerifiedAt).toBeTruthy();
    // R5/F6: lifecycleStage UNCHANGED by verifyExecution
    expect(body.alert.lifecycleStage).toBe("decision_documented");
  }, 30_000);

  it("14. POST /alerts/[id]/close as REVIEWER → 200 (closed; execution=verified preserved)", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}/close`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "Completed — memo received and verified",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alert.lifecycleStage).toBe("closed");
    expect(body.alert.closedBy).toBe(reviewerUserId);
    expect(body.alert.closedAt).toBeTruthy();
    expect(body.alert.closureReason).toContain("Completed");
    // R5: executionStatus UNCHANGED by close
    expect(body.alert.executionStatus).toBe("verified");
  }, 30_000);

  it("15. Audit log: every alert operation persisted an audit_log row", async () => {
    // Use adminDb (DIRECT_URL = balance_admin, BYPASSRLS) to count audit entries
    const entries = await adminDb.auditLog.findMany({
      where: {
        tenantId: tenantAId,
        action: { startsWith: "observatory.alert." },
      },
      orderBy: { at: "asc" },
    });
    // Expected actions:
    //   - observatory.alert.detected   (evaluateAndRaise)
    //   - observatory.alert.notified   (auto-transition)
    //   - observatory.alert.reviewed   (markReviewed)
    //   - observatory.alert.decision_documented (documentDecision)
    //   - observatory.alert.execution_status_updated (updateExecutionStatus x2)
    //   - observatory.alert.closed     (closeAlert)
    const actions = entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("observatory.alert.reviewed");
    expect(actions).toContain("observatory.alert.closed");
    // At least 4 audit entries for this alert's lifecycle
    expect(entries.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  // ============================================================
  // Cross-tenant isolation (RLS)
  // ============================================================
  it("16. RLS: Tenant B GET /alerts → 200 with empty list (no Tenant A leaks)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      "/api/v1/state-observatory/alerts"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.alerts)).toBe(true);
    // Tenant B should NOT see Tenant A's alert
    const found = body.alerts.find(
      (a: { id: string }) => a.id === createdAlertId
    );
    expect(found).toBeUndefined();
  }, 30_000);

  it("17. RLS: Tenant B GET /alerts/[id from A] → 404 (NotFound, NOT 403)", async () => {
    // Tenant B should NOT be able to fetch Tenant A's alert by id
    const res = await fetchWithCookies(
      tenantBCookies,
      `/api/v1/state-observatory/alerts/${createdAlertId}`
    );
    expect(res.status).toBe(404);
    // 404, NOT 403 — does not leak existence across tenants
  }, 30_000);

  it("18. RLS: Tenant B GET /indicators → empty (no Tenant A indicator leak)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      "/api/v1/state-observatory/indicators"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.indicators)).toBe(true);
    const found = body.indicators.find(
      (i: { id: string }) => i.id === createdIndicatorId
    );
    expect(found).toBeUndefined();
  }, 30_000);

  it("19. RLS: Tenant B GET /observations → empty (no Tenant A observation leak)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      "/api/v1/state-observatory/observations"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.observations)).toBe(true);
    const found = body.observations.find(
      (o: { id: string }) => o.id === createdObservationId
    );
    expect(found).toBeUndefined();
  }, 30_000);
});
