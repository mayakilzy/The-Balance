// ============================================================
// task.integration.test.ts — Durable Task Runtime tests
// ------------------------------------------------------------
// Tests:
//   1. Create → claim → execute → complete cycle
//   2. Concurrent claim: two workers, only one gets task
//   3. Idempotency: same key → same task, no duplicate
//   4. Crash + resume: lease expires → task reclaimed
//   5. Cross-tenant isolation (RLS)
//   6. Task events audit trail (append-only)
//   7. Balance Master stub: executeNextTask full cycle
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createTask,
  claimTask,
  startTask,
  updateProgress,
  completeTask,
  failTask,
  renewLease,
  reclaimStaleTasks,
  getTask,
} from "@/lib/task-service";
import { executeNextTask } from "@/lib/balance-master";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let adminClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let adminUserId: string;

const ADMIN_EMAIL = "admin@demolandia.test";

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
  if (!tenantA || !tenantB || !adminUser) throw new Error("Seed data not found");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  adminUserId = adminUser.id;

  // Ensure admin has membership in Tenant B (for cross-tenant tests)
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: adminUserId, tenantId: tenantBId } },
    update: {},
    create: { userId: adminUserId, tenantId: tenantBId, roleCode: "admin", status: "active" },
  });

  await adminClient.taskEvent.deleteMany({});
  await adminClient.task.deleteMany({});
});

afterAll(async () => {
  if (adminClient) {
    await adminClient.taskEvent.deleteMany({});
    await adminClient.task.deleteMany({});
    // Clean up Tenant B membership (added in beforeAll)
    await adminClient.membership.deleteMany({
      where: { userId: adminUserId, tenantId: tenantBId },
    }).catch(() => {});
    await adminClient.$disconnect();
  }
});

