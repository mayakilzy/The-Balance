// ============================================================
// tests/unit/reform/services.test.ts
// ------------------------------------------------------------
// Service-level unit tests with mocked Prisma + auth dependencies.
// Uses vitest's hoisted mock pattern to avoid top-level variable
// references in vi.mock factories.
//
// Real PostgreSQL integration is covered by tests/integration/g03-02-*.ts.
// ============================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

// ============================================================
// Hoisted state — vi.mock factories can safely reference this.
// ============================================================
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
  ingestObservation: vi.fn(),
}));
vi.mock("@/lib/state-observatory/alert-service", () => ({
  closeAlert: vi.fn(),
}));

// ============================================================
// Imports (after vi.mock declarations)
// ============================================================
import {
  submitForReview,
  approveReformProposal,
  rejectReformProposal,
} from "@/lib/reform/reform-proposal-service";
import {
  startReformAction,
  completeReformAction,
  createReformAction,
} from "@/lib/reform/reform-action-service";
import { verifyReformAction } from "@/lib/reform/reform-verification-service";
import { PermissionDeniedError } from "@/lib/permissions";
import { NotFoundError, ConflictError } from "@/lib/reform/contracts";

// ============================================================
// Helpers
// ============================================================
function makeSession(roleCode: string = "analyst"): Session {
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
  mocks.writeAuditTx.mockResolvedValue(undefined);
});

// ============================================================
// Authorization tests
// ============================================================
describe("G03-02 service authorization", () => {
  it("submitForReview requires reform:proposal:write", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:proposal:write")
    );
    await expect(submitForReview(makeSession(), "prop_1")).rejects.toThrow(
      /Permission denied/
    );
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "reform:proposal:write"
    );
  });

  it("approveReformProposal requires reform:proposal:approve", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:proposal:approve")
    );
    await expect(
      approveReformProposal(makeSession(), {
        proposalId: "p1",
        rationale: "valid rationale for approval here",
      })
    ).rejects.toThrow(/Permission denied/);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "reform:proposal:approve"
    );
  });

  it("rejectReformProposal requires reform:proposal:approve", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:proposal:approve")
    );
    await expect(
      rejectReformProposal(makeSession(), {
        proposalId: "p1",
        rejectionReason: "Insufficient evidence to support the reform.",
      })
    ).rejects.toThrow(/Permission denied/);
  });

  it("startReformAction requires reform:action:write", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:action:write")
    );
    await expect(startReformAction(makeSession(), "act_1")).rejects.toThrow(
      /Permission denied/
    );
  });

  it("completeReformAction requires reform:action:write", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:action:write")
    );
    await expect(
      completeReformAction(makeSession(), { actionId: "act_1" })
    ).rejects.toThrow(/Permission denied/);
  });

  it("verifyReformAction requires reform:action:verify (NOT reform:action:write)", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:action:verify")
    );
    await expect(
      verifyReformAction(makeSession(), {
        actionId: "act_1",
        verificationStatus: "verified",
        verifiedAction:
          "Action mandate published in gazette on 2025-03-15",
        evidenceSource: "gazette-2025-03-15.pdf",
      })
    ).rejects.toThrow(/Permission denied/);
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "reform:action:verify"
    );
  });

  it("createReformAction requires reform:action:write", async () => {
    mocks.requirePermission.mockRejectedValueOnce(
      new PermissionDeniedError("reform:action:write")
    );
    await expect(
      createReformAction(makeSession(), {
        proposalId: "p1",
        title: "valid action title",
      })
    ).rejects.toThrow(/Permission denied/);
  });
});

// ============================================================
// Lifecycle transition tests
// ============================================================
describe("G03-02 lifecycle transitions", () => {
  it("submitForReview throws ConflictError when proposal is not in draft status", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              updateMany: vi.fn().mockResolvedValue({ count: 0 }),
              findFirst: vi.fn().mockResolvedValue({ id: "p1", status: "approved" }),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(submitForReview(makeSession(), "p1")).rejects.toThrow(ConflictError);
  });

  it("submitForReview throws NotFoundError when proposal does not exist", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              updateMany: vi.fn().mockResolvedValue({ count: 0 }),
              findFirst: vi.fn().mockResolvedValue(null),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(submitForReview(makeSession(), "p1")).rejects.toThrow(NotFoundError);
  });

  it("approveReformProposal throws ConflictError when proposal is not under_review", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi.fn().mockResolvedValue({ id: "p1", status: "draft" }),
              updateMany: vi.fn(),
            },
            reformApproval: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn(),
            },
            reformAlternative: { findMany: vi.fn() },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "reviewer",
        });
      }
    );

    await expect(
      approveReformProposal(makeSession(), {
        proposalId: "p1",
        rationale: "valid rationale for approval here",
      })
    ).rejects.toThrow(ConflictError);
  });

  it("approveReformProposal throws ConflictError when approval already exists (idempotency)", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi
                .fn()
                .mockResolvedValue({ id: "p1", status: "under_review" }),
              updateMany: vi.fn(),
            },
            reformApproval: {
              findFirst: vi.fn().mockResolvedValue({ id: "existing_approval" }),
              create: vi.fn(),
            },
            reformAlternative: { findMany: vi.fn() },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "reviewer",
        });
      }
    );

    await expect(
      approveReformProposal(makeSession(), {
        proposalId: "p1",
        rationale: "valid rationale for approval here",
      })
    ).rejects.toThrow(/already has an approval record/);
  });

  it("startReformAction throws ConflictError when action is not planned", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformAction: {
              updateMany: vi.fn().mockResolvedValue({ count: 0 }),
              findFirst: vi
                .fn()
                .mockResolvedValue({ id: "a1", status: "in_progress" }),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(startReformAction(makeSession(), "a1")).rejects.toThrow(ConflictError);
  });

  it("completeReformAction throws ConflictError when action is not in_progress", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformAction: {
              updateMany: vi.fn().mockResolvedValue({ count: 0 }),
              findFirst: vi.fn().mockResolvedValue({ id: "a1", status: "planned" }),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      completeReformAction(makeSession(), { actionId: "a1" })
    ).rejects.toThrow(ConflictError);
  });
});

