// ============================================================
// /api/v1/reform/advisor/draft-comparison — POST
// Permission: reform:alternative:read (reviewer, analyst, admin)
// ============================================================
import { NextResponse } from "next/server";
import { draftComparisonSummary } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "@/app/api/v1/reform/_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:alternative:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const proposalId =
      typeof body?.proposalId === "string" ? body.proposalId : "";
    if (!proposalId) {
      return NextResponse.json(
        { error: "Validation Error", detail: "proposalId is required" },
        { status: 400 }
      );
    }
    const result = await draftComparisonSummary(session, proposalId);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return mapServiceError(err);
  }
}
