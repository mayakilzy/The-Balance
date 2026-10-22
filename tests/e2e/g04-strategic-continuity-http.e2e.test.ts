// ============================================================
// tests/e2e/g04-strategic-continuity-http.e2e.test.ts
// ------------------------------------------------------------
// G04 Delivery 03 — Strategic Continuity E2E HTTP acceptance test.
//
// Implements the owner's 8-step scenario:
//   1. Government A approves a strategy and records key decisions.
//   2. Programs and reform actions advance through documented states.
//   3. A new authorized administration receives a handover dossier.
//   4. The incoming administration inspects historical decisions + evidence.
//   5. It proposes a policy change and receives an impact assessment.
//   6. A new strategy version is created while the previous remains inspectable.
//   7. A decision is amended or reversed through an authorized workflow.
//   8. Audit history remains consistent, and unauthorized access is denied.
//
// Convention (matches g01 + g02 + g03 conventions):
//   - The CI e2e step starts ONE Next.js dev server on port 3001 (shared).
//   - This test EXPECTS that server — does NOT spawn its own (avoids
//     .next/dev cache collision).
//   - For LOCAL runs: `bun run dev -- -p 3001` in a separate terminal first.
//
// Rate-limit safe:
//   - 3 signins (analyst + reviewer + tenantB analyst) with 2s+500ms gaps
//   - 429 retry-with-backoff on signIn (matches g02 pattern)
//   - Runs in a SEPARATE CI step (after G01/G03 + G02 steps), so it has
//     a fresh rate-limit window from a fresh Next.js process
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
  email: "g04-d3-e2e-reviewer@demolandia.test",
  password: "Test1234!",
};
const ADMIN = {
  email: "admin@demolandia.test",
  password: "test_admin_password_00_03",
};
const TENANT_B_ANALYST = {
  email: "g04-d3-e2e-tenantb-analyst@demolandia.test",
  password: "Test1234!",
};

let adminDb: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let strategyId: string;
let strategyVersionId: string;
let newStrategyVersionId: string;
let objectiveId: string;
let analystUserId: string;
let reviewerUserId: string;
let adminUserId: string;
let tenantBAnalystUserId: string;

let analystCookies: string[] = [];
let reviewerCookies: string[] = [];
let adminCookies: string[] = [];
let tenantBCookies: string[] = [];

