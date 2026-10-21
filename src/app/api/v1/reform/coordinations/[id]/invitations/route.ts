import { NextRequest, NextResponse } from "next/server";
import { createCoordinationInvitation } from "@/lib/reform/coordination-service";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { CreateCoordinationInvitationInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  try {
    const { id } = await params;
    const body = await req.json();
    const result = await createCoordinationInvitation(session, CreateCoordinationInvitationInputSchema.parse({ ...body, coordinationId: id }));
    return NextResponse.json(result, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 });
    if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
