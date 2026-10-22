// ============================================================
// /api/v1/continuity/strategies/[id]/trace — GET
// ------------------------------------------------------------
// Exposes:
//   - traceability-service.getHistoricalTrace (GET, strategy:read)
//
// Query params:
//   strategyVersionId (required) — the version whose history to trace
//
// Returns the full chronological trace of:
//   - reform proposals linked to this strategy version (status transitions)
//   - audit_log entries referencing this strategyVersionId
//
// Honesty: includes ALL entries (including superseded/rejected) so the
// incoming administration sees the full institutional memory, not just
// the "current" state.
// ============================================================
import { NextResponse } from "next/server";
import { getHistoricalTrace } from "@/lib/continuity/traceability-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
});

const QuerySchema = z.object({
  strategyVersionId: z.string().min(1, "strategyVersionId query param is required"),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const { id: _strategyId } = PathParamsSchema.parse(await params);
    void _strategyId; // The trace is keyed on strategyVersionId; strategyId is for routing only.
    const { searchParams } = new URL(request.url);
    const { strategyVersionId } = QuerySchema.parse({
      strategyVersionId: searchParams.get("strategyVersionId") ?? "",
    });
    const result = await getHistoricalTrace(session, { strategyVersionId });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
