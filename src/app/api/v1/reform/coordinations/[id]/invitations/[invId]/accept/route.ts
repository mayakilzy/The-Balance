import { NextRequest, NextResponse } from "next/server";
import { acceptCoordinationInvitation } from "@/lib/reform/coordination-service";
import { auth } from "@/lib/auth";
import { AcceptCoordinationInvitationInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; invId: string }> }) {
  const session = await auth();
  try { const { invId } = await params; const r = await acceptCoordinationInvitation(session, AcceptCoordinationInvitationInputSchema.parse({ invitationId: invId })); return NextResponse.json(r, { status: 201 }); }
  catch (e: unknown) { if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 }); if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 }); if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 }); if (e instanceof Error && e.message.includes("Conflict")) return NextResponse.json({ error: "conflict" }, { status: 409 }); return NextResponse.json({ error: "internal" }, { status: 500 }); }
}
