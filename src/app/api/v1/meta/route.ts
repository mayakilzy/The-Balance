// ============================================================
// /api/v1/_meta — Version + build info
// ------------------------------------------------------------
// Public endpoint (no auth in 00-01) returning version metadata.
// Used by the UI shell and by ops to verify deployments.
// ============================================================
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getLLMProvider } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  const provider = getLLMProvider();
  return NextResponse.json({
    name: env.APP_NAME,
    version: env.APP_VERSION,
    env: env.NODE_ENV,
    group: "00",
    mission: "00-01",
    llm: {
      provider: provider.name,
      defaultModel: provider.defaultModel,
      defaultEmbeddingModel: provider.defaultEmbeddingModel,
    },
    // Feature flags — all OFF by default in 00-01.
    features: {
      auth: false, // 00-03
      evidence: false, // 00-04
      strategy: false, // 00-05
      tasks: false, // 00-06
      capabilities: false, // 00-07
      ui: false, // 00-08
    },
  });
}
