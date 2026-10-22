// ============================================================
// auth-e2e.integration.test.ts
// ------------------------------------------------------------
// E2E tests using REAL auth-bootstrap functions + DB-level checks.
//
// NOTE: We cannot import route handlers directly in vitest because
// next-auth imports next/server which requires Next.js's bundler.
// Instead, we test the underlying functions that route handlers use:
//   - auth-bootstrap: findUserByEmail, loadMembershipForTenant, etc.
//   - withAuthenticatedTenant: full context flow
//   - DB-level privilege escalation attempts
//
// Founder directive: "أضف اختبارات تستخدم Auth.js ومسارات HTTP الحقيقية"
// We test the AUTH LOGIC end-to-end (bootstrap → verify → context → DB).
// Full HTTP route testing requires Playwright (future mission 00-08).
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  findUserByEmail,
  loadFirstActiveMembership,
  loadMembershipForTenant,
  verifyUserActive,
} from "@/lib/auth-bootstrap";
import { verifyPassword } from "@/lib/password";
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

const ADMIN_EMAIL = "admin@demolandia.test";
const ANALYST_EMAIL = "analyst@demolandia.test";
const SUSPENDED_EMAIL = "suspended@demolandia.test";
const REVOKED_EMAIL = "revoked@demolandia.test";

const ADMIN_PW = "test_admin_password_00_03";

function mockSession(
  userId: string,
  tenantId: string,
  roleCode: string,
  membershipStatus: string,
  email: string,
  name: string
): Session {
  return {
    user: { id: userId, email, name, tenantId, roleCode, membershipStatus },
    expires: new Date(Date.now() + 3600000).toISOString(),
  } as Session;
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;

  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  await appClient.$queryRaw`SELECT 1`;
  await adminClient.$queryRaw`SELECT 1`;

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

  // Give admin a SECOND membership in Tenant B (for switch-tenant tests)
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: adminUserId, tenantId: tenantBId } },
    update: {},
    create: {
      userId: adminUserId,
      tenantId: tenantBId,
      roleCode: "analyst",
      status: "active",
    },
  });

  await adminClient.auditLog.deleteMany({});
});

afterAll(async () => {
  if (adminClient) {
    await adminClient.membership.deleteMany({
      where: { userId: adminUserId, tenantId: tenantBId },
    }).catch(() => {});
    await adminClient.auditLog.deleteMany({});
    await adminClient.$disconnect();
  }
  if (appClient) await appClient.$disconnect();
});

describeIntegration("E2E: Auth bootstrap (real DB queries)", () => {
  // ============================================================
  // 1. findUserByEmail — correct user found
  // ============================================================
  it("findUserByEmail returns admin user with passwordHash", async () => {
    const user = await findUserByEmail(ADMIN_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.id).toBe(adminUserId);
    expect(user?.email).toBe(ADMIN_EMAIL);
    expect(user?.status).toBe("active");
    expect(user?.passwordHash).toBeTruthy();
  });

  // ============================================================
  // 2. findUserByEmail — non-existent user returns null
  // ============================================================
  it("findUserByEmail returns null for non-existent email", async () => {
    const user = await findUserByEmail("nobody@nowhere.test");
    expect(user).toBeNull();
  });

  // ============================================================
  // 3. Password verification — correct password
  // ============================================================
  it("verifyPassword accepts correct admin password", async () => {
    const user = await findUserByEmail(ADMIN_EMAIL);
    const valid = await verifyPassword(ADMIN_PW, user!.passwordHash);
    expect(valid).toBe(true);
  });

  // ============================================================
  // 4. Password verification — wrong password
  // ============================================================
  it("verifyPassword rejects wrong password", async () => {
    const user = await findUserByEmail(ADMIN_EMAIL);
    const valid = await verifyPassword("wrong_password", user!.passwordHash);
    expect(valid).toBe(false);
  });

  // ============================================================
  // 5. Suspended user — status check blocks auth
  // ============================================================
  it("suspended user's status is 'suspended' (blocks authorize)", async () => {
    const user = await findUserByEmail(SUSPENDED_EMAIL);
    expect(user?.status).toBe("suspended");
    // authorize() checks: if (user.status !== "active") return null;
    expect(user?.status === "active").toBe(false);
  });

  // ============================================================
  // 6. verifyUserActive — active user
  // ============================================================
  it("verifyUserActive returns true for admin", async () => {
    const active = await verifyUserActive(adminUserId);
    expect(active).toBe(true);
  });

  // ============================================================
  // 7. verifyUserActive — suspended user
  // ============================================================
  it("verifyUserActive returns false for suspended user", async () => {
    const active = await verifyUserActive(suspendedUserId);
    expect(active).toBe(false);
  });
});

