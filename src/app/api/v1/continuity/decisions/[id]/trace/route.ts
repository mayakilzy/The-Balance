// ============================================================
// /api/v1/continuity/decisions/[id]/trace — GET
// ------------------------------------------------------------
// Exposes:
//   - traceability-service.getHistoricalTrace (GET, strategy:read)
//
// Returns the full chronological trace for a single decision:
//   - decision_events (lifecycle: proposed|reviewed|approved|implemented|reversed|notes_added)
//   - audit_log entries referencing this decisionId
//
// Used by an incoming administration to reconstruct the institutional
// memory of a single decision: who proposed it, who approved it, who
// implemented it, who reversed it (if applicable), and the rationale
// captured at each step.
// ============================================================
import { NextResponse } from "next/server";
import { getHistoricalTrace } from "@/lib/continuity/traceability-service";
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
    const { id: decisionId } = PathParamsSchema.parse(await params);
    const result = await getHistoricalTrace(session, { decisionId });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
