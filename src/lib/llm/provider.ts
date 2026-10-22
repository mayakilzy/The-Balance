// ============================================================
// llm/provider.ts — Provider-agnostic LLM interface
// ------------------------------------------------------------
// The Balance must NOT be bound to a single LLM vendor. This interface
// is the contract every provider implements. The factory in `index.ts`
// selects the active provider based on LLM_PROVIDER env var.
//
// Design principles:
// 1. No vendor SDK is imported in this file — only type definitions.
// 2. Providers live in sibling files (zai-provider.ts, openai-provider.ts).
// 3. The StubProvider returns deterministic responses for tests + 00-01.
// 4. Embedding is part of the contract because RAG (00-04) needs it.
// 5. Streaming is supported via AsyncIterable for real-time UIs (00-08).
//
// See ADR-0002 for the full rationale.
// ============================================================

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Optional tool-call payload for role="assistant" or role="tool"
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface LLMCompleteOptions {
  messages: LLMMessage[];
  /** Max output tokens. Provider clamps to model max. */
  maxTokens?: number;
  /** 0.0–2.0; provider maps to its own sampling param. */
  temperature?: number;
  /** Optional tool definitions for function-calling. */
  tools?: LLMToolDefinition[];
  /** Stop sequences. */
  stop?: string[];
  /** Caller-provided trace id for observability. */
  traceId?: string;
}

export interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface LLMCompleteResult {
  content: string;
  toolCalls?: LLMCompleteOptions["tools"] extends infer T
    ? Array<{ id: string; name: string; arguments: string }>
    : never;
  // Usage stats (provider fills what it can)
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  // Provider's internal model identifier (for audit)
  model: string;
  // Provider name (e.g., "stub", "zai", "openai")
  provider: string;
  // Elapsed wall-clock ms
  elapsedMs: number;
}

export interface LLMEmbedOptions {
  input: string | string[];
  /** Desired vector dimensionality (provider may ignore). */
  dimensions?: number;
  traceId?: string;
}

export interface LLMEmbedResult {
  vectors: number[][];
  model: string;
  provider: string;
  elapsedMs: number;
  usage?: { totalTokens?: number };
}

export interface LLMStreamChunk {
  delta: string;
  // Final chunk carries usage + done=true
  done: boolean;
  usage?: LLMCompleteResult["usage"];
}

/**
 * The contract every LLM provider implements.
 * A provider that cannot do something (e.g., a local model without
 * function-calling) SHOULD throw a typed error rather than fake it.
 */
export interface LLMProvider {
  /** Unique provider name (e.g., "stub", "zai", "openai", "anthropic"). */
  readonly name: string;

  /** Default model identifier for completions. */
  readonly defaultModel: string;

  /** Default model identifier for embeddings. */
  readonly defaultEmbeddingModel: string;

  /** Non-streaming completion. */
  complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult>;

  /** Streaming completion. Yields deltas; final chunk has done=true. */
  stream(opts: LLMCompleteOptions): AsyncIterable<LLMStreamChunk>;

  /** Embedding (for RAG — used from 00-04). */
  embed(opts: LLMEmbedOptions): Promise<LLMEmbedResult>;

  /** Health check — returns true if the provider is reachable. */
  health(): Promise<boolean>;
}

/**
 * Typed errors so callers can distinguish provider failures from
 * application logic errors.
 */
export class LLMProviderError extends Error {
  readonly provider: string;
  readonly code: string;
  constructor(provider: string, code: string, message: string) {
    super(`[${provider}] ${code}: ${message}`);
    this.name = "LLMProviderError";
    this.provider = provider;
    this.code = code;
  }
}

export class LLMUnsupportedError extends LLMProviderError {
  constructor(provider: string, capability: string) {
    super(provider, "UNSUPPORTED", `capability '${capability}' not supported`);
    this.name = "LLMUnsupportedError";
  }
}
