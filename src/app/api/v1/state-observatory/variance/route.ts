// ============================================================
// /api/v1/state-observatory/variance — POST (compute) + GET (list)
// ------------------------------------------------------------
// Exposes:
//   - variance-service.computeVariance (POST, observatory:variance:read)
//   - variance-service.listVariance    (GET,  observatory:variance:read)
// ============================================================
import { NextResponse } from "next/server";
import {
  computeVariance,
  listVariance,
} from "@/lib/state-observatory/variance-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ComputeVarianceBodySchema = z.object({
  strategyVersionId: z.string().min(1),
  observationPeriodId: z.string().min(1),
  indicatorId: z.string().optional(),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:variance:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = ComputeVarianceBodySchema.parse(body);
    const result = await computeVariance(session, input);
    return NextResponse.json({ varianceRecords: result }, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:variance:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const strategyVersionId =
      searchParams.get("strategyVersionId") ?? undefined;
    const indicatorId = searchParams.get("indicatorId") ?? undefined;
    const observationPeriodId =
      searchParams.get("observationPeriodId") ?? undefined;
    const result = await listVariance(session, {
      strategyVersionId,
      indicatorId,
      observationPeriodId,
    });
    return NextResponse.json({ varianceRecords: result });
  } catch (err) {
    return mapServiceError(err);
  }
}
