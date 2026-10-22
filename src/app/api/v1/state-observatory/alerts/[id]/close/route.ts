// ============================================================
// /api/v1/state-observatory/alerts/[id]/close — POST
// ------------------------------------------------------------
// Exposes:
//   - alert-service.closeAlert (POST, observatory:alert:act)
//
// R5: does NOT require executionStatus="verified" (closing is a
// human-sovereign decision, separate from execution verification).
//
// Valid from lifecycleStage "reviewed" or later stages (decision_documented,
// closed — idempotent).
// Body: { reason: string (required, non-empty) }
// ============================================================
import { NextResponse } from "next/server";
import { closeAlert } from "@/lib/state-observatory/alert-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
});

const CloseBodySchema = z.object({
  reason: z.string().min(1, "Closure reason is required"),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:alert:act"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id: alertId } = PathParamsSchema.parse(await params);
    const body = await request.json();
    const { reason } = CloseBodySchema.parse(body);
    const alert = await closeAlert(session, alertId, reason);
    return NextResponse.json({ alert });
  } catch (err) {
    return mapServiceError(err);
  }
}
