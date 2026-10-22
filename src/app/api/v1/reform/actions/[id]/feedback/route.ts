// ============================================================
// /api/v1/reform/actions/[id]/feedback — POST (create) + GET (read)
// ============================================================
import { NextResponse } from "next/server";
import {
  createReformFeedbackLoop,
  getReformFeedbackLoop,
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
    const result = await createReformFeedbackLoop(session, {
      actionId: id,
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
    "reform:verification:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const feedback = await getReformFeedbackLoop(session, id);
    if (!feedback) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }
    return NextResponse.json({ feedback });
  } catch (err) {
    return mapServiceError(err);
  }
}
