// ============================================================
// /api/v1/reform/proposals/[id]/approve — POST (under_review → approved)
// ============================================================
import { NextResponse } from "next/server";
import { approveReformProposal } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:proposal:approve"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const body = await request.json();
    const result = await approveReformProposal(session, {
      proposalId: id,
      ...body,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
