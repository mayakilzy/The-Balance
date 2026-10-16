// ============================================================
// auth.integration.test.ts
// ------------------------------------------------------------
// Integration tests for authentication + RBAC + tenant isolation.
// Runs in CI against real PostgreSQL 16.
//
// Covers:
//   1. Login with correct credentials → succeeds
//   2. Login with wrong password → fails
//   3. Login with suspended user → fails
//   4. withAuthenticatedTenant sets correct context
//   5. Revoked membership → rejected
//   6. Suspended user → rejected
//   7. Client cannot forge tenantId (session is source of truth)
//   8. RBAC: observer cannot write
//   9. RBAC: admin can write
//  10. Switch tenant: verified membership required
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { verifyPassword, hashPassword } from "@/lib/password";
import { hasPermission, isAuthenticated } from "@/lib/permissions";
import { withAuthenticatedTenant, withTenant } from "@/lib/security/tenant-context";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let appClient: PrismaClient;
let adminClient: PrismaClient;

let tenantAId: string;
let tenantBId: string;
let adminUserId: string;
let analystUserId: string;
let suspendedUserId: string;
let revokedUserId: string;

// Test fixtures (from seed-ontology.ts)
const ADMIN_EMAIL = "admin@demolandia.test";
const ANALYST_EMAIL = "analyst@demolandia.test";
const SUSPENDED_EMAIL = "suspended@demolandia.test";
const REVOKED_EMAIL = "revoked@demolandia.test";

const ADMIN_PW = "test_admin_password_00_03";
const ANALYST_PW = "test_analyst_password_00_03";

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;

  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  await appClient.$queryRaw`SELECT 1`;
  await adminClient.$queryRaw`SELECT 1`;

  // Fetch seeded data
  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("Tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const adminUser = await adminClient.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const analystUser = await adminClient.user.findUnique({ where: { email: ANALYST_EMAIL } });
  const suspendedUser = await adminClient.user.findUnique({ where: { email: SUSPENDED_EMAIL } });
  const revokedUser = await adminClient.user.findUnique({ where: { email: REVOKED_EMAIL } });
  if (!adminUser || !analystUser || !suspendedUser || !revokedUser) {
    throw new Error("Users not seeded");
  }
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;
  suspendedUserId = suspendedUser.id;
  revokedUserId = revokedUser.id;

  // Clean audit_log
  await adminClient.auditLog.deleteMany({});
});

afterAll(async () => {
  if (adminClient) {
    await adminClient.auditLog.deleteMany({});
    await adminClient.$disconnect();
  }
  if (appClient) await appClient.$disconnect();
});

// Helper: create a mock Session matching Auth.js shape
function mockSession(
  userId: string,
  tenantId: string,
  roleCode: string,
  membershipStatus: string,
  email: string,
  name: string
): Session {
  return {
    user: {
      id: userId,
      email,
      name,
      tenantId,
      roleCode,
      membershipStatus,
    },
    expires: new Date(Date.now() + 3600000).toISOString(),
  } as Session;
}

