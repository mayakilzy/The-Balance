// ============================================================
// tests/e2e/g03-06-coordination-http.e2e.test.ts
// ------------------------------------------------------------
// G03-06 FINAL HTTP ACCEPTANCE — REAL HTTP integration tests
// against a running Next.js app + real PostgreSQL 17 database.
//
// Coverage:
//   - All 16 active HTTP operations on /api/v1/reform/coordinations/*
//   - 9 critical negative tests (auth, RBAC, cross-tenant, snapshot
//     visibility, B3 absence, state transition, validation)
//
// Server must be running on http://localhost:3001 (start via
// scripts/start-nextjs.sh).
//
// Run with:
//   RUN_E2E_HTTP_TESTS=1 bunx vitest run tests/e2e/g03-06-coordination-http.e2e.test.ts
//
// All test fixtures are clearly fictional (Demolandia).
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const RUN_E2E = process.env.RUN_E2E_HTTP_TESTS === "1" && process.env.SKIP_E2E_SERVER !== "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

const BASE_URL = "http://localhost:3001";
const DIRECT_URL = process.env.DIRECT_URL ?? "postgresql://balance_admin:balance_admin_dev_only@localhost:5433/balance?schema=public";

// Test fixtures (FIXTURES, not secrets — see seed-ontology.ts).
// All emails are LOWERCASE to match findUserByEmail()'s lowercasing.
const ADMIN_A = { email: "admin@demolandia.test", password: "test_admin_password_00_03" };
const ADMIN_B = { email: "adminb@demolandia.test", password: "test_adminB_password_g0306" };
const ANALYST_A = { email: "analyst@demolandia.test", password: "test_analyst_password_00_03" };
const REVIEWER_A = { email: "reviewera@demolandia.test", password: "test_reviewer_password_g0306" };
const OBSERVER_A = { email: "observera@demolandia.test", password: "test_observer_password_g0306" };
const SUSPENDED = { email: "suspended@demolandia.test", password: "test_suspended_password_00_03" };
const REVOKED = { email: "revoked@demolandia.test", password: "test_revoked_password_00_03" };

let adminDb: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let createdCoordinationIds: string[] = [];

// Shared session cookie jars (signed in once in beforeAll, reused across tests).
// This avoids hitting the rate limit (10 signin POSTs per minute).
let adminACookies: string[] = [];
let adminBCookies: string[] = [];
let analystACookies: string[] = [];
let reviewerACookies: string[] = [];
let observerACookies: string[] = [];

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

  // Verify the server is reachable
  const probe = await fetch(`${BASE_URL}/api/v1/meta`);
  if (!probe.ok) {
    throw new Error(`Next.js server not reachable at ${BASE_URL}/api/v1/meta`);
  }

  // Wait 5s before signins to let the rate-limit window recover from
  // the g01 E2E test's signins (vitest runs files sequentially but
  // without delay between them).
  await new Promise((r) => setTimeout(r, 5000));

  // Sign in once per role (avoid rate limit on /api/v1/auth/signin: 10/min).
  // Stagger signins to stay under the limit.
  adminACookies = await signIn(ADMIN_A);
  await new Promise((r) => setTimeout(r, 500));
  adminBCookies = await signIn(ADMIN_B);
  await new Promise((r) => setTimeout(r, 500));
  analystACookies = await signIn(ANALYST_A);
  await new Promise((r) => setTimeout(r, 500));
  reviewerACookies = await signIn(REVIEWER_A);
  await new Promise((r) => setTimeout(r, 500));
  observerACookies = await signIn(OBSERVER_A);
}, 180_000);

afterAll(async () => {
  if (!RUN_E2E) return;
  // Clean up coordination records created during tests
  if (createdCoordinationIds.length > 0) {
    await adminDb.reformCoordinationSharedSnapshotRevocation.deleteMany({
      where: { coordinationId: { in: createdCoordinationIds } },
    }).catch(() => {});
    await adminDb.reformCoordinationSharedSnapshot.deleteMany({
      where: { coordinationId: { in: createdCoordinationIds } },
    }).catch(() => {});
    await adminDb.reformCoordinationApprovalEvent.deleteMany({
      where: { coordinationId: { in: createdCoordinationIds } },
    }).catch(() => {});
    await adminDb.reformCoordinationInvitation.deleteMany({
      where: { coordinationId: { in: createdCoordinationIds } },
    }).catch(() => {});
    await adminDb.reformCoordinationParticipant.deleteMany({
      where: { coordinationId: { in: createdCoordinationIds } },
    }).catch(() => {});
    await adminDb.reformCoordination.deleteMany({
      where: { id: { in: createdCoordinationIds } },
    }).catch(() => {});
  }
  await adminDb?.$disconnect();
}, 30_000);

