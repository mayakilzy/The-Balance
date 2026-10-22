// ============================================================
// /api/v1/state-builder/advisor — POST (conditional recommendation)
// ============================================================
import { NextResponse } from "next/server";
import { advise } from "@/lib/state-builder/advisor-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const AdviseBodySchema = z.object({
  countryId: z.string().min(1),
  objectiveIds: z.array(z.string().min(1)).min(1),
  alternativeIds: z.array(z.string().min(1)).min(2),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = AdviseBodySchema.parse(body);
    const result = await advise(session, input);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
