# ADR-0002 — LLM Provider Abstraction

**Date:** 2026-10-16
**Status:** Accepted (founder-mandated)
**Mission:** 00-01

## Context

The Balance's `Balance Master` orchestrator (mission 00-06) and downstream expert agents will require LLM capabilities: completion, streaming, function-calling, and embedding (for RAG).

The founder's directive is explicit:

> "أرى تحفظاً على اعتماد `z-ai-web-dev-sdk` كمزود أساسي وحيد للذكاء الاصطناعي. الأفضل إنشاء Provider Abstraction يسمح باستخدام نماذج مختلفة، بما فيها GLM، دون ربط مستقبل الميزان بمكتبة أو شركة واحدة."

(Translation: I object to binding `z-ai-web-dev-sdk` as the sole AI provider. A Provider Abstraction allowing different models — including GLM — is preferable, so the project's future is not tied to one library or company.)

## Decision

Define a provider-agnostic `LLMProvider` interface in `src/lib/llm/provider.ts`. Every LLM interaction in The Balance goes through this interface — never through a vendor SDK directly.

### Interface (summary)

```typescript
interface LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly defaultEmbeddingModel: string;
  complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult>;
  stream(opts: LLMCompleteOptions): AsyncIterable<LLMStreamChunk>;
  embed(opts: LLMEmbedOptions): Promise<LLMEmbedResult>;
  health(): Promise<boolean>;
}
```

### Provider selection

The active provider is selected by `LLM_PROVIDER` env var:

| Value | Provider | Status |
|---|---|---|
| `stub` (default) | `StubProvider` — deterministic, no real LLM | Shipped in 00-01 |
| `zai` | `ZaiProvider` — uses `z-ai-web-dev-sdk` | To be added in 00-06 |
| `openai` | `OpenAIProvider` — uses OpenAI API | To be added when needed |
| `anthropic` | `AnthropicProvider` — uses Anthropic API | To be added when needed |

### Provider implementation rules

1. **No vendor SDK imported at the top level of `index.ts`** — only inside the factory function, so unused providers don't inflate the bundle.
2. **Each provider file is self-contained** — no cross-imports between providers.
3. **Providers throw `LLMUnsupportedError`** for capabilities they don't have (e.g., a local model without function-calling), rather than faking it.
4. **Every result carries `provider` + `model` + `elapsedMs`** for audit.
5. **Streaming is mandatory** — providers that don't support streaming must buffer internally and emit one chunk.

## Alternatives considered

### Single provider (z-ai-web-dev-sdk)
- **Rejected:** violates founder directive; creates vendor lock-in.

### LangChain
- **Considered:** provides abstraction over many providers.
- **Rejected:** heavy dependency, opinionated patterns, abstraction leaks. The Balance's needs are simple enough that a 50-line interface suffices.

### Vercel AI SDK
- **Considered:** first-class Next.js integration.
- **Rejected:** still a layer on top of vendor SDKs; doesn't solve the abstraction requirement cleanly. May revisit for streaming UI helpers in 00-08.

## Consequences

- **Positive:** Vendor independence. Tests use `StubProvider` (deterministic, free, fast). Switching providers is a config change, not a code change.
- **Negative:** Slight indirection on every LLM call. Real providers must be implemented when needed (00-06 for `ZaiProvider`).
- **Trade-off accepted:** The interface is minimal — adding capabilities (e.g., vision, audio) will require extending it. This is intentional; YAGNI until 00-04+.

## Verification

- `StubProvider` implements the full interface (verified by `tests/unit/llm-provider.test.ts`).
- `getLLMProvider()` factory correctly dispatches on `LLM_PROVIDER` env var.
- Unknown provider throws a clear error listing available options.

## Future work

- **00-06:** Implement `ZaiProvider` using `z-ai-web-dev-sdk` for the Balance Master stub.
- **00-04:** Implement embedding-backed RAG; the `embed()` method is part of this interface for that reason.
- **00-08:** Streaming UI may use Vercel AI SDK helpers *on top of* this interface, not instead of it.
