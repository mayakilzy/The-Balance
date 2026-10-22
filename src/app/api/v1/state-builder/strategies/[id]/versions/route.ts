// ============================================================
// /api/v1/state-builder/strategies/[id]/versions — POST (new version)
// ------------------------------------------------------------
// Creates a new version of an existing strategy (for supersession).
// Old approved versions remain immutable; new version starts as draft.
// ============================================================
import { NextResponse } from "next/server";
import { createStrategyVersion } from "@/lib/strategy-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CreateVersionBodySchema = z.object({
  content: z.string().min(1),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:write");
  if (errorResponse) return errorResponse;

  try {
    const { id: strategyId } = await params;
    const body = await request.json();
    const input = CreateVersionBodySchema.parse(body);
    const result = await createStrategyVersion(session, strategyId, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}
