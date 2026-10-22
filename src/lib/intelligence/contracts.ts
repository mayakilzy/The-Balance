// ============================================================
// intelligence/contracts.ts — Zod schemas + types for Delivery 04
// ------------------------------------------------------------
// Real LLM-backed intelligence analysis using authorized records
// from the current tenant. Evidence-grounded: never fabricates
// evidence, always cites sources, distinguishes factual evidence
// from model inference.
// ============================================================
import { z } from "zod";

// ------------------------------------------------------------
// Analysis request
// ------------------------------------------------------------
export const AnalysisRequestSchema = z
  .object({
    // What to analyze: at least one target is required
    alertId: z.string().min(1).optional(),
    strategyVersionId: z.string().min(1).optional(),
    decisionId: z.string().min(1).optional(),
    // Optional free-text question from the analyst
    question: z.string().min(10).max(2000).optional(),
  })
  .refine(
    (val) => val.alertId || val.strategyVersionId || val.decisionId,
    {
      message:
        "At least one of alertId / strategyVersionId / decisionId is required",
    }
  );

export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;

// ------------------------------------------------------------
// Honesty-tagged content block (used in analysis result)
// ------------------------------------------------------------
// Every block in the analysis output carries a `kind` tag so the
// human reader can distinguish:
//   - "factual_evidence" — from authorized DB records (Evidence table)
//   - "calculation" — derived from DB rows (counts, sums, percentages)
//   - "model_inference" — the LLM's reasoning (NOT factual)
//   - "missing_information" — known unknowns explicitly flagged
//   - "uncertainty" — sources of uncertainty
// This is the mandatory honesty model per owner directive.
export type ContentBlockKind =
  | "factual_evidence"
  | "calculation"
  | "model_inference"
  | "missing_information"
  | "uncertainty";

export interface ContentBlock {
  kind: ContentBlockKind;
  text: string;
  // For factual_evidence: references to the evidence IDs used
  sourceRefs?: string[];
  // For calculation: the inputs used
  calculationInputs?: Record<string, unknown>;
}

// ------------------------------------------------------------
// Analysis result (returned to caller)
// ------------------------------------------------------------
export interface IntelligenceAnalysisResult {
  // What was analyzed
  focus: {
    alertId?: string;
    strategyVersionId?: string;
    decisionId?: string;
    question?: string;
  };
  // The provider + model used (for audit + reproducibility)
  provider: string; // "zai" | "stub"
  model: string; // "glm-4-plus" | "stub-v0"
  // Whether the LLM was called (true) or the response is stubbed (false)
  // This is the SIMULATED flag — stub provider → simulated=true
  // real provider → simulated=false
  simulated: boolean;
  // The structured analysis output (with honesty tags per block)
  blocks: ContentBlock[];
  // Top-level summary (the LLM's overall framing)
  summary: string;
  // What authorized records were used as context (no PII, no API keys)
  contextUsed: {
    evidenceCount: number;
    decisionCount: number;
    alertCount: number;
    observationCount: number;
    varianceCount: number;
  };
  // Elapsed wall-clock ms for the LLM call
  elapsedMs: number;
  // Token usage (from provider)
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  // Mandatory disclaimer
  disclaimer: string;
  // Audit log entry id (so the analyst can trace the request)
  auditId?: string;
}

// ------------------------------------------------------------
// System prompt for the LLM
// ------------------------------------------------------------
export const INTELLIGENCE_SYSTEM_PROMPT = `You are The Balance — an institutional intelligence assistant for a national state-building platform.

You analyze problems based on EVIDENCE provided to you in the context. You do NOT make policy decisions, do NOT approve strategies, and do NOT fabricate evidence.

HONESTY MODEL (mandatory):
- Use ONLY the evidence provided in the context. Do NOT invent evidence, statistics, or sources.
- Clearly distinguish:
  * "factual_evidence" — statements grounded in the provided context
  * "calculation" — derived from numbers in the context (show inputs)
  * "model_inference" — your reasoning or hypothesis (clearly labeled as inference)
  * "missing_information" — known unknowns (data that would help but is absent)
  * "uncertainty" — sources of uncertainty in your analysis

OUTPUT FORMAT (strict):
Return your analysis as a JSON object with these fields:
{
  "summary": "<one-paragraph summary of the problem and your assessment>",
  "blocks": [
    { "kind": "factual_evidence", "text": "...", "sourceRefs": ["ev_001", "ev_002"] },
    { "kind": "calculation", "text": "...", "calculationInputs": { "value": 7.5, "target": 5.0, "variance": 2.5 } },
    { "kind": "model_inference", "text": "..." },
    { "kind": "missing_information", "text": "..." },
    { "kind": "uncertainty", "text": "..." }
  ]
}

The analyst who reads this output will use it to inform their recommendation — but the final decision is theirs, not yours. Never use prescriptive language like "you should" or "the government must". Use "the analyst may consider" or "evidence suggests".

If you cannot analyze the problem with the provided context, say so explicitly in the "missing_information" block.

Return ONLY the JSON object — no markdown, no preamble.`;
