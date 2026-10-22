// ============================================================
// /api/v1/state-observatory/alerts/[id]/execution — POST
// ------------------------------------------------------------
// Exposes:
//   - alert-service.updateExecutionStatus (POST, observatory:alert:act)
//
// R5: does NOT change lifecycleStage. Updates executionStatus only.
// F6: when executionStatus="verified", BOTH verifiedAction (specific
//     documented action) AND evidenceSource (evidence for that action)
//     are required — Zod schema enforces this. The route returns 400
//     if either is missing for the "verified" case.
//
// Body: {
//   executionStatus: "pending" | "verified" | "disputed",
//   verifiedAction?:  string  (required when executionStatus="verified"),
//   evidenceSource?:  string  (required when executionStatus="verified"),
//   notes?:           string
// }
// ============================================================
import { NextResponse } from "next/server";
import { updateExecutionStatus } from "@/lib/state-observatory/alert-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { UpdateExecutionStatusInputSchema } from "@/lib/state-observatory/contracts";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
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
    // Re-use the schema from contracts.ts — same F6 superRefine logic.
    const input = UpdateExecutionStatusInputSchema.parse(body);
    const alert = await updateExecutionStatus(session, alertId, input);
    return NextResponse.json({ alert });
  } catch (err) {
    return mapServiceError(err);
  }
}
