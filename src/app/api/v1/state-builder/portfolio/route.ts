// ============================================================
// /api/v1/state-builder/portfolio — POST (build) + GET (retrieve)
// ============================================================
import { NextResponse } from "next/server";
import { buildPortfolio } from "@/lib/state-builder/portfolio-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BuildPortfolioBodySchema = z.object({
  strategyAlternativeId: z.string().min(1),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = BuildPortfolioBodySchema.parse(body);
    const result = await buildPortfolio(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const strategyAlternativeId = searchParams.get("strategyAlternativeId");
    if (!strategyAlternativeId) {
      return NextResponse.json(
        { error: "Validation Error", detail: "strategyAlternativeId query parameter is required" },
        { status: 400 }
      );
    }
    const result = await buildPortfolio(session, { strategyAlternativeId });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