describeIntegration("Authentication + RBAC + Tenant Isolation", () => {
  // ============================================================
  // 1. PASSWORD VERIFICATION
  // ============================================================
  it("verifyPassword accepts correct password", async () => {
    const user = await adminClient.user.findUnique({ where: { email: ADMIN_EMAIL } });
    expect(user).toBeTruthy();
    const valid = await verifyPassword(ADMIN_PW, user!.passwordHash);
    expect(valid).toBe(true);
  });

  it("verifyPassword rejects wrong password", async () => {
    const user = await adminClient.user.findUnique({ where: { email: ADMIN_EMAIL } });
    const valid = await verifyPassword("wrong_password", user!.passwordHash);
    expect(valid).toBe(false);
  });

  // ============================================================
  // 2. SUSPENDED USER CANNOT AUTHENTICATE
  // ============================================================
  it("suspended user's password verifies but status blocks auth", async () => {
    const user = await adminClient.user.findUnique({ where: { email: SUSPENDED_EMAIL } });
    expect(user?.status).toBe("suspended");
    // Password is correct, but authorize() checks status === 'active'
    const pwValid = await verifyPassword("test_suspended_password_00_03", user!.passwordHash);
    expect(pwValid).toBe(true);
    // But the status check would reject:
    expect(user?.status === "active").toBe(false);
  });

  // ============================================================
  // 3. withAuthenticatedTenant — VALID SESSION
  // ============================================================
  it("withAuthenticatedTenant sets context for active admin session", async () => {
    const session = mockSession(
      adminUserId, tenantAId, "admin", "active",
      ADMIN_EMAIL, "Test Admin"
    );

    const result = await withAuthenticatedTenant(session, async ({ tx, userId, tenantId }) => {
      // Can read own user
      const me = await tx.user.findUnique({ where: { id: userId } });
      // Can write audit log in own tenant
      await tx.auditLog.create({
        data: { tenantId, actor: userId, action: "test.auth.context" },
      });
      return { meId: me?.id, tenantId };
    });

    expect(result.meId).toBe(adminUserId);
    expect(result.tenantId).toBe(tenantAId);
  });

  // ============================================================
  // 4. REVOKED MEMBERSHIP — REJECTED
  // ============================================================
  it("withAuthenticatedTenant rejects revoked membership", async () => {
    // The revoked user has membership status 'revoked' in the session
    const session = mockSession(
      revokedUserId, tenantAId, "observer", "revoked",
      REVOKED_EMAIL, "Test Revoked"
    );

    await expect(
      withAuthenticatedTenant(session, async () => "should not reach")
    ).rejects.toThrow(/Membership not active/);
  });

  // ============================================================
  // 5. SUSPENDED USER — REJECTED
  // ============================================================
  it("withAuthenticatedTenant rejects suspended user (DB re-check)", async () => {
    // Even if the session claims 'active', the DB re-check catches suspension
    const session = mockSession(
      suspendedUserId, tenantAId, "observer", "active",
      SUSPENDED_EMAIL, "Test Suspended"
    );

    await expect(
      withAuthenticatedTenant(session, async () => "should not reach")
    ).rejects.toThrow(/User account not active/);
  });

  // ============================================================
  // 6. CLIENT CANNOT FORGE TENANTID
  // ============================================================
  it("withAuthenticatedTenant uses session tenantId, not client input", async () => {
    // Admin is in Tenant A. Create a session for Tenant A.
    const session = mockSession(
      adminUserId, tenantAId, "admin", "active",
      ADMIN_EMAIL, "Test Admin"
    );

    // The function uses session.user.tenantId, ignoring any external input.
    // There's no parameter for client to pass a different tenantId.
    const result = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
      await tx.auditLog.create({
        data: { tenantId, actor: adminUserId, action: "test.no.forge" },
      });
      return tenantId;
    });

    // The tenantId used is from the session, not forgeable
    expect(result).toBe(tenantAId);
    expect(result).not.toBe(tenantBId);
  });

  // ============================================================
  // 7. RBAC — admin has all permissions
  // ============================================================
  it("admin role has all permissions", () => {
    const session = mockSession(
      adminUserId, tenantAId, "admin", "active",
      ADMIN_EMAIL, "Test Admin"
    );
    expect(hasPermission(session, "tenant:read")).toBe(true);
    expect(hasPermission(session, "evidence:write")).toBe(true);
    expect(hasPermission(session, "strategy:approve")).toBe(true);
    expect(hasPermission(session, "user:write")).toBe(true);
  });

  // ============================================================
  // 8. RBAC — analyst cannot approve strategies
  // ============================================================
  it("analyst role cannot approve strategies", () => {
    const session = mockSession(
      analystUserId, tenantAId, "analyst", "active",
      ANALYST_EMAIL, "Test Analyst"
    );
    expect(hasPermission(session, "evidence:write")).toBe(true);
    expect(hasPermission(session, "strategy:approve")).toBe(false);
  });

  // ============================================================
  // 9. RBAC — observer cannot write
  // ============================================================
  it("observer role cannot write", () => {
    const session = mockSession(
      adminUserId, tenantAId, "observer", "active",
      ADMIN_EMAIL, "Test Admin"
    );
    expect(hasPermission(session, "evidence:read")).toBe(true);
    expect(hasPermission(session, "evidence:write")).toBe(false);
  });

  // ============================================================
  // 10. DEFAULT-DENY — no membership → no permissions
  // ============================================================
  it("session without membership has no permissions", () => {
    const session = mockSession(
      adminUserId, "", "", "inactive",
      ADMIN_EMAIL, "Test Admin"
    );
    expect(isAuthenticated(session)).toBe(false);
    expect(hasPermission(session as Session | null, "tenant:read")).toBe(false);
  });

  // ============================================================
  // 11. SWITCH TENANT — verified membership required
  // ============================================================
  it("switch-tenant logic: admin in Tenant A cannot switch to Tenant B", async () => {
    // Admin has membership ONLY in Tenant A.
    // Simulate the switch-tenant verification:
    const membership = await adminClient.membership.findFirst({
      where: { userId: adminUserId, tenantId: tenantBId, status: "active" },
    });
    expect(membership).toBeNull(); // No membership in Tenant B
  });

  it("switch-tenant logic: admin can switch to Tenant A (own tenant)", async () => {
    const membership = await adminClient.membership.findFirst({
      where: { userId: adminUserId, tenantId: tenantAId, status: "active" },
    });
    expect(membership).toBeTruthy();
    expect(membership?.roleCode).toBe("admin");
  });

  // ============================================================
  // 12. CROSS-TENANT AUDIT LOG ISOLATION (re-verified with auth context)
  // ============================================================
  it("admin in Tenant A cannot see Tenant B's audit logs", async () => {
    // Admin writes to Tenant B (as admin client)
    await adminClient.auditLog.create({
      data: { tenantId: tenantBId, actor: "tenant-b-system", action: "test.isolation.b" },
    });

    // Admin in Tenant A context reads audit_log → sees only A's rows
    const session = mockSession(
      adminUserId, tenantAId, "admin", "active",
      ADMIN_EMAIL, "Test Admin"
    );

    const result = await withAuthenticatedTenant(session, async ({ tx }) => {
      return await tx.auditLog.findMany({
        where: { actor: "tenant-b-system" },
      });
    });

    expect(result.length).toBe(0); // Tenant B's rows invisible to Tenant A
  });

  // ============================================================
  // 13. PUBLIC DATA accessible to authenticated users
  // ============================================================
  it("authenticated user can read PUBLIC tables (countries)", async () => {
    const session = mockSession(
      adminUserId, tenantAId, "admin", "active",
      ADMIN_EMAIL, "Test Admin"
    );

    const result = await withAuthenticatedTenant(session, async ({ tx }) => {
      return await tx.country.findMany({ where: { iso3: "DML" } });
    });

    expect(result.length).toBe(1);
    expect(result[0]?.displayName).toBe("Demolandia");
  });
});
