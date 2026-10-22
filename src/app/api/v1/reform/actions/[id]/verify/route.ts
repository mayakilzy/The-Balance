// ============================================================
// /api/v1/reform/actions/[id]/verify — POST (F6 verification)
// ============================================================
import { NextResponse } from "next/server";
import { verifyReformAction } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:verify"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const body = await request.json();
    const result = await verifyReformAction(session, {
      actionId: id,
      ...body,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