// ============================================================
// Helper: create a coordination as admin A (using cached session)
// ============================================================
async function createCoordinationAsAdminA(suffix: string): Promise<string> {
  const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      countryId,
      title: `HTTP Acceptance Coordination ${suffix}`,
      description: `Test coordination created by G03-06 HTTP acceptance suite (suffix=${suffix}).`,
      approvalPolicy: "unanimous",
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.coordinationId).toBeTruthy();
  createdCoordinationIds.push(body.coordinationId);
  return body.coordinationId;
}

// ============================================================
// 1) COORDINATION CREATION + LIST + GET
// ============================================================
describeE2E("G03-06 HTTP — 1. Create coordination", () => {
  it("POST /coordinations as admin → 201 with coordinationId", async () => {
    const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        countryId,
        title: "HTTP Acceptance — Create Test",
        description: "Description with at least twenty characters for validation.",
        approvalPolicy: "unanimous",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.coordinationId).toBeTruthy();
    expect(typeof body.coordinationId).toBe("string");
    createdCoordinationIds.push(body.coordinationId);

    // Verify DB persistence
    const inDb = await adminDb.reformCoordination.findUnique({ where: { id: body.coordinationId } });
    expect(inDb).toBeTruthy();
    expect(inDb!.status).toBe("draft");
    expect(inDb!.leadTenantId).toBe(tenantAId);
    expect(inDb!.title).toBe("HTTP Acceptance — Create Test");

    // Verify audit log
    const audit = await adminDb.auditLog.findFirst({
      where: {
        tenantId: tenantAId,
        action: "reform.coordination.created",
        details: { path: ["coordinationId"], equals: body.coordinationId } as any,
      },
      orderBy: { at: "desc" },
    });
    expect(audit).toBeTruthy();
  });

  it("POST /coordinations with invalid input (title too short) → 400", async () => {
    const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        countryId,
        title: "x",  // < 5 chars
        description: "Description with at least twenty characters for validation.",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation");
  });
});

describeE2E("G03-06 HTTP — 2. List coordinations", () => {
  it("GET /coordinations as admin → 200 with array", async () => {
    const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].id).toBeTruthy();
    expect(body[0].title).toBeTruthy();
  });

  it("GET /coordinations?status=draft filters by status", async () => {
    const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations?status=draft");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const c of body) {
      expect(c.status).toBe("draft");
    }
  });
});

describeE2E("G03-06 HTTP — 3. Get coordination by id", () => {
  it("GET /coordinations/:id as admin → 200 with coordination details", async () => {
    const coordId = await createCoordinationAsAdminA("get-by-id");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(coordId);
    expect(body.title).toContain("HTTP Acceptance Coordination");
    expect(body.status).toBe("draft");
  });

  it("GET /coordinations/non-existent-id → 404", async () => {
    const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations/nonexistent_coord_id_xyz");
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 4) PARTICIPANTS — add + list
// ============================================================
describeE2E("G03-06 HTTP — 5/6. Participants", () => {
  it("POST /coordinations/:id/participants adds Tenant B → 201", async () => {
    const coordId = await createCoordinationAsAdminA("add-participant");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantBId, role: "contributor" }),
    });
    expect(res.status).toBe(201);

    // Verify in DB
    const p = await adminDb.reformCoordinationParticipant.findFirst({
      where: { coordinationId: coordId, tenantId: tenantBId },
    });
    expect(p).toBeTruthy();
    expect(p!.status).toBe("active");
  });

  it("GET /coordinations/:id/participants lists participants", async () => {
    const coordId = await createCoordinationAsAdminA("list-participants");
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantBId, role: "contributor" }),
    });
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const hasA = body.some((p: any) => p.tenantId === tenantAId);
    expect(hasA).toBe(true);
    const hasB = body.some((p: any) => p.tenantId === tenantBId);
    expect(hasB).toBe(true);
  });
});

