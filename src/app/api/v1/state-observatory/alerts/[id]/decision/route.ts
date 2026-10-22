// ============================================================
// /api/v1/state-observatory/alerts/[id]/decision — POST
// ------------------------------------------------------------
// Exposes:
//   - alert-service.documentDecision (POST, observatory:alert:act)
//
// R5: documents WHAT the human decided, NOT that the decision was
// executed. Execution verification is a separate block (see
// /alerts/[id]/execution).
//
// Valid from lifecycleStage "reviewed" only.
// Body: { decisionDescription: string (required, non-empty) }
// ============================================================
import { NextResponse } from "next/server";
import { documentDecision } from "@/lib/state-observatory/alert-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
});

const DecisionBodySchema = z.object({
  decisionDescription: z
    .string()
    .min(1, "Decision description is required"),
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
    const { decisionDescription } = DecisionBodySchema.parse(body);
    const alert = await documentDecision(session, alertId, decisionDescription);
    return NextResponse.json({ alert });
  } catch (err) {
    return mapServiceError(err);
  }
}
