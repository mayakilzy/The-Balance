import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/lib/permissions", () => ({
  requirePermissionWithCurrentRole: vi.fn().mockResolvedValue(undefined),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    readonly permission: string;
    constructor(p: string) { super(`Permission denied: ${p}`); this.name = "PermissionDeniedError"; this.permission = p; }
  },
}));
const mockWriteAuditTx = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({ writeAuditTx: (...a: unknown[]) => mockWriteAuditTx(...a) }));

const mockTx = {
  strategyVersion: { findFirst: vi.fn() },
  program: { findMany: vi.fn() },
  institution: { findMany: vi.fn() },
  tenant: { findUnique: vi.fn() },
  indicatorDefinition: { findMany: vi.fn() },
  observation: { count: vi.fn() },
};

vi.mock("@/lib/security/tenant-context", () => ({
  withAuthenticatedTenant: vi.fn(async (_s: Session | null, fn: (c: { tx: typeof mockTx; userId: string; tenantId: string; roleCode: string }) => Promise<unknown>) =>
    fn({ tx: mockTx, userId: "u1", tenantId: "t1", roleCode: "reviewer" })),
}));

import { getSectorView } from "@/lib/state-observatory/sector-view-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  mockTx.strategyVersion.findFirst.mockResolvedValue({ id: "sv_1" });
  mockTx.tenant.findUnique.mockResolvedValue({ countryId: "country_DML" });
  mockTx.program.findMany.mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("V-06: deduplicates indicators across programs", () => {
  it("totalIndicators counts unique indicatorIds (not per-program)", async () => {
    mockTx.program.findMany.mockResolvedValue([
      { id: "p1", owningInstitutionId: "inst_1" },
      { id: "p2", owningInstitutionId: "inst_1" },
    ]);
    mockTx.institution.findMany.mockResolvedValue([{ id: "inst_1", code: "X", displayName: "X", type: "ministry", countryId: "country_DML" }]);
    // Both programs have the same indicator (deduplicated)
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{ id: "ind_shared" }]);
    mockTx.observation.count.mockResolvedValue(0);
    const result = await getSectorView(null, { sector: "education", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    // 1 unique indicator across 2 programs
    expect(result.totalIndicators).toBe(1);
  });
});

describe("V-07: aggregateObservability = not_computed", () => {
  it("returns not_computed with reason pointing to real analysis", async () => {
    mockTx.program.findMany.mockResolvedValue([]);
    const result = await getSectorView(null, { sector: "education", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    expect(result.aggregateObservability.status).toBe("not_computed");
    expect(result.aggregateObservability.reason).toContain("analyzeAggregateIndependence");
  });
});

describe("CORRECTION 3: simulatedData = null when not inspected", () => {
  it("simulatedData is null when no indicators exist (not inspected)", async () => {
    mockTx.program.findMany.mockResolvedValue([]);
    const result = await getSectorView(null, { sector: "education", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    expect(result.honesty.simulatedData).toBeNull();
  });
});
