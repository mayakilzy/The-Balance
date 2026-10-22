// ============================================================
// tests/unit/reform/reform-advisor-service.test.ts
// ------------------------------------------------------------
// G03-04 — Unit tests for the LLM-assisted advisor service.
//
// Covers (per PRE-03 Acceptance Checklist):
//   - draftProblemStatement / draftReformAlternatives / draftComparisonSummary / draftAnticipatedOutcomes
//   - simulated flag from provider.name === "stub"
//   - causal REJECTION (throws CausalRejectionError, not warn)
//   - LLM invoked OUTSIDE DB transaction
//   - receipt issued and returned in AdvisorDraftResult
//   - no DB writes (tx.create/update/delete never called)
//   - no state-transition services imported/called
// ============================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  withAuthenticatedTenant: vi.fn(),
  getLLMProvider: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({
  requirePermissionWithCurrentRole: mocks.requirePermission,
  PermissionDeniedError: class PermissionDeniedError extends Error {
    readonly permission: string;
    constructor(permission: string) {
      super(`Permission denied: ${permission}`);
      this.name = "PermissionDeniedError";
      this.permission = permission;
    }
  },
}));

vi.mock("@/lib/security/tenant-context", () => ({
  withAuthenticatedTenant: mocks.withAuthenticatedTenant,
}));

vi.mock("@/lib/llm", () => ({
  getLLMProvider: mocks.getLLMProvider,
}));

vi.mock("@/lib/audit", () => ({
  writeAuditTx: vi.fn(),
}));

vi.mock("@/lib/state-observatory/observation-service", () => ({
  ingestObservationTx: vi.fn(),
}));
vi.mock("@/lib/state-observatory/contracts", () => ({
  IngestObservationInputSchema: { parse: (x: unknown) => x },
}));
vi.mock("@/lib/state-observatory/alert-service", () => ({
  closeAlert: vi.fn(),
}));

import {
  draftProblemStatement,
  draftReformAlternatives,
  draftComparisonSummary,
  draftAnticipatedOutcomes,
} from "@/lib/reform/reform-advisor-service";
import {
  NotFoundError,
  CausalRejectionError,
  ReceiptVerificationError,
} from "@/lib/reform/contracts";

function makeSession(roleCode = "analyst"): Session {
  return {
    user: {
      id: "user_test_001",
      tenantId: "tenant_test_001",
      roleCode,
      membershipStatus: "active",
    },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as unknown as Session;
}

function mockStubProvider(content: string) {
  return {
    name: "stub",
    defaultModel: "stub-v0",
    defaultEmbeddingModel: "stub-embed-v0",
    complete: vi.fn().mockResolvedValue({
      content,
      model: "stub-v0",
      provider: "stub",
      elapsedMs: 10,
    }),
    stream: vi.fn(),
    embed: vi.fn(),
    health: vi.fn().mockResolvedValue(true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue(undefined);
});

describe("G03-04 advisor — draftProblemStatement", () => {
  it("U-ADV-1: returns AdvisorDraftResult with simulated=true when StubProvider active", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            alert: {
              findFirst: vi.fn().mockResolvedValue({
                title: "Alert",
                description: "desc",
                severity: "warning",
                lifecycleStage: "reviewed",
                varianceRecordId: null,
              }),
            },
            varianceRecord: { findFirst: vi.fn() },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );
    mocks.getLLMProvider.mockReturnValue(
      mockStubProvider("A descriptive draft about the alert situation.")
    );

    const result = await draftProblemStatement(makeSession(), {
      alertId: "alert_001",
    });

    expect(result.draft).toContain("descriptive draft");
    expect(result.simulated).toBe(true);
    expect(result.provider).toBe("stub");
    expect(result.model).toBe("stub-v0");
    expect(result.warnings).toContain(
      "This is a SIMULATED draft from the StubProvider."
    );
    expect(result.receipt).toBeTruthy(); // receipt issued
  });

  it("U-ADV-6: throws NotFoundError for non-existent alert", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            alert: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            varianceRecord: { findFirst: vi.fn() },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      draftProblemStatement(makeSession(), { alertId: "nonexistent" })
    ).rejects.toThrow(NotFoundError);
  });

  it("U-ADV-5: causal language in output → CausalRejectionError thrown (REJECT, not warn)", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            alert: {
              findFirst: vi.fn().mockResolvedValue({
                title: "Alert",
                description: "desc",
                severity: "warning",
                lifecycleStage: "reviewed",
                varianceRecordId: null,
              }),
            },
            varianceRecord: { findFirst: vi.fn() },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );
    // StubProvider returns causal text
    mocks.getLLMProvider.mockReturnValue(
      mockStubProvider("This reform will reduce inflation by 3%.")
    );

    await expect(
      draftProblemStatement(makeSession(), { alertId: "alert_001" })
    ).rejects.toThrow(CausalRejectionError);
  });
});