// ============================================================
// 7-10) INVITATIONS — create / accept / decline / revoke
// ============================================================
describeE2E("G03-06 HTTP — 7. Create invitation", () => {
  it("POST /coordinations/:id/invitations creates pending invitation → 201", async () => {
    const coordId = await createCoordinationAsAdminA("create-invitation");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitedTenantId: tenantBId,
        invitedRole: "contributor",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invitationId).toBeTruthy();
  });
});

describeE2E("G03-06 HTTP — 8. Accept invitation (cross-tenant)", () => {
  it("Tenant B admin accepts invitation created by Tenant A → 200/201", async () => {
    const coordId = await createCoordinationAsAdminA("accept-invitation");
    const invRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitedTenantId: tenantBId, invitedRole: "contributor" }),
    });
    expect(invRes.status).toBe(201);
    const invBody = await invRes.json();
    const invId = invBody.invitationId;

    // Accept as Tenant B admin
    const acceptRes = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}/invitations/${invId}/accept`, {
      method: "POST",
    });
    expect([200, 201]).toContain(acceptRes.status);

    // Verify in DB
    const inv = await adminDb.reformCoordinationInvitation.findUnique({ where: { id: invId } });
    expect(inv!.status).toBe("accepted");
    expect(inv!.acceptedAt).toBeTruthy();

    const p = await adminDb.reformCoordinationParticipant.findFirst({
      where: { coordinationId: coordId, tenantId: tenantBId },
    });
    expect(p).toBeTruthy();
    expect(p!.status).toBe("active");
  });
});

describeE2E("G03-06 HTTP — 9. Decline invitation", () => {
  it("Tenant B admin declines invitation → 200", async () => {
    const coordId = await createCoordinationAsAdminA("decline-invitation");
    const invRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitedTenantId: tenantBId, invitedRole: "contributor" }),
    });
    const invId = (await invRes.json()).invitationId;

    const res = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}/invitations/${invId}/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ declineReason: "Tenant B declined for testing purposes." }),
    });
    expect(res.status).toBe(200);

    const inv = await adminDb.reformCoordinationInvitation.findUnique({ where: { id: invId } });
    expect(inv!.status).toBe("declined");
    expect(inv!.declinedAt).toBeTruthy();
  });
});

describeE2E("G03-06 HTTP — 10. Revoke invitation (by lead)", () => {
  it("Lead revokes a pending invitation → 200", async () => {
    const coordId = await createCoordinationAsAdminA("revoke-invitation");
    const invRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitedTenantId: tenantBId, invitedRole: "contributor" }),
    });
    const invId = (await invRes.json()).invitationId;

    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/invitations/${invId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revocationReason: "Lead revoked for testing purposes." }),
    });
    expect(res.status).toBe(200);

    const inv = await adminDb.reformCoordinationInvitation.findUnique({ where: { id: invId } });
    expect(inv!.status).toBe("revoked");
    expect(inv!.revokedAt).toBeTruthy();
  });
});

// ============================================================
// 11) SUBMIT + APPROVE PLAN (single HTTP path, two actions)
// ============================================================
describeE2E("G03-06 HTTP — 11a. Submit coordination plan", () => {
  it("POST /coordinations/:id/approve-plan {action=submit} transitions draft → plan_submitted", async () => {
    const coordId = await createCoordinationAsAdminA("submit-plan");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("plan_submitted");

    const inDb = await adminDb.reformCoordination.findUnique({ where: { id: coordId } });
    expect(inDb!.status).toBe("plan_submitted");
    expect(inDb!.planSubmittedAt).toBeTruthy();
  });
});

describeE2E("G03-06 HTTP — 11b. Approve coordination plan", () => {
  it("POST /coordinations/:id/approve-plan {action=approve} transitions plan_submitted → plan_approved", async () => {
    const coordId = await createCoordinationAsAdminA("approve-plan");
    // Submit first
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    });
    // Approve
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", approvalNotes: "Plan meets all criteria for activation." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("plan_approved");

    const inDb = await adminDb.reformCoordination.findUnique({ where: { id: coordId } });
    expect(inDb!.status).toBe("plan_approved");
    expect(inDb!.planApprovedAt).toBeTruthy();
    expect(inDb!.planApprovedBy).toBeTruthy();
  });

  it("POST /coordinations/:id/approve-plan with invalid action → 400", async () => {
    const coordId = await createCoordinationAsAdminA("invalid-action");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid_action_xyz" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation");
  });

  it("POST /coordinations/:id/approve-plan with missing action → 400", async () => {
    const coordId = await createCoordinationAsAdminA("missing-action");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================
// 12-15) SHARED SNAPSHOTS — create / list / approve / revoke
// ============================================================
describeE2E("G03-06 HTTP — 12. Create shared snapshot", () => {
  it("POST /coordinations/:id/snapshots creates a draft snapshot → 201", async () => {
    const coordId = await createCoordinationAsAdminA("create-snapshot");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "HTTP Acceptance Snapshot",
        summary: "Snapshot summary for G03-06 HTTP acceptance test cases.",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.snapshotId).toBeTruthy();
  });
});

describeE2E("G03-06 HTTP — 13. List shared snapshots", () => {
  it("GET /coordinations/:id/snapshots returns array", async () => {
    const coordId = await createCoordinationAsAdminA("list-snapshots");
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Snapshot for List Test",
        summary: "Snapshot summary for list test case in HTTP acceptance.",
      }),
    });
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});

describeE2E("G03-06 HTTP — 14. Approve shared snapshot (lead)", () => {
  it("Lead approves a draft snapshot → 200, status=approved", async () => {
    const coordId = await createCoordinationAsAdminA("approve-snapshot");
    const createRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Snapshot to Approve",
        summary: "Snapshot summary for the approve-snapshot test case.",
      }),
    });
    const snapId = (await createRes.json()).snapshotId;
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalNotes: "Approved by lead for testing." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");

    const snap = await adminDb.reformCoordinationSharedSnapshot.findUnique({ where: { id: snapId } });
    expect(snap!.status).toBe("approved");
    expect(snap!.approvedAt).toBeTruthy();
  });
});

describeE2E("G03-06 HTTP — 15. Revoke shared snapshot (lead)", () => {
  it("Lead revokes an approved snapshot → 200, status=revoked", async () => {
    const coordId = await createCoordinationAsAdminA("revoke-snapshot");
    const createRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Snapshot to Revoke",
        summary: "Snapshot summary for the revoke-snapshot test case.",
      }),
    });
    const snapId = (await createRes.json()).snapshotId;
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Snapshot revoked for testing purposes." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("revoked");

    const rev = await adminDb.reformCoordinationSharedSnapshotRevocation.findFirst({
      where: { snapshotId: snapId },
    });
    expect(rev).toBeTruthy();
    expect(rev!.reason).toContain("revoked for testing");
  });

  it("Revoking an already-revoked snapshot → 409", async () => {
    const coordId = await createCoordinationAsAdminA("double-revoke");
    const createRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Snapshot to Double-Revoke",
        summary: "Snapshot summary for the double-revoke test case.",
      }),
    });
    const snapId = (await createRes.json()).snapshotId;
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "First revocation for testing purposes." }),
    });
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Second revocation should be rejected." }),
    });
    expect(res.status).toBe(409);
  });
});

// ============================================================
// 16) SHARED VIEW (cross-tenant, coordination-aware)
// ============================================================
describeE2E("G03-06 HTTP — 16. Shared coordination view", () => {
  it("GET /coordinations/:id/shared-view returns coordination + approved snapshots (not revoked)", async () => {
    const coordId = await createCoordinationAsAdminA("shared-view");
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantBId, role: "contributor" }),
    });
    // Snapshot 1: create + approve (should be visible)
    const createRes1 = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Visible Snapshot",
        summary: "Snapshot that should remain visible in shared view.",
      }),
    });
    const snapId1 = (await createRes1.json()).snapshotId;
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId1}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Snapshot 2: create + approve + REVOKE (should be excluded)
    const createRes2 = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Revoked Snapshot",
        summary: "Snapshot that should be excluded from shared view.",
      }),
    });
    const snapId2 = (await createRes2.json()).snapshotId;
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId2}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId2}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Revoked to test shared-view filtering." }),
    });
    // Snapshot 3: create only (DRAFT — should NOT be visible)
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Draft Snapshot — Not Visible",
        summary: "Snapshot in draft status, should not appear in shared view.",
      }),
    });
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/shared-view`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.coordination).toBeTruthy();
    expect(body.coordination.id).toBe(coordId);
    expect(Array.isArray(body.participants)).toBe(true);
    expect(Array.isArray(body.sharedSnapshots)).toBe(true);
    const visibleIds = body.sharedSnapshots.map((s: any) => s.id);
    expect(visibleIds).toContain(snapId1);
    expect(visibleIds).not.toContain(snapId2);  // revoked
    const visibleTitles = body.sharedSnapshots.map((s: any) => s.title);
    expect(visibleTitles).not.toContain("Draft Snapshot — Not Visible");
  });
});

