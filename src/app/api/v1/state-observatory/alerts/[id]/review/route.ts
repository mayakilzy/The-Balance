// ============================================================
// /api/v1/state-observatory/alerts/[id]/review — POST
// ------------------------------------------------------------
// Exposes:
//   - alert-service.markReviewed (POST, observatory:alert:review)
//
// Valid from lifecycleStage "detected" or "notified".
// Body: { notes: string (required, non-empty) }
// Reviewer/admin only — analyst/observer get 403 from auth layer.
// ============================================================
import { NextResponse } from "next/server";
import { markReviewed } from "@/lib/state-observatory/alert-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
});

const ReviewBodySchema = z.object({
  notes: z.string().min(1, "Review notes are required"),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:alert:review"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id: alertId } = PathParamsSchema.parse(await params);
    const body = await request.json();
    const { notes } = ReviewBodySchema.parse(body);
    const alert = await markReviewed(session, alertId, notes);
    return NextResponse.json({ alert });
  } catch (err) {
    return mapServiceError(err);
  }
}