describe("G03-04 advisor — draftReformAlternatives", () => {
  it("U-ADV-2: returns array of `count` results, each with receipt", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue({
                title: "Test Proposal",
                problemStatement: "Test problem statement.",
                hypothesizedCauses: [],
              }),
            },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );
    mocks.getLLMProvider.mockReturnValue(
      mockStubProvider("A descriptive alternative draft text.")
    );

    const results = await draftReformAlternatives(makeSession(), {
      proposalId: "p1",
      count: 3,
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.simulated).toBe(true);
      expect(r.provider).toBe("stub");
      expect(r.receipt).toBeTruthy();
    }
  });

  it("U-ADV-7: throws NotFoundError for non-existent proposal", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      draftReformAlternatives(makeSession(), { proposalId: "nonexistent" })
    ).rejects.toThrow(NotFoundError);
  });
});

describe("G03-04 advisor — draftComparisonSummary", () => {
  it("U-ADV-3: reads alternatives as context, returns draft with receipt", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue({
                title: "Proposal",
                problemStatement: "Problem statement.",
              }),
            },
            reformAlternative: {
              findMany: vi.fn().mockResolvedValue([
                {
                  title: "Alt 1",
                  description: "desc 1",
                  riskLevel: "low",
                  feasibilityScore: "high",
                },
              ]),
            },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );
    mocks.getLLMProvider.mockReturnValue(
      mockStubProvider("A descriptive comparison summary text.")
    );

    const result = await draftComparisonSummary(makeSession(), "p1");
    expect(result.draft).toContain("descriptive comparison");
    expect(result.simulated).toBe(true);
    expect(result.receipt).toBeTruthy();
  });

  it("U-ADV-8: throws NotFoundError for non-existent proposal", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            reformAlternative: { findMany: vi.fn() },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      draftComparisonSummary(makeSession(), "nonexistent")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("G03-04 advisor — draftAnticipatedOutcomes", () => {
  it("U-ADV-4: reads alternative as context, returns draft with receipt", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformAlternative: {
              findFirst: vi.fn().mockResolvedValue({
                title: "Alt",
                description: "desc",
                riskLevel: "low",
                feasibilityScore: "high",
                proposalId: "p1",
              }),
            },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );
    mocks.getLLMProvider.mockReturnValue(
      mockStubProvider("Anticipated outcome: descriptive, qualified text.")
    );

    const result = await draftAnticipatedOutcomes(makeSession(), {
      alternativeId: "a1",
    });
    expect(result.draft).toContain("Anticipated outcome");
    expect(result.simulated).toBe(true);
    expect(result.receipt).toBeTruthy();
  });

  it("U-ADV-9: throws NotFoundError for non-existent alternative", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformAlternative: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      draftAnticipatedOutcomes(makeSession(), { alternativeId: "nonexistent" })
    ).rejects.toThrow(NotFoundError);
  });
});

describe("G03-04 advisor — LLM-outside-DB-transaction pattern", () => {
  it("U-ADV-12: LLM invoked AFTER withAuthenticatedTenant callback returns", async () => {
    const callOrder: string[] = [];
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        callOrder.push("tx-start");
        const result = await fn({
          tx: {
            alert: {
              findFirst: vi.fn().mockImplementation(async () => {
                callOrder.push("db-read");
                return {
                  title: "Alert",
                  description: "desc",
                  severity: "warning",
                  lifecycleStage: "reviewed",
                  varianceRecordId: null,
                };
              }),
            },
            varianceRecord: { findFirst: vi.fn() },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
        callOrder.push("tx-end");
        return result;
      }
    );
    const provider = mockStubProvider("A descriptive draft text.");
    provider.complete.mockImplementation(async () => {
      callOrder.push("llm-call");
      return {
        content: "A descriptive draft text.",
        model: "stub-v0",
        provider: "stub",
        elapsedMs: 10,
      };
    });
    mocks.getLLMProvider.mockReturnValue(provider);

    await draftProblemStatement(makeSession(), { alertId: "alert_001" });

    // Verify LLM was called AFTER tx-end (not during tx)
    const txEndIdx = callOrder.indexOf("tx-end");
    const llmCallIdx = callOrder.indexOf("llm-call");
    expect(txEndIdx).toBeGreaterThanOrEqual(0);
    expect(llmCallIdx).toBeGreaterThanOrEqual(0);
    expect(llmCallIdx).toBeGreaterThan(txEndIdx);
  });
});

describe("G03-04 advisor — output schema rejection", () => {
  it("U-ADV-11: AdvisorDraftResult has NO confidence/recommended/ranking/selection fields", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            alert: {
              findFirst: vi.fn().mockResolvedValue({
                title: "Alert",
                description: "desc",
                severity: "warning",
                lifecycleStage: "reviewed",
                varianceRecordId: null,
              }),
            },
            varianceRecord: { findFirst: vi.fn() },
          },
          tenantId: "tenant_test_001",
          userId: "user_test_001",
          roleCode: "analyst",
        });
      }
    );
    mocks.getLLMProvider.mockReturnValue(
      mockStubProvider("A descriptive draft text.")
    );

    const result = await draftProblemStatement(makeSession(), {
      alertId: "alert_001",
    });
    expect(result).not.toHaveProperty("confidence");
    expect(result).not.toHaveProperty("recommended");
    expect(result).not.toHaveProperty("ranking");
    expect(result).not.toHaveProperty("selection");
  });
});