// ============================================================
// 4) CLOSE coordination
// ============================================================
describeE2E("G03-06 HTTP — 4. Close coordination (PATCH)", () => {
  it("PATCH /coordinations/:id with closureReason closes an active coordination → 200", async () => {
    const coordId = await createCoordinationAsAdminA("close-coordination");
    // Move to plan_approved (closable state per service contract)
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    });
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", approvalNotes: "Approved for close test case." }),
    });
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closureReason: "Closing after successful HTTP acceptance test." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("closed");

    const inDb = await adminDb.reformCoordination.findUnique({ where: { id: coordId } });
    expect(inDb!.status).toBe("closed");
    expect(inDb!.closedAt).toBeTruthy();
    expect(inDb!.closedBy).toBeTruthy();
  });

  it("PATCH /coordinations/:id on draft (not plan_approved/active) → 409", async () => {
    const coordId = await createCoordinationAsAdminA("close-conflict");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closureReason: "Cannot close from draft state." }),
    });
    expect(res.status).toBe(409);
  });
});

// ============================================================
// CRITICAL NEGATIVE TESTS
// ============================================================
describeE2E("G03-06 HTTP — NEG-1: Unauthenticated requests → 401/403", () => {
  it("GET /coordinations without session → 401 or 403", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/reform/coordinations`);
    expect([401, 403]).toContain(res.status);
  });

  it("POST /coordinations without session → 401 or 403", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/reform/coordinations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        countryId,
        title: "Should Not Be Created",
        description: "This should be rejected because no session is provided.",
      }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it("POST /coordinations/:id/approve-plan without session → 401 or 403", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/reform/coordinations/some-id/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describeE2E("G03-06 HTTP — NEG-2: Unauthorized role cannot approve institutional plans", () => {
  it("Analyst (no coordination:approve) cannot approve snapshots → 403", async () => {
    const coordId = await createCoordinationAsAdminA("neg-rbac-approve");
    const createRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Snapshot for RBAC test",
        summary: "Snapshot summary for the RBAC approve test case.",
      }),
    });
    const snapId = (await createRes.json()).snapshotId;
    // Analyst has only coordination:read (no approve)
    const res = await fetchWithCookies(analystACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("Observer (read-only) cannot create coordinations → 403", async () => {
    const res = await fetchWithCookies(observerACookies, "/api/v1/reform/coordinations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        countryId,
        title: "Should Not Be Created By Observer",
        description: "This should be rejected because observer has read-only role.",
      }),
    });
    expect(res.status).toBe(403);
  });
});

describeE2E("G03-06 HTTP — NEG-3: Cross-tenant private data isolation", () => {
  it("Tenant B admin cannot GET a coordination owned by Tenant A (no participant relation)", async () => {
    const coordId = await createCoordinationAsAdminA("cross-tenant-isolation");
    const res = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}`);
    // RLS hides the row entirely → 404 (or 403 if any leakage)
    expect([403, 404]).toContain(res.status);
  });

  it("Tenant B admin cannot close a Tenant A coordination → 404 or 403", async () => {
    const coordId = await createCoordinationAsAdminA("cross-tenant-close");
    const res = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closureReason: "Tenant B trying to close Tenant A's coordination." }),
    });
    expect([403, 404]).toContain(res.status);
  });
});

