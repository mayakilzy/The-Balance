// ============================================================
// /api/v1/state-builder/strategies/[id] — GET (strategy detail)
// ============================================================
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateAndAuthorize, mapServiceError } from "../../_lib";
import { auth } from "@/lib/auth";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const result = await withAuthenticatedTenant(session, async ({ tx }) => {
      const strategy = await tx.strategy.findFirst({ where: { id } });
      if (!strategy) return null;
      const versions = await tx.strategyVersion.findMany({
        where: { strategyId: id },
        orderBy: { versionNumber: "asc" },
      });
      return { strategy, versions };
    });
    if (!result) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
