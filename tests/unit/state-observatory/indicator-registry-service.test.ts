// ============================================================
// tests/unit/state-observatory/indicator-registry-service.test.ts
// ------------------------------------------------------------
// Unit tests for IndicatorRegistryService — uses mocked Prisma client
// and mocked auth/permission utilities.
//
// Covers:
//   U-01: defineIndicator creates a valid indicator with periodMilestones + alertThresholds
//   U-02: defineIndicator rejects invalid alertThresholds (Zod) — covered in contracts.test.ts
//   U-03: defineIndicator rejects >2 rules — covered in contracts.test.ts
//   E6: sourceRef prefix validation for Demolandia
//   listIndicators + retireIndicator basic flow
// ============================================================
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Session } from "next-auth";

// Mock the permission utility
const mockRequirePermission = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/permissions", () => ({
  requirePermissionWithCurrentRole: (...args: unknown[]) =>
    mockRequirePermission(...args),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    readonly permission: string;
    constructor(permission: string) {
      super(`Permission denied: ${permission}`);
      this.name = "PermissionDeniedError";
      this.permission = permission;
    }
  },
}));

// Mock the audit module
const mockWriteAuditTx = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  writeAuditTx: (...args: unknown[]) => mockWriteAuditTx(...args),
}));

// Mock the tenant context
const mockTx = {
  indicatorDefinition: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  strategyVersion: {
    findFirst: vi.fn(),
  },
  objective: {
    findFirst: vi.fn(),
  },
  program: {
    findFirst: vi.fn(),
  },
};

vi.mock("@/lib/security/tenant-context", () => ({
  withAuthenticatedTenant: vi.fn(
    async (
      _session: Session | null,
      fn: (ctx: {
        tx: typeof mockTx;
        userId: string;
        tenantId: string;
        roleCode: string;
      }) => Promise<unknown>
    ) => {
      return fn({
        tx: mockTx,
        userId: "user_1",
        tenantId: "tenant_1",
        roleCode: "analyst",
      });
    }
  ),
}));

// Re-import after mocks are set up
import {
  defineIndicator,
  listIndicators,
  retireIndicator,
} from "@/lib/state-observatory/indicator-registry-service";