describeE2E("G03-06 HTTP — NEG-4: Draft snapshot not exposed in shared view", () => {
  it("Draft snapshot is NOT visible via shared-view (only approved + non-revoked)", async () => {
    const coordId = await createCoordinationAsAdminA("neg-draft-invisible");
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantBId, role: "contributor" }),
    });
    // Create draft snapshot (do NOT approve)
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Draft Snapshot — Should Be Invisible",
        summary: "Snapshot summary for the draft-invisible test case.",
      }),
    });
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/shared-view`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = (body.sharedSnapshots ?? []).map((s: any) => s.title);
    expect(titles).not.toContain("Draft Snapshot — Should Be Invisible");
  });
});

describeE2E("G03-06 HTTP — NEG-5: Revoked snapshots not exposed in shared view", () => {
  it("Revoked snapshot is NOT visible via shared-view after revocation", async () => {
    const coordId = await createCoordinationAsAdminA("neg-revoked-invisible");
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantBId, role: "contributor" }),
    });
    const createRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Will-Be-Revoked Snapshot",
        summary: "Snapshot that will be revoked then tested for invisibility.",
      }),
    });
    const snapId = (await createRes.json()).snapshotId;
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Verify visible BEFORE revocation
    const beforeRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/shared-view`);
    const beforeBody = await beforeRes.json();
    const beforeIds = beforeBody.sharedSnapshots.map((s: any) => s.id);
    expect(beforeIds).toContain(snapId);

    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Revoking to verify shared-view filtering." }),
    });

    // Verify NOT visible AFTER revocation
    const afterRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/shared-view`);
    const afterBody = await afterRes.json();
    const afterIds = afterBody.sharedSnapshots.map((s: any) => s.id);
    expect(afterIds).not.toContain(snapId);
  });
});

describeE2E("G03-06 HTTP — NEG-6: Invalid approve-plan action returns 400", () => {
  it("action=foobar → 400", async () => {
    const coordId = await createCoordinationAsAdminA("neg-invalid-action");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "foobar" }),
    });
    expect(res.status).toBe(400);
  });
});

describeE2E("G03-06 HTTP — NEG-7: Missing resources return documented error", () => {
  it("GET /coordinations/:nonexistent-id → 404", async () => {
    const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations/nonexistent_id_xyz_123");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("POST /coordinations/:nonexistent-id/participants → 404", async () => {
    const res = await fetchWithCookies(adminACookies, "/api/v1/reform/coordinations/nonexistent_id_xyz_123/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantBId }),
    });
    expect(res.status).toBe(404);
  });
});

describeE2E("G03-06 HTTP — NEG-8: Deferred B3 endpoints absent (no 501 paths leak privileged ops)", () => {
  it("No /coordinations/:id/participants/:partId/remove route exists (404)", async () => {
    const coordId = await createCoordinationAsAdminA("neg-b3-remove");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants/some-part-id/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Attempt to call deferred B3 endpoint." }),
    });
    expect(res.status).toBe(404);
  });

  it("No /coordinations/:id/participants/:partId/verify route exists (404)", async () => {
    const coordId = await createCoordinationAsAdminA("neg-b3-verify");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants/some-part-id/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "document" }),
    });
    expect(res.status).toBe(404);
  });

  it("No /coordinations/:id/participants/:partId/grant-commitment route exists (404)", async () => {
    const coordId = await createCoordinationAsAdminA("neg-b3-grant");
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/participants/some-part-id/grant-commitment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Grant commitment attempt." }),
    });
    expect(res.status).toBe(404);
  });
});

describeE2E("G03-06 HTTP — NEG-9: Invalid or revoked membership cannot bypass authorization", () => {
  it("Suspended user cannot sign in (HTTP 401)", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SUSPENDED),
    });
    expect(res.status).toBe(401);
  });

  it("User with revoked membership cannot list coordinations", async () => {
    // Revoked user can authenticate but has no active membership
    // Retry on 429 (rate limit) — g01 test may have consumed rate budget
    let cookies: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        cookies = await signIn(REVOKED);
        break;
      } catch (e) {
        if (attempt < 2 && e instanceof Error && e.message.includes("429")) {
          await new Promise((r) => setTimeout(r, 30000)); // wait 30s and retry
          continue;
        }
        throw e;
      }
    }
    const meRes = await fetchWithCookies(cookies, "/api/v1/auth/me");
    const me = await meRes.json();
    if (me.authenticated) {
      expect(me.user.membershipStatus).not.toBe("active");
    } else {
      expect(me.authenticated).toBe(false);
    }
    const res = await fetchWithCookies(cookies, "/api/v1/reform/coordinations");
    expect([401, 403]).toContain(res.status);
  });

  it("Reviewer (no coordination:manage) cannot submit plan → 403", async () => {
    const coordId = await createCoordinationAsAdminA("neg-reviewer-submit");
    const res = await fetchWithCookies(reviewerACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    });
    expect(res.status).toBe(403);
  });

  it("Reviewer (no coordination:manage) cannot create coordination → 403", async () => {
    const res = await fetchWithCookies(reviewerACookies, "/api/v1/reform/coordinations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        countryId,
        title: "Reviewer Should Not Create",
        description: "Reviewer lacks coordination:manage permission for this.",
      }),
    });
    expect(res.status).toBe(403);
  });
});

// ============================================================
// Cross-tenant: invitation lifecycle end-to-end
// ============================================================
describeE2E("G03-06 HTTP — CROSS-TENANT: Invitation lifecycle end-to-end", () => {
  it("Tenant A creates invitation → Tenant B accepts → Tenant B sees coordination in shared-view", async () => {
    const coordId = await createCoordinationAsAdminA("e2e-cross-tenant");
    const invRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitedTenantId: tenantBId, invitedRole: "contributor" }),
    });
    expect(invRes.status).toBe(201);
    const invId = (await invRes.json()).invitationId;

    // Tenant B accepts
    const acceptRes = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}/invitations/${invId}/accept`, {
      method: "POST",
    });
    expect([200, 201]).toContain(acceptRes.status);

    // Tenant B can now GET the coordination (it's a participant)
    const getRes = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}`);
    expect(getRes.status).toBe(200);

    // Tenant B can list participants
    const listRes = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}/participants`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(Array.isArray(listBody)).toBe(true);
    expect(listBody.some((p: any) => p.tenantId === tenantBId)).toBe(true);

    // Tenant B can access shared-view
    const svRes = await fetchWithCookies(adminBCookies, `/api/v1/reform/coordinations/${coordId}/shared-view`);
    expect(svRes.status).toBe(200);
  });
});

