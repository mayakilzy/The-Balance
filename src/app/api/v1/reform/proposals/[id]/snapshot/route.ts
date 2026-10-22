// ============================================================
// /api/v1/reform/proposals/[id]/snapshot — GET (proposal + alternatives + approval)
// G03-05: Read-only snapshot for reviewers.
// ============================================================
import { NextResponse } from "next/server";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { NotFoundError } from "@/lib/reform/contracts";
import { authenticateAndAuthorize, mapServiceError } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:proposal:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    // Use withAuthenticatedTenant for RLS-scoped reads
    const result = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
      const proposal = await tx.reformProposal.findFirst({
        where: { id, tenantId },
      });
      if (!proposal) {
        throw new NotFoundError(`Proposal ${id} not found in tenant ${tenantId}`);
      }

      const alternatives = await tx.reformAlternative.findMany({
        where: { proposalId: id, tenantId },
        orderBy: { createdAt: "asc" },
      });

      const approval = await tx.reformApproval.findFirst({
        where: { proposalId: id, tenantId },
      });

      return { proposal, alternatives, approval };
    });

    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
