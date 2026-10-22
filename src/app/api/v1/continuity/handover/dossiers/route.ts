// ============================================================
// /api/v1/continuity/handover/dossiers — GET (list)
// ------------------------------------------------------------
// Exposes:
//   - handover-dossier-service.listHandoverDossiers (GET, strategy:read)
//
// Returns metadata for all dossiers in the caller's tenant (most recent
// first). Does NOT include content — use GET /handover/dossiers/[id]
// to retrieve the full dossier.
// ============================================================
import { NextResponse } from "next/server";
import { listHandoverDossiers } from "@/lib/continuity/handover-dossier-service";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? undefined;
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const result = await listHandoverDossiers(session, {
      status,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json({ dossiers: result });
  } catch (err) {
    return mapServiceError(err);
  }
}
