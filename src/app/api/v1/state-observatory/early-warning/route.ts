// ============================================================
// /api/v1/state-observatory/early-warning — GET
// ------------------------------------------------------------
// Exposes:
//   - early-warning-service.assessEarlyWarning
//     (GET, observatory:observation:read)
//
// C14: advisory ONLY — NEVER creates Alert records.
// C15: "none" means "no signal detected" NOT "safe".
//
// Query params:
//   indicatorId         (required)
//   observationPeriodId (required)
//   strategyVersionId   (required)
// ============================================================
import { NextResponse } from "next/server";
import { assessEarlyWarning } from "@/lib/state-observatory/early-warning-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const EarlyWarningQuerySchema = z.object({
  indicatorId: z.string().min(1, "indicatorId is required"),
  observationPeriodId: z.string().min(1, "observationPeriodId is required"),
  strategyVersionId: z.string().min(1, "strategyVersionId is required"),
});

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:observation:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const input = EarlyWarningQuerySchema.parse({
      indicatorId: searchParams.get("indicatorId") ?? "",
      observationPeriodId: searchParams.get("observationPeriodId") ?? "",
      strategyVersionId: searchParams.get("strategyVersionId") ?? "",
    });
    const warning = await assessEarlyWarning(session, input);
    return NextResponse.json({ warning });
  } catch (err) {
    return mapServiceError(err);
  }
}
