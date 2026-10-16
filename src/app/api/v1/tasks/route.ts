// ============================================================
// /api/v1/tasks — List + create tasks
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createTask } from "@/lib/task-service";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// GET — list tasks
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  try {
    await requirePermissionWithCurrentRole(session, "task:read");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const tasks = await withAuthenticatedTenant(session, async ({ tx }) => {
      return await tx.task.findMany({
        select: {
          id: true, type: true, goal: true, status: true, progress: true,
          priority: true, createdAt: true, startedAt: true, completedAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    });
    return NextResponse.json({ tasks, count: tasks.length });
  } catch (err) {
    return NextResponse.json({ error: "Failed to list tasks" }, { status: 500 });
  }
}

// POST — create task
export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  try {
    await requirePermissionWithCurrentRole(session, "task:write");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const result = await createTask(session, {
      type: body.type ?? "general",
      goal: body.goal,
      input: body.input,
      idempotencyKey: body.idempotencyKey,
      priority: body.priority,
    });

    await writeAudit({
      action: "task.create",
      route: "/api/v1/tasks",
      method: "POST",
      actor: session.user.id,
      tenantId: session.user.tenantId,
      details: { taskId: result.taskId, created: result.created },
    });

    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to create task", detail }, { status: 500 });
  }
}
