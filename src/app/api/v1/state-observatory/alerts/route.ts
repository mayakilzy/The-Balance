// ============================================================
// /api/v1/state-observatory/alerts — GET (list)
// ------------------------------------------------------------
// Exposes:
//   - alert-service.listAlerts (GET, observatory:alert:read)
//
// RLS-enforced: caller only ever sees alerts in their current tenant.
// Supports filters: lifecycleStage, severity, strategyVersionId,
// indicatorDefinitionId, limit (capped at 200).
// ============================================================
import { NextResponse } from "next/server";
import { listAlerts } from "@/lib/state-observatory/alert-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:alert:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const lifecycleStage = searchParams.get("lifecycleStage") ?? undefined;
    const severity = searchParams.get("severity") ?? undefined;
    const strategyVersionId =
      searchParams.get("strategyVersionId") ?? undefined;
    const indicatorDefinitionId =
      searchParams.get("indicatorDefinitionId") ?? undefined;
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    const alerts = await listAlerts(session, {
      lifecycleStage,
      severity,
      strategyVersionId,
      indicatorDefinitionId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json({ alerts });
  } catch (err) {
    return mapServiceError(err);
  }
}
