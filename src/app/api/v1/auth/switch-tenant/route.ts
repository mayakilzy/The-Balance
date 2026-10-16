// ============================================================
// /api/v1/auth/switch-tenant — Switch active tenant
// ------------------------------------------------------------
// VERIFIES the user has an active membership in the requested tenant
// before switching. Client cannot switch to a tenant they're not a
// member of.
// ============================================================
import { NextResponse } from "next/server";
import { auth, unstable_update } from "@/lib/auth";
import { PrismaClient } from "@prisma/client";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session || !session.user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const userId = session.user.id;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  let body: { tenantId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const requestedTenantId = body.tenantId;
  if (typeof requestedTenantId !== "string" || requestedTenantId.length === 0) {
    return NextResponse.json({ error: "tenantId required" }, { status: 400 });
  }

  // VERIFY membership using admin client (cross-tenant query needed).
  // SECURITY: requestedTenantId is verified against DB, not trusted from input.
  const adminDb = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL! } },
  });

  try {
    const membership = await adminDb.membership.findFirst({
      where: {
        userId,
        tenantId: requestedTenantId,
        status: "active",
      },
    });

    if (!membership) {
      await writeAudit({
        action: "auth.switch-tenant",
        route: "/api/v1/auth/switch-tenant",
        method: "POST",
        actor: userId,
        details: { requestedTenantId, reason: "no active membership" },
        status: "denied",
        errorCode: "MEMBERSHIP_NOT_FOUND",
      });
      return NextResponse.json(
        { error: "No active membership in requested tenant" },
        { status: 403 }
      );
    }

    // Trigger session update — jwt callback reloads membership from DB.
    await unstable_update({});

    await writeAudit({
      action: "auth.switch-tenant",
      route: "/api/v1/auth/switch-tenant",
      method: "POST",
      actor: userId,
      tenantId: requestedTenantId,
      details: { newTenantId: requestedTenantId },
      status: "ok",
    });

    return NextResponse.json({
      ok: true,
      tenantId: requestedTenantId,
    });
  } finally {
    await adminDb.$disconnect();
  }
}
