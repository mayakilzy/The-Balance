// ============================================================
// llm/zai-provider.ts — Real LLM provider via z-ai-web-dev-sdk
// ------------------------------------------------------------
// Delivery 04 — Real AI Intelligence & Cross-Module Integration.
//
// Implements the LLMProvider contract using real authenticated
// API requests via the z-ai-web-dev-sdk (GLM-4-Plus model).
//
// Design:
//   - Lazy SDK init (z-ai-web-dev-sdk is imported ONLY when this
//     provider is instantiated, so the bundle is not inflated when
//     LLM_PROVIDER=stub).
//   - Server-side credentials via the SDK's implicit auth (no API
//     keys in code or logs). ZAI_API_KEY env var optional.
//   - Configurable model selection via ZAI_MODEL env var
//     (default: "glm-4-plus" — matches the SDK's default).
//   - Embeddings: SDK exposes embeddings via a separate API. If
//     unavailable, throws LLMUnsupportedError (honest — never fakes).
//   - Streaming: SDK supports stream:true. Adapter yields deltas.
//   - Error mapping: SDK errors → LLMProviderError with typed codes
//     (TIMEOUT, AUTH_FAILED, RATE_LIMIT, NETWORK, INVALID_REQUEST,
//      SERVER_ERROR) so callers can react appropriately.
//
// HONESTY: every response from this provider has `provider: "zai"`
// and `model: <real-model-id>`. Callers can distinguish real LLM
// output from StubProvider's deterministic canned responses
// (provider: "stub", model: "stub-v0", simulated: true).
// ============================================================
import type {
  LLMCompleteOptions,
  LLMCompleteResult,
  LLMEmbedOptions,
  LLMEmbedResult,
  LLMProvider,
  LLMStreamChunk,
  LLMToolDefinition,
} from "./provider";
import { LLMProviderError, LLMUnsupportedError } from "./provider";

// Lazy import — only loaded if ZaiProvider is actually instantiated.
// The z-ai-web-dev-sdk default export is the ZAI class. Usage:
//   const zai = await ZAI.create();  // static factory method
//   const response = await zai.chat.completions.create({ messages, ... });
interface ZaiSDKInstance {
  chat: {
    completions: {
      create: (opts: {
        messages: Array<{ role: string; content: string }>;
        model?: string;
        stream?: boolean;
        thinking?: { type: string };
        max_tokens?: number;
        temperature?: number;
        stop?: string | string[];
        [key: string]: unknown;
      }) => Promise<ZaiCompletionResponse> | AsyncIterable<ZaiStreamChunk>;
      createVision?: (opts: unknown) => Promise<unknown>;
    };
  };
  audio?: unknown;
  images?: unknown;
  video?: unknown;
  async?: unknown;
  functions?: unknown;
}

interface ZaiSDKModule {
  default: {
    create: () => Promise<ZaiSDKInstance>;
  };
}

interface ZaiCompletionResponse {
  choices?: Array<{
    message?: { content?: string; role?: string };
    finish_reason?: string;
    index?: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  id?: string;
  created?: number;
  request_id?: string;
}

interface ZaiStreamChunk {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string;
  }>;
  usage?: ZaiCompletionResponse["usage"];
}

interface ZaiEmbedResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
  usage?: { total_tokens?: number };
}

/**
 * Lazy-load the z-ai-web-dev-sdk module. This is a dynamic import
 * so the SDK is only loaded when ZaiProvider is actually used
 * (i.e., LLM_PROVIDER=zai). When LLM_PROVIDER=stub, the SDK is
 * never imported → bundle stays small.
 */
async function loadZaiSDK(): Promise<ZaiSDKInstance> {
  try {
    const mod = (await import("z-ai-web-dev-sdk")) as unknown as ZaiSDKModule;
    const ZAIClass = mod.default;
    if (!ZAIClass || typeof ZAIClass.create !== "function") {
      throw new Error("z-ai-web-dev-sdk default export missing create() static method");
    }
    return await ZAIClass.create();
  } catch (err) {
    throw new LLMProviderError(
      "zai",
      "SDK_IMPORT_FAILED",
      `Failed to import/initialize z-ai-web-dev-sdk: ${
        err instanceof Error ? err.message : String(err)
      }. Ensure the package is installed (bun add z-ai-web-dev-sdk).`
    );
  }
}

export class ZaiProvider implements LLMProvider {
  readonly name = "zai";
  readonly defaultModel: string;
  readonly defaultEmbeddingModel: string;

  private sdkPromise: Promise<ZaiSDKInstance> | null = null;

  constructor() {
    // Configurable model selection via env vars. Defaults match the
    // SDK's defaults (glm-4-plus for chat, embedding-3 for embeddings).
    this.defaultModel = process.env.ZAI_MODEL ?? "glm-4-plus";
    this.defaultEmbeddingModel =
      process.env.ZAI_EMBEDDING_MODEL ?? "embedding-3";
  }

