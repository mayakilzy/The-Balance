// ============================================================
// /api/v1/continuity/decisions — POST (create) + GET (list)
// ------------------------------------------------------------
// Exposes:
//   - strategy-service.createDecision (POST, strategy:write)
//   - continuity.listDecisions         (GET,  strategy:read)
// ============================================================
import { NextResponse } from "next/server";
import { createDecision } from "@/lib/strategy-service";
import { listDecisions } from "@/lib/continuity/traceability-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { CreateDecisionBodySchema } from "@/lib/continuity/contracts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:write");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = CreateDecisionBodySchema.parse(body);
    const result = await createDecision(session, input);
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
    const strategyVersionId = searchParams.get("strategyVersionId") ?? undefined;
    const status = searchParams.get("status") ?? undefined;
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const result = await listDecisions(session, {
      strategyVersionId,
      status,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json({ decisions: result });
  } catch (err) {
    return mapServiceError(err);
  }
}
