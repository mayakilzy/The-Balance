// ============================================================
// /api/v1/state-observatory/indicators — POST (define) + GET (list)
// ------------------------------------------------------------
// Exposes:
//   - indicator-registry-service.defineIndicator  (POST, observatory:indicator:write)
//   - indicator-registry-service.listIndicators   (GET,  observatory:indicator:read)
// ============================================================
import { NextResponse } from "next/server";
import {
  defineIndicator,
  listIndicators,
} from "@/lib/state-observatory/indicator-registry-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { DefineIndicatorInputSchema } from "@/lib/state-observatory/contracts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:indicator:write"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    // Validate via the shared Zod schema (re-used from contracts.ts)
    const input = DefineIndicatorInputSchema.parse(body);
    const result = await defineIndicator(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:indicator:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const strategyVersionId = searchParams.get("strategyVersionId") ?? undefined;
    const status = searchParams.get("status") ?? undefined;
    const result = await listIndicators(session, { strategyVersionId, status });
    return NextResponse.json({ indicators: result });
  } catch (err) {
    return mapServiceError(err);
  }
}
