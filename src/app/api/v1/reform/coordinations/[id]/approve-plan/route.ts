import { NextRequest, NextResponse } from "next/server";
import { submitCoordinationPlan, approveCoordinationPlan } from "@/lib/reform/coordination-service";
import { auth } from "@/lib/auth";
import { SubmitCoordinationPlanInputSchema, ApproveCoordinationPlanInputSchema } from "@/lib/reform/coordination-contracts";
import { ZodError } from "zod";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (body.action === 'submit') {
      const result = await submitCoordinationPlan(session, SubmitCoordinationPlanInputSchema.parse({ coordinationId: id }));
      return NextResponse.json(result);
    }
    const result = await approveCoordinationPlan(session, ApproveCoordinationPlanInputSchema.parse({ coordinationId: id, approvalNotes: body.approvalNotes }));
    return NextResponse.json(result);
  } catch (e: unknown) {
    if (e instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400 });
    if (e instanceof Error && e.message.includes("Permission")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof Error && e.message.includes("not found")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (e instanceof Error && e.message.includes("Conflict")) return NextResponse.json({ error: "conflict" }, { status: 409 });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
