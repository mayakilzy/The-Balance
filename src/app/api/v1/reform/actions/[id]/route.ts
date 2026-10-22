// ============================================================
// /api/v1/reform/actions/[id] — GET (single action)
// ============================================================
import { NextResponse } from "next/server";
import { getReformAction } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const action = await getReformAction(session, id);
    if (!action) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }
    return NextResponse.json({ action });
  } catch (err) {
    return mapServiceError(err);
  }
}
