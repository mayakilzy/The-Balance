// ============================================================
// /api/v1/state-builder/programs — POST (expand) + GET (list by version)
// ============================================================
import { NextResponse } from "next/server";
import { expandPrograms, getPrograms } from "@/lib/state-builder/program-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ExpandProgramsBodySchema = z.object({
  strategyAlternativeId: z.string().min(1),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:write");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = ExpandProgramsBodySchema.parse(body);
    const result = await expandPrograms(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("program:read");
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const strategyVersionId = searchParams.get("strategyVersionId");
    if (!strategyVersionId) {
      return NextResponse.json(
        { error: "Validation Error", detail: "strategyVersionId query parameter is required" },
        { status: 400 }
      );
    }
    const result = await getPrograms(session, strategyVersionId);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
