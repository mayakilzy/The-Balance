// ============================================================
// llm/index.ts — Provider factory + singleton accessor
// ------------------------------------------------------------
// Selects the active LLMProvider based on LLM_PROVIDER env var.
// Lazy-init: the provider is constructed on first use so test setups
// can mutate process.env before the first call.
//
// To add a real provider (e.g., zai):
//   1. Create `zai-provider.ts` implementing LLMProvider.
//   2. Register it in the PROVIDER_FACTORIES map below.
//   3. Do NOT import z-ai-web-dev-sdk at the top level of this file —
//      only inside the factory, so unused providers don't inflate the
//      bundle.
// ============================================================
import { env } from "@/lib/env";
import type { LLMProvider } from "./provider";
import { StubProvider } from "./stub-provider";

type ProviderFactory = () => LLMProvider;

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  stub: () => new StubProvider(),
  // zai: () => import("./zai-provider").then(m => new m.ZaiProvider()),
  // openai: () => import("./openai-provider").then(m => new m.OpenAIProvider()),
  // anthropic: () => import("./anthropic-provider").then(m => new m.AnthropicProvider()),
};

let _provider: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (_provider === null) {
    const factory = PROVIDER_FACTORIES[env.LLM_PROVIDER];
    if (!factory) {
      throw new Error(
        `Unknown LLM_PROVIDER='${env.LLM_PROVIDER}'. ` +
          `Available: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`
      );
    }
    _provider = factory();
  }
  return _provider;
}

export function resetLLMProviderForTesting(): void {
  _provider = null;
}

// Re-export public types
export type {
  LLMProvider,
  LLMMessage,
  LLMCompleteOptions,
  LLMCompleteResult,
  LLMEmbedOptions,
  LLMEmbedResult,
  LLMStreamChunk,
  LLMToolDefinition,
} from "./provider";
export { LLMProviderError, LLMUnsupportedError } from "./provider";
export { StubProvider } from "./stub-provider";
