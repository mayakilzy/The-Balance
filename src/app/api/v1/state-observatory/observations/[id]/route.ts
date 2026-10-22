// ============================================================
// /api/v1/state-observatory/observations/[id] — POST (correct)
// ------------------------------------------------------------
// Exposes:
//   - observation-service.correctObservation (POST, observatory:observation:ingest)
//
// R4 + F2: append-only correction chain. The previous version is
// preserved (supersededById links to the new version), isCurrent
// flag is flipped atomically. The new observation gets a new id.
// ============================================================
import { NextResponse } from "next/server";
import { correctObservation } from "@/lib/state-observatory/observation-service";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";
import { CorrectionInputSchema } from "@/lib/state-observatory/contracts";
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
    "observatory:observation:ingest"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id: observationId } = PathParamsSchema.parse(await params);
    const body = await request.json();
    const input = CorrectionInputSchema.parse(body);
    const result = await correctObservation(session, observationId, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}
