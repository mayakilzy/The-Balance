// ============================================================
// /api/v1/reform/proposals/[id]/alternatives — POST (add) + GET (list)
// ============================================================
import { NextResponse } from "next/server";
import {
  addReformAlternative,
  listReformAlternatives,
} from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:alternative:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const body = await request.json();
    const result = await addReformAlternative(session, {
      proposalId: id,
      ...body,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:alternative:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const alternatives = await listReformAlternatives(session, id);
    return NextResponse.json({ alternatives, count: alternatives.length });
  } catch (err) {
    return mapServiceError(err);
  }
}
