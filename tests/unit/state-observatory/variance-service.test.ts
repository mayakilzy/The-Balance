// ============================================================
// tests/unit/state-observatory/variance-service.test.ts
// ------------------------------------------------------------
// Unit tests for VarianceService — uses mocked Prisma client.
//
// Covers:
//   U-11: computeVariance uses periodMilestone when available
//   U-12: computeVariance returns unknown when only defaultTargetValue (no milestone)
//   U-13 (F4): all nullable fields null when no target at all
//   U-14: pins observationId + snapshot in result
//   U-15: attributionLevel = "descriptive" always
//   R2: comparisonValid logic
// ============================================================
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/lib/permissions", () => ({
  requirePermissionWithCurrentRole: vi.fn().mockResolvedValue(undefined),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    readonly permission: string;
    constructor(permission: string) {
      super(`Permission denied: ${permission}`);
      this.name = "PermissionDeniedError";
      this.permission = permission;
    }
  },
}));

const mockWriteAuditTx = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  writeAuditTx: (...args: unknown[]) => mockWriteAuditTx(...args),
}));

const mockTx = {
  strategyVersion: { findFirst: vi.fn() },
  observationPeriod: { findFirst: vi.fn() },
  indicatorDefinition: { findMany: vi.fn() },
  observation: { findFirst: vi.fn() },
  varianceRecord: {
    create: vi.fn(),
    findMany: vi.fn(),
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
        roleCode: "reviewer",
      });
    }
  ),
}));

import { computeVariance, listVariance } from "@/lib/state-observatory/variance-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  mockTx.strategyVersion.findFirst.mockResolvedValue({ id: "sv_1" });
  mockTx.observationPeriod.findFirst.mockResolvedValue({ id: "period_1" });
  mockTx.varianceRecord.create.mockImplementation(async (args: any) => ({
    id: "vr_1",
    ...args.data,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseIndicator = {
  id: "ind_1",
  tenantId: "tenant_1",
  code: "INFLATION_RATE",
  displayName: "Inflation Rate",
  unit: "percent",
  preferredDirection: "decrease",
  defaultTargetValue: 5.0,
  targetTimeHorizon: "multi_year",
  periodMilestones: [
    { periodId: "period_1", targetValue: 7.0, sourceRef: "synthetic:demolandia-test-policy-2026-001" },
  ],
  alertThresholds: [],
  status: "active",
  strategyVersionId: "sv_1",
};

describe("VarianceService.computeVariance — U-11 (periodMilestone used)", () => {
  it("uses periodMilestone when available; comparisonValid=true", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
      observedAt: new Date("2026-04-15"),
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result).toHaveLength(1);
    const varianceRecord = result[0]!;
    expect(varianceRecord.plannedValueType).toBe("period_milestone");
    expect(varianceRecord.comparisonValid).toBe(true);
    // 9.0 - 7.0 = 2.0 (positive, preferred decrease → worse)
    expect(Number(varianceRecord.varianceAbsolute)).toBe(2.0);
    expect(varianceRecord.varianceDirection).toBe("worse");
  });

  it("U-15: attributionLevel is always 'descriptive'", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.attributionLevel).toBe("descriptive");
  });

  it("U-14: pins observationId + observationSnapshot in result", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_42",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
      observedAt: null,
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.observationId).toBe("obs_42");
    // observationSnapshot should contain id + observedValue
    const snapshot = result[0]!.observationSnapshot as unknown as Record<string, unknown>;
    expect(snapshot.id).toBe("obs_42");
  });
});

describe("VarianceService.computeVariance — U-12 (no milestone, defaultTargetValue)", () => {
  it("falls back to defaultTargetValue; comparisonValid=false; direction=unknown", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{
      ...baseIndicator,
      periodMilestones: [], // no milestone for this period
    }]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_no_milestone" }
    );

    expect(result[0]!.plannedValueType).toBe("final");
    expect(result[0]!.comparisonValid).toBe(false);
    expect(result[0]!.varianceDirection).toBe("unknown");
    // Absolute is still computed descriptively (9.0 - 5.0 = 4.0)
    expect(Number(result[0]!.varianceAbsolute)).toBe(4.0);
    expect(result[0]!.plannedValueSourceKind).toBe("indicator_definition");
    expect(result[0]!.plannedValueSourceId).toBe("ind_1");
  });
});