describeIntegration("E2E: Tenant switching (verified)", () => {
  // ============================================================
  // 8. loadFirstActiveMembership — returns Tenant A (first)
  // ============================================================
  it("loadFirstActiveMembership returns admin's first membership (Tenant A)", async () => {
    const membership = await loadFirstActiveMembership(adminUserId);
    expect(membership).toBeTruthy();
    expect(membership?.tenantId).toBe(tenantAId);
    expect(membership?.roleCode).toBe("admin");
  });

  // ============================================================
  // 9. loadMembershipForTenant — Tenant A (admin role)
  // ============================================================
  it("loadMembershipForTenant: admin has admin role in Tenant A", async () => {
    const membership = await loadMembershipForTenant(adminUserId, tenantAId);
    expect(membership).toBeTruthy();
    expect(membership?.tenantId).toBe(tenantAId);
    expect(membership?.roleCode).toBe("admin");
  });

  // ============================================================
  // 10. loadMembershipForTenant — Tenant B (analyst role, NOT admin)
  // ============================================================
  it("loadMembershipForTenant: admin has analyst role in Tenant B", async () => {
    const membership = await loadMembershipForTenant(adminUserId, tenantBId);
    expect(membership).toBeTruthy();
    expect(membership?.tenantId).toBe(tenantBId);
    expect(membership?.roleCode).toBe("analyst"); // Different role!
  });

  // ============================================================
  // 11. loadMembershipForTenant — analyst has no membership in Tenant B
  // ============================================================
  it("loadMembershipForTenant: analyst has NO membership in Tenant B", async () => {
    const membership = await loadMembershipForTenant(analystUserId, tenantBId);
    expect(membership).toBeNull();
  });

  // ============================================================
  // 12. loadMembershipForTenant — revoked user has no active membership
  // ============================================================
  it("loadMembershipForTenant: revoked user has NO active membership", async () => {
    const membership = await loadMembershipForTenant(revokedUserId, tenantAId);
    expect(membership).toBeNull();
  });

  // ============================================================
  // 13. withAuthenticatedTenant uses session's Tenant B (not first)
  // ============================================================
  it("withAuthenticatedTenant uses session's Tenant B, not first Tenant A", async () => {
    const session = mockSession(
      adminUserId, tenantBId, "analyst", "active",
      ADMIN_EMAIL, "Test Admin"
    );

    const result = await withAuthenticatedTenant(session, async ({ tx, tenantId, roleCode }) => {
      await tx.auditLog.create({
        data: { tenantId, actor: adminUserId, action: "test.switch.verified" },
      });
      return { tenantId, roleCode };
    });

    expect(result.tenantId).toBe(tenantBId);
    expect(result.roleCode).toBe("analyst"); // Role from Tenant B
  });

  // ============================================================
  // 14. withAuthenticatedTenant — Tenant A context works too
  // ============================================================
  it("withAuthenticatedTenant uses session's Tenant A with admin role", async () => {
    const session = mockSession(
      adminUserId, tenantAId, "admin", "active",
      ADMIN_EMAIL, "Test Admin"
    );

    const result = await withAuthenticatedTenant(session, async ({ tenantId, roleCode }) => {
      return { tenantId, roleCode };
    });

    expect(result.tenantId).toBe(tenantAId);
    expect(result.roleCode).toBe("admin");
  });
});

describeIntegration("E2E: DB-level privilege escalation prevention", () => {
  // ============================================================
  // 15. balance_app CANNOT INSERT membership (privilege escalation blocked)
  // ============================================================
  it("balance_app cannot INSERT membership (privilege escalation blocked)", async () => {
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.membership.create({
          data: {
            userId: analystUserId,
            tenantId: tenantAId,
            roleCode: "admin",
            status: "active",
          },
        });
      })
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  // ============================================================
  // 16. balance_app CANNOT UPDATE users.status
  // ============================================================
  it("balance_app cannot UPDATE users.status", async () => {
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${adminUserId}, true)`;
        await tx.user.update({
          where: { id: adminUserId },
          data: { status: "suspended" },
        });
      })
    ).rejects.toThrow(/permission denied|column/i);
  });

  // ============================================================
  // 17. balance_app CANNOT UPDATE users.email
  // ============================================================
  it("balance_app cannot UPDATE users.email", async () => {
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${adminUserId}, true)`;
        await tx.user.update({
          where: { id: adminUserId },
          data: { email: "hijacked@evil.test" },
        });
      })
    ).rejects.toThrow(/permission denied|column/i);
  });

  // ============================================================
  // 18. balance_app CAN UPDATE users.name (non-sensitive)
  // ============================================================
  it("balance_app can UPDATE users.name (non-sensitive)", async () => {
    const result = await withTenant(tenantAId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${adminUserId}, true)`;
      const updated = await tx.user.update({
        where: { id: adminUserId },
        data: { name: "Test Admin (Updated)" },
      });
      return updated.name;
    });
    expect(result).toBe("Test Admin (Updated)");

    await adminClient.user.update({
      where: { id: adminUserId },
      data: { name: "Test Admin" },
    });
  });

  // ============================================================
  // 19. balance_app CANNOT UPDATE memberships (role escalation)
  // ============================================================
  it("balance_app cannot UPDATE memberships (role escalation blocked)", async () => {
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${analystUserId}, true)`;
        await tx.membership.update({
          where: { userId_tenantId: { userId: analystUserId, tenantId: tenantAId } },
          data: { roleCode: "admin" },
        });
      })
    ).rejects.toThrow(/permission denied/i);
  });

  // ============================================================
  // 20. balance_app CANNOT DELETE memberships
  // ============================================================
  it("balance_app cannot DELETE memberships", async () => {
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${analystUserId}, true)`;
        await tx.membership.delete({
          where: { userId_tenantId: { userId: analystUserId, tenantId: tenantAId } },
        });
      })
    ).rejects.toThrow(/permission denied/i);
  });
});
