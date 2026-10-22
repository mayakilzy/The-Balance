// ============================================================
// /api/v1/countries — List countries (PUBLIC, read-only)
// ------------------------------------------------------------
// Returns the list of countries. This is PUBLIC data — accessible
// to any caller (no tenant context required in 00-02; will require
// auth in 00-03). The endpoint reads via balance_app role with
// PUBLIC RLS policy (USING true).
// ============================================================
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withPublicScope } from "@/lib/security/tenant-context";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const countries = await withPublicScope(async (tx) => {
      return await tx.country.findMany({
        where: { status: "active" },
        select: {
          id: true,
          iso3: true,
          iso2: true,
          displayName: true,
          status: true,
        },
        orderBy: { displayName: "asc" },
      });
    });

    await writeAudit({
      action: "countries.list",
      route: "/api/v1/countries",
      method: "GET",
      details: { count: countries.length },
    });

    return NextResponse.json({ countries, count: countries.length });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await writeAudit({
      action: "countries.list",
      route: "/api/v1/countries",
      method: "GET",
      status: "error",
      errorCode: "COUNTRIES_LIST_FAILED",
      details: { error: detail.slice(0, 200) },
    });
    return NextResponse.json(
      { error: "Failed to list countries", detail },
      { status: 500 }
    );
  }
}
