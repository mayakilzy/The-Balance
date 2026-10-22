// ============================================================
// /api/v1/continuity/handover/dossier — POST (generate)
// ------------------------------------------------------------
// Exposes:
//   - handover-dossier-service.generateHandoverDossier
//     (POST, strategy:approve — reviewer/admin only)
//
// Body: { title: string, scope: HandoverDossierScope }
//
// Generates + persists a snapshot to handover_dossiers. Content is
// IMMUTABLE post-publication (DB trigger blocks mutation). Returns
// the dossierId + content immediately so the caller can verify.
// ============================================================
import { NextResponse } from "next/server";
import { generateHandoverDossier } from "@/lib/continuity/handover-dossier-service";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";
import { GenerateHandoverDossierBodySchema } from "@/lib/continuity/contracts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:approve");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = GenerateHandoverDossierBodySchema.parse(body);
    const result = await generateHandoverDossier(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}
