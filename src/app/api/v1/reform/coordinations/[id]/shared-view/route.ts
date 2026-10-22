import { NextRequest, NextResponse } from "next/server";
import { getCoordinationSharedView } from "@/lib/reform/coordination-service";
import { auth } from "@/lib/auth";
import { GetCoordinationSharedViewInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  try {
    const { id } = await params;
    const result = await getCoordinationSharedView(session, GetCoordinationSharedViewInputSchema.parse({ coordinationId: id }));
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 });
    if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
