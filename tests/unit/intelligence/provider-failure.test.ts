// ============================================================
// tests/unit/intelligence/provider-failure.test.ts
// ------------------------------------------------------------
// Delivery 04 — Deterministic provider failure test.
//
// Verifies that when the LLM provider fails (timeout, auth error,
// network error, etc.), the intelligence-service:
//   1. Does NOT fabricate a successful analysis
//   2. Returns a clear missing_information block noting the failure
//   3. Still returns the contextUsed counts (so the analyst sees
//      what context was prepared)
//   4. Still includes the mandatory disclaimer
//
// This test is DETERMINISTIC — it does NOT depend on a real external
// LLM call. It uses a FailingProvider (injected via
// setLLMProviderForTesting) that always throws LLMProviderError.
//
// Per owner directive: "اختبر فشل المزود بصورة حتمية وتحقق من
// وضوح النتيجة دون اختلاق تحليل ناجح" — test provider failure
// deterministically and verify the result is clear without faking
// a successful analysis.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Session } from "next-auth";
import {
  setLLMProviderForTesting,
  resetLLMProviderForTesting,
  LLMProviderError,
} from "@/lib/llm";
import type {
  LLMProvider,
  LLMCompleteOptions,
  LLMCompleteResult,
  LLMEmbedOptions,
  LLMEmbedResult,
  LLMStreamChunk,
} from "@/lib/llm";
import { analyzeProblem } from "@/lib/intelligence/intelligence-service";

const DIRECT_URL =
  process.env.DIRECT_URL ??
  "postgresql://balance_admin:balance_admin_dev_only@localhost:5433/balance?schema=public";

// A provider that ALWAYS throws LLMProviderError on complete().
class FailingProvider implements LLMProvider {
  readonly name = "failing-test-provider";
  readonly defaultModel = "fail-v0";
  readonly defaultEmbeddingModel = "fail-embed-v0";

  async complete(_opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
    throw new LLMProviderError(
      "failing-test-provider",
      "TIMEOUT",
      "Simulated provider timeout for deterministic failure test"
    );
  }

  async embed(_opts: LLMEmbedOptions): Promise<LLMEmbedResult> {
    throw new LLMProviderError("failing-test-provider", "TIMEOUT", "simulated");
  }

  async health(): Promise<boolean> {
    return false;
  }

  // stream is required by the interface but not used in this test
  async *stream(_opts: LLMCompleteOptions): AsyncIterable<LLMStreamChunk> {
    throw new LLMProviderError("failing-test-provider", "TIMEOUT", "simulated");
  }
}

// A provider that throws AUTH_FAILED specifically
class AuthFailingProvider implements LLMProvider {
  readonly name = "auth-failing";
  readonly defaultModel = "fail-v0";
  readonly defaultEmbeddingModel = "fail-embed-v0";

  async complete(_opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
    throw new LLMProviderError(
      "auth-failing",
      "AUTH_FAILED",
      "Simulated authentication failure for deterministic test"
    );
  }

  async embed(_opts: LLMEmbedOptions): Promise<LLMEmbedResult> {
    throw new LLMProviderError("auth-failing", "AUTH_FAILED", "simulated");
  }

  async health(): Promise<boolean> {
    return false;
  }

  async *stream(_opts: LLMCompleteOptions): AsyncIterable<LLMStreamChunk> {
    throw new LLMProviderError("auth-failing", "AUTH_FAILED", "simulated");
  }
}

let adminDb: PrismaClient;
let tenantAId: string;
let analystUserId: string;
let adminUserId: string;
let testAlertId: string;

