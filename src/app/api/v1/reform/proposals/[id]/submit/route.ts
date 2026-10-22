// ============================================================
// /api/v1/reform/proposals/[id]/submit — POST (draft → under_review)
// ============================================================
import { NextResponse } from "next/server";
import { submitForReview } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:proposal:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const result = await submitForReview(session, id);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
