// ============================================================
// /api/v1/capabilities/[code]/invoke — Invoke a capability
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { invokeCapability } from "@/lib/capability-service";
import { writeAudit } from "@/lib/audit";
import { buildApiErrorResponse } from "@/lib/error-sanitizer";
import { recordApiError } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { code } = await params;
  let body: { input?: Record<string, unknown>; taskId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await invokeCapability(session, code, body.input ?? {}, body.taskId);

    await writeAudit({
      action: "capability.invoke",
      route: `/api/v1/capabilities/${code}/invoke`,
      method: "POST",
      actor: session.user.id,
      tenantId: session.user.tenantId,
      details: {
        capabilityCode: code,
        status: result.status,
        provider: result.provider,
        simulated: result.simulated,
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    const { status, body } = buildApiErrorResponse(
      err,
      `/api/v1/capabilities/${code}/invoke`,
      "POST"
    );
    if (status >= 500) recordApiError();
    return NextResponse.json(body, { status });
  }
}
