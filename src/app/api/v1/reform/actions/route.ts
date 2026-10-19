// ============================================================
// /api/v1/reform/actions — POST (create) + GET (list)
// ============================================================
import { NextResponse } from "next/server";
import {
  createReformAction,
  listReformActions,
} from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const result = await createReformAction(session, body);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const proposalId = searchParams.get("proposalId") ?? undefined;
    const status = searchParams.get("status") ?? undefined;
    const limit = searchParams.get("limit")
      ? parseInt(searchParams.get("limit")!, 10)
      : undefined;
    const cursor = searchParams.get("cursor") ?? undefined;
    const result = await listReformActions(session, {
      proposalId,
      status,
      limit,
      cursor,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