describeIntegration("Durable Task Runtime", () => {
  // ============================================================
  // 1. CREATE → CLAIM → EXECUTE → COMPLETE
  // ============================================================
  it("full cycle: create → claim → start → progress → complete", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create
    const createResult = await createTask(session, {
      type: "analysis",
      goal: "Analyze agricultural data for Demolandia.",
      input: { sector: "agriculture" },
    });
    expect(createResult.created).toBe(true);
    expect(createResult.taskId).toBeTruthy();

    // Claim
    const claimed = await claimTask(session, "worker-1", 60_000);
    expect(claimed).toBeTruthy();
    expect(claimed?.taskId).toBe(createResult.taskId);

    // Start
    await startTask(session, claimed!.taskId, "worker-1");

    // Progress
    await updateProgress(session, claimed!.taskId, 50, "worker-1");

    // Complete
    await completeTask(session, claimed!.taskId, { result: "Agricultural analysis complete." }, "worker-1");

    // Verify
    const detail = await getTask(session, claimed!.taskId);
    expect(detail.task.status).toBe("completed");
    expect(detail.task.progress).toBe(100);
    expect(detail.task.completedAt).toBeTruthy();

    // Verify events
    const eventTypes = detail.events.map((e) => e.eventType);
    expect(eventTypes).toContain("created");
    expect(eventTypes).toContain("claimed");
    expect(eventTypes).toContain("started");
    expect(eventTypes).toContain("completed");
  });

  // ============================================================
  // 2. CONCURRENT CLAIM — only one worker gets the task
  // ============================================================
  it("concurrent claim: only one worker gets the task", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create a task
    const createResult = await createTask(session, {
      type: "concurrent-test",
      goal: "Test concurrent claiming.",
    });

    // Two workers try to claim simultaneously
    const [claim1, claim2] = await Promise.all([
      claimTask(session, "worker-A", 60_000),
      claimTask(session, "worker-B", 60_000),
    ]);

    // Only one should get the task
    const claims = [claim1, claim2].filter((c) => c !== null);
    expect(claims.length).toBe(1);
    expect(claims[0]?.taskId).toBe(createResult.taskId);

    // Cleanup
    await completeTask(session, createResult.taskId, {}, claims[0]!.goal);
  });

  // ============================================================
  // 3. IDEMPOTENCY — same key returns same task
  // ============================================================
  it("idempotency: same key returns same task, no duplicate", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const key = `idem-${Date.now()}`;
    const result1 = await createTask(session, {
      type: "idempotent-test",
      goal: "First request.",
      idempotencyKey: key,
    });
    const result2 = await createTask(session, {
      type: "idempotent-test",
      goal: "Second request (should be ignored).",
      idempotencyKey: key,
    });

    expect(result1.created).toBe(true);
    expect(result2.created).toBe(false);
    expect(result1.taskId).toBe(result2.taskId);
  });

  // ============================================================
  // 4. CRASH + RESUME — lease expires, task reclaimed
  // ============================================================
  it("crash + resume: expired lease → task reclaimed", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create + claim with very short lease (1 second)
    const createResult = await createTask(session, {
      type: "crash-test",
      goal: "Test crash recovery.",
    });

    const claimed = await claimTask(session, "crashed-worker", 1_000); // 1s lease
    expect(claimed).toBeTruthy();

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Reclaim stale tasks
    const reclaimResult = await reclaimStaleTasks(session);
    expect(reclaimResult.reclaimedCount).toBeGreaterThanOrEqual(1);

    // Task should be pending again
    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("pending");
    expect(detail.task.claimedBy).toBeNull();
  });

  // ============================================================
  // 5. CROSS-TENANT ISOLATION
  // ============================================================
  it("cross-tenant: Tenant B cannot see or claim Tenant A's tasks", async () => {
    const sessionA = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");
    const sessionB = mockSession(adminUserId, tenantBId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create task in Tenant A
    const createResult = await createTask(sessionA, {
      type: "isolation-test",
      goal: "Tenant A private task.",
    });

    // Tenant B tries to claim → should get null (no pending tasks in B)
    const claimed = await claimTask(sessionB, "worker-B", 60_000);
    expect(claimed).toBeNull();

    // Tenant B tries to get Tenant A's task → should fail
    await expect(getTask(sessionB, createResult.taskId)).rejects.toThrow(/not found/i);
  });

  // ============================================================
  // 6. TASK EVENTS ARE APPEND-ONLY
  // ============================================================
  it("task events are append-only (cannot UPDATE/DELETE)", async () => {
    const { withTenant } = await import("@/lib/security/tenant-context");
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const createResult = await createTask(session, {
      type: "append-test",
      goal: "Test append-only events.",
    });
    const claimed = await claimTask(session, "worker-1", 60_000);

    // Get an event ID
    const detail = await getTask(session, createResult.taskId);
    const firstEventId = detail.events[0]?.id;
    expect(firstEventId).toBeTruthy();

    // Attempt UPDATE → should fail
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.taskEvent.update({
          where: { id: firstEventId! },
          data: { eventType: "tampered" },
        });
      })
    ).rejects.toThrow(/permission denied/i);

    // Attempt DELETE → should fail
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.taskEvent.delete({ where: { id: firstEventId! } });
      })
    ).rejects.toThrow(/permission denied/i);
  });

  // ============================================================
  // 7. BALANCE MASTER STUB — executeNextTask full cycle
  // ============================================================
  it("Balance Master: executeNextTask completes a pending task", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create a task with HIGH priority so it gets claimed first
    const createResult = await createTask(session, {
      type: "master-test",
      goal: "Analyze economic indicators for Q3 2025.",
      input: { quarter: "Q3", year: 2025 },
      priority: 100, // High priority
    });

    // Execute via Balance Master
    const execResult = await executeNextTask(session);
    expect(execResult.status).toBe("completed");
    expect(execResult.taskId).toBe(createResult.taskId);
    expect(execResult.provider).toBe("stub"); // StubProvider
    expect(execResult.simulated).toBe(true); // HONEST: simulated

    // Verify task is completed
    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("completed");
    expect(detail.task.output).toBeTruthy();

    // Verify output includes simulated flag
    const output = detail.task.output as Record<string, unknown>;
    expect(output.simulated).toBe(true);
    expect(output.response).toBeTruthy();
  });

  // ============================================================
  // 8. FAIL TASK — error is saved
  // ============================================================
  it("failTask saves error and marks task as failed", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const createResult = await createTask(session, {
      type: "fail-test",
      goal: "This task will fail.",
      priority: 100, // High priority
    });

    const claimed = await claimTask(session, "failing-worker", 60_000);
    expect(claimed?.taskId).toBe(createResult.taskId);
    await startTask(session, claimed!.taskId, "failing-worker");

    await failTask(session, claimed!.taskId, "Simulated processing error.", "failing-worker");

    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("failed");
    expect(detail.task.error).toContain("Simulated processing error");

    const eventTypes = detail.events.map((e) => e.eventType);
    expect(eventTypes).toContain("failed");
  });
});
