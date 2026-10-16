// ============================================================
// task-service.ts — Durable Task Runtime (Integrity Closure)
// ------------------------------------------------------------
// FENCING: claimGeneration increments on each claim. All operations
//   (start, renew, progress, complete, fail) verify claimGeneration
//   matches the caller's claim. Stale workers are rejected.
//
// ATOMIC IDEMPOTENCY: unique partial index on (tenantId, idempotencyKey).
//   createTask handles unique violation → returns existing task.
//
// DURABLE RECLAIM: reclaimStaleTasks records an event per task
//   within the transaction. No silent .catch() on FK violation.
// ============================================================
import { db } from "@/lib/db";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

const LEASE_DURATION_MS = 60_000;

// ============================================================
// CREATE TASK (atomic idempotency via unique index)
// ============================================================

export interface CreateTaskInput {
  type: string;
  goal: string;
  input?: Record<string, unknown>;
  idempotencyKey?: string;
  priority?: number;
}

export async function createTask(
  session: Session,
  input: CreateTaskInput
): Promise<{ taskId: string; created: boolean }> {
  // Step 1: Check for existing task (fast path, inside tx with RLS context)
  if (input.idempotencyKey) {
    const existing = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
      return await tx.task.findFirst({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
    });
    if (existing) {
      return { taskId: existing.id, created: false };
    }
  }

  // Step 2: Try to create (inside tx with RLS context)
  try {
    return await withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
      const task = await tx.task.create({
        data: {
          tenantId,
          type: input.type,
          goal: input.goal,
          input: (input.input ?? {}) as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
          priority: input.priority ?? 0,
          status: "pending",
        },
      });

      await tx.taskEvent.create({
        data: {
          taskId: task.id,
          tenantId,
          eventType: "created",
          actor: userId,
          details: { type: input.type, goal: input.goal.slice(0, 200) } as Prisma.InputJsonValue,
        },
      });

      return { taskId: task.id, created: true };
    });
  } catch (err) {
    // P2002 = unique constraint violation — concurrent create with same key won.
    // The transaction is aborted, so we need a NEW transaction to findFirst.
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      const existing = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
        return await tx.task.findFirst({
          where: { tenantId, idempotencyKey: input.idempotencyKey },
        });
      });
      if (existing) {
        return { taskId: existing.id, created: false };
      }
    }
    throw err;
  }
}

// ============================================================
// CLAIM TASK (SELECT FOR UPDATE SKIP LOCKED + claimGeneration increment)
// ============================================================

export interface ClaimedTask {
  taskId: string;
  goal: string;
  input: unknown;
  claimGeneration: number;
}

export async function claimTask(
  session: Session,
  workerId: string,
  leaseDurationMs: number = LEASE_DURATION_MS
): Promise<ClaimedTask | null> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Atomic claim: UPDATE with subquery SELECT FOR UPDATE SKIP LOCKED.
    // Increments claimGeneration so stale workers are fenced out.
    const rows = await tx.$queryRaw<ClaimedTask[]>`
      UPDATE "tasks"
      SET "status" = 'claimed',
          "claimedBy" = ${workerId},
          "claimGeneration" = "claimGeneration" + 1,
          "leaseExpiresAt" = NOW() + (${leaseDurationMs}::integer / 1000.0) * INTERVAL '1 second',
          "startedAt" = COALESCE("startedAt", NOW()),
          "updatedAt" = NOW()
      WHERE id = (
        SELECT id FROM "tasks"
        WHERE "tenantId" = ${tenantId}
          AND "status" = 'pending'
        ORDER BY "priority" DESC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id AS "taskId", goal, input, "claimGeneration"
    `;

    if (rows.length === 0) {
      return null;
    }

    const claimed = rows[0]!;

    await tx.taskEvent.create({
      data: {
        taskId: claimed.taskId,
        tenantId,
        eventType: "claimed",
        actor: workerId,
        details: {
          leaseDurationMs,
          claimGeneration: claimed.claimGeneration,
        } as Prisma.InputJsonValue,
      },
    });

    return claimed;
  });
}

// ============================================================
// FENCING HELPER: verify worker owns current claim + lease is valid
// ============================================================
// All task operations use updateMany with WHERE clause that checks:
//   - id matches
//   - tenantId matches (RLS also enforces)
//   - claimedBy matches workerId
//   - claimGeneration matches expected generation
//   - leaseExpiresAt is in the future (lease still valid)
// If the row was re-claimed or lease expired, updateMany returns count=0.

function assertClaimValid(result: { count: number }, operation: string): void {
  if (result.count === 0) {
    throw new Error(
      `Claim lost, fencing mismatch, or lease expired: operation '${operation}' failed. ` +
        "The task may have been reclaimed by another worker after lease expiry."
    );
  }
}

// ============================================================
// RENEW LEASE
// ============================================================

export async function renewLease(
  session: Session,
  taskId: string,
  workerId: string,
  claimGeneration: number,
  leaseDurationMs: number = LEASE_DURATION_MS
): Promise<{ renewed: boolean }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const result = await tx.task.updateMany({
      where: {
        id: taskId,
        tenantId,
        claimedBy: workerId,
        claimGeneration,
        status: { in: ["claimed", "running"] },
        leaseExpiresAt: { gt: new Date() }, // Lease must still be valid
      },
      data: {
        leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
      },
    });
    assertClaimValid(result, "renewLease");
    return { renewed: true };
  });
}

// ============================================================
// START TASK
// ============================================================

