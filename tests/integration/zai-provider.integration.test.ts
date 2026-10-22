// ============================================================
// tests/intelligence/zai-provider.integration.test.ts
// ------------------------------------------------------------
// Delivery 04 — REAL provider verification (not a mock).
//
// Per owner directive: "A real provider call must be demonstrated
// in a controlled integration test or documented live verification.
// Mock-only success is insufficient."
//
// This test is GATED behind the RUN_REAL_LLM_TESTS=1 env var so it
// does NOT run in the default test battery. CI runs it explicitly
// via a dedicated step (mirrors the G02/G04 e2e isolated-server
// pattern) when a real ZAI_API_KEY or implicit SDK auth is available.
//
// To run locally:
//   RUN_REAL_LLM_TESTS=1 bunx vitest run tests/intelligence/zai-provider.integration.test.ts --reporter=verbose
//
// Honesty model: this test verifies the REAL provider returns a
// non-empty response with the expected provider/model identifiers.
// It does NOT verify the LLM's "intelligence" — only that the
// integration plumbing works end-to-end.
// ============================================================
import { describe, it, expect, beforeAll } from "vitest";

const RUN_REAL =
  process.env.RUN_REAL_LLM_TESTS === "1" &&
  process.env.LLM_PROVIDER === "zai";
const describeReal = RUN_REAL ? describe : describe.skip;

