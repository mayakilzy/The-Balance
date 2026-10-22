// ============================================================
// tests/unit/llm-provider.test.ts — Stub provider contract test
// ------------------------------------------------------------
// Verifies the StubProvider honors the LLMProvider interface and
// returns deterministic outputs. This same test file structure will
// be reused for real providers (zai, openai) in 00-06.
// ============================================================
import { describe, it, expect, beforeEach } from "vitest";
import { StubProvider } from "@/lib/llm/stub-provider";
import type { LLMCompleteOptions } from "@/lib/llm/provider";

describe("StubProvider", () => {
  let provider: StubProvider;

  beforeEach(() => {
    provider = new StubProvider();
  });

  it("implements the LLMProvider interface", () => {
    expect(provider.name).toBe("stub");
    expect(provider.defaultModel).toBe("stub-v0");
    expect(provider.defaultEmbeddingModel).toBe("stub-embed-v0");
    expect(typeof provider.complete).toBe("function");
    expect(typeof provider.stream).toBe("function");
    expect(typeof provider.embed).toBe("function");
    expect(typeof provider.health).toBe("function");
  });

  it("complete() returns deterministic canned content", async () => {
    const opts: LLMCompleteOptions = {
      messages: [
        { role: "system", content: "You are a test." },
        { role: "user", content: "Hello world" },
      ],
    };

    const result1 = await provider.complete(opts);
    const result2 = await provider.complete(opts);

    expect(result1.content).toBe(result2.content);
    expect(result1.content).toContain("[STUB PROVIDER");
    expect(result1.content).toContain("Hello world");
    expect(result1.provider).toBe("stub");
    expect(result1.model).toBe("stub-v0");
    expect(result1.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result1.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("complete() handles empty messages array", async () => {
    const result = await provider.complete({ messages: [] });
    expect(result.content).toContain("(no user input)");
  });

  it("stream() yields chunks and terminates with done=true", async () => {
    const opts: LLMCompleteOptions = {
      messages: [{ role: "user", content: "Stream test" }],
    };

    const chunks = [];
    for await (const chunk of provider.stream(opts)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk).toBeDefined();
    expect(lastChunk!.done).toBe(true);
    expect(lastChunk!.delta).toBe("");
  });

  it("embed() returns deterministic vectors", async () => {
    const result = await provider.embed({ input: "test text" });

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]?.length).toBe(8); // default dimensions
    expect(result.provider).toBe("stub");
    expect(result.model).toBe("stub-embed-v0");

    // Same input → same vector
    const result2 = await provider.embed({ input: "test text" });
    expect(result2.vectors[0]).toEqual(result.vectors[0]);
  });

  it("embed() handles array input", async () => {
    const result = await provider.embed({
      input: ["one", "two", "three"],
      dimensions: 4,
    });
    expect(result.vectors).toHaveLength(3);
    expect(result.vectors[0]?.length).toBe(4);
  });

  it("health() always returns true (in-process provider)", async () => {
    expect(await provider.health()).toBe(true);
  });
});
