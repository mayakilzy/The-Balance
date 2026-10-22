// ============================================================
// /api/v1/state-builder/comparison — POST (compare scenarios)
// ============================================================
import { NextResponse } from "next/server";
import { compareScenarios } from "@/lib/state-builder/comparison-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CompareBodySchema = z.object({
  alternativeIds: z.array(z.string().min(1)).min(2),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("comparison:read");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = CompareBodySchema.parse(body);
    const result = await compareScenarios(session, input);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
