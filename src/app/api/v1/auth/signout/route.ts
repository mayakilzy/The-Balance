// ============================================================
// /api/v1/auth/signout — Sign out (invalidate session)
// ============================================================
import { NextResponse } from "next/server";
import { signOut } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await signOut({ redirect: false });
    await writeAudit({
      action: "auth.signout",
      route: "/api/v1/auth/signout",
      method: "POST",
      status: "ok",
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Signout failed", detail },
      { status: 500 }
    );
  }
}
