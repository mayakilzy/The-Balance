import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/lib/permissions", () => ({
  requirePermissionWithCurrentRole: vi.fn().mockResolvedValue(undefined),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    readonly permission: string;
    constructor(permission: string) { super(`Permission denied: ${permission}`); this.name = "PermissionDeniedError"; this.permission = permission; }
  },
}));
const mockWriteAuditTx = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({ writeAuditTx: (...args: unknown[]) => mockWriteAuditTx(...args) }));

const mockTx = {
  varianceRecord: { findFirst: vi.fn() },
  observation: { count: vi.fn() },
};

vi.mock("@/lib/security/tenant-context", () => ({
  withAuthenticatedTenant: vi.fn(async (_s: Session | null, fn: (ctx: { tx: typeof mockTx; userId: string; tenantId: string; roleCode: string }) => Promise<unknown>) =>
    fn({ tx: mockTx, userId: "user_1", tenantId: "tenant_A", roleCode: "reviewer" })),
}));

// Mock analyzeTemporalTrend
vi.mock("@/lib/state-observatory/temporal-trend-service", () => ({
  analyzeTemporalTrend: vi.fn(),
}));

import { assessEarlyWarning } from "@/lib/state-observatory/early-warning-service";
import { analyzeTemporalTrend } from "@/lib/state-observatory/temporal-trend-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  mockTx.varianceRecord.findFirst.mockResolvedValue(null);
  mockTx.observation.count.mockResolvedValue(1);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("U-12: insufficient_data (NOT none) when data insufficient", () => {
  it("returns insufficient_data when dataSufficiency=insufficient", async () => {
    (analyzeTemporalTrend as any).mockResolvedValue({
      trendDirection: "unknown", dataSufficiency: "insufficient",
      magnitudeOfChange: "unknown", consistencyIssues: [], temporalGaps: [],
    });
    mockTx.observation.count.mockResolvedValue(0); // LOW observability

    const result = await assessEarlyWarning(null, {
      indicatorId: "ind_1", observationPeriodId: "p1", strategyVersionId: "sv_1",
    });
    expect(result.warningLevel).toBe("insufficient_data");
    expect(result.warningLevel).not.toBe("none");
  });
});

describe("U-13: advisory when deteriorating + worse variance", () => {
  it("returns advisory for deteriorating trend + worse variance", async () => {
    (analyzeTemporalTrend as any).mockResolvedValue({
      trendDirection: "deteriorating", dataSufficiency: "sufficient",
      magnitudeOfChange: "unknown", consistencyIssues: [], temporalGaps: [],
    });
    mockTx.varianceRecord.findFirst.mockResolvedValue({ varianceDirection: "worse" });
    mockTx.observation.count.mockResolvedValue(1);

    const result = await assessEarlyWarning(null, {
      indicatorId: "ind_1", observationPeriodId: "p1", strategyVersionId: "sv_1",
    });
    expect(result.warningLevel).toBe("advisory");
  });
});

describe("U-14: none when improving — but limitationReason clarifies 'no signal' not 'safe'", () => {
  it("returns none + limitationReason for improving trend", async () => {
    (analyzeTemporalTrend as any).mockResolvedValue({
      trendDirection: "improving", dataSufficiency: "sufficient",
      magnitudeOfChange: "unknown", consistencyIssues: [], temporalGaps: [],
    });
    mockTx.varianceRecord.findFirst.mockResolvedValue({ varianceDirection: "better" });
    mockTx.observation.count.mockResolvedValue(1);

    const result = await assessEarlyWarning(null, {
      indicatorId: "ind_1", observationPeriodId: "p1", strategyVersionId: "sv_1",
    });
    expect(result.warningLevel).toBe("none");
    expect(result.limitationReason).toContain("does NOT mean");
  });
});

describe("U-15: isAdvisoryOnly + noCausalClaims always true", () => {
  it("isAdvisoryOnly=true and noCausalClaims=true", async () => {
    (analyzeTemporalTrend as any).mockResolvedValue({
      trendDirection: "unknown", dataSufficiency: "insufficient",
      magnitudeOfChange: "unknown", consistencyIssues: [], temporalGaps: [],
    });
    mockTx.observation.count.mockResolvedValue(0);

    const result = await assessEarlyWarning(null, {
      indicatorId: "ind_1", observationPeriodId: "p1", strategyVersionId: "sv_1",
    });
    expect(result.isAdvisoryOnly).toBe(true);
    expect(result.noCausalClaims).toBe(true);
    expect(result.isCalibrated).toBe(false); // CORRECTION 4: always uncalibrated
  });
});
