// ============================================================
// /api/v1/state-builder/objectives — POST (create) + GET (list)
// ============================================================
import { NextResponse } from "next/server";
import { createObjective, listObjectives } from "@/lib/state-builder/objective-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CreateObjectiveBodySchema = z.object({
  countryId: z.string().min(1),
  title: z.string().min(5).max(200),
  description: z.string().optional(),
  targetMetric: z.string().min(1),
  targetValue: z.string().min(1),
  horizon: z.number().int().min(1).max(50),
  status: z.enum(["draft", "active", "achieved", "abandoned"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:write");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = CreateObjectiveBodySchema.parse(body);
    const result = await createObjective(session, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function GET(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("strategy:read");
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(request.url);
    const countryId = searchParams.get("countryId") ?? undefined;
    const status = searchParams.get("status") ?? undefined;
    const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : undefined;
    const result = await listObjectives(session, { countryId, status, limit });
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
