// ============================================================
// tests/e2e/g03-02-reform-e2e.test.ts
// ------------------------------------------------------------
// G03-02 — REAL API End-to-End test.
//
// Starts a real Next.js server + PostgreSQL, makes authenticated HTTP
// requests with cookie persistence, and verifies the full reform
// workflow:
//
//   Login (analyst) → Create Alert (direct DB) →
//   POST /api/v1/reform/proposals →
//   POST /api/v1/reform/proposals/[id]/submit →
//   Login (reviewer) →
//   POST /api/v1/reform/proposals/[id]/approve →
//   Login (analyst) →
//   POST /api/v1/reform/actions →
//   POST /api/v1/reform/actions/[id]/start →
//   POST /api/v1/reform/actions/[id]/updates →
//   POST /api/v1/reform/actions/[id]/complete →
//   Login (reviewer) →
//   POST /api/v1/reform/actions/[id]/verify →
//   Login (analyst) →
//   POST /api/v1/reform/actions/[id]/feedback →
//   Login (reviewer) →
//   POST /api/v1/reform/proposals/[id]/close-alert →
//   Verify DB state: alert.lifecycleStage="closed"
//
// Negative path: analyst cannot approve (403).
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";

const RUN_E2E = process.env.RUN_E2E_HTTP_TESTS === "1" && process.env.SKIP_E2E_SERVER !== "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

const BASE_URL = "http://localhost:3001";
const DIRECT_URL = process.env.DIRECT_URL ?? "";

const ANALYST_EMAIL = "analyst@demolandia.test";
const ANALYST_PW = "test_analyst_password_00_03";
const REVIEWER_EMAIL = "g03-02-e2e-reviewer@demolandia.test";
const REVIEWER_PW = "Test1234!";

let serverProcess: ChildProcess | null = null;
let adminDb: PrismaClient;
let tenantAId: string;
let countryId: string;
let strategyVersionId: string;
let adminUserId: string;
let analystUserId: string;
let reviewerUserId: string;
let alertId: string;
let proposalId: string;
let actionId: string;
let feedbackLoopId: string;

// Per-user cookie jars
let analystCookies: string[] = [];
let reviewerCookies: string[] = [];

async function fetchAs(
  cookies: string[],
  path: string,
  options: RequestInit = {}
): Promise<{ response: Response; cookies: string[] }> {
  const headers = new Headers(options.headers);
  if (cookies.length > 0) {
    headers.set("Cookie", cookies.join("; "));
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const newCookies = [...cookies];
  for (const cookie of setCookie) {
    const cookiePart = cookie.split(";")[0];
    if (cookiePart) {
      const [name] = cookiePart.split("=");
      const idx = newCookies.findIndex((c) => c.startsWith(`${name}=`));
      if (idx >= 0) newCookies.splice(idx, 1);
      newCookies.push(cookiePart);
    }
  }
  return { response, cookies: newCookies };
}

async function waitForServer(timeoutMs = 90000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/meta`);
      if (response.ok) return;
    } catch {
      // Server not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function login(email: string, password: string): Promise<string[]> {
  let cookies: string[] = [];
  const { response, cookies: newCookies } = await fetchAs(cookies, "/api/v1/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  cookies = newCookies;
  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status}`);
  }
  return cookies;
}