// ============================================================
// F6 verification service-level check
// ============================================================
describe("G03-02 F6 service-level check", () => {
  it("rejects vague verifiedAction like 'inflation improved'", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformAction: {
              findFirst: vi.fn().mockResolvedValue({ id: "a1", status: "completed" }),
            },
            reformVerification: {
              findFirst: vi
                .fn()
                .mockResolvedValue({ id: "v1", verificationStatus: "pending" }),
              update: vi.fn(),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "reviewer",
        });
      }
    );

    await expect(
      verifyReformAction(makeSession(), {
        actionId: "a1",
        verificationStatus: "verified",
        verifiedAction: "inflation improved after the reform was implemented",
        evidenceSource: "imf-data-2025.pdf",
      })
    ).rejects.toThrow(/F6 service check/);
  });

  it("rejects vague verifiedAction like 'the policy worked'", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformAction: {
              findFirst: vi.fn().mockResolvedValue({ id: "a1", status: "completed" }),
            },
            reformVerification: {
              findFirst: vi
                .fn()
                .mockResolvedValue({ id: "v1", verificationStatus: "pending" }),
              update: vi.fn(),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "reviewer",
        });
      }
    );

    await expect(
      verifyReformAction(makeSession(), {
        actionId: "a1",
        verificationStatus: "verified",
        verifiedAction:
          "the policy worked and inflation went down significantly over the period",
        evidenceSource: "imf-data-2025.pdf",
      })
    ).rejects.toThrow(/F6 service check/);
  });

  it("throws ConflictError when verification is not pending (already verified)", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformAction: {
              findFirst: vi.fn().mockResolvedValue({ id: "a1", status: "completed" }),
            },
            reformVerification: {
              findFirst: vi
                .fn()
                .mockResolvedValue({ id: "v1", verificationStatus: "verified" }),
              update: vi.fn(),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "reviewer",
        });
      }
    );

    await expect(
      verifyReformAction(makeSession(), {
        actionId: "a1",
        verificationStatus: "verified",
        verifiedAction: "Action mandate published in gazette on 2025-03-15",
        evidenceSource: "gazette-2025-03-15.pdf",
      })
    ).rejects.toThrow(ConflictError);
  });
});

// ============================================================
// Atomic audit propagation
// ============================================================
describe("G03-02 atomic audit propagation", () => {
  it("writeAuditTx failure propagates (does NOT silently succeed)", async () => {
    mocks.writeAuditTx.mockRejectedValueOnce(
      new Error("audit_log INSERT failed: RLS denied")
    );
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
              findFirst: vi.fn(),
            },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(submitForReview(makeSession(), "p1")).rejects.toThrow(
      /audit_log INSERT failed/
    );
  });
});

// ============================================================
// createReformAction preconditions
// ============================================================
describe("G03-02 createReformAction preconditions", () => {
  it("throws ConflictError when proposal is not approved", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: {
              findFirst: vi
                .fn()
                .mockResolvedValue({ id: "p1", status: "under_review" }),
            },
            reformApproval: { findFirst: vi.fn() },
            reformAction: { create: vi.fn() },
            reformVerification: { create: vi.fn() },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      createReformAction(makeSession(), {
        proposalId: "p1",
        title: "valid action title",
      })
    ).rejects.toThrow(ConflictError);
  });

  it("throws NotFoundError when proposal does not exist", async () => {
    mocks.withAuthenticatedTenant.mockImplementation(
      async (_s: Session, fn: (ctx: unknown) => Promise<unknown>) => {
        return fn({
          tx: {
            reformProposal: { findFirst: vi.fn().mockResolvedValue(null) },
            reformApproval: { findFirst: vi.fn() },
            reformAction: { create: vi.fn() },
            reformVerification: { create: vi.fn() },
          },
          tenantId: "t1",
          userId: "u1",
          roleCode: "analyst",
        });
      }
    );

    await expect(
      createReformAction(makeSession(), {
        proposalId: "p1",
        title: "valid action title",
      })
    ).rejects.toThrow(NotFoundError);
  });
});