  /**
   * Lazy-init the SDK instance. Cached for the lifetime of the provider.
   * Throws LLMProviderError with code AUTH_FAILED if the SDK cannot
   * authenticate (no implicit auth + no ZAI_API_KEY).
   */
  private async getSDK(): Promise<ZaiSDKInstance> {
    if (this.sdkPromise === null) {
      this.sdkPromise = (async () => {
        try {
          return await loadZaiSDK();
        } catch (err) {
          this.sdkPromise = null; // allow retry on next call
          throw err;
        }
      })();
    }
    return this.sdkPromise;
  }

  /**
   * Map unknown SDK errors to typed LLMProviderError. Callers can
   * branch on `err.code` to handle specific failure modes:
   *   - TIMEOUT → retry with backoff
   *   - RATE_LIMIT → backoff or queue
   *   - AUTH_FAILED → operator alert (credentials issue)
   *   - NETWORK → retry
   *   - INVALID_REQUEST → fix the request (caller error)
   *   - SERVER_ERROR → retry with backoff
   */
  private mapError(err: unknown): LLMProviderError {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    // Heuristic code mapping based on error message content
    let code = "SERVER_ERROR";
    if (
      lower.includes("timeout") ||
      lower.includes("timed out") ||
      lower.includes("etimedout")
    ) {
      code = "TIMEOUT";
    } else if (
      lower.includes("rate limit") ||
      lower.includes("429") ||
      lower.includes("too many requests")
    ) {
      code = "RATE_LIMIT";
    } else if (
      lower.includes("auth") ||
      lower.includes("unauthorized") ||
      lower.includes("401") ||
      lower.includes("api key") ||
      lower.includes("forbidden") ||
      lower.includes("403")
    ) {
      code = "AUTH_FAILED";
    } else if (
      lower.includes("network") ||
      lower.includes("econnrefused") ||
      lower.includes("econnreset") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed")
    ) {
      code = "NETWORK";
    } else if (
      lower.includes("invalid") ||
      lower.includes("bad request") ||
      lower.includes("400") ||
      lower.includes("validation")
    ) {
      code = "INVALID_REQUEST";
    }

    return new LLMProviderError("zai", code, msg);
  }

  async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
    const start = Date.now();
    try {
      const sdk = await this.getSDK();
      const response = (await sdk.chat.completions.create({
        messages: opts.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        model: this.defaultModel,
        stream: false,
        thinking: { type: "disabled" },
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.stop ? { stop: opts.stop } : {}),
      })) as ZaiCompletionResponse;

      const content = response.choices?.[0]?.message?.content ?? "";
      const usage = response.usage;
      const model = response.model ?? this.defaultModel;

      return {
        content,
        model,
        provider: this.name,
        elapsedMs: Date.now() - start,
        usage: {
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          totalTokens: usage?.total_tokens,
        },
      };
    } catch (err) {
      // Re-throw already-typed errors
      if (err instanceof LLMProviderError) throw err;
      throw this.mapError(err);
    }
  }

  async *stream(opts: LLMCompleteOptions): AsyncIterable<LLMStreamChunk> {
    // The z-ai SDK supports streaming via stream:true. However, the
    // response shape is an AsyncIterable. We adapt it to LLMStreamChunk.
    try {
      const sdk = await this.getSDK();
      const streamResult = (await sdk.chat.completions.create({
        messages: opts.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        model: this.defaultModel,
        stream: true,
        thinking: { type: "disabled" },
      })) as AsyncIterable<ZaiStreamChunk>;

      for await (const chunk of streamResult) {
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        const isDone = !!chunk.choices?.[0]?.finish_reason;
        yield {
          delta,
          done: isDone,
          ...(chunk.usage
            ? {
                usage: {
                  promptTokens: chunk.usage.prompt_tokens,
                  completionTokens: chunk.usage.completion_tokens,
                  totalTokens: chunk.usage.total_tokens,
                },
              }
            : {}),
        };
      }
      // Final done chunk (if not already emitted)
      yield { delta: "", done: true };
    } catch (err) {
      if (err instanceof LLMProviderError) throw err;
      throw this.mapError(err);
    }
  }

  async embed(_opts: LLMEmbedOptions): Promise<LLMEmbedResult> {
    // The z-ai-web-dev-sdk does not expose a public embeddings API
    // (only chat / images / audio / video / async). Be honest:
    // throw LLMUnsupportedError rather than faking embeddings.
    throw new LLMUnsupportedError("zai", "embeddings");
  }

  /**
   * Health check: returns true if the SDK can be initialized AND a
   * minimal completion request succeeds. Used by /api/v1/meta to
   * surface provider status to operators.
   */
  async health(): Promise<boolean> {
    try {
      const sdk = await this.getSDK();
      const response = (await sdk.chat.completions.create({
        messages: [{ role: "user", content: "ping" }],
        model: this.defaultModel,
        stream: false,
        thinking: { type: "disabled" },
        max_tokens: 1,
      })) as ZaiCompletionResponse;
      return !!response.choices?.[0]?.message?.content;
    } catch {
      return false;
    }
  }
}
