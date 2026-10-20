// ============================================================
// /api/v1/reform/alternatives/[id]/select — POST (select one)
// ============================================================
import { NextResponse } from "next/server";
import { selectAlternative } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:proposal:approve"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const result = await selectAlternative(session, { alternativeId: id });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
