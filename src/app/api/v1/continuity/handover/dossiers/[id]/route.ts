// ============================================================
// /api/v1/continuity/handover/dossiers/[id] — GET (retrieve)
// ------------------------------------------------------------
// Exposes:
//   - handover-dossier-service.getHandoverDossier (GET, strategy:read)
//
// Returns the full dossier (scope + content). Updates the
// retrieval-tracking columns atomically (retrievedBy, retrievedAt,
// retrievalCount). Content is IMMUTABLE (DB trigger blocks any
// content mutation on published dossiers).
//
// NotFoundError (→ 404) if not in caller's tenant — does NOT leak
// cross-tenant existence.
// ============================================================
import { NextResponse } from "next/server";
import { getHandoverDossier } from "@/lib/continuity/handover-dossier-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const { id: dossierId } = PathParamsSchema.parse(await params);
    const result = await getHandoverDossier(session, dossierId);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
