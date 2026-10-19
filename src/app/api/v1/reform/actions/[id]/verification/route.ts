// ============================================================
// /api/v1/reform/actions/[id]/verification — GET (read verification record)
// ============================================================
import { NextResponse } from "next/server";
import { getReformVerification } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:verification:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const verification = await getReformVerification(session, id);
    if (!verification) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }
    return NextResponse.json({ verification });
  } catch (err) {
    return mapServiceError(err);
  }
}
