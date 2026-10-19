// ============================================================
// /api/v1/reform/actions/[id]/start — POST (planned → in_progress)
// ============================================================
import { NextResponse } from "next/server";
import { startReformAction } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const result = await startReformAction(session, id);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
