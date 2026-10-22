// ============================================================
// /api/v1/intelligence/analysis — POST
// ------------------------------------------------------------
// Delivery 04 — Real AI-assisted analysis endpoint.
//
// Calls the active LLM provider (zai by default in production,
// stub in tests) to produce an evidence-grounded analysis of
// the requested problem context.
//
// Input:
//   { alertId?, strategyVersionId?, decisionId?, question? }
//   At least one of alertId/strategyVersionId/decisionId is required.
//
// Returns: IntelligenceAnalysisResult with:
//   - blocks tagged by honesty kind (factual_evidence / calculation /
//     model_inference / missing_information / uncertainty)
//   - simulated flag (true if stub provider, false if real LLM)
//   - contextUsed counts (what records were gathered)
//   - disclaimer (mandatory — LLM advises, human decides)
//
// Permission: strategy:read (analyst + reviewer + admin)
// — the analyst remains the decision-maker
// ============================================================
import { NextResponse } from "next/server";
import { analyzeProblem } from "@/lib/intelligence/intelligence-service";
import { authenticateAndAuthorize, mapServiceError } from "../_lib";
import { AnalysisRequestSchema } from "@/lib/intelligence/contracts";
import { LLMProviderError } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { session, errorResponse } = await authenticateAndAuthorize(
    "strategy:read"
  );
  if (errorResponse) return errorResponse;

  try {
    const body = await request.json();
    const input = AnalysisRequestSchema.parse(body);
    const result = await analyzeProblem(session, input);
    return NextResponse.json({ analysis: result });
  } catch (err) {
    // Provider failures → 503 with structured body (so client can retry)
    if (err instanceof LLMProviderError) {
      return NextResponse.json(
        {
          error: "LLM Provider Error",
          provider: err.provider,
          code: err.code,
          detail: err.message,
        },
        { status: 503 }
      );
    }
    return mapServiceError(err);
  }
}
