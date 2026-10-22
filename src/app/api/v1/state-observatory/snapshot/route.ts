// ============================================================
// /api/v1/state-observatory/snapshot — GET
// ------------------------------------------------------------
// Exposes:
//   - observatory-query-service.getObservatorySnapshot
//     (GET, requires observatory:observation:read + observatory:variance:read
//      + observatory:alert:read — checked inside the service)
//
// Query params:
//   strategyVersionId  (required)
//   observationPeriodId (required)
//
// Returns the full observatory snapshot: indicator values, variance
// records, alerts, aggregate independence analysis per indicator.
// ============================================================
import { NextResponse } from "next/server";
import { getObservatorySnapshot } from "@/lib/state-observatory/observatory-query-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const SnapshotQuerySchema = z.object({
  strategyVersionId: z.string().min(1, "strategyVersionId is required"),
  observationPeriodId: z.string().min(1, "observationPeriodId is required"),
});

export async function GET(request: Request) {
  // Use any one of the three required permissions for the auth gate;
  // the service itself checks all three explicitly.
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:observation:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const input = SnapshotQuerySchema.parse({
      strategyVersionId: searchParams.get("strategyVersionId") ?? "",
      observationPeriodId: searchParams.get("observationPeriodId") ?? "",
    });
    const snapshot = await getObservatorySnapshot(session, input);
    return NextResponse.json({ snapshot });
  } catch (err) {
    return mapServiceError(err);
  }
}
