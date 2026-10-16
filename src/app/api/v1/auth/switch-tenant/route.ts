// ============================================================
// /api/v1/auth/switch-tenant — Switch active tenant (FIXED)
// ------------------------------------------------------------
// VERIFIES the user has an active membership in the requested tenant,
// then passes the SPECIFIC tenantId + roleCode via unstable_update.
//
// The jwt callback's "update" branch RE-VERIFIES this tenantId is still
// active (catches revocation) but does NOT reload first membership.
//
// This ensures the session ACTUALLY switches to the requested tenant,
// not just claims to.
// ============================================================
import { NextResponse } from "next/server";
import { auth, unstable_update } from "@/lib/auth";
import { loadMembershipForTenant } from "@/lib/auth-bootstrap";
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

  // VERIFY membership using auth-bootstrap (balance_admin, BYPASSRLS).
  // SECURITY: requestedTenantId is verified against DB, not trusted from input.
  const membership = await loadMembershipForTenant(userId, requestedTenantId);

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

  // Pass the SPECIFIC tenantId + roleCode to the jwt callback.
  // unstable_update expects Session-shaped data ({ user: {...} }).
  // The jwt callback (trigger="update") reads from session.user
  // and RE-VERIFIES this membership is still active.
  await unstable_update({
    user: {
      tenantId: membership.tenantId,
      roleCode: membership.roleCode,
      membershipStatus: membership.status,
    },
  });

  await writeAudit({
    action: "auth.switch-tenant",
    route: "/api/v1/auth/switch-tenant",
    method: "POST",
    actor: userId,
    tenantId: requestedTenantId,
    details: {
      newTenantId: requestedTenantId,
      newRoleCode: membership.roleCode,
    },
    status: "ok",
  });

  return NextResponse.json({
    ok: true,
    tenantId: requestedTenantId,
    roleCode: membership.roleCode,
  });
}
