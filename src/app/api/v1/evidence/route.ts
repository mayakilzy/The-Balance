// ============================================================
// /api/v1/evidence — List + create evidence
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createEvidence } from "@/lib/evidence-service";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// GET — list evidence (tenant-scoped)
export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  try {
    await requirePermissionWithCurrentRole(session, "evidence:read");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const evidence = await withAuthenticatedTenant(session, async ({ tx }) => {
      return await tx.evidence.findMany({
        select: {
          id: true,
          claim: true,
          summary: true,
          type: true,
          verificationStatus: true,
          classification: true,
          observedAt: true,
          retrievedAt: true,
          source: { select: { code: true, displayName: true, type: true } },
          relatedEvidenceId: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    });

    return NextResponse.json({ evidence, count: evidence.length });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to list evidence" },
      { status: 500 }
    );
  }
}

// POST — create evidence
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  try {
    await requirePermissionWithCurrentRole(session, "evidence:write");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const result = await createEvidence(session, body);

    await writeAudit({
      action: "evidence.create",
      route: "/api/v1/evidence",
      method: "POST",
      actor: session.user.id,
      tenantId: session.user.tenantId,
      details: { evidenceId: result.evidenceId, type: body.type },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to create evidence", detail },
      { status: 500 }
    );
  }
}