describe("VarianceService.computeVariance — U-13 (F4: no target at all)", () => {
  it("returns 'none' type with null sourceKind/sourceId when no target exists", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{
      ...baseIndicator,
      periodMilestones: [],
      defaultTargetValue: null,
    }]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_no_target" }
    );

    const record = result[0]!;
    expect(record.plannedValueType).toBe("none");
    expect(record.plannedValueSourceKind).toBeNull(); // F4
    expect(record.plannedValueSourceId).toBeNull(); // F4
    expect(record.plannedValue).toBeNull();
    expect(record.varianceAbsolute).toBeNull();
    expect(record.varianceDirection).toBe("unknown");
    expect(record.comparisonValid).toBe(false);
  });

  it("F4 + U-13: returns null observationId when observation is missing", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{
      ...baseIndicator,
      periodMilestones: [],
      defaultTargetValue: null,
    }]);
    mockTx.observation.findFirst.mockResolvedValue(null); // no observation

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_no_data" }
    );

    expect(result[0]!.observationId).toBeNull();
    expect(result[0]!.varianceAbsolute).toBeNull();
    expect(result[0]!.varianceDirection).toBe("unknown");
  });

  it("U-13: when observedValue is null, all variance fields are null/unknown", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_null",
      observedValue: null, // unknown
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.varianceAbsolute).toBeNull();
    expect(result[0]!.varianceDirection).toBe("unknown");
  });
});

describe("VarianceService.computeVariance — direction logic", () => {
  it("preferredDirection=decrease + actual > planned → worse", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.varianceDirection).toBe("worse");
  });

  it("preferredDirection=decrease + actual < planned → better", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 5.0, // below milestone of 7.0 → better (decrease direction)
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.varianceDirection).toBe("better");
  });

  it("preferredDirection=decrease + actual == planned → neutral", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 7.0, // exactly at milestone
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.varianceDirection).toBe("neutral");
  });

  it("preferredDirection=increase + actual > planned → better", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{
      ...baseIndicator,
      preferredDirection: "increase",
    }]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 10.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.varianceDirection).toBe("better");
  });

  it("preferredDirection=stable → neutral unless variance=0", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{
      ...baseIndicator,
      preferredDirection: "stable",
    }]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 8.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    const result = await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(result[0]!.varianceDirection).toBe("neutral"); // stable + non-zero variance
  });
});

describe("VarianceService.computeVariance — audit + filtering", () => {
  it("writes atomic audit log for each variance record", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1" }
    );

    expect(mockWriteAuditTx).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditTx.mock.calls[0]![1];
    expect(auditCall.action).toBe("observatory.variance.computed");
    expect(auditCall.status).toBe("ok");
  });

  it("filters by indicatorId when provided", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([baseIndicator]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
    });

    await computeVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1", observationPeriodId: "period_1", indicatorId: "ind_1" }
    );

    const findManyCall = mockTx.indicatorDefinition.findMany.mock.calls[0]![0];
    expect(findManyCall.where.id).toBe("ind_1");
  });

  it("throws when strategy version is not approved", async () => {
    mockTx.strategyVersion.findFirst.mockResolvedValue(null);

    await expect(
      computeVariance(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        { strategyVersionId: "sv_unapproved", observationPeriodId: "period_1" }
      )
    ).rejects.toThrow(/not.*approved/);
  });
});

describe("VarianceService.listVariance", () => {
  it("returns variance records filtered by tenant", async () => {
    mockTx.varianceRecord.findMany.mockResolvedValue([
      { id: "vr_1", tenantId: "tenant_1" },
    ]);

    const result = await listVariance(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { strategyVersionId: "sv_1" }
    );

    expect(result).toHaveLength(1);
    const call = mockTx.varianceRecord.findMany.mock.calls[0]![0];
    expect(call.where.tenantId).toBe("tenant_1");
    expect(call.where.strategyVersionId).toBe("sv_1");
  });
});
