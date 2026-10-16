// ============================================================
// /api/v1/capabilities — List + discover capabilities
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { discoverCapabilities } from "@/lib/capability-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? undefined;
  const domain = searchParams.get("domain") ?? undefined;
  const readiness = searchParams.get("readiness") ?? undefined;

  try {
    const capabilities = await discoverCapabilities(session, { type, domain, readiness });
    return NextResponse.json({ capabilities, count: capabilities.length });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to list capabilities", detail }, { status: 500 });
  }
}
