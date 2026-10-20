// ============================================================
// tests/unit/reform/reform-alternative-service.test.ts
// ------------------------------------------------------------
// G03-03 — Unit tests for the alternative service.
// Tests Zod validation, authorization, lifecycle rules, and max 5.
// Concurrency tests are in tests/integration/g03-03-*.ts (real PostgreSQL).
// ============================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  withAuthenticatedTenant: vi.fn(),
  writeAuditTx: vi.fn(),
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
  writeAuditTx: mocks.writeAuditTx,
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
  addReformAlternative,
  selectAlternative,
  withdrawAlternative,
} from "@/lib/reform/reform-alternative-service";
import { PermissionDeniedError } from "@/lib/permissions";
import { NotFoundError, ConflictError } from "@/lib/reform/contracts";

function makeSession(roleCode = "analyst"): Session {
  return {
    user: { id: "user_test_001", tenantId: "tenant_test_001", roleCode, membershipStatus: "active" },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as unknown as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue(undefined);
  mocks.writeAuditTx.mockResolvedValue(undefined);
});

// ============================================================
// Authorization tests
// ============================================================
describe("G03-03 authorization", () => {
  it("addReformAlternative requires reform:alternative:write", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new PermissionDeniedError("reform:alternative:write"));
    await expect(
      addReformAlternative(makeSession(), { proposalId: "p1", title: "Test Alternative Title", description: "Test alternative description for unit testing here.", costCurrency: "USD", riskLevel: "medium", feasibilityScore: "unknown", anticipatedOutcomes: [], assumptions: [] })
    ).rejects.toThrow(/Permission denied/);
  });

  it("selectAlternative requires reform:proposal:approve (NOT alternative:write)", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new PermissionDeniedError("reform:proposal:approve"));
    await expect(
      selectAlternative(makeSession(), { alternativeId: "a1" })
    ).rejects.toThrow(/Permission denied/);
  });

  it("withdrawAlternative requires reform:proposal:approve", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new PermissionDeniedError("reform:proposal:approve"));
    await expect(
      withdrawAlternative(makeSession(), { alternativeId: "a1", withdrawalReason: "This alternative is no longer viable due to changed conditions." })
    ).rejects.toThrow(/Permission denied/);
  });
});

// ============================================================
// Input validation tests
// ============================================================
describe("G03-03 input validation", () => {
  it("addReformAlternative rejects title < 5 chars", async () => {
    await expect(
      addReformAlternative(makeSession(), { proposalId: "p1", title: "ab", description: "Valid description for testing purposes.", costCurrency: "USD", riskLevel: "medium", feasibilityScore: "unknown", anticipatedOutcomes: [], assumptions: [] })
    ).rejects.toThrow();
  });

  it("addReformAlternative rejects description < 20 chars", async () => {
    await expect(
      addReformAlternative(makeSession(), { proposalId: "p1", title: "Valid Title", description: "short", costCurrency: "USD", riskLevel: "medium", feasibilityScore: "unknown", anticipatedOutcomes: [], assumptions: [] })
    ).rejects.toThrow();
  });

  it("selectAlternative rejects empty alternativeId", async () => {
    await expect(
      selectAlternative(makeSession(), { alternativeId: "" })
    ).rejects.toThrow();
  });

  it("withdrawAlternative rejects withdrawalReason < 20 chars", async () => {
    await expect(
      withdrawAlternative(makeSession(), { alternativeId: "a1", withdrawalReason: "short" })
    ).rejects.toThrow();
  });

  it("addReformAlternative rejects unknown fields (strict schema)", async () => {
    await expect(
      addReformAlternative(makeSession(), {
        proposalId: "p1",
        title: "Valid Title",
        description: "Valid description for testing purposes.",
        // @ts-expect-error — testing runtime rejection of unknown field
        canApproveCommitments: true,
      })
    ).rejects.toThrow();
  });
});

// ============================================================
// Lifecycle rules
// ============================================================
describe("G03-03 lifecycle rules", () => {
  it("addReformAlternative throws ConflictError when proposal is not draft", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            $queryRaw: vi.fn().mockResolvedValue([{ id: "p1" }]),
            reformProposal: { findFirst: vi.fn().mockResolvedValue({ id: "p1", status: "under_review" }) },
            reformAlternative: { count: vi.fn().mockResolvedValue(1) },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      addReformAlternative(makeSession(), { proposalId: "p1", title: "Valid Title", description: "Valid description for testing purposes.", costCurrency: "USD", riskLevel: "medium", feasibilityScore: "unknown", anticipatedOutcomes: [], assumptions: [] })
    ).rejects.toThrow(ConflictError);
  });

  it("addReformAlternative throws NotFoundError when proposal does not exist", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            // $queryRaw returns [] — lock-acquire boundary rejects missing rows
            $queryRaw: vi.fn().mockResolvedValue([]),
            reformProposal: { findFirst: vi.fn().mockResolvedValue(null) },
            reformAlternative: { count: vi.fn() },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      addReformAlternative(makeSession(), { proposalId: "p1", title: "Valid Title", description: "Valid description for testing purposes.", costCurrency: "USD", riskLevel: "medium", feasibilityScore: "unknown", anticipatedOutcomes: [], assumptions: [] })
    ).rejects.toThrow(NotFoundError);
  });

  it("addReformAlternative throws ConflictError when 5 active alternatives exist (D1)", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            $queryRaw: vi.fn().mockResolvedValue([{ id: "p1" }]),
            reformProposal: { findFirst: vi.fn().mockResolvedValue({ id: "p1", status: "draft" }) },
            reformAlternative: { count: vi.fn().mockResolvedValue(5) },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      addReformAlternative(makeSession(), { proposalId: "p1", title: "Valid Title", description: "Valid description for testing purposes.", costCurrency: "USD", riskLevel: "medium", feasibilityScore: "unknown", anticipatedOutcomes: [], assumptions: [] })
    ).rejects.toThrow(/maximum.*5/i);
  });

  it("selectAlternative throws ConflictError when alternative is not draft", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            $queryRaw: vi.fn().mockResolvedValue([{ id: "p1" }]),
            reformAlternative: {
              findFirst: vi.fn()
                .mockResolvedValueOnce({ id: "a1", proposalId: "p1", status: "withdrawn" }) // first find
                .mockResolvedValueOnce({ id: "a1", proposalId: "p1", status: "withdrawn" }), // re-read after lock
            },
            reformProposal: { findFirst: vi.fn().mockResolvedValue({ id: "p1", status: "under_review" }) },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "reviewer",
        });
      }
    );

    await expect(
      selectAlternative(makeSession(), { alternativeId: "a1" })
    ).rejects.toThrow(ConflictError);
  });

  it("withdrawAlternative throws ConflictError when proposal is approved", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            $queryRaw: vi.fn().mockResolvedValue([{ id: "p1" }]),
            reformAlternative: {
              findFirst: vi.fn()
                .mockResolvedValueOnce({ id: "a1", proposalId: "p1", status: "selected" })
                .mockResolvedValueOnce({ id: "a1", proposalId: "p1", status: "selected" }),
            },
            reformProposal: { findFirst: vi.fn().mockResolvedValue({ id: "p1", status: "approved" }) },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "reviewer",
        });
      }
    );

    await expect(
      withdrawAlternative(makeSession(), { alternativeId: "a1", withdrawalReason: "This alternative is no longer viable due to changed conditions." })
    ).rejects.toThrow(/already approved/i);
  });
});