function makeSession(user: {
  id: string;
  tenantId: string;
  roleCode: string;
  membershipStatus: string;
}): Session {
  return {
    user: {
      id: user.id,
      tenantId: user.tenantId,
      roleCode: user.roleCode,
      membershipStatus: user.membershipStatus,
    },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as unknown as Session;
}

describe("Provider Failure Handling (deterministic — no real LLM call)", () => {
  beforeAll(async () => {
    adminDb = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

    const tenantA = await adminDb.tenant.findUnique({
      where: { code: "DML-MOP-TENANT" },
    });
    if (!tenantA) throw new Error("Tenant A not seeded");
    tenantAId = tenantA.id;

    const analyst = await adminDb.user.findUnique({
      where: { email: "analyst@demolandia.test" },
    });
    const admin = await adminDb.user.findUnique({
      where: { email: "admin@demolandia.test" },
    });
    if (!analyst || !admin) throw new Error("Test users not seeded");
    analystUserId = analyst.id;
    adminUserId = admin.id;

    // Create a strategy + version + alert for the test
    const strategy = await adminDb.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "G04-D4 Failure Test Strategy",
        createdBy: analystUserId,
      },
    });
    const sv = await adminDb.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "approved",
        approvedBy: adminUserId,
        approvedAt: new Date(),
        metadata: { simulated: true },
        createdBy: analystUserId,
      },
    });
    const alert = await adminDb.alert.create({
      data: {
        tenantId: tenantAId,
        strategyVersionId: sv.id,
        title: "G04-D4 Failure Test Alert",
        description: "Test alert for provider failure handling",
        severity: "warning",
        lifecycleStage: "detected",
        createdBy: "system",
      },
    });
    testAlertId = alert.id;

    // Inject the FailingProvider so every LLM call will throw
    setLLMProviderForTesting(new FailingProvider());
  }, 30_000);

  afterAll(async () => {
    // Restore the real provider
    resetLLMProviderForTesting();
    // Clean up test fixtures
    if (adminDb && testAlertId) {
      await adminDb.alert.deleteMany({ where: { id: testAlertId } }).catch(() => {});
      await adminDb.strategyVersion.deleteMany({
        where: { tenantId: tenantAId, strategy: { title: "G04-D4 Failure Test Strategy" } },
      }).catch(() => {});
      await adminDb.strategy.deleteMany({
        where: { tenantId: tenantAId, title: "G04-D4 Failure Test Strategy" },
      }).catch(() => {});
      await adminDb.auditLog.deleteMany({
        where: { tenantId: tenantAId, action: "intelligence.analysis.requested" },
      }).catch(() => {});
      await adminDb.$disconnect();
    }
  }, 30_000);

  it("when provider fails (TIMEOUT), analysis result contains a missing_information block with the failure — NOT a fabricated success", async () => {
    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const result = await analyzeProblem(session, {
      alertId: testAlertId,
      question: "What are the likely causes of this alert?",
    });

    // 1. The result must NOT be empty
    expect(result).toBeDefined();
    expect(result.blocks.length).toBeGreaterThan(0);

    // 2. The provider name must be the FAILING provider (not a real one)
    //    — this proves no fallback to a "successful" provider happened
    expect(result.provider).toBe("failing-test-provider");

    // 3. There MUST be a missing_information block noting the failure
    const missingInfoBlocks = result.blocks.filter(
      (b) => b.kind === "missing_information"
    );
    expect(missingInfoBlocks.length).toBeGreaterThan(0);
    const failureBlock = missingInfoBlocks[0]!;
    expect(failureBlock.text).toContain("LLM provider failed");
    expect(failureBlock.text).toContain("TIMEOUT");
    expect(failureBlock.text).toContain("deterministic failure test");

    // 4. The summary must NOT claim a successful analysis
    expect(result.summary).toMatch(/not parseable|no output|failed/i);

    // 5. The contextUsed counts must still reflect what was gathered
    expect(result.contextUsed.alertCount).toBe(1);

    // 6. The mandatory disclaimer must still be present
    expect(result.disclaimer).toContain("AI-assisted");
    expect(result.disclaimer).toContain("human decides");
  }, 30_000);

  it("when provider fails with AUTH_FAILED, the missing_information block includes the error code", async () => {
    setLLMProviderForTesting(new AuthFailingProvider());

    const session = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    const result = await analyzeProblem(session, {
      alertId: testAlertId,
      question: "Test auth failure handling",
    });

    const missingBlocks = result.blocks.filter((b) => b.kind === "missing_information");
    expect(missingBlocks.length).toBeGreaterThan(0);
    expect(missingBlocks[0]!.text).toContain("AUTH_FAILED");
    expect(result.provider).toBe("auth-failing");
  }, 30_000);
});
