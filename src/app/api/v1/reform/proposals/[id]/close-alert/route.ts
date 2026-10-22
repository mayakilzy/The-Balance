// ============================================================
// /api/v1/reform/proposals/[id]/close-alert — POST (close originating G02 alert)
// ============================================================
import { NextResponse } from "next/server";
import { closeOriginatingAlert } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Note: this uses `observatory:alert:act` (reviewer, admin), not a reform
  // permission. Closing an alert is a G02 institutional action — it requires
  // the G02 alert-act permission, even though it is reached via the reform
  // API surface.
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:alert:act"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const body = await request.json();
    const result = await closeOriginatingAlert(session, {
      proposalId: id,
      closureReason: body.closureReason,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