// ============================================================
// DB persistence + audit log verification
// ============================================================
describeE2E("G03-06 HTTP — DB persistence + audit records", () => {
  it("Each successful state transition produces an audit_log entry", async () => {
    const coordId = await createCoordinationAsAdminA("audit-trail");
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    });
    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", approvalNotes: "Audit trail verification." }),
    });

    // Verify audit entries exist for create + submit + approve
    const audits = await adminDb.auditLog.findMany({
      where: {
        tenantId: tenantAId,
        action: { startsWith: "reform.coordination." },
        details: { path: ["coordinationId"], equals: coordId } as any,
      },
      orderBy: { at: "asc" },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("reform.coordination.created");
    expect(actions).toContain("reform.coordination.plan_submitted");
    expect(actions).toContain("reform.coordination.plan_approved");
  });
});

// ============================================================
// SECURITY FIX: Direct privileged function execution is DENIED
// ------------------------------------------------------------
// Migration 31 dropped the direct-call function
// approve_coordination_shared_snapshot and replaced it with a
// trigger-based pattern. balance_app CANNOT call any privileged
// function directly — the ONLY path is through the RLS-gated INSERT
// on reform_coordination_snapshot_approval_requests.
// ============================================================
describeE2E("G03-06 HTTP — SECURITY: Trust boundary closure (Migration 32)", () => {
  it("approve_coordination_shared_snapshot function does not exist (dropped in M31)", async () => {
    const result = await adminDb.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM pg_proc
        WHERE proname = 'approve_coordination_shared_snapshot'
      ) AS exists
    `;
    expect(result[0]?.exists).toBe(false);
  });

  it("process_snapshot_approval_request function does not exist (dropped in M32)", async () => {
    const result = await adminDb.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM pg_proc
        WHERE proname = 'process_snapshot_approval_request'
      ) AS exists
    `;
    expect(result[0]?.exists).toBe(false);
  });

  it("reform_coordination_snapshot_approval_requests table does not exist (dropped in M32)", async () => {
    const result = await adminDb.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'reform_coordination_snapshot_approval_requests'
      ) AS exists
    `;
    expect(result[0]?.exists).toBe(false);
  });

  it("balance_snapshot_approver LOGIN role exists with column-scoped UPDATE", async () => {
    // Role exists
    const roleResult = await adminDb.$queryRaw<{ exists: boolean; can_login: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'balance_snapshot_approver') AS exists,
             (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'balance_snapshot_approver') AS can_login
    `;
    expect(roleResult[0]?.exists).toBe(true);
    expect(roleResult[0]?.can_login).toBe(true);

    // balance_app is NOT a member of balance_snapshot_approver (cannot SET ROLE)
    const memberResult = await adminDb.$queryRaw<{ is_member: boolean }[]>`
      SELECT pg_has_role('balance_app', 'balance_snapshot_approver', 'member') AS is_member
    `;
    expect(memberResult[0]?.is_member).toBe(false);

    // Column-level UPDATE on shared_snapshots
    const colResult = await adminDb.$queryRaw<{ status: boolean; approved_at: boolean; approved_by: boolean; title: boolean }[]>`
      SELECT
        has_column_privilege('balance_snapshot_approver', 'reform_coordination_shared_snapshots', 'status', 'UPDATE') AS status,
        has_column_privilege('balance_snapshot_approver', 'reform_coordination_shared_snapshots', 'approvedAt', 'UPDATE') AS approved_at,
        has_column_privilege('balance_snapshot_approver', 'reform_coordination_shared_snapshots', 'approvedBy', 'UPDATE') AS approved_by,
        has_column_privilege('balance_snapshot_approver', 'reform_coordination_shared_snapshots', 'title', 'UPDATE') AS title
    `;
    expect(colResult[0]?.status).toBe(true);
    expect(colResult[0]?.approved_at).toBe(true);
    expect(colResult[0]?.approved_by).toBe(true);
    expect(colResult[0]?.title).toBe(false);
  });

  it("legitimate HTTP snapshot approval still works (trigger fires correctly)", async () => {
    const coordId = await createCoordinationAsAdminA("security-fix-approval");

    // Create a draft snapshot
    const createRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Post-Security-Fix Snapshot",
        summary: "Snapshot to verify approval works after Migration 32.",
      }),
    });
    const snapId = (await createRes.json()).snapshotId;

    // Approve via the HTTP API (uses privileged balance_snapshot_approver connection)
    const res = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalNotes: "Approval after security fix." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");

    // Verify the snapshot is approved in the DB
    const snap = await adminDb.reformCoordinationSharedSnapshot.findUnique({ where: { id: snapId } });
    expect(snap!.status).toBe("approved");
    expect(snap!.approvedBy).toBeTruthy();

    // Verify the audit log entry
    const audit = await adminDb.auditLog.findFirst({
      where: {
        action: "reform.coordination.snapshot_approved",
        details: { path: ["snapshotId"], equals: snapId } as any,
      },
      orderBy: { at: "desc" },
    });
    expect(audit).toBeTruthy();
  });

  it("duplicate snapshot approval rejected without duplicate audit entry", async () => {
    const coordId = await createCoordinationAsAdminA("security-fix-duplicate");

    // Create + approve
    const createRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshotType: "custom",
        title: "Duplicate Approval Test",
        summary: "Snapshot to verify duplicate approval is rejected.",
      }),
    });
    const snapId = (await createRes.json()).snapshotId;

    await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Second approval should fail (snapshot no longer draft)
    const secondRes = await fetchWithCookies(adminACookies, `/api/v1/reform/coordinations/${coordId}/snapshots/${snapId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(secondRes.status).toBe(409);

    // Verify only ONE audit entry exists
    const auditCount = await adminDb.auditLog.count({
      where: {
        action: "reform.coordination.snapshot_approved",
        details: { path: ["snapshotId"], equals: snapId } as any,
      },
    });
    expect(auditCount).toBe(1);
  });
});
