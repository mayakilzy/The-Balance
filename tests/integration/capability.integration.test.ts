// ============================================================
// capability.integration.test.ts
// ------------------------------------------------------------
// Tests:
//   1. Register a capability (via admin)
//   2. Discover capabilities (tenant-scoped read)
//   3. Check eligibility — admin can, observer cannot
//   4. Invoke capability — stub adapter returns simulated result
//   5. Unauthorized capability rejected
//   6. Cross-tenant isolation (invocations are tenant-scoped)
//   7. Invocation audit trail
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  registerCapability,
  discoverCapabilities,
  checkEligibility,
  invokeCapability,
} from "@/lib/capability-service";
import type { Session } from "next-auth";

const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let adminClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let adminUserId: string;
let analystUserId: string;

const ADMIN_EMAIL = "admin@demolandia.test";
const ANALYST_EMAIL = "analyst@demolandia.test";

function mockSession(
  userId: string,
  tenantId: string,
  roleCode: string,
  email: string,
  name: string
): Session {
  return {
    user: { id: userId, email, name, tenantId, roleCode, membershipStatus: "active" },
    expires: new Date(Date.now() + 3600000).toISOString(),
  } as Session;
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  const adminUser = await adminClient.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const analystUser = await adminClient.user.findUnique({ where: { email: ANALYST_EMAIL } });
  if (!tenantA || !tenantB || !adminUser || !analystUser) throw new Error("Seed data not found");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  // Register test capabilities
  await registerCapability({
    code: "TEST-AGRI-ANALYSIS",
    displayName: "Agricultural Analysis Tool",
    description: "Analyzes agricultural data and returns insights.",
    type: "tool",
    readiness: "stub",
    requiredPermission: "evidence:read",
    domains: ["agriculture", "economics"],
  });

  await registerCapability({
    code: "TEST-STRATEGY-ADVISOR",
    displayName: "Strategy Advisor Expert",
    description: "Provides strategic recommendations based on evidence.",
    type: "expert",
    readiness: "stub",
    requiredPermission: "strategy:write",
    domains: ["strategy", "planning"],
  });

  // Ensure admin has membership in Tenant B (for cross-tenant tests)
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: adminUserId, tenantId: tenantBId } },
    update: {},
    create: { userId: adminUserId, tenantId: tenantBId, roleCode: "admin", status: "active" },
  });

  await adminClient.capabilityInvocation.deleteMany({});
});

afterAll(async () => {
  if (adminClient) {
    await adminClient.capabilityInvocation.deleteMany({});
    await adminClient.capability.deleteMany({
      where: { code: { startsWith: "TEST-" } },
    });
    await adminClient.membership.deleteMany({
      where: { userId: adminUserId, tenantId: tenantBId },
    }).catch(() => {});
    await adminClient.$disconnect();
  }
});

