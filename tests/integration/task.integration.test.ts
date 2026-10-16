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
import { executeNextTask, executeNextTaskWithProvider } from "@/lib/balance-master";
import type { LLMProvider } from "@/lib/llm";
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
      priority: 100,
    });
    expect(createResult.created).toBe(true);

    // Claim
    const claimed = await claimTask(session, "worker-1", 60_000);
    expect(claimed).toBeTruthy();
    expect(claimed?.taskId).toBe(createResult.taskId);
    const gen = claimed!.claimGeneration;

    // Start
    await startTask(session, claimed!.taskId, "worker-1", gen);

    // Progress
    await updateProgress(session, claimed!.taskId, 50, "worker-1", gen);

    // Complete
    await completeTask(session, claimed!.taskId, { result: "Agricultural analysis complete." }, "worker-1", gen);

    // Verify
    const detail = await getTask(session, claimed!.taskId);
    expect(detail.task.status).toBe("completed");
    expect(detail.task.progress).toBe(100);
    expect(detail.task.completedAt).toBeTruthy();

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

    const createResult = await createTask(session, {
      type: "concurrent-test",
      goal: "Test concurrent claiming.",
      priority: 100,
    });

    const [claim1, claim2] = await Promise.all([
      claimTask(session, "worker-A", 60_000),
      claimTask(session, "worker-B", 60_000),
    ]);

    const claims = [claim1, claim2].filter((c) => c !== null);
    expect(claims.length).toBe(1);
    expect(claims[0]?.taskId).toBe(createResult.taskId);

    await completeTask(session, createResult.taskId, {}, "worker-A", claims[0]!.claimGeneration);
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

    const createResult = await createTask(session, {
      type: "crash-test",
      goal: "Test crash recovery.",
      priority: 100,
    });

    const claimed = await claimTask(session, "crashed-worker", 1_000);
    expect(claimed).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const reclaimResult = await reclaimStaleTasks(session);
    expect(reclaimResult.reclaimedCount).toBeGreaterThanOrEqual(1);

    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("pending");
    expect(detail.task.claimedBy).toBeNull();

    // VERIFY: stale_reclaimed event was recorded (durable reclaim events)
    const eventTypes = detail.events.map((e) => e.eventType);
    expect(eventTypes).toContain("stale_reclaimed");
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
      priority: 100,
    });
    await claimTask(session, "worker-1", 60_000);

    const detail = await getTask(session, createResult.taskId);
    const firstEventId = detail.events[0]?.id;
    expect(firstEventId).toBeTruthy();

    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.taskEvent.update({
          where: { id: firstEventId! },
          data: { eventType: "tampered" },
        });
      })
    ).rejects.toThrow(/permission denied/i);

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

    // Clean up any leftover pending tasks first
    await adminClient.task.deleteMany({ where: { tenantId: tenantAId, status: "pending" } });

    const createResult = await createTask(session, {
      type: "master-test",
      goal: "Analyze economic indicators for Q3 2025.",
      input: { quarter: "Q3", year: 2025 },
      priority: 100,
    });

    const execResult = await executeNextTask(session);
    expect(execResult.status).toBe("completed");
    expect(execResult.taskId).toBe(createResult.taskId);
    expect(execResult.provider).toBe("stub");
    expect(execResult.simulated).toBe(true);

    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("completed");
    expect(detail.task.output).toBeTruthy();

    const output = detail.task.output as Record<string, unknown>;
    expect(output.simulated).toBe(true);
    expect(output.response).toBeTruthy();
  });

  // ============================================================
  // 8. FAIL TASK — error is saved
  // ============================================================
  it("failTask saves error and marks task as failed", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Clean up any leftover pending tasks first
    await adminClient.task.deleteMany({ where: { tenantId: tenantAId, status: "pending" } });

    const createResult = await createTask(session, {
      type: "fail-test",
      goal: "This task will fail.",
      priority: 100,
    });

    const claimed = await claimTask(session, "failing-worker", 60_000);
    expect(claimed?.taskId).toBe(createResult.taskId);
    await startTask(session, claimed!.taskId, "failing-worker", claimed!.claimGeneration);

    await failTask(session, claimed!.taskId, "Simulated processing error.", "failing-worker", claimed!.claimGeneration);

    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("failed");
    expect(detail.task.error).toContain("Simulated processing error");

    const eventTypes = detail.events.map((e) => e.eventType);
    expect(eventTypes).toContain("failed");
  });

  // ============================================================
  // 9. FENCING — stale worker cannot complete after lease expiry
  // ============================================================
  it("fencing: stale worker A cannot complete after B reclaims", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Clean up any leftover pending tasks first
    await adminClient.task.deleteMany({ where: { tenantId: tenantAId, status: "pending" } });

    // Create task
    const createResult = await createTask(session, {
      type: "fencing-test",
      goal: "Test fencing token.",
      priority: 100,
    });

    // Worker A claims
    const claimA = await claimTask(session, "worker-A", 1_000); // 1s lease
    expect(claimA).toBeTruthy();
    const genA = claimA!.claimGeneration;

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Reclaim stale tasks
    await reclaimStaleTasks(session);

    // Worker B claims
    const claimB = await claimTask(session, "worker-B", 60_000);
    expect(claimB).toBeTruthy();
    expect(claimB?.taskId).toBe(createResult.taskId);
    const genB = claimB!.claimGeneration;
    expect(genB).toBeGreaterThan(genA); // New generation

    // Worker A tries to complete with OLD generation → should be REJECTED
    await expect(
      completeTask(session, createResult.taskId, { result: "A's stale result" }, "worker-A", genA)
    ).rejects.toThrow(/Claim lost or fencing mismatch/i);

    // Worker B completes with CURRENT generation → should SUCCEED
    await completeTask(session, createResult.taskId, { result: "B's correct result" }, "worker-B", genB);

    // Verify B's result is saved, not A's
    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("completed");
    const output = detail.task.output as Record<string, unknown>;
    expect(output.result).toBe("B's correct result");
  });

  // ============================================================
  // 10. ATOMIC IDEMPOTENCY — concurrent creates with same key
  // ============================================================
  it("atomic idempotency: concurrent creates with same key → one task", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const key = `atomic-idem-${Date.now()}`;

    // Two concurrent creates with the same key
    const [result1, result2] = await Promise.all([
      createTask(session, { type: "atomic-test", goal: "First.", idempotencyKey: key, priority: 100 }),
      createTask(session, { type: "atomic-test", goal: "Second.", idempotencyKey: key, priority: 100 }),
    ]);

    // Exactly one should be created, the other returns existing
    const tasks = [result1, result2];
    const createdCount = tasks.filter((t) => t.created).length;
    expect(createdCount).toBe(1);

    // Both should return the SAME task ID
    expect(result1.taskId).toBe(result2.taskId);

    // Verify only ONE task exists in DB with this key
    const dbTasks = await adminClient.task.findMany({
      where: { tenantId: tenantAId, idempotencyKey: key },
    });
    expect(dbTasks.length).toBe(1);
  });

  // ============================================================
  // 11. LLM PROVIDER FAILURE — Balance Master handles provider error
  // ============================================================
  it("Balance Master: LLM provider failure → task fails with error", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Clean up ALL non-terminal tasks first
    await adminClient.task.deleteMany({
      where: { tenantId: tenantAId, status: { in: ["pending", "claimed", "running"] } },
    });

    // Create a task
    const createResult = await createTask(session, {
      type: "llm-fail-test",
      goal: "This task will fail because the LLM provider throws.",
      priority: 100,
    });

    // Create a failing provider that always throws
    const failingProvider: LLMProvider = {
      name: "failing-test-provider",
      defaultModel: "fail-model",
      defaultEmbeddingModel: "fail-embed",
      async complete() {
        throw new Error("Simulated LLM provider failure: API key invalid.");
      },
      async *stream() {
        throw new Error("Simulated LLM provider failure.");
      },
      async embed() {
        throw new Error("Simulated embedding failure.");
      },
      async health() {
        return false;
      },
    };

    // Execute with the failing provider
    const execResult = await executeNextTaskWithProvider(session, failingProvider);
    expect(execResult.status).toBe("failed");
    expect(execResult.taskId).toBe(createResult.taskId);
    expect(execResult.error).toContain("Simulated LLM provider failure");

    // Verify task is failed in DB
    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("failed");
    expect(detail.task.error).toContain("Simulated LLM provider failure");

    // Verify failed event was recorded
    const eventTypes = detail.events.map((e) => e.eventType);
    expect(eventTypes).toContain("failed");
  });

  // ============================================================
  // 12. LEASE EXPIRY BLOCKS COMPLETE — worker cannot complete after lease expires
  // ============================================================
  it("completeTask rejected when lease has expired (before reclaim)", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Clean up
    await adminClient.task.deleteMany({
      where: { tenantId: tenantAId, status: { in: ["pending", "claimed", "running"] } },
    });

    // Create + claim with 1s lease
    const createResult = await createTask(session, {
      type: "lease-expiry-test",
      goal: "Test lease expiry blocks complete.",
      priority: 100,
    });

    const claimed = await claimTask(session, "worker-X", 1_000); // 1s lease
    expect(claimed).toBeTruthy();
    const gen = claimed!.claimGeneration;

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Worker X tries to complete — should be REJECTED (lease expired)
    await expect(
      completeTask(session, createResult.taskId, { result: "late completion" }, "worker-X", gen)
    ).rejects.toThrow(/lease expired|Claim lost/i);

    // Task should still be claimed/running (not completed)
    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).not.toBe("completed");
  });

  // ============================================================
  // 13. RECLAIM RACE — renewed lease is NOT reclaimed
  // ============================================================
  it("reclaimStaleTasks does not reclaim task with valid renewed lease", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Clean up
    await adminClient.task.deleteMany({
      where: { tenantId: tenantAId, status: { in: ["pending", "claimed", "running"] } },
    });

    // Create + claim with 5s lease
    const createResult = await createTask(session, {
      type: "reclaim-race-test",
      goal: "Test reclaim race with renewed lease.",
      priority: 100,
    });

    const claimed = await claimTask(session, "worker-Y", 5_000); // 5s lease
    expect(claimed).toBeTruthy();
    const gen = claimed!.claimGeneration;

    // Immediately run reclaimStaleTasks — lease is still valid
    const reclaimResult = await reclaimStaleTasks(session);
    expect(reclaimResult.reclaimedCount).toBe(0); // Nothing reclaimed

    // Task should still be claimed (not pending)
    const detail = await getTask(session, createResult.taskId);
    expect(detail.task.status).toBe("claimed");
    expect(detail.task.claimedBy).toBe("worker-Y");

    // Worker Y can still complete (lease valid)
    await completeTask(session, createResult.taskId, { result: "completed before expiry" }, "worker-Y", gen);
    const finalDetail = await getTask(session, createResult.taskId);
    expect(finalDetail.task.status).toBe("completed");
  });
});
