// ============================================================
// /api/v1/continuity/impact-assessment — POST
// ------------------------------------------------------------
// Exposes:
//   - policy-impact-service.assessPolicyChangeImpact (POST, strategy:read)
//
// Body: { changeType, description, target: {strategyVersionId?, decisionId?, proposalId?} }
//
// On-demand computation (NOT persisted). Returns the assessment result
// immediately. The audit_log captures that the QUESTION was asked
// (action="policy.impact.assessed") so institutional memory of the
// inquiry is preserved, but the result is not saved (it would
// immediately become stale).
//
// Honesty model:
//   - calculated = direct query results (affectedPrograms, etc.)
//   - documented = qualitative strings from existing metadata
//   - missing = known unknowns (explicitly listed)
//   - simulated = NOT used (we never invent values)
// ============================================================
import { NextResponse } from "next/server";
import { assessPolicyChangeImpact } from "@/lib/continuity/policy-impact-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { PolicyChangeBodySchema } from "@/lib/continuity/contracts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = PolicyChangeBodySchema.parse(body);
    const result = await assessPolicyChangeImpact(session, input);
    return NextResponse.json({ assessment: result }, { status: 200 });
  } catch (err) {
    return mapServiceError(err);
  }
}
