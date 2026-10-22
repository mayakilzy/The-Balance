// ============================================================
// /api/v1/state-builder/baseline/[taskId] — GET (task status)
// ============================================================
import { NextResponse } from "next/server";
import { getBaselineTask } from "@/lib/state-builder/baseline-service";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize("baseline:read");
  if (errorResponse) return errorResponse;

  try {
    const { taskId } = await params;
    const result = await getBaselineTask(session, taskId);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
