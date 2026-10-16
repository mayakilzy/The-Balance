// ============================================================
// llm/stub-provider.ts — Deterministic provider for tests + 00-01
// ------------------------------------------------------------
// The StubProvider does NOT call any real LLM. It returns deterministic,
// canned responses based on the input. This is the default in 00-01
// so the platform skeleton runs without any external API keys.
//
// When a real provider is needed (mission 00-06 Balance Master stub),
// set LLM_PROVIDER=zai (or openai/anthropic) and implement the
// corresponding provider file.
//
// Honest classification: ALL outputs from this provider are SIMULATED.
// Tests must assert against the deterministic output, not against
// "intelligence".
// ============================================================
import type {
  LLMCompleteOptions,
  LLMCompleteResult,
  LLMEmbedOptions,
  LLMEmbedResult,
  LLMProvider,
  LLMStreamChunk,
} from "./provider";
import { LLMUnsupportedError } from "./provider";

export class StubProvider implements LLMProvider {
  readonly name = "stub";
  readonly defaultModel = "stub-v0";
  readonly defaultEmbeddingModel = "stub-embed-v0";

  async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
    const start = Date.now();
    const userMessages = opts.messages.filter((m) => m.role === "user");
    const lastUser = userMessages[userMessages.length - 1];
    const userText = lastUser?.content ?? "(no user input)";

    // Deterministic canned response — NOT intelligent.
    const content = [
      "[STUB PROVIDER — no real LLM call]",
      `Received ${opts.messages.length} message(s).`,
      `Last user input: "${userText.slice(0, 200)}"`,
      "",
      "This response is deterministic and contains no reasoning.",
      "Set LLM_PROVIDER to a real provider to enable actual intelligence.",
    ].join("\n");

    return {
      content,
      model: this.defaultModel,
      provider: this.name,
      elapsedMs: Date.now() - start,
      usage: {
        promptTokens: Math.ceil(userText.length / 4),
        completionTokens: Math.ceil(content.length / 4),
        totalTokens: Math.ceil((userText.length + content.length) / 4),
      },
    };
  }

  async *stream(opts: LLMCompleteOptions): AsyncIterable<LLMStreamChunk> {
    const result = await this.complete(opts);
    // Emit content in 3 chunks to simulate streaming.
    const chunkSize = Math.ceil(result.content.length / 3);
    for (let i = 0; i < result.content.length; i += chunkSize) {
      yield {
        delta: result.content.slice(i, i + chunkSize),
        done: false,
      };
    }
    yield { delta: "", done: true, usage: result.usage };
  }

  async embed(opts: LLMEmbedOptions): Promise<LLMEmbedResult> {
    const start = Date.now();
    const inputs = Array.isArray(opts.input) ? opts.input : [opts.input];
    // Deterministic dummy vectors — NOT real embeddings.
    // Hash the input to produce a stable 8-dim vector.
    const vectors = inputs.map((text) => {
      const hash = simpleHash(text);
      const dim = opts.dimensions ?? 8;
      return Array.from({ length: dim }, (_, i) => ((hash >> i) & 0xff) / 255);
    });
    return {
      vectors,
      model: this.defaultEmbeddingModel,
      provider: this.name,
      elapsedMs: Date.now() - start,
      usage: {
        totalTokens: inputs.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
      },
    };
  }

  async health(): Promise<boolean> {
    // Stub is always "healthy" — it's in-process.
    return true;
  }
}

function simpleHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
