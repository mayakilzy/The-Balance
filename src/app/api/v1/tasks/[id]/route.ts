// ============================================================
// /api/v1/tasks/[id] — Get task detail + execute
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getTask } from "@/lib/task-service";
import { executeNextTask } from "@/lib/balance-master";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// GET — task detail
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  try {
    await requirePermissionWithCurrentRole(session, "task:read");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const detail = await getTask(session, id);
    return NextResponse.json(detail);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Task not found", detail }, { status: 404 });
  }
}

// POST — trigger Balance Master to execute next pending task
export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  try {
    await requirePermissionWithCurrentRole(session, "task:write");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await executeNextTask(session);

    await writeAudit({
      action: "task.execute",
      route: "/api/v1/tasks/execute",
      method: "POST",
      actor: session.user.id,
      tenantId: session.user.tenantId,
      details: {
        taskId: result.taskId,
        status: result.status,
        provider: result.provider,
        simulated: result.simulated,
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Execution failed", detail }, { status: 500 });
  }
}