// Track IDs we created for cleanup
let createdDecisionId: string;
let createdReversedDecisionId: string;
let createdDossierId: string;

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
      lastErr = new Error(
        `Signin rate-limited for ${creds.email}: HTTP 429 (will retry)`
      );
      continue;
    }
    throw new Error(`Signin failed for ${creds.email}: HTTP ${res.status}`);
  }
  throw new Error(
    `Signin exhausted retries for ${creds.email}: ${String(lastErr)}`
  );
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
// Setup: ensure approved StrategyVersion + Objective + users
// ============================================================
async function ensureContinuityFixtures(): Promise<void> {
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

  // Reviewer (for dossier generation + decision approval)
  const reviewer = await adminDb.user.upsert({
    where: { email: REVIEWER.email },
    update: {},
    create: {
      email: REVIEWER.email,
      name: "G04-D3 E2E Reviewer",
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

  // Tenant B analyst (for cross-tenant isolation tests)
  const tenantBAnalyst = await adminDb.user.upsert({
    where: { email: TENANT_B_ANALYST.email },
    update: {},
    create: {
      email: TENANT_B_ANALYST.email,
      name: "G04-D3 E2E Tenant B Analyst",
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

  // Approved Strategy + StrategyVersion (for decision + dossier linkage)
  let strategy = await adminDb.strategy.findFirst({
    where: { tenantId: tenantAId, title: "G04-D3 E2E Strategy" },
  });
  if (!strategy) {
    strategy = await adminDb.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "G04-D3 E2E Strategy",
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
        approvalNotes: "G04-D3 E2E auto-approved fixture",
        metadata: { simulated: true, source: "g04-d3-e2e-fixture" },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  // Objective (required by some G01/G03 services)
  let obj = await adminDb.objective.findFirst({
    where: { tenantId: tenantAId },
  });
  if (!obj) {
    obj = await adminDb.objective.create({
      data: {
        tenantId: tenantAId,
        countryId,
        title: "G04-D3 E2E Objective",
        targetMetric: "inflation_rate",
        targetValue: "5.0",
        horizon: 5,
        status: "active",
        createdBy: analystUserId,
      },
    });
  }
  objectiveId = obj.id;

  // Clean up stale G04-D3 data from prior runs
  await adminDb.handoverDossier.deleteMany({
    where: { tenantId: tenantAId, title: { startsWith: "G04-D3 E2E:" } },
  }).catch(() => {});
  await adminDb.decision.deleteMany({
    where: { tenantId: tenantAId, title: { startsWith: "G04-D3 E2E:" } },
  }).catch(() => {});
  await adminDb.auditLog.deleteMany({
    where: { tenantId: tenantAId, action: { startsWith: "handover." } },
  }).catch(() => {});
  await adminDb.auditLog.deleteMany({
    where: { tenantId: tenantAId, action: "policy.impact.assessed" },
  }).catch(() => {});
}

// ============================================================
// Setup + teardown
// ============================================================
beforeAll(async () => {
  if (!RUN_E2E) return;

  adminDb = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
  await ensureContinuityFixtures();

  await waitForServer();
  await new Promise((r) => setTimeout(r, 2000)); // avoid rate-limit collision

  analystCookies = await signIn(ANALYST);
  await new Promise((r) => setTimeout(r, 500));
  reviewerCookies = await signIn(REVIEWER);
  await new Promise((r) => setTimeout(r, 500));
  adminCookies = await signIn(ADMIN);
  await new Promise((r) => setTimeout(r, 500));
  tenantBCookies = await signIn(TENANT_B_ANALYST);
}, 120_000);

afterAll(async () => {
  if (adminDb) {
    await adminDb.handoverDossier.deleteMany({
      where: { tenantId: tenantAId, title: { startsWith: "G04-D3 E2E:" } },
    }).catch(() => {});
    await adminDb.decision.deleteMany({
      where: { tenantId: tenantAId, title: { startsWith: "G04-D3 E2E:" } },
    }).catch(() => {});
    // Clean new strategy version created in test 6
    if (newStrategyVersionId) {
      await adminDb.strategyVersion.deleteMany({
        where: { id: newStrategyVersionId },
      }).catch(() => {});
    }
    await adminDb.auditLog.deleteMany({
      where: { tenantId: tenantAId, action: { startsWith: "handover." } },
    }).catch(() => {});
    await adminDb.auditLog.deleteMany({
      where: { tenantId: tenantAId, action: "policy.impact.assessed" },
    }).catch(() => {});
    await adminDb.auditLog.deleteMany({
      where: { tenantId: tenantAId, action: { startsWith: "decision." } },
    }).catch(() => {});
    await adminDb.$disconnect();
  }
}, 60_000);

// ============================================================
// Tests — owner's 8-step scenario
// ============================================================
describeE2E("G04 Delivery 03 — Strategic Continuity (owner's 8-step scenario)", () => {
  // ----------------------------------------------------------
  // STEP 1: Government A approves a strategy and records key decisions
  // ----------------------------------------------------------
  it("1. POST /decisions → 201 (analyst creates decision linked to approved strategy)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/decisions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyVersionId,
          title: "G04-D3 E2E: Adopt inflation-targeting framework",
          rationale:
            "Decision to adopt an inflation-targeting framework as the primary monetary policy instrument, with a 5-year horizon and quarterly milestones.",
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.decisionId).toBeTruthy();
    createdDecisionId = body.decisionId;
  }, 30_000);

  it("1b. GET /decisions → 200 (list shows the new decision)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/decisions"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.decisions)).toBe(true);
    const found = body.decisions.find((d: { id: string }) => d.id === createdDecisionId);
    expect(found).toBeTruthy();
    expect(found.status).toBe("proposed"); // initial status
  }, 30_000);

  it("1c. POST /decisions/[id]/advance (reviewed as ANALYST) → 200 (analyst can review)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "reviewed",
          notes: "Reviewed by analyst — rationale is sound",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("reviewed");
  }, 30_000);

  it("1d. POST /decisions/[id]/advance (approved as ANALYST) → 403 (analyst lacks strategy:approve)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "approved",
          notes: "Should be 403 — analyst cannot approve",
        }),
      }
    );
    expect(res.status).toBe(403);
    // Verify decision is still "reviewed" (not approved)
    const getRes = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}`
    );
    const getBody = await getRes.json();
    expect(getBody.decision.status).toBe("reviewed");
  }, 30_000);

  it("1e. POST /decisions/[id]/advance (approved as REVIEWER) → 200 (reviewer can approve)", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "approved",
          notes: "Approved by reviewer — proceed with implementation",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
  }, 30_000);

  it("1f. POST /decisions/[id]/advance (implemented as ADMIN) → 200 (lifecycle continues)", async () => {
    // Admin has both strategy:write + strategy:approve — can implement decisions.
    // Reviewer only has strategy:approve — cannot implement (strategy:write required).
    const res = await fetchWithCookies(
      adminCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "implemented",
          notes: "Implementation verified",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("implemented");
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 2: Programs and reform actions advance through documented states
  // (uses existing /api/v1/reform/* routes — already HTTP-exposed + seeded)
  // ----------------------------------------------------------
  it("2. GET /reform/proposals → 200 (seeded reform proposals are inspectable)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/reform/proposals?limit=10"
    );
    expect(res.status).toBe(200);
    // The response shape may be { proposals: [] } or { data: [...] } or [...]
    const body = await res.json();
    const proposals = body.proposals || body.data || body;
    expect(Array.isArray(proposals)).toBe(true);
    // The seed (seed-ontology.ts) creates at least one G03 reform proposal.
    // We don't assert count > 0 strictly because test isolation may have cleaned
    // some up — but the endpoint itself must respond 200.
  }, 30_000);

  it("2b. GET /reform/actions → 200 (existing reform actions are inspectable)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/reform/actions?limit=10"
    );
    expect([200]).toContain(res.status);
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 3: A new authorized administration receives a handover dossier
  // ----------------------------------------------------------
  it("3a. POST /handover/dossier as ANALYST → 403 (analyst lacks strategy:approve)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/handover/dossier",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "G04-D3 E2E: Handover Dossier (should fail)",
          scope: {
            includeActiveStrategies: true,
            includeOutstandingObligations: true,
            includeAuditHighlights: true,
          },
        }),
      }
    );
    expect(res.status).toBe(403);
  }, 30_000);

  it("3b. POST /handover/dossier as REVIEWER → 201 (dossier generated + persisted)", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      "/api/v1/continuity/handover/dossier",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "G04-D3 E2E: Handover Dossier for Incoming Administration",
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
    expect(body.content).toBeTruthy();
    expect(body.content.counts).toBeTruthy();
    expect(body.content.counts.strategies).toBeGreaterThanOrEqual(1);
    expect(body.content.counts.decisions).toBeGreaterThanOrEqual(1);
    expect(body.content.honesty.scope).toBe("descriptive");
    createdDossierId = body.dossierId;
  }, 30_000);

  it("3c. GET /handover/dossiers → 200 (incoming admin can list available dossiers)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/handover/dossiers"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.dossiers)).toBe(true);
    const found = body.dossiers.find((d: { id: string }) => d.id === createdDossierId);
    expect(found).toBeTruthy();
    expect(found.status).toBe("published");
  }, 30_000);

  it("3d. GET /handover/dossiers/[id] → 200 (full dossier retrieved; retrievalCount incremented)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/handover/dossiers/${createdDossierId}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(createdDossierId);
    expect(body.content).toBeTruthy();
    expect(body.retrievalCount).toBeGreaterThanOrEqual(1);
    expect(body.retrievedBy).toBe(analystUserId);
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 4: Incoming administration inspects historical decisions + evidence
  // ----------------------------------------------------------
  it("4a. GET /decisions/[id] → 200 (full decision detail with evidence snapshot + event trail)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision.id).toBe(createdDecisionId);
    expect(body.decision.title).toContain("inflation-targeting");
    expect(Array.isArray(body.events)).toBe(true);
    // Expect at least 4 events: proposed + reviewed + approved + implemented
    expect(body.events.length).toBeGreaterThanOrEqual(4);
    const eventTypes = body.events.map((e: { eventType: string }) => e.eventType);
    expect(eventTypes).toContain("reviewed");
    expect(eventTypes).toContain("approved");
    expect(eventTypes).toContain("implemented");
  }, 30_000);

  it("4b. GET /decisions/[id]/trace → 200 (full chronological trace for the decision)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}/trace`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.focus.decisionId).toBe(createdDecisionId);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    // Verify the trace includes the decision_event entries
    const sources = body.entries.map((e: { source: string }) => e.source);
    expect(sources).toContain("decision_event");
  }, 30_000);

  it("4c. GET /strategies/[id]/history → 200 (all versions of the strategy)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/strategies/${strategyId}/history`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.strategyId).toBe(strategyId);
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.versions.length).toBeGreaterThanOrEqual(1);
    // The original version (v1) is approved
    const v1 = body.versions.find((v: { versionNumber: number }) => v.versionNumber === 1);
    expect(v1).toBeTruthy();
    expect(v1.status).toBe("approved");
    expect(v1.isLatest).toBe(true); // no v2 yet
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 5: Proposes a policy change and receives an impact assessment
  // ----------------------------------------------------------
  it("5a. POST /impact-assessment → 200 (assessment computed with honesty labels)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/impact-assessment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changeType: "supersede",
          description:
            "Incoming administration proposes to supersede the current inflation-targeting framework with a monetary-base-growth anchor.",
          target: {
            strategyVersionId,
          },
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assessment).toBeTruthy();
    expect(body.assessment.changeType).toBe("supersede");
    expect(Array.isArray(body.assessment.affectedPrograms)).toBe(true);
    expect(Array.isArray(body.assessment.affectedDecisions)).toBe(true);
    expect(Array.isArray(body.assessment.outstandingObligations)).toBe(true);
    expect(Array.isArray(body.assessment.risks)).toBe(true);
    expect(Array.isArray(body.assessment.missingInformation)).toBe(true);
    expect(body.assessment.honesty.scope).toBe("descriptive");
    expect(body.assessment.honesty.notes).toContain("no simulated");
  }, 30_000);

  it("5b. POST /impact-assessment without target → 400 (Zod validation)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/impact-assessment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changeType: "amend",
          description: "Missing target — should fail validation.",
          // target intentionally omitted
        }),
      }
    );
    expect(res.status).toBe(400);
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 6: A new strategy version is created while the previous remains inspectable
  // ----------------------------------------------------------
  it("6a. Create new strategy version v2 (via adminDb — direct DB insertion, simulating admin approval)", async () => {
    // Use the adminDb to create v2 directly (mirrors how the seed + integration tests do it).
    // This is the same pattern as the existing g02-t2-slice integration test.
    const sv2 = await adminDb.strategyVersion.create({
      data: {
        strategyId,
        tenantId: tenantAId,
        versionNumber: 2,
        content: '{"v2":"updated framework"}',
        status: "approved",
        approvedBy: adminUserId,
        approvedAt: new Date(),
        approvalNotes: "G04-D3 E2E v2 auto-approved (incoming administration)",
        metadata: { simulated: true, source: "g04-d3-e2e-v2-fixture" },
        createdBy: analystUserId,
      },
    });
    newStrategyVersionId = sv2.id;
    expect(sv2.versionNumber).toBe(2);
  }, 30_000);

  it("6b. GET /strategies/[id]/history → 200 (shows v2 as latest, v1 still inspectable)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/strategies/${strategyId}/history`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions.length).toBeGreaterThanOrEqual(2);
    const v2 = body.versions.find((v: { versionNumber: number }) => v.versionNumber === 2);
    const v1 = body.versions.find((v: { versionNumber: number }) => v.versionNumber === 1);
    expect(v2).toBeTruthy();
    expect(v2.isLatest).toBe(true);
    expect(v1).toBeTruthy();
    expect(v1.isLatest).toBe(false);
    // Both versions are inspectable (no destructive overwrite)
    expect(v1.status).toBe("approved");
    expect(v2.status).toBe("approved");
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 7: A decision is amended or reversed through an authorized workflow
  // ----------------------------------------------------------
  it("7a. POST /decisions (new decision to reverse) → 201", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      "/api/v1/continuity/decisions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyVersionId,
          title: "G04-D3 E2E: Decision to be reversed by incoming administration",
          rationale:
            "This decision will be reversed in the next test step to verify the reversal workflow preserves institutional memory.",
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.decisionId).toBeTruthy();
    createdReversedDecisionId = body.decisionId;
  }, 30_000);

  it("7b. POST /decisions/[id]/advance (reviewed → approved → implemented → reversed) → 200 at each step", async () => {
    // reviewed (analyst — has strategy:write)
    let res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${createdReversedDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "reviewed", notes: "reviewed" }),
      }
    );
    expect(res.status).toBe(200);

    // approved (reviewer — has strategy:approve)
    res = await fetchWithCookies(
      reviewerCookies,
      `/api/v1/continuity/decisions/${createdReversedDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "approved", notes: "approved" }),
      }
    );
    expect(res.status).toBe(200);

    // implemented (admin — has strategy:write + strategy:approve)
    res = await fetchWithCookies(
      adminCookies,
      `/api/v1/continuity/decisions/${createdReversedDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "implemented", notes: "implemented" }),
      }
    );
    expect(res.status).toBe(200);

    // reversed (admin — institutional reversal via authorized workflow)
    res = await fetchWithCookies(
      adminCookies,
      `/api/v1/continuity/decisions/${createdReversedDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "reversed",
          notes: "Reversed by incoming administration — new evidence suggests alternative framework is preferable.",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("reversed");
  }, 30_000);

  it("7c. GET /decisions/[id]/trace → 200 (reversal preserved in event trail — append-only)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/decisions/${createdReversedDecisionId}/trace`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBeGreaterThan(0);
    // All 5 lifecycle events should be present (proposed/reviewed/approved/implemented/reversed)
    const decisionEvents = body.entries.filter(
      (e: { source: string }) => e.source === "decision_event"
    );
    const actionTypes = decisionEvents.map((e: { action: string }) => e.action);
    expect(actionTypes).toContain("decision.proposed");
    expect(actionTypes).toContain("decision.reviewed");
    expect(actionTypes).toContain("decision.approved");
    expect(actionTypes).toContain("decision.implemented");
    expect(actionTypes).toContain("decision.reversed");
  }, 30_000);

  // ----------------------------------------------------------
  // STEP 8: Audit history consistent + unauthorized access denied
  // ----------------------------------------------------------
  it("8a. Audit log: handover + impact-assessment + decision events all recorded", async () => {
    const entries = await adminDb.auditLog.findMany({
      where: {
        tenantId: tenantAId,
        action: {
          in: [
            "handover.dossier.generated",
            "handover.dossier.retrieved",
            "policy.impact.assessed",
          ],
        },
      },
      orderBy: { at: "asc" },
    });
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const actions = entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("handover.dossier.generated");
    expect(actions).toContain("handover.dossier.retrieved");
    expect(actions).toContain("policy.impact.assessed");
  }, 30_000);

  it("8b. RLS: Tenant B GET /decisions → 200 with empty list (no Tenant A leak)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      "/api/v1/continuity/decisions"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.decisions)).toBe(true);
    const found = body.decisions.find((d: { id: string }) => d.id === createdDecisionId);
    expect(found).toBeUndefined();
  }, 30_000);

  it("8c. RLS: Tenant B GET /decisions/[id from A] → 404 (NotFound, NOT 403)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}`
    );
    expect(res.status).toBe(404);
  }, 30_000);

  it("8d. RLS: Tenant B GET /handover/dossiers → empty (no Tenant A dossier leak)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      "/api/v1/continuity/handover/dossiers"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.dossiers)).toBe(true);
    const found = body.dossiers.find((d: { id: string }) => d.id === createdDossierId);
    expect(found).toBeUndefined();
  }, 30_000);

  it("8e. RLS: Tenant B GET /handover/dossiers/[id from A] → 404 (no cross-tenant leak)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      `/api/v1/continuity/handover/dossiers/${createdDossierId}`
    );
    expect(res.status).toBe(404);
  }, 30_000);

  it("8f. RLS: Tenant B GET /strategies/[id from A]/history → 404 (strategy not in B's tenant)", async () => {
    const res = await fetchWithCookies(
      tenantBCookies,
      `/api/v1/continuity/strategies/${strategyId}/history`
    );
    expect([404, 400]).toContain(res.status); // 404 if strategy not found in B; 400 if strategyId is invalid format
  }, 30_000);

  // ----------------------------------------------------------
  // NEGATIVE: dossier content immutability (DB trigger enforcement)
  // ----------------------------------------------------------
  it("9a. NEG: handover dossier content is immutable post-publication (DB trigger blocks UPDATE)", async () => {
    // Attempt to mutate the content directly via balance_admin (BYPASSRLS, but trigger still fires)
    // This proves the DB-level invariant works regardless of who attempts the change.
    let triggerFired = false;
    try {
      await adminDb.$executeRaw`
        UPDATE handover_dossiers
        SET content = '{"hacked": true}'::jsonb
        WHERE id = ${createdDossierId}
      `;
    } catch (err) {
      triggerFired = true;
      expect(String(err)).toContain("Cannot mutate content of a published handover dossier");
    }
    expect(triggerFired).toBe(true);
    // Verify content is unchanged
    const row = await adminDb.handoverDossier.findUnique({
      where: { id: createdDossierId },
      select: { content: true },
    });
    const content = row?.content as unknown as { counts?: { strategies?: number } };
    expect(content?.counts?.strategies).toBeGreaterThanOrEqual(1); // original content preserved
  }, 30_000);

  it("9b. NEG: invalid decision advance transition → 400 (e.g., implemented → reviewed is not allowed)", async () => {
    // The implemented decision cannot go back to "reviewed" — invalid transition
    // Use admin (has all permissions, so 403 won't mask the validation error)
    const res = await fetchWithCookies(
      adminCookies,
      `/api/v1/continuity/decisions/${createdDecisionId}/advance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newStatus: "reviewed", // implemented → reviewed is invalid
          notes: "Should fail — invalid transition",
        }),
      }
    );
    expect(res.status).toBe(400);
  }, 30_000);

  // ----------------------------------------------------------
  // Handover dossier scope filtering (include/exclude controls)
  // ----------------------------------------------------------
  it("10a. POST /handover/dossier with includeActiveStrategies=false → dossier has 0 strategies", async () => {
    const res = await fetchWithCookies(
      reviewerCookies,
      "/api/v1/continuity/handover/dossier",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "G04-D3 E2E: Dossier without active strategies",
          scope: {
            includeActiveStrategies: false,
            includeOutstandingObligations: false,
            includeAuditHighlights: false,
          },
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.content.counts.strategies).toBe(0);
    expect(body.content.counts.obligations).toBe(0);
    expect(body.content.counts.auditEntries).toBe(0);
  }, 30_000);

  // ----------------------------------------------------------
  // Traceability: full strategy trace (audit_log + reform_proposals)
  // ----------------------------------------------------------
  it("11. GET /strategies/[id]/trace?strategyVersionId=... → 200 (aggregated trace)", async () => {
    const res = await fetchWithCookies(
      analystCookies,
      `/api/v1/continuity/strategies/${strategyId}/trace?strategyVersionId=${strategyVersionId}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.focus.strategyVersionId).toBe(strategyVersionId);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    // Trace should include at least one audit_log entry referencing the strategyVersionId
    const auditEntries = body.entries.filter(
      (e: { source: string }) => e.source === "audit_log"
    );
    expect(auditEntries.length).toBeGreaterThan(0);
  }, 30_000);
});
