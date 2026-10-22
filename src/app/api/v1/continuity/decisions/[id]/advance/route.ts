// ============================================================
// /api/v1/continuity/decisions/[id]/advance — POST
// ------------------------------------------------------------
// Exposes:
//   - strategy-service.advanceDecision (POST, strategy:write OR strategy:approve)
//
// R5-style: lifecycle stage transitions are validated by the service
// (VALID_TRANSITIONS map). Allowed newStatus values:
//   reviewed | approved | implemented | reversed
//
// Approval (newStatus=approved) requires strategy:approve (reviewer/admin).
// Other transitions require strategy:write (analyst/admin).
//
// Reversal (newStatus=reversed) is the institutional "amend or reverse"
// path per owner directive. The Decision row + all its events are
// preserved (append-only) — only the status field changes, and a new
// DecisionEvent is recorded for the reversal.
// ============================================================
import { NextResponse } from "next/server";
import { advanceDecision } from "@/lib/strategy-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { AdvanceDecisionBodySchema, type AdvanceDecisionBody } from "@/lib/continuity/contracts";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Pre-flight: if newStatus=approved, the auth gate requires strategy:approve;
  // otherwise strategy:write suffices. We do TWO auth passes to honor this.
  // First peek at the body to choose the permission, then authorize.
  let body: AdvanceDecisionBody;
  try {
    const raw = await request.json();
    body = AdvanceDecisionBodySchema.parse(raw);
  } catch (err) {
    // Use the lower-permission auth gate to return a 403 if needed,
    // otherwise return the validation error.
    const auth = await authenticateAndAuthorize("strategy:write");
    if (auth.errorResponse) return auth.errorResponse;
    return mapServiceError(err);
  }

  const permission =
    body.newStatus === "approved" ? "strategy:approve" : "strategy:write";
  const { session, errorResponse } = await authenticateAndAuthorize(permission);
  if (errorResponse) return errorResponse;

  try {
    const { id: decisionId } = PathParamsSchema.parse(await params);
    const result = await advanceDecision(
      session,
      decisionId,
      body.newStatus,
      body.notes
    );
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
