// ============================================================
// /api/v1/evidence/[id]/verify — Verify evidence (separate operation)
// ------------------------------------------------------------
// Requires evidence:verify permission (reviewer + admin only).
// New evidence is always "unverified" — this is the ONLY way to change
// verificationStatus.
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { verifyEvidence } from "@/lib/evidence-service";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  try {
    await requirePermissionWithCurrentRole(session, "evidence:verify");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: evidenceId } = await params;
  if (!evidenceId) {
    return NextResponse.json({ error: "Evidence ID required" }, { status: 400 });
  }

  let body: { status?: string; notes?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const newStatus = body.status;
  if (!["verified", "disputed", "refuted"].includes(newStatus ?? "")) {
    return NextResponse.json(
      { error: "status must be 'verified', 'disputed', or 'refuted'" },
      { status: 400 }
    );
  }

  try {
    const result = await verifyEvidence(
      session,
      evidenceId,
      newStatus as "verified" | "disputed" | "refuted",
      body.notes
    );

    await writeAudit({
      action: "evidence.verify",
      route: `/api/v1/evidence/${evidenceId}/verify`,
      method: "POST",
      actor: session.user.id,
      tenantId: session.user.tenantId,
      details: { evidenceId, newStatus, notes: body.notes?.slice(0, 200) },
    });

    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Verification failed", detail },
      { status: 500 }
    );
  }
}
