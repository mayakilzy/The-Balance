// ============================================================
// /api/v1/reform/advisor/draft-anticipated-outcomes — POST
// Permission: reform:alternative:write (analyst)
// ============================================================
import { NextResponse } from "next/server";
import { draftAnticipatedOutcomes } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "@/app/api/v1/reform/_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:alternative:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const result = await draftAnticipatedOutcomes(session, body);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return mapServiceError(err);
  }
}
