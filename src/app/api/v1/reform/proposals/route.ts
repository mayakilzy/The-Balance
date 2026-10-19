// ============================================================
// /api/v1/reform/proposals — POST (create) + GET (list)
// ============================================================
import { NextResponse } from "next/server";
import {
  createReformProposal,
  listReformProposals,
} from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:proposal:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const result = await createReformProposal(session, body);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:proposal:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? undefined;
    const limit = searchParams.get("limit")
      ? parseInt(searchParams.get("limit")!, 10)
      : undefined;
    const cursor = searchParams.get("cursor") ?? undefined;
    const result = await listReformProposals(session, { status, limit, cursor });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
