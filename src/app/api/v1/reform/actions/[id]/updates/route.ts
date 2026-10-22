// ============================================================
// /api/v1/reform/actions/[id]/updates — POST (append) + GET (list)
// ============================================================
import { NextResponse } from "next/server";
import {
  addReformActionUpdate,
  listReformActionUpdates,
} from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const body = await request.json();
    const result = await addReformActionUpdate(session, {
      actionId: id,
      ...body,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:action:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get("limit")
      ? parseInt(searchParams.get("limit")!, 10)
      : undefined;
    const cursor = searchParams.get("cursor") ?? undefined;
    const result = await listReformActionUpdates(session, {
      actionId: id,
      limit,
      cursor,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
