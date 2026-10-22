import { NextRequest, NextResponse } from "next/server";
import { revokeSharedSnapshot } from "@/lib/reform/coordination-service";
import { auth } from "@/lib/auth";
import { RevokeSharedSnapshotInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; snapId: string }> }) {
  const session = await auth();
  try { const { snapId } = await params; const body = await req.json(); const r = await revokeSharedSnapshot(session, RevokeSharedSnapshotInputSchema.parse({ snapshotId: snapId, reason: body.reason })); return NextResponse.json(r); }
  catch (e: unknown) { if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 }); if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 }); if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 }); if (e instanceof Error && e.message.includes("Conflict")) return NextResponse.json({ error: "conflict" }, { status: 409 }); return NextResponse.json({ error: "internal" }, { status: 500 }); }
}