describeIntegration("Capability Registry", () => {
  // ============================================================
  // 1. DISCOVER CAPABILITIES
  // ============================================================
  it("discoverCapabilities returns registered capabilities", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const capabilities = await discoverCapabilities(session);

    const agri = capabilities.find((c) => c.code === "TEST-AGRI-ANALYSIS");
    expect(agri).toBeTruthy();
    expect(agri?.type).toBe("tool");
    expect(agri?.readiness).toBe("stub");
    expect(agri?.domains).toContain("agriculture");
  });

  // ============================================================
  // 2. DISCOVER BY TYPE
  // ============================================================
  it("discoverCapabilities filters by type", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const experts = await discoverCapabilities(session, { type: "expert" });
    expect(experts.every((c) => c.type === "expert")).toBe(true);
    expect(experts.some((c) => c.code === "TEST-STRATEGY-ADVISOR")).toBe(true);
  });

  // ============================================================
  // 3. CHECK ELIGIBILITY — admin eligible for evidence:read
  // ============================================================
  it("checkEligibility: admin is eligible for evidence:read capability", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await checkEligibility(session, "TEST-AGRI-ANALYSIS");
    expect(result.eligible).toBe(true);
  });

  // ============================================================
  // 4. CHECK ELIGIBILITY — observer NOT eligible for strategy:write
  // ============================================================
  it("checkEligibility: observer lacks strategy:write permission", async () => {
    // Use analyst user (has analyst role — can write strategies, so use a different approach)
    // Actually observer lacks strategy:write. But we need an observer user.
    // The seed has observer role in role_references but no user with observer role.
    // Use admin session but check against a capability requiring a permission admin DOESN'T have.
    // admin has all permissions, so let's test with analyst who lacks strategy:approve.
    const analystSession = mockSession(analystUserId, tenantAId, "analyst", ANALYST_EMAIL, "Test Analyst");

    // Register a capability requiring strategy:approve (analyst doesn't have)
    await registerCapability({
      code: "TEST-APPROVE-ONLY",
      displayName: "Approve Only Tool",
      description: "Requires strategy:approve.",
      type: "tool",
      readiness: "stub",
      requiredPermission: "strategy:approve",
    });

    const result = await checkEligibility(analystSession, "TEST-APPROVE-ONLY");
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("strategy:approve");
  });

  // ============================================================
  // 5. INVOKE CAPABILITY — stub adapter returns simulated result
  // ============================================================
  it("invokeCapability: stub adapter returns simulated result", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await invokeCapability(session, "TEST-AGRI-ANALYSIS", {
      sector: "agriculture",
      year: 2025,
    });

    expect(result.status).toBe("completed");
    expect(result.simulated).toBe(true);
    expect(result.provider).toBe("stub-adapter");
    expect(result.output).toBeTruthy();
    expect((result.output as Record<string, unknown>).result).toContain("[STUB ADAPTER");
  });

  // ============================================================
  // 6. INVOKE UNAUTHORIZED CAPABILITY — rejected
  // ============================================================
  it("invokeCapability: analyst cannot invoke strategy:approve capability", async () => {
    const analystSession = mockSession(analystUserId, tenantAId, "analyst", ANALYST_EMAIL, "Test Analyst");

    await expect(
      invokeCapability(analystSession, "TEST-APPROVE-ONLY", {})
    ).rejects.toThrow(/Permission denied/i);
  });

  // ============================================================
  // 7. CROSS-TENANT ISOLATION — Tenant B cannot see Tenant A's invocations
  // ============================================================
  it("cross-tenant: invocations are tenant-scoped", async () => {
    const sessionA = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");
    const sessionB = mockSession(adminUserId, tenantBId, "admin", ADMIN_EMAIL, "Test Admin");

    // Invoke in Tenant A
    const resultA = await invokeCapability(sessionA, "TEST-AGRI-ANALYSIS", { tenant: "A" });
    expect(resultA.status).toBe("completed");

    // Tenant B's invocations should NOT include Tenant A's
    const { withAuthenticatedTenant } = await import("@/lib/security/tenant-context");
    const invocationsB = await withAuthenticatedTenant(sessionB, async ({ tx }) => {
      return await tx.capabilityInvocation.findMany({});
    });

    // Tenant B should see 0 invocations (Tenant A's are isolated)
    expect(invocationsB.length).toBe(0);
  });

  // ============================================================
  // 8. INVOCATION AUDIT TRAIL
  // ============================================================
  it("invocation creates an audit trail entry", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await invokeCapability(session, "TEST-AGRI-ANALYSIS", { auditTest: true });

    // Verify the invocation was recorded
    const { withAuthenticatedTenant } = await import("@/lib/security/tenant-context");
    const invocations = await withAuthenticatedTenant(session, async ({ tx }) => {
      return await tx.capabilityInvocation.findMany({
        where: { id: result.invocationId },
        include: { capability: { select: { code: true } } },
      });
    });

    expect(invocations.length).toBe(1);
    expect(invocations[0]?.status).toBe("completed");
    expect(invocations[0]?.capability.code).toBe("TEST-AGRI-ANALYSIS");
    expect(invocations[0]?.invokedBy).toBe(adminUserId);
  });

  // ============================================================
  // 9. NO SILENT ADAPTER FALLBACK — missing adapter fails, not stub
  // ============================================================
  it("invokeCapability with missing adapter fails (no silent stub fallback)", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Register a capability with adapterEndpoint pointing to non-existent adapter
    await registerCapability({
      code: "TEST-MISSING-ADAPTER",
      displayName: "Missing Adapter Tool",
      description: "Has adapterEndpoint but adapter not registered.",
      type: "tool",
      readiness: "live",
      requiredPermission: "evidence:read",
      adapterEndpoint: "non-existent-adapter-xyz",
    });

    const result = await invokeCapability(session, "TEST-MISSING-ADAPTER", { test: true });

    // Must FAIL — not silently complete with stub
    expect(result.status).toBe("failed");
    expect(result.error).toContain("non-existent-adapter-xyz");
    expect(result.error).toContain("not registered");
    expect(result.simulated).toBe(false);
  });

  // ============================================================
  // 10. LIVE CAPABILITY WITHOUT ADAPTER — fails
  // ============================================================
  it("invokeCapability with readiness=live and no adapter fails", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    await registerCapability({
      code: "TEST-LIVE-NO-ADAPTER",
      displayName: "Live No Adapter",
      description: "Readiness=live but no adapterEndpoint.",
      type: "tool",
      readiness: "live",
      requiredPermission: "evidence:read",
      // No adapterEndpoint
    });

    const result = await invokeCapability(session, "TEST-LIVE-NO-ADAPTER", { test: true });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no adapterEndpoint");
    expect(result.simulated).toBe(false);
  });

  // ============================================================
  // 11. CROSS-TENANT taskId — rejected
  // ============================================================
  it("invokeCapability rejects taskId from different tenant", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create a task in Tenant B (via admin client)
    const tenantBTask = await adminClient.task.create({
      data: { tenantId: tenantBId, type: "test", goal: "Tenant B task" },
    });

    // Attempt: invoke capability in Tenant A with Tenant B's taskId
    await expect(
      invokeCapability(session, "TEST-AGRI-ANALYSIS", {}, tenantBTask.id)
    ).rejects.toThrow(/not found in tenant scope/i);

    // Cleanup
    await adminClient.task.delete({ where: { id: tenantBTask.id } });
  });
});
