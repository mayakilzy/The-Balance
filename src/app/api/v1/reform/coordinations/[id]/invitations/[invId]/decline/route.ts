import { NextRequest, NextResponse } from "next/server";
import { declineCoordinationInvitation } from "@/lib/reform/coordination-service";
import { auth } from "@/lib/auth";
import { DeclineCoordinationInvitationInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; invId: string }> }) {
  const session = await auth();
  try { const { invId } = await params; const body = await req.json().catch(() => ({})); const r = await declineCoordinationInvitation(session, DeclineCoordinationInvitationInputSchema.parse({ invitationId: invId, declineReason: body.declineReason })); return NextResponse.json(r); }
  catch (e: unknown) { if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 }); if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 }); if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 }); return NextResponse.json({ error: "internal" }, { status: 500 }); }
}
