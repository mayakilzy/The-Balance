// ============================================================
// /api/v1/continuity/strategies/[id]/history — GET
// ------------------------------------------------------------
// Exposes:
//   - traceability-service.getStrategyVersionHistory
//     (GET, strategy:read)
//
// Returns all versions of a strategy, ordered by versionNumber DESC.
// Each version includes status (draft|approved|superseded), approval
// metadata, and a flag indicating the latest version.
// ============================================================
import { NextResponse } from "next/server";
import { getStrategyVersionHistory } from "@/lib/continuity/traceability-service";
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
    const { id: strategyId } = PathParamsSchema.parse(await params);
    const result = await getStrategyVersionHistory(session, strategyId);
    return NextResponse.json({ strategyId, versions: result });
  } catch (err) {
    return mapServiceError(err);
  }
}
