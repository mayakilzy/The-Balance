// ============================================================
// /api/v1/reform/proposals/[id] — GET (single proposal)
// ============================================================
import { NextResponse } from "next/server";
import { getReformProposal } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:proposal:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const proposal = await getReformProposal(session, id);
    if (!proposal) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }
    return NextResponse.json({ proposal });
  } catch (err) {
    return mapServiceError(err);
  }
}