describeReal("ZAI Real Provider Integration", () => {
  beforeAll(() => {
    // Ensure the provider is initialized fresh for this test
    process.env.LLM_PROVIDER = "zai";
  });

  it("real provider completes a basic prompt (returns non-empty content)", async () => {
    const { ZaiProvider } = await import("@/lib/llm/zai-provider");
    const provider = new ZaiProvider();
    expect(provider.name).toBe("zai");
    expect(provider.defaultModel).toBeTruthy();

    const result = await provider.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a test assistant. Reply with exactly the word OK and nothing else.",
        },
        { role: "user", content: "ping" },
      ],
      maxTokens: 10,
      temperature: 0.0,
    });

    // Verify the response shape
    expect(result.content).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.provider).toBe("zai");
    expect(result.model).toBeTruthy();
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.usage).toBeDefined();
    expect(result.usage?.totalTokens).toBeGreaterThan(0);

    // The content should mention OK somewhere (real LLMs may add
    // small variations but should include the requested token)
    expect(result.content.toLowerCase()).toContain("ok");
  }, 60_000);

  it("real provider produces structured JSON when asked — STRICT validation (fails if unparseable)", async () => {
    const { ZaiProvider } = await import("@/lib/llm/zai-provider");
    const provider = new ZaiProvider();

    const result = await provider.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a test assistant. Return a JSON object with the field 'status' set to 'ok'. Return ONLY the JSON. No markdown, no prose.",
        },
        { role: "user", content: "Return the JSON object now." },
      ],
      maxTokens: 50,
      temperature: 0.0,
    });

    expect(result.content).toBeTruthy();

    // STRICT: the response MUST be parseable as JSON. If it is not,
    // the test FAILS — no fallback to "accept any non-empty text".
    // This is the owner's directive: "اجعل اختبار مزود Z.ai الحقيقي
    // يفشل إذا لم تكن الاستجابة JSON صحيحة ومطابقة للعقد المطلوب."
    let text = result.content.trim();
    // Strip markdown fences if present
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try extracting JSON object from prose
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          // STRICT FAILURE: the LLM's response is not valid JSON
          throw new Error(
            `STRICT JSON VALIDATION FAILED: real LLM response is not parseable as JSON. ` +
              `Raw content (first 500 chars): ${result.content.slice(0, 500)}`
          );
        }
      } else {
        throw new Error(
          `STRICT JSON VALIDATION FAILED: no JSON object found in LLM response. ` +
            `Raw content (first 500 chars): ${result.content.slice(0, 500)}`
        );
      }
    }

    // Verify the parsed object matches the contract
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
    expect((parsed as Record<string, unknown>).status).toBe("ok");
  }, 60_000);

  it("real provider health check returns true", async () => {
    const { ZaiProvider } = await import("@/lib/llm/zai-provider");
    const provider = new ZaiProvider();
    const healthy = await provider.health();
    expect(healthy).toBe(true);
  }, 30_000);

  it("real provider: intelligence service end-to-end with a real problem (using synthetic records)", async () => {
    // This test verifies the full intelligence-service plumbing:
    //   1. ZaiProvider is initialized via getLLMProviderAsync()
    //   2. A simple problem context is constructed (no DB — synthetic)
    //   3. The LLM is called with the system prompt
    //   4. The response is parsed + validated
    //   5. The IntelligenceAnalysisResult has the correct honesty labels
    //
    // NOTE: This test bypasses the DB layer (whichAuthenticatedTenant)
    // and calls the LLM directly with a synthetic context. For a full
    // HTTP-based test, see tests/e2e/g04-delivery-04-intelligence-http.e2e.test.ts
    // which exercises the entire stack against real PostgreSQL.
    const { getLLMProviderAsync } = await import("@/lib/llm");
    const { INTELLIGENCE_SYSTEM_PROMPT } = await import(
      "@/lib/intelligence/contracts"
    );

    const provider = await getLLMProviderAsync();
    expect(provider.name).toBe("zai");

    // Synthetic context (no real institutional records)
    const syntheticContext = `ALERT: Inflation exceeds target
  Description: The inflation rate has exceeded the central bank's target by 2 percentage points.
  Severity: warning
  Lifecycle: detected

VARIANCE: absolute=2.0, direction=worse, comparison_valid=true

EVIDENCE (authorized records):
  - [synthetic-ev-001] "Q3 CPI print showed 7.2% year-over-year inflation, above the 5% target."
    verification: verified, stance: supporting
  - [synthetic-ev-002] "Money supply growth has accelerated in the last quarter."
    verification: unverified, stance: supporting
`;

    const result = await provider.complete({
      messages: [
        { role: "system", content: INTELLIGENCE_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Analyze the following problem using ONLY the evidence provided in the context. ` +
            `Return your analysis as a JSON object per the system prompt format.\n\n` +
            `=== CONTEXT (synthetic test records — no real institutional data) ===\n${syntheticContext}\n=== END CONTEXT ===\n\n` +
            `Produce your JSON analysis now.`,
        },
      ],
      maxTokens: 1000,
      temperature: 0.3,
      traceId: `intel-real-provider-test-${Date.now()}`,
    });

    expect(result.content).toBeTruthy();
    expect(result.provider).toBe("zai");
    expect(result.model).toBeTruthy();
    expect(result.usage?.totalTokens).toBeGreaterThan(0);

    // The content should be JSON-parseable (the system prompt requests JSON)
    let text = result.content.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    // STRICT: the LLM MUST produce valid JSON matching the intelligence
    // analysis contract (summary + blocks[]). If it doesn't, the test
    // FAILS — no tolerance for unparseable output.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          throw new Error(
            `STRICT CONTRACT VALIDATION FAILED: real LLM did not produce parseable JSON for intelligence analysis. ` +
              `Raw content (first 500 chars): ${text.slice(0, 500)}`
          );
        }
      } else {
        throw new Error(
          `STRICT CONTRACT VALIDATION FAILED: no JSON object found in intelligence analysis response. ` +
            `Raw content (first 500 chars): ${text.slice(0, 500)}`
        );
      }
    }

    // Verify the parsed object matches the intelligence analysis contract
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
    const obj = parsed as Record<string, unknown>;
    expect(obj.summary).toBeDefined();
    expect(typeof obj.summary).toBe("string");
    expect(Array.isArray(obj.blocks)).toBe(true);
    expect((obj.blocks as unknown[]).length).toBeGreaterThan(0);

    // Verify each block has the required fields (kind + text)
    const validKinds = new Set([
      "factual_evidence",
      "calculation",
      "model_inference",
      "missing_information",
      "uncertainty",
    ]);
    for (const block of obj.blocks as Array<Record<string, unknown>>) {
      expect(block.kind).toBeDefined();
      expect(validKinds.has(block.kind as string)).toBe(true);
      expect(block.text).toBeDefined();
      expect(typeof block.text).toBe("string");
    }

    // Verify the analysis includes at least one model_inference block
    // (the LLM's reasoning — clearly distinguished from factual_evidence)
    const blockKinds = (obj.blocks as Array<Record<string, unknown>>).map(
      (b) => b.kind
    );
    expect(blockKinds).toContain("model_inference");
  }, 120_000);
});
