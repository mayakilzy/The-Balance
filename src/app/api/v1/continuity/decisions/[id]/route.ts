// ============================================================
// /api/v1/continuity/decisions/[id] — GET (detail with evidence + event trail)
// ------------------------------------------------------------
// Exposes:
//   - strategy-service.getDecisionDetail (GET, strategy:read)
// ============================================================
import { NextResponse } from "next/server";
import { getDecisionDetail } from "@/lib/strategy-service";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";
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
    const { id: decisionId } = PathParamsSchema.parse(await params);
    const result = await getDecisionDetail(session, decisionId);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