const validInput = {
  code: "INFLATION_RATE",
  displayName: "Inflation Rate",
  unit: "percent",
  preferredDirection: "decrease" as const,
  defaultTargetValue: 5.0,
  targetTimeHorizon: "multi_year" as const,
  periodMilestones: [
    {
      periodId: "2026-Q1",
      targetValue: 7.5,
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    },
    {
      periodId: "2026-Q2",
      targetValue: 7.0,
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    },
  ],
  alertThresholds: [
    {
      metric: "varianceAbsolute" as const,
      operator: "gt" as const,
      value: 1.5,
      logicalOp: "and" as const,
      severity: "warning" as const,
      rationale: "Demo threshold for inflation — 1.5pp above milestone",
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    },
    {
      metric: "varianceDirection" as const,
      operator: "eq" as const,
      value: "worse" as const,
      severity: "warning" as const,
      rationale: "Only raise when direction is worse",
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(undefined);
  mockWriteAuditTx.mockResolvedValue(undefined);
  mockTx.strategyVersion.findFirst.mockResolvedValue({ id: "sv_1" });
  mockTx.objective.findFirst.mockResolvedValue({ id: "obj_1" });
  mockTx.program.findFirst.mockResolvedValue({ id: "prog_1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IndicatorRegistryService.defineIndicator — U-01", () => {
  it("creates a valid IndicatorDefinition with periodMilestones + alertThresholds", async () => {
    mockTx.indicatorDefinition.create.mockResolvedValue({
      id: "ind_1",
      ...validInput,
      tenantId: "tenant_1",
      status: "draft",
      createdBy: "user_1",
    });

    const result = await defineIndicator(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      validInput
    );

    expect(result).toBeDefined();
    expect(result.code).toBe("INFLATION_RATE");
    expect(result.status).toBe("draft");
    expect(mockTx.indicatorDefinition.create).toHaveBeenCalledOnce();

    // Verify audit was written
    expect(mockWriteAuditTx).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditTx.mock.calls[0]![1];
    expect(auditCall.action).toBe("observatory.indicator.defined");
    expect(auditCall.status).toBe("ok");

    // Verify create payload included periodMilestones and alertThresholds
    const createCall = mockTx.indicatorDefinition.create.mock.calls[0]![0];
    expect(createCall.data.periodMilestones).toHaveLength(2);
    expect(createCall.data.alertThresholds).toHaveLength(2);
    expect(createCall.data.status).toBe("draft");
  });

  it("E6: rejects sourceRef that does not start with 'synthetic:demolandia-'", async () => {
    await expect(
      defineIndicator(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        {
          ...validInput,
          periodMilestones: [
            {
              periodId: "2026-Q1",
              targetValue: 7.5,
              sourceRef: "worldbank:real-data", // forbidden prefix
            },
          ],
        }
      )
    ).rejects.toThrow(/E6 violation/);

    expect(mockTx.indicatorDefinition.create).not.toHaveBeenCalled();
  });

  it("E6: rejects alertThreshold sourceRef without synthetic prefix", async () => {
    await expect(
      defineIndicator(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        {
          ...validInput,
          alertThresholds: [
            {
              ...validInput.alertThresholds[0]!,
              sourceRef: "real-government-decree-2026", // forbidden
            },
          ],
        }
      )
    ).rejects.toThrow(/E6 violation/);
  });

  it("rejects when strategyVersionId is not approved in tenant", async () => {
    mockTx.strategyVersion.findFirst.mockResolvedValue(null); // not found

    await expect(
      defineIndicator(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        { ...validInput, strategyVersionId: "sv_nonexistent" }
      )
    ).rejects.toThrow(/not found or not approved/);
  });

  it("rejects when objectiveId is not in tenant", async () => {
    mockTx.objective.findFirst.mockResolvedValue(null);

    await expect(
      defineIndicator(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        { ...validInput, objectiveId: "obj_nonexistent" }
      )
    ).rejects.toThrow(/Objective.*not found/);
  });

  it("rejects when programId is not in tenant", async () => {
    mockTx.program.findFirst.mockResolvedValue(null);

    await expect(
      defineIndicator(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        { ...validInput, programId: "prog_nonexistent" }
      )
    ).rejects.toThrow(/Program.*not found/);
  });
});

describe("IndicatorRegistryService.listIndicators", () => {
  it("returns indicators filtered by tenant", async () => {
    const fakeIndicators = [
      { id: "ind_1", code: "X", tenantId: "tenant_1" },
      { id: "ind_2", code: "Y", tenantId: "tenant_1" },
    ];
    mockTx.indicatorDefinition.findMany.mockResolvedValue(fakeIndicators);

    const result = await listIndicators(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1" }
    );

    expect(result).toHaveLength(2);
    expect(mockTx.indicatorDefinition.findMany).toHaveBeenCalledOnce();
    const call = mockTx.indicatorDefinition.findMany.mock.calls[0]![0];
    expect(call.where.tenantId).toBe("tenant_1");
    expect(call.where.strategyVersionId).toBe("sv_1");
  });
});

describe("IndicatorRegistryService.retireIndicator", () => {
  it("retires an existing indicator and writes audit", async () => {
    mockTx.indicatorDefinition.findFirst.mockResolvedValue({
      id: "ind_1",
      status: "draft",
    });
    mockTx.indicatorDefinition.update.mockResolvedValue({
      id: "ind_1",
      status: "retired",
    });

    const result = await retireIndicator(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      "ind_1",
      "deprecated in favor of INFLATION_RATE_V2"
    );

    expect(result.status).toBe("retired");
    expect(mockTx.indicatorDefinition.update).toHaveBeenCalledOnce();
    const updateCall = mockTx.indicatorDefinition.update.mock.calls[0]![0];
    expect(updateCall.data.status).toBe("retired");
    expect(mockWriteAuditTx).toHaveBeenCalledOnce();
  });

  it("throws NotFoundError when indicator does not exist", async () => {
    mockTx.indicatorDefinition.findFirst.mockResolvedValue(null);

    await expect(
      retireIndicator(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        "ind_nonexistent",
        "reason"
      )
    ).rejects.toThrow(/not found/);
  });

  it("rejects empty reason", async () => {
    await expect(
      retireIndicator(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        "ind_1",
        ""
      )
    ).rejects.toThrow(/reason/i);
  });
});
