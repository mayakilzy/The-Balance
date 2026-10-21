import { NextRequest, NextResponse } from "next/server";
import { createCoordination, listCoordinations } from "@/lib/reform/coordination-service";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { CreateCoordinationInputSchema, ListCoordinationsInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  try {
    const body = await req.json();
    const input = CreateCoordinationInputSchema.parse(body);
    const result = await createCoordination(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "validation", details: e.issues }, { status: 400 });
    if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const input = ListCoordinationsInputSchema.parse({
      ...params,
      limit: params.limit ? parseInt(params.limit) : 50,
      offset: params.offset ? parseInt(params.offset) : 0,
    });
    const result = await listCoordinations(session, input);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 });
    if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
