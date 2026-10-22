// ============================================================
// /api/v1/state-builder/baseline — POST (compute) + GET (latest)
// ============================================================
import { NextResponse } from "next/server";
import { computeBaseline, getLatestBaseline } from "@/lib/state-builder/baseline-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ComputeBaselineBodySchema = z.object({
  countryId: z.string().min(1),
  sectors: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("baseline:compute");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = ComputeBaselineBodySchema.parse(body);
    const result = await computeBaseline(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("baseline:read");
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const countryId = searchParams.get("countryId");
    if (!countryId) {
      return NextResponse.json(
        { error: "Validation Error", detail: "countryId query parameter is required" },
        { status: 400 }
      );
    }
    const result = await getLatestBaseline(session, countryId);
    if (!result) {
      return NextResponse.json({ error: "Not Found", detail: "No baseline found for this country" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
