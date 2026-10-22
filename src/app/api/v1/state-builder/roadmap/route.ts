// ============================================================
// /api/v1/state-builder/roadmap — POST (build implementation roadmap)
// ============================================================
import { NextResponse } from "next/server";
import { buildRoadmap } from "@/lib/state-builder/roadmap-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BuildRoadmapBodySchema = z.object({
  strategyAlternativeId: z.string().min(1),
});

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize("roadmap:read");
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = BuildRoadmapBodySchema.parse(body);
    const result = await buildRoadmap(session, input);
    return NextResponse.json(result);
  } catch (err) {
    return mapServiceError(err);
  }
}
