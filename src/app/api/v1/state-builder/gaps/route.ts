// ============================================================
// /api/v1/state-builder/gaps — POST (compute) + GET (latest task)
// ============================================================
import { NextResponse } from "next/server";
import { computeGaps, getGapTask } from "@/lib/state-builder/gap-analysis-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ComputeGapsBodySchema = z.object({
  countryId: z.string().min(1),
  objectiveIds: z.array(z.string().min(1)).min(1),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("baseline:compute");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = ComputeGapsBodySchema.parse(body);
    const result = await computeGaps(session, input);
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
    const taskId = searchParams.get("taskId");
    if (!taskId) {
      return NextResponse.json(
        { error: "Validation Error", detail: "taskId query parameter is required" },
        { status: 400 }
      );
    }
    const result = await getGapTask(session, taskId);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
