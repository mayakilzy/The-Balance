// ============================================================
// /api/v1/evidence/search — Vector similarity search
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchEvidence } from "@/lib/evidence-service";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  try {
    await requirePermissionWithCurrentRole(session, "evidence:read");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const limit = parseInt(searchParams.get("limit") ?? "10", 10);

  if (!query || query.length === 0) {
    return NextResponse.json(
      { error: "Query parameter 'q' is required" },
      { status: 400 }
    );
  }

  try {
    const results = await searchEvidence(session, query, limit);

    await writeAudit({
      action: "evidence.search",
      route: "/api/v1/evidence/search",
      method: "GET",
      actor: session.user.id,
      tenantId: session.user.tenantId,
      details: { query: query.slice(0, 100), resultCount: results.length },
    });

    return NextResponse.json({ results, count: results.length });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Search failed", detail },
      { status: 500 }
    );
  }
}
