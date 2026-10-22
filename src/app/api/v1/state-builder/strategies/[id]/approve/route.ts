// ============================================================
// /api/v1/state-builder/strategies/[id]/approve — POST (human approval)
// ------------------------------------------------------------
// Transitions a strategy version from draft → approved.
// Requires strategy:approve permission (reviewer + admin).
// Uses approveStrategyVersionWithAuditSafe from approval-service
// (atomic with audit_log + event emission).
// ============================================================
import { NextResponse } from "next/server";
import { approveStrategyVersionWithAuditSafe } from "@/lib/state-builder/approval-service";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ApproveBodySchema = z.object({
  versionId: z.string().min(1),
  approvalNotes: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:approve");
  if (errorResponse) return errorResponse;

  try {
    const { id: _strategyId } = await params;
    const body = await request.json();
    const input = ApproveBodySchema.parse(body);
    const result = await approveStrategyVersionWithAuditSafe(
      session,
      input.versionId,
      input.approvalNotes
    );
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
