// ============================================================
// tests/unit/reform/reform-comparison-service.test.ts
// ------------------------------------------------------------
// G03-04 — Unit tests for the deterministic comparison service.
// Uses mocked Prisma + auth dependencies (same pattern as G03-02/03 unit tests).
// ============================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  withAuthenticatedTenant: vi.fn(),
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

import { compareReformAlternatives } from "@/lib/reform/reform-comparison-service";
import { PermissionDeniedError } from "@/lib/permissions";
import { NotFoundError } from "@/lib/reform/contracts";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue(undefined);
});

describe("G03-04 comparison service — authorization", () => {
  it("U-CMP-4: throws PermissionDeniedError for wrong role", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:alternative:read")
    );
    await expect(
      compareReformAlternatives(makeSession(), "p1")
    ).rejects.toThrow(/Permission denied/);
  });
});

describe("G03-04 comparison service — outputs", () => {
  it("U-CMP-1: returns matrix for proposal with 3 alternatives (with actual content)", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue({ id: "p1" }),
            },
            reformAlternative: {
              findMany: vi.fn().mockResolvedValue([
                {
                  id: "a1",
                  title: "Alt 1",
                  status: "draft",
                  costEstimateMin: "100.00",
                  costEstimateMax: "200.00",
                  costCurrency: "USD",
                  riskLevel: "low",
                  feasibilityScore: "high",
                  assumptions: ["assumption 1", "assumption 2"],
                  anticipatedOutcomes: ["outcome 1"],
                  draftedVia: "human",
                  simulated: false,
                  metadata: {},
                },
                {
                  id: "a2",
                  title: "Alt 2",
                  status: "selected",
                  costEstimateMin: null,
                  costEstimateMax: null,
                  costCurrency: "USD",
                  riskLevel: "medium",
                  feasibilityScore: "medium",
                  assumptions: [],
                  anticipatedOutcomes: [],
                  draftedVia: "llm_advisory",
                  simulated: true,
                  metadata: { provider: "stub" },
                },
                {
                  id: "a3",
                  title: "Alt 3",
                  status: "withdrawn",
                  costEstimateMin: "50.00",
                  costEstimateMax: null,
                  costCurrency: "EUR",
                  riskLevel: "high",
                  feasibilityScore: "unknown",
                  assumptions: ["assumption 3"],
                  anticipatedOutcomes: ["outcome 2", "outcome 3"],
                  draftedVia: "hybrid",
                  simulated: true,
                  metadata: { provider: "stub" },
                },
              ]),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    const result = await compareReformAlternatives(makeSession(), "p1");

    expect(result.proposalId).toBe("p1");
    expect(result.alternatives).toHaveLength(3);

    // U-CMP-7: actual assumptions[] text (not just count)
    expect(result.alternatives[0]!.assumptions).toEqual([
      "assumption 1",
      "assumption 2",
    ]);
    expect(result.alternatives[0]!.assumptionCount).toBe(2);

    // U-CMP-8: actual anticipatedOutcomes[] text
    expect(result.alternatives[2]!.anticipatedOutcomes).toEqual([
      "outcome 2",
      "outcome 3",
    ]);
    expect(result.alternatives[2]!.anticipatedOutcomeCount).toBe(2);

    // U-CMP-9: provenance per alternative
    expect(result.alternatives[0]!.provenance).toEqual({
      draftedVia: "human",
      simulated: false,
      provider: null,
    });
    expect(result.alternatives[1]!.provenance).toEqual({
      draftedVia: "llm_advisory",
      simulated: true,
      provider: "stub",
    });
    expect(result.alternatives[2]!.provenance).toEqual({
      draftedVia: "hybrid",
      simulated: true,
      provider: "stub",
    });

    // U-CMP-10: honestyBlock
    expect(result.honestyBlock.simulatedData).toBe(true); // a2 + a3 are simulated
    expect(result.honestyBlock.knownLimitations.length).toBeGreaterThan(0);

    // costRange correctly parsed
    expect(result.alternatives[0]!.costRange).toEqual({
      min: 100,
      max: 200,
      currency: "USD",
    });
    expect(result.alternatives[1]!.costRange).toBeNull(); // both null
    expect(result.alternatives[2]!.costRange).toEqual({
      min: 50,
      max: null,
      currency: "EUR",
    });
  });

  it("U-CMP-2: returns empty matrix for proposal with 0 alternatives", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue({ id: "p1" }),
            },
            reformAlternative: {
              findMany: vi.fn().mockResolvedValue([]),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    const result = await compareReformAlternatives(makeSession(), "p1");
    expect(result.alternatives).toEqual([]);
    expect(result.honestyBlock.simulatedData).toBe(false);
  });

  it("U-CMP-3: throws NotFoundError for non-existent proposal", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
            reformAlternative: {
              findMany: vi.fn(),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      compareReformAlternatives(makeSession(), "nonexistent")
    ).rejects.toThrow(NotFoundError);
  });

  it("U-CMP-6: returns all alternatives including withdrawn ones", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue({ id: "p1" }),
            },
            reformAlternative: {
              findMany: vi.fn().mockResolvedValue([
                {
                  id: "a1",
                  title: "Active",
                  status: "draft",
                  costEstimateMin: null,
                  costEstimateMax: null,
                  costCurrency: "USD",
                  riskLevel: "low",
                  feasibilityScore: "high",
                  assumptions: [],
                  anticipatedOutcomes: [],
                  draftedVia: "human",
                  simulated: false,
                  metadata: {},
                },
                {
                  id: "a2",
                  title: "Withdrawn",
                  status: "withdrawn",
                  costEstimateMin: null,
                  costEstimateMax: null,
                  costCurrency: "USD",
                  riskLevel: "low",
                  feasibilityScore: "high",
                  assumptions: [],
                  anticipatedOutcomes: [],
                  draftedVia: "human",
                  simulated: false,
                  metadata: {},
                },
              ]),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    const result = await compareReformAlternatives(makeSession(), "p1");
    expect(result.alternatives).toHaveLength(2);
    expect(result.alternatives[0]!.status).toBe("draft");
    expect(result.alternatives[1]!.status).toBe("withdrawn");
  });

  it("U-CMP-11: output schema has NO recommended/ranking/confidenceScore fields (Zod strict)", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue({ id: "p1" }),
            },
            reformAlternative: {
              findMany: vi.fn().mockResolvedValue([]),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    const result = await compareReformAlternatives(makeSession(), "p1");
    expect(result).not.toHaveProperty("recommended");
    expect(result).not.toHaveProperty("ranking");
    expect(result).not.toHaveProperty("confidenceScore");
    expect(result.comparisonMatrix).not.toHaveProperty("recommended");
    expect(result.comparisonMatrix).not.toHaveProperty("ranking");
  });
});
