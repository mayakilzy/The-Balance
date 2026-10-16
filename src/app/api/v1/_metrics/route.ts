// ============================================================
// /api/v1/_metrics — Basic operational metrics
// ============================================================
import { NextResponse } from "next/server";
import { getMetrics } from "@/lib/audit-observability";
import { auth } from "@/lib/auth";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  try {
    await requirePermissionWithCurrentRole(session, "audit:read");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const metrics = getMetrics();
  return NextResponse.json({
    metrics,
    timestamp: new Date().toISOString(),
  });
}