beforeAll(async () => {
  if (!RUN_E2E) return;

  adminDb = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  const country = await adminDb.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia (DML) not seeded");
  countryId = country.id;

  const tenantA = await adminDb.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  if (!tenantA) throw new Error("Tenant A not seeded");
  tenantAId = tenantA.id;

  const adminUser = await adminDb.user.findUnique({ where: { email: "admin@demolandia.test" } });
  const analystUser = await adminDb.user.findUnique({ where: { email: ANALYST_EMAIL } });
  if (!adminUser || !analystUser) throw new Error("Test users not seeded");
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  // Create reviewer for E2E
  const reviewer = await adminDb.user.upsert({
    where: { email: REVIEWER_EMAIL },
    update: {},
    create: {
      email: REVIEWER_EMAIL,
      name: "G03-02 E2E Reviewer",
      passwordHash: await hashPassword(REVIEWER_PW),
      status: "active",
    },
  });
  await adminDb.membership.upsert({
    where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "reviewer" },
    create: { userId: reviewer.id, tenantId: tenantAId, roleCode: "reviewer", status: "active" },
  });
  reviewerUserId = reviewer.id;

  // Fetch (or create) approved strategy version
  let sv = await adminDb.strategyVersion.findFirst({
    where: { tenantId: tenantAId, status: "approved" },
  });
  if (!sv) {
    const strategy = await adminDb.strategy.create({
      data: { tenantId: tenantAId, title: "G03-02 E2E Test Strategy", createdBy: analystUserId },
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
        metadata: { simulated: true },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;

  // Create an alert directly (bypass G02 to keep E2E test focused on G03-02)
  alertId = `g03-02-e2e-alert-${Date.now()}`;
  await adminDb.alert.create({
    data: {
      id: alertId,
      tenantId: tenantAId,
      strategyVersionId,
      title: "G03-02 E2E Test Alert",
      description: "Test alert for G03-02 end-to-end API workflow.",
      severity: "warning",
      lifecycleStage: "reviewed",
      executionStatus: "verified",
      executionVerifiedAction: "E2E test fixture — alert pre-verified",
      executionVerificationSource: "g03-02-e2e-test-fixture",
      executionVerifiedById: reviewerUserId,
      executionVerifiedAt: new Date(),
      createdBy: "system",
      reviewedBy: reviewerUserId,
      reviewedAt: new Date(),
      isAutoGenerated: true,
      metadata: { simulated: true, source: "g03-02-e2e" },
    },
  });

  // Start Next.js server on port 3001
  serverProcess = spawn(
    "bun",
    ["run", "dev", "--", "-p", "3001"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: "3001",
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  serverProcess.stdout?.on("data", (data) => {
    if (process.env.E2E_DEBUG) process.stdout.write("[server] " + data.toString());
  });
  serverProcess.stderr?.on("data", (data) => {
    if (process.env.E2E_DEBUG) process.stderr.write("[server error] " + data.toString());
  });

  await waitForServer();
}, 120000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  if (adminDb) {
    try {
      // Cleanup fixtures (disable append-only triggers first)
      await adminDb.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" DISABLE TRIGGER prevent_delete_reform_feedback_loops`);
      await adminDb.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`);
      await adminDb.$executeRawUnsafe(`ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`);

      await adminDb.reformFeedbackLoop.deleteMany({
        where: { id: feedbackLoopId ? { equals: feedbackLoopId } : undefined },
      }).catch(() => {});
      if (actionId) {
        await adminDb.reformVerification.deleteMany({ where: { actionId } }).catch(() => {});
        await adminDb.reformActionUpdate.deleteMany({ where: { actionId } }).catch(() => {});
        await adminDb.reformAction.deleteMany({ where: { id: actionId } }).catch(() => {});
      }
      if (proposalId) {
        await adminDb.reformApproval.deleteMany({ where: { proposalId } }).catch(() => {});
        await adminDb.reformAlternative.deleteMany({ where: { proposalId } }).catch(() => {});
        await adminDb.reformProposal.deleteMany({ where: { id: proposalId } }).catch(() => {});
      }
      if (alertId) {
        await adminDb.alert.deleteMany({ where: { id: alertId } }).catch(() => {});
      }

      await adminDb.$executeRawUnsafe(`ALTER TABLE "reform_feedback_loops" ENABLE TRIGGER prevent_delete_reform_feedback_loops`);
      await adminDb.$executeRawUnsafe(`ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`);
      await adminDb.$executeRawUnsafe(`ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`);
    } finally {
      await adminDb.$disconnect();
    }
  }
});

// ============================================================
// E2E workflow
// ============================================================
describeE2E("G03-02 Real API End-to-End Workflow", () => {
  it("step 1: analyst logs in", async () => {
    analystCookies = await login(ANALYST_EMAIL, ANALYST_PW);
    expect(analystCookies.length).toBeGreaterThan(0);
  }, 30000);

  it("step 2: analyst creates reform proposal via API", async () => {
    const { response, cookies } = await fetchAs(analystCookies, "/api/v1/reform/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originatingAlertId: alertId,
        title: "G03-02 E2E Reform Proposal",
        problemStatement:
          "Demolandia monetary base growth exceeded 7% in 2024, threatening price stability. Reform proposal explores alternative anchors.",
        hypothesizedCauses: ["loose fiscal-monetary coordination"],
        alternative: {
          title: "G03-02 E2E Inflation Targeting Framework",
          description:
            "Adopt a 3%±1pp inflation targeting framework with quarterly accountability reports co-signed by the Central Bank.",
          costEstimateMin: 500000,
          costEstimateMax: 1500000,
          costCurrency: "USD",
          riskLevel: "medium",
          feasibilityScore: "high",
        },
      }),
    });
    analystCookies = cookies;
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.proposalId).toBeDefined();
    expect(body.alternativeId).toBeDefined();
    proposalId = body.proposalId;
  }, 30000);

  it("step 3: analyst submits proposal for review", async () => {
    const { response } = await fetchAs(analystCookies, `/api/v1/reform/proposals/${proposalId}/submit`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("under_review");
  }, 30000);

  it("step 4: analyst attempts to approve own proposal → 403 Forbidden", async () => {
    const { response } = await fetchAs(analystCookies, `/api/v1/reform/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rationale: "Analyst attempts to approve own proposal — must be denied.",
      }),
    });
    expect(response.status).toBe(403);
  }, 30000);

  it("step 5: reviewer logs in and approves the proposal", async () => {
    reviewerCookies = await login(REVIEWER_EMAIL, REVIEWER_PW);
    expect(reviewerCookies.length).toBeGreaterThan(0);

    const { response } = await fetchAs(reviewerCookies, `/api/v1/reform/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rationale:
          "Approved based on cross-tenant evidence convergence (IMF + World Bank) and Demolandia Central Bank operational capacity.",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.proposalStatus).toBe("approved");
  }, 30000);

  it("step 6: analyst creates reform action for the approved proposal", async () => {
    const { response } = await fetchAs(analystCookies, "/api/v1/reform/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposalId,
        title: "G03-02 E2E Action — Publish Inflation Targeting Mandate",
        description:
          "Jointly publish the new inflation targeting mandate in the official gazette, co-signed by the Minister of Planning and the Central Bank Governor.",
        assignedTo: analystUserId,
        dueDate: "2026-12-31T00:00:00Z",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.actionId).toBeDefined();
    actionId = body.actionId;
  }, 30000);

  it("step 7: analyst starts the action", async () => {
    const { response } = await fetchAs(analystCookies, `/api/v1/reform/actions/${actionId}/start`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("in_progress");
  }, 30000);

  it("step 8: analyst appends a progress update", async () => {
    const { response } = await fetchAs(analystCookies, `/api/v1/reform/actions/${actionId}/updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updateType: "progress",
        notes:
          "Draft mandate circulated to Central Bank for technical review. Legal review pending with Ministry of Justice.",
        progressPercentage: 40,
        evidenceIds: [],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.updateId).toBeDefined();
  }, 30000);

  it("step 9: analyst completes the action", async () => {
    const { response } = await fetchAs(analystCookies, `/api/v1/reform/actions/${actionId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
  }, 30000);

  it("step 10: reviewer verifies the action execution (F6)", async () => {
    const { response } = await fetchAs(reviewerCookies, `/api/v1/reform/actions/${actionId}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verificationStatus: "verified",
        verifiedAction:
          "Action mandate published in official gazette on 2026-04-15; verified via gazette archive URL gazette-2026-04-15.pdf",
        evidenceSource: "gazette-2026-04-15.pdf",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.verificationStatus).toBe("verified");
  }, 30000);

  it("step 11: analyst creates descriptive feedback loop", async () => {
    const { response } = await fetchAs(analystCookies, `/api/v1/reform/actions/${actionId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        comparisonType: "none",
        descriptiveSummary:
          "The action was implemented on 2026-04-15; observation #X1 recorded inflation at 4.2% on 2026-04-30. No causal claim is made about the relationship between the action and the observation.",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.feedbackLoopId).toBeDefined();
    feedbackLoopId = body.feedbackLoopId;
  }, 30000);

  it("step 12: reviewer closes the originating alert", async () => {
    const { response } = await fetchAs(reviewerCookies, `/api/v1/reform/proposals/${proposalId}/close-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        closureReason:
          "Reform action verified and descriptive feedback loop documented per G03-02 workflow. Alert closure follows the G02 closeAlert contract.",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.alertClosed).toBe(true);
  }, 30000);

  it("step 13: verify DB state — alert is closed + audit_log entries exist", async () => {
    const alert = await adminDb.alert.findUnique({ where: { id: alertId } });
    expect(alert?.lifecycleStage).toBe("closed");
    expect(alert?.closedBy).toBe(reviewerUserId);

    // Verify audit_log entries for the major state transitions
    const auditActions = [
      "reform.proposal.created",
      "reform.proposal.submitted",
      "reform.proposal.approved",
      "reform.action.created",
      "reform.action.started",
      "reform.action.completed",
      "reform.verification.set",
      "reform.feedback.created",
    ];
    for (const action of auditActions) {
      const entry = await adminDb.auditLog.findFirst({
        where: { tenantId: tenantAId, action },
        orderBy: { at: "desc" },
      });
      expect(entry, `audit_log entry for ${action} should exist`).not.toBeNull();
    }

    // Verify the proposal + action + verification + feedback are all in the
    // expected final state.
    const proposal = await adminDb.reformProposal.findUnique({ where: { id: proposalId } });
    expect(proposal?.status).toBe("approved");

    const action = await adminDb.reformAction.findUnique({ where: { id: actionId } });
    expect(action?.status).toBe("completed");

    const verification = await adminDb.reformVerification.findFirst({
      where: { actionId, tenantId: tenantAId },
    });
    expect(verification?.verificationStatus).toBe("verified");

    const feedback = await adminDb.reformFeedbackLoop.findFirst({
      where: { actionId, tenantId: tenantAId },
    });
    expect(feedback?.attributionLevel).toBe("descriptive");
  }, 30000);
});