export async function startTask(
  session: Session,
  taskId: string,
  workerId: string,
  claimGeneration: number
): Promise<void> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const result = await tx.task.updateMany({
      where: {
        id: taskId,
        tenantId,
        claimedBy: workerId,
        claimGeneration,
        status: "claimed",
        leaseExpiresAt: { gt: new Date() }, // Lease must still be valid
      },
      data: { status: "running" },
    });
    assertClaimValid(result, "startTask");

    await tx.taskEvent.create({
      data: { taskId, tenantId, eventType: "started", actor: workerId },
    });
  });
}

// ============================================================
// UPDATE PROGRESS
// ============================================================

export async function updateProgress(
  session: Session,
  taskId: string,
  progress: number,
  workerId: string,
  claimGeneration: number
): Promise<void> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const result = await tx.task.updateMany({
      where: {
        id: taskId,
        tenantId,
        claimedBy: workerId,
        claimGeneration,
        leaseExpiresAt: { gt: new Date() }, // Lease must still be valid
      },
      data: { progress: Math.max(0, Math.min(100, progress)) },
    });
    assertClaimValid(result, "updateProgress");
  });
}

// ============================================================
// COMPLETE TASK
// ============================================================

export async function completeTask(
  session: Session,
  taskId: string,
  output: Record<string, unknown>,
  workerId: string,
  claimGeneration: number
): Promise<void> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const result = await tx.task.updateMany({
      where: {
        id: taskId,
        tenantId,
        claimedBy: workerId,
        claimGeneration,
        status: { in: ["claimed", "running"] },
        leaseExpiresAt: { gt: new Date() }, // Lease must still be valid
      },
      data: {
        status: "completed",
        output: output as Prisma.InputJsonValue,
        progress: 100,
        completedAt: new Date(),
        leaseExpiresAt: null,
      },
    });
    assertClaimValid(result, "completeTask");

    await tx.taskEvent.create({
      data: {
        taskId,
        tenantId,
        eventType: "completed",
        actor: workerId,
        details: { outputKeys: Object.keys(output) } as Prisma.InputJsonValue,
      },
    });
  });
}

// ============================================================
// FAIL TASK
// ============================================================

export async function failTask(
  session: Session,
  taskId: string,
  error: string,
  workerId: string,
  claimGeneration: number
): Promise<void> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const result = await tx.task.updateMany({
      where: {
        id: taskId,
        tenantId,
        claimedBy: workerId,
        claimGeneration,
        status: { in: ["claimed", "running"] },
        leaseExpiresAt: { gt: new Date() }, // Lease must still be valid
      },
      data: {
        status: "failed",
        error,
        leaseExpiresAt: null,
      },
    });
    assertClaimValid(result, "failTask");

    await tx.taskEvent.create({
      data: {
        taskId,
        tenantId,
        eventType: "failed",
        actor: workerId,
        details: { error: error.slice(0, 500) } as Prisma.InputJsonValue,
      },
    });
  });
}

// ============================================================
// RECLAIM STALE TASKS (with per-task event recording)
// ============================================================

export async function reclaimStaleTasks(
  session: Session
): Promise<{ reclaimedCount: number }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // ATOMIC RECLAIM: use UPDATE with WHERE clause that checks:
    //   - status is claimed/running
    //   - leaseExpiresAt is in the past
    // This prevents the race where a worker renews its lease between
    // our read and our update — the UPDATE will simply not match that row.
    //
    // We use raw SQL to RETURN the reclaimed task IDs + their old
    // claimedBy + claimGeneration, so we can record events per task.
    const reclaimedRows = await tx.$queryRaw<
      Array<{ id: string; oldClaimedBy: string | null; oldClaimGeneration: number }>
    >`
      UPDATE "tasks"
      SET "status" = 'pending',
          "claimedBy" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
        AND "status" IN ('claimed', 'running')
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" < NOW()
      RETURNING id, "claimedBy" AS "oldClaimedBy", "claimGeneration" AS "oldClaimGeneration"
    `;

    if (reclaimedRows.length === 0) {
      return { reclaimedCount: 0 };
    }

    // Record a stale_reclaimed event for each actually-reclaimed task
    for (const row of reclaimedRows) {
      await tx.taskEvent.create({
        data: {
          taskId: row.id,
          tenantId,
          eventType: "stale_reclaimed",
          actor: "system",
          details: {
            previousWorker: row.oldClaimedBy,
            previousClaimGeneration: row.oldClaimGeneration,
          } as Prisma.InputJsonValue,
        },
      });
    }

    return { reclaimedCount: reclaimedRows.length };
  });
}

// ============================================================
// GET TASK
// ============================================================

export async function getTask(
  session: Session,
  taskId: string
): Promise<{
  task: {
    id: string;
    type: string;
    goal: string;
    status: string;
    progress: number;
    output: unknown;
    error: string | null;
    claimedBy: string | null;
    claimGeneration: number;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
  };
  events: Array<{
    id: string;
    eventType: string;
    actor: string;
    at: Date;
    details: unknown;
  }>;
}> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const task = await tx.task.findFirst({
      where: { id: taskId, tenantId },
    });
    if (!task) {
      throw new Error("Task not found in tenant scope");
    }

    const events = await tx.taskEvent.findMany({
      where: { taskId, tenantId },
      orderBy: { at: "asc" },
    });

    return {
      task: {
        id: task.id,
        type: task.type,
        goal: task.goal,
        status: task.status,
        progress: task.progress,
        output: task.output,
        error: task.error,
        claimedBy: task.claimedBy,
        claimGeneration: task.claimGeneration,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      },
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        actor: e.actor,
        at: e.at,
        details: e.details,
      })),
    };
  });
}
