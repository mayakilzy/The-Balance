// ============================================================
// /api/v1/reform/actions/[id]/complete — POST (in_progress → completed)
// ============================================================
import { NextResponse } from "next/server";
import { completeReformAction } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    let body: { completedDate?: string } = {};
    try {
      body = await request.json();
    } catch {
      // body is optional
    }
    const result = await completeReformAction(session, {
      actionId: id,
      completedDate: body.completedDate,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
