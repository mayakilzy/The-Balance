// ============================================================
// /api/v1/auth/me — Get current session info
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();

  if (!session || !session.user) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  await writeAudit({
    action: "auth.me",
    route: "/api/v1/auth/me",
    method: "GET",
    tenantId: session.user.tenantId,
    actor: session.user.id,
    details: { email: session.user.email },
    status: "ok",
  });

  return NextResponse.json({
    authenticated: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      tenantId: session.user.tenantId,
      roleCode: session.user.roleCode,
      membershipStatus: session.user.membershipStatus,
    },
  });
}
