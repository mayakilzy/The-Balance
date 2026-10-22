import { NextRequest, NextResponse } from "next/server";
import { getCoordination, closeCoordination } from "@/lib/reform/coordination-service";
import { auth } from "@/lib/auth";
import { GetCoordinationInputSchema, CloseCoordinationInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  try {
    const { id } = await params;
    const result = await getCoordination(session, GetCoordinationInputSchema.parse({ coordinationId: id }));
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 });
    if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  try {
    const { id } = await params;
    const body = await req.json();
    const result = await closeCoordination(session, CloseCoordinationInputSchema.parse({ coordinationId: id, closureReason: body.closureReason }));
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 });
    if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (e instanceof Error && e.message.includes("Conflict")) return NextResponse.json({ error: "conflict" }, { status: 409 });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
