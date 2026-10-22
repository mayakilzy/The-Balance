// ============================================================
// /api/v1/state-observatory/alerts/[id] — GET (detail)
// ------------------------------------------------------------
// Exposes:
//   - alert-service.getAlert (GET, observatory:alert:read)
//
// RLS-enforced: NotFoundError (→ 404) if alert does not exist in the
// caller's tenant — does NOT leak existence across tenants.
// ============================================================
import { NextResponse } from "next/server";
import { getAlert } from "@/lib/state-observatory/alert-service";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PathParamsSchema = z.object({
  id: z.string().min(1),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "observatory:alert:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id: alertId } = PathParamsSchema.parse(await params);
    const alert = await getAlert(session, alertId);
    return NextResponse.json({ alert });
  } catch (err) {
    return mapServiceError(err);
  }
}
