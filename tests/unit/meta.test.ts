// ============================================================
// tests/unit/meta.test.ts — /api/v1/meta smoke test
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/v1/meta/route";

vi.mock("@/lib/env", () => ({
  env: {
    APP_NAME: "The Balance",
    APP_VERSION: "0.0.1-test",
    NODE_ENV: "test",
    LLM_PROVIDER: "stub",
  },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("GET /api/v1/meta", () => {
  it("returns build metadata with all feature flags off", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.name).toBe("The Balance");
    expect(body.version).toBe("0.0.1-test");
    expect(body.group).toBe("00");
    expect(body.mission).toBe("00-01");
    expect(body.llm.provider).toBe("stub");
    expect(body.features).toMatchObject({
      auth: false,
      evidence: false,
      strategy: false,
      tasks: false,
      capabilities: false,
      ui: false,
    });
  });
});
