// ============================================================
// /api/v1/state-builder/strategies — POST (compose alternatives)
// ============================================================
import { NextResponse } from "next/server";
import { composeStrategies } from "@/lib/state-builder/strategy-composer-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ComposeBodySchema = z.object({
  countryId: z.string().min(1),
  objectiveIds: z.array(z.string().min(1)).min(1),
  constraints: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:write");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = ComposeBodySchema.parse(body);
    const result = await composeStrategies(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}
