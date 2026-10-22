// ============================================================
// /api/v1/state-builder/objectives/[id] — GET (detail)
// ============================================================
import { NextResponse } from "next/server";
import { getObjective } from "@/lib/state-builder/objective-service";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const result = await getObjective(session, id);
    if (!result) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
