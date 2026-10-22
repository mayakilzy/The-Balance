// ============================================================
// /api/v1/state-observatory/observations — POST (ingest) + GET (list)
// ------------------------------------------------------------
// Exposes:
//   - observation-service.ingestObservation (POST, observatory:observation:ingest)
//   - observation-service.listObservations  (GET,  observatory:observation:read)
// ============================================================
import { NextResponse } from "next/server";
import {
  ingestObservation,
  listObservations,
} from "@/lib/state-observatory/observation-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { IngestObservationInputSchema } from "@/lib/state-observatory/contracts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:observation:ingest"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = IngestObservationInputSchema.parse(body);
    const result = await ingestObservation(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:observation:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const indicatorDefinitionId =
      searchParams.get("indicatorDefinitionId") ?? undefined;
    const observationPeriodId =
      searchParams.get("observationPeriodId") ?? undefined;
    const includeHistory = searchParams.get("includeHistory") === "true";
    const result = await listObservations(session, {
      indicatorDefinitionId,
      observationPeriodId,
      includeHistory,
    });
    return NextResponse.json({ observations: result });
  } catch (err) {
    return mapServiceError(err);
  }
}
