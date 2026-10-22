// ============================================================
// http-auth.e2e.test.ts — REAL HTTP authentication acceptance test
// ------------------------------------------------------------
// Founder directive (00-03 final runtime acceptance):
//   "شغّل خادم Next.js فعلياً مع PostgreSQL في CI، ونفذ اختباراً
//    يحافظ على Cookies عبر طلبات حقيقية"
//
// This test starts a REAL Next.js server, makes HTTP requests with
// cookie persistence, and proves the full authentication journey:
//   1. Login with correct credentials → 200
//   2. Login with wrong password → 401
//   3. GET /api/v1/auth/me → 200, verify tenantId + roleCode
//   4. Switch tenant A → B → verify session actually changed
//   5. Switch to non-member tenant → 403
//   6. Logout → 200
//   7. GET /api/v1/auth/me after logout → 401
//   8. Current membership authorization: change role in DB, verify
//      next request uses CURRENT role (not stale JWT)
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const RUN_E2E = process.env.RUN_E2E_HTTP_TESTS === "1" && process.env.SKIP_E2E_SERVER !== "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

const BASE_URL = "http://localhost:3001";
const DIRECT_URL = process.env.DIRECT_URL ?? "";

let serverProcess: ChildProcess | null = null;
let adminDb: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let adminUserId: string;

const ADMIN_EMAIL = "admin@demolandia.test";
const ADMIN_PW = "test_admin_password_00_03";

// Cookie jar (simple implementation)
let cookies: string[] = [];

async function fetchWithCookies(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (cookies.length > 0) {
    headers.set("Cookie", cookies.join("; "));
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
  // Capture Set-Cookie headers
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    const cookiePart = cookie.split(";")[0];
    if (cookiePart) {
      const [name] = cookiePart.split("=");
      cookies = cookies.filter((c) => !c.startsWith(`${name}=`));
      cookies.push(cookiePart);
    }
  }
  return response;
}

async function waitForServer(timeoutMs = 60000): Promise<void> {
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

beforeAll(async () => {
  if (!RUN_E2E) return;

  adminDb = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  const tenantA = await adminDb.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminDb.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  const adminUser = await adminDb.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!tenantA || !tenantB || !adminUser) {
    throw new Error("Seed data not found");
  }
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  adminUserId = adminUser.id;

  // Ensure admin has membership in Tenant B (for switch test)
  await adminDb.membership.upsert({
    where: { userId_tenantId: { userId: adminUserId, tenantId: tenantBId } },
    update: {},
    create: {
      userId: adminUserId,
      tenantId: tenantBId,
      roleCode: "analyst",
      status: "active",
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
      detached: false,
    }
  );

  serverProcess.stdout?.on("data", (data) => {
    const text = data.toString();
    if (process.env.E2E_DEBUG) process.stdout.write("[server] " + text);
  });
  serverProcess.stderr?.on("data", (data) => {
    const text = data.toString();
    if (process.env.E2E_DEBUG) process.stderr.write("[server error] " + text);
  });

  await waitForServer();
}, 120000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  if (adminDb) {
    await adminDb.membership.deleteMany({
      where: { userId: adminUserId, tenantId: tenantBId },
    }).catch(() => {});
    await adminDb.$disconnect();
  }
});

describeE2E("HTTP Authentication Acceptance (real Next.js + cookies)", () => {
  it("POST /api/v1/auth/signin with correct credentials → 200", async () => {
    cookies = [];
    const response = await fetchWithCookies("/api/v1/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(cookies.length).toBeGreaterThan(0);
  }, 30000);

  it("POST /api/v1/auth/signin with wrong password → 401", async () => {
    const savedCookies = [...cookies];
    cookies = [];
    const response = await fetchWithCookies("/api/v1/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong_password" }),
    });
    expect(response.status).toBe(401);
    cookies = savedCookies;
  }, 30000);

  it("GET /api/v1/auth/me with session → 200, verify tenantId=A + role=admin", async () => {
    const response = await fetchWithCookies("/api/v1/auth/me");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.user.tenantId).toBe(tenantAId);
    expect(body.user.roleCode).toBe("admin");
    expect(body.user.membershipStatus).toBe("active");
  }, 30000);

  it("POST /api/v1/auth/switch-tenant {tenantB} → 200, session switches", async () => {
    const response = await fetchWithCookies("/api/v1/auth/switch-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantBId }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe(tenantBId);
    expect(body.roleCode).toBe("analyst");
  }, 30000);

  it("GET /api/v1/auth/me after switch → tenantId=B + role=analyst", async () => {
    const response = await fetchWithCookies("/api/v1/auth/me");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.tenantId).toBe(tenantBId);
    expect(body.user.roleCode).toBe("analyst");
  }, 30000);

  it("POST /api/v1/auth/switch-tenant with fake tenantId → 403", async () => {
    const response = await fetchWithCookies("/api/v1/auth/switch-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "nonexistent-tenant-id" }),
    });
    expect(response.status).toBe(403);
  }, 30000);

  it("POST /api/v1/auth/switch-tenant {tenantA} → 200, back to admin", async () => {
    const response = await fetchWithCookies("/api/v1/auth/switch-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenantAId }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenantId).toBe(tenantAId);
    expect(body.roleCode).toBe("admin");
  }, 30000);

  it("withAuthenticatedTenant uses CURRENT DB role, not stale JWT", async () => {
    await adminDb.membership.update({
      where: { userId_tenantId: { userId: adminUserId, tenantId: tenantAId } },
      data: { roleCode: "observer" },
    });

    try {
      const { withAuthenticatedTenant } = await import("@/lib/security/tenant-context");
      const staleSession = {
        user: {
          id: adminUserId,
          email: ADMIN_EMAIL,
          name: "Test Admin",
          tenantId: tenantAId,
          roleCode: "admin",
          membershipStatus: "active",
        },
        expires: new Date(Date.now() + 3600000).toISOString(),
      };

      const result = await withAuthenticatedTenant(staleSession as any, async ({ roleCode }) => {
        return { roleCode };
      });

      expect(result.roleCode).toBe("observer");
      expect(result.roleCode).not.toBe("admin");
    } finally {
      await adminDb.membership.update({
        where: { userId_tenantId: { userId: adminUserId, tenantId: tenantAId } },
        data: { roleCode: "admin" },
      });
    }
  }, 30000);

  it("POST /api/v1/auth/signout → 200", async () => {
    const response = await fetchWithCookies("/api/v1/auth/signout", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  }, 30000);

  it("GET /api/v1/auth/me after logout → 401", async () => {
    const response = await fetchWithCookies("/api/v1/auth/me");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.authenticated).toBe(false);
  }, 30000);
});
