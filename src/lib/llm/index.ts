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
//
// Delivery 04: the `zai` provider is now registered + functional.
// Set LLM_PROVIDER=zai in production to enable real LLM calls.
// The factory uses dynamic import so the SDK is only loaded when
// actually needed (LLM_PROVIDER=zai); when LLM_PROVIDER=stub,
// the SDK is never imported.
// ============================================================
import { env } from "@/lib/env";
import type { LLMProvider } from "./provider";
import { StubProvider } from "./stub-provider";

type ProviderFactory = () => LLMProvider | Promise<LLMProvider>;

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  stub: () => new StubProvider(),
  zai: async () => {
    const { ZaiProvider } = await import("./zai-provider");
    return new ZaiProvider();
  },
  // openai: () => import("./openai-provider").then(m => new m.OpenAIProvider()),
  // anthropic: () => import("./anthropic-provider").then(m => new m.AnthropicProvider()),
};

let _provider: LLMProvider | null = null;
let _providerPromise: Promise<LLMProvider> | null = null;

export function getLLMProvider(): LLMProvider {
  // Synchronous accessor — returns the cached provider or throws
  // if async init hasn't completed. For async-safe initialization,
  // use getLLMProviderAsync() below.
  if (_provider === null) {
    const factory = PROVIDER_FACTORIES[env.LLM_PROVIDER];
    if (!factory) {
      throw new Error(
        `Unknown LLM_PROVIDER='${env.LLM_PROVIDER}'. ` +
          `Available: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`
      );
    }
    // The stub factory is synchronous — assign directly
    if (env.LLM_PROVIDER === "stub") {
      _provider = factory() as LLMProvider;
    } else {
      // For async providers (zai, openai, etc.), throw if not yet
      // initialized via getLLMProviderAsync(). The caller should
      // call the async variant first.
      throw new Error(
        `LLM_PROVIDER='${env.LLM_PROVIDER}' requires async initialization. ` +
          `Call getLLMProviderAsync() first to await SDK setup, then use getLLMProvider().`
      );
    }
  }
  return _provider;
}

/**
 * Async initializer for LLM providers that require SDK setup
 * (zai, openai, anthropic). Safe to call multiple times — caches
 * the init promise so concurrent callers wait for the same init.
 *
 * For the stub provider (default), this is a no-op (returns
 * immediately).
 */
export async function getLLMProviderAsync(): Promise<LLMProvider> {
  if (_provider !== null) return _provider;
  if (_providerPromise !== null) return _providerPromise;

  const factory = PROVIDER_FACTORIES[env.LLM_PROVIDER];
  if (!factory) {
    throw new Error(
      `Unknown LLM_PROVIDER='${env.LLM_PROVIDER}'. ` +
        `Available: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`
    );
  }

  _providerPromise = Promise.resolve(factory()).then((p) => {
    _provider = p;
    return p;
  });
  return _providerPromise;
}

export function resetLLMProviderForTesting(): void {
  _provider = null;
  _providerPromise = null;
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
export { ZaiProvider } from "./zai-provider";
