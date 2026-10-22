// ============================================================
// /api/v1/reform/proposals/[id]/comparison — GET (deterministic comparison)
// ============================================================
import { NextResponse } from "next/server";
import { compareReformAlternatives } from "@/lib/reform";
import { authenticateAndAuthorize, mapServiceError } from "@/app/api/v1/reform/_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "reform:alternative:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const { id } = await params;
    const result = await compareReformAlternatives(session, id);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
