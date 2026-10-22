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
  observationPeriod: { findFirst: vi.fn(), findMany: vi.fn() },
  indicatorDefinition: { findFirst: vi.fn() },
  observation: { findFirst: vi.fn() },
};
vi.mock("@/lib/security/tenant-context", () => ({
  withAuthenticatedTenant: vi.fn(async (_s: Session | null, fn: (ctx: { tx: typeof mockTx; userId: string; tenantId: string; roleCode: string }) => Promise<unknown>) =>
    fn({ tx: mockTx, userId: "user_1", tenantId: "tenant_A", roleCode: "reviewer" })),
}));
import { analyzeTemporalTrend } from "@/lib/state-observatory/temporal-trend-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  mockTx.observationPeriod.findFirst.mockResolvedValue({ id: "p_end", endAt: new Date("2026-06-30"), periodType: "quarterly", periodValue: "2026-Q2" });
  mockTx.indicatorDefinition.findFirst.mockResolvedValue({ id: "ind_1", preferredDirection: "decrease", unit: "percent", measurementConstraints: {} });
});
afterEach(() => { vi.restoreAllMocks(); });

function makePeriod(id: string, periodValue: string, startAt: string, endAt: string) {
  return { id, periodType: "quarterly", periodValue, startAt: new Date(startAt), endAt: new Date(endAt) };
}
function makeObs(value: number | null, observedAt?: string) {
  return { id: "obs_x", observedValue: value !== null ? BigInt(Math.round(value * 10000)) : null, observedAt: observedAt ? new Date(observedAt) : null, retrievedAt: new Date("2026-04-15"), isSynthetic: true };
}

describe("U-01: insufficient when <2 usable data points", () => {
  it("returns unknown + insufficient when 0 periods", async () => {
    mockTx.observationPeriod.findMany.mockResolvedValue([]);
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    expect(result.trendDirection).toBe("unknown");
    expect(result.dataSufficiency).toBe("insufficient");
    expect(result.limitationReason).toContain("no periods");
  });
});

describe("U-02: improving when ALL changes in preferred direction", () => {
  it("3 periods all decreasing (preferred=decrease) → improving", async () => {
    mockTx.observationPeriod.findMany.mockResolvedValue([
      makePeriod("p1", "2025-Q4", "2025-10-01", "2025-12-31"),
      makePeriod("p2", "2026-Q1", "2026-01-01", "2026-03-31"),
      makePeriod("p3", "2026-Q2", "2026-04-01", "2026-06-30"),
    ]);
    mockTx.observation.findFirst
      .mockResolvedValueOnce(makeObs(10.0))
      .mockResolvedValueOnce(makeObs(8.0))
      .mockResolvedValueOnce(makeObs(6.0));
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    expect(result.trendDirection).toBe("improving");
    expect(result.dataSufficiency).toBe("sufficient");
  });
});

describe("U-03: deteriorating when ALL changes opposite", () => {
  it("3 periods all increasing (preferred=decrease) → deteriorating", async () => {
    mockTx.observationPeriod.findMany.mockResolvedValue([
      makePeriod("p1", "2025-Q4", "2025-10-01", "2025-12-31"),
      makePeriod("p2", "2026-Q1", "2026-01-01", "2026-03-31"),
      makePeriod("p3", "2026-Q2", "2026-04-01", "2026-06-30"),
    ]);
    mockTx.observation.findFirst
      .mockResolvedValueOnce(makeObs(6.0))
      .mockResolvedValueOnce(makeObs(8.0))
      .mockResolvedValueOnce(makeObs(10.0));
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    expect(result.trendDirection).toBe("deteriorating");
  });
});

describe("U-05: unknown when mixed signals", () => {
  it("3 periods with mixed directions → unknown", async () => {
    mockTx.observationPeriod.findMany.mockResolvedValue([
      makePeriod("p1", "2025-Q4", "2025-10-01", "2025-12-31"),
      makePeriod("p2", "2026-Q1", "2026-01-01", "2026-03-31"),
      makePeriod("p3", "2026-Q2", "2026-04-01", "2026-06-30"),
    ]);
    mockTx.observation.findFirst
      .mockResolvedValueOnce(makeObs(10.0))
      .mockResolvedValueOnce(makeObs(8.0))  // decrease (improving)
      .mockResolvedValueOnce(makeObs(9.0)); // increase (deteriorating)
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    expect(result.trendDirection).toBe("unknown");
  });
});

describe("U-06: temporal gaps reported", () => {
  it("missing observation in middle period → temporalGaps non-empty + trend unknown", async () => {
    mockTx.observationPeriod.findMany.mockResolvedValue([
      makePeriod("p1", "2025-Q4", "2025-10-01", "2025-12-31"),
      makePeriod("p2", "2026-Q1", "2026-01-01", "2026-03-31"),
    ]);
    mockTx.observation.findFirst
      .mockResolvedValueOnce(makeObs(10.0))
      .mockResolvedValueOnce(null); // missing observation
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    expect(result.temporalGaps.length).toBeGreaterThan(0);
    expect(result.trendDirection).toBe("unknown");
    // When data is insufficient (<2 points), limitationReason mentions insufficient data
    // (temporal gaps are still reported in the temporalGaps array)
    expect(result.limitationReason).toMatch(/insufficient data|temporal gaps/);
  });
});

describe("U-07: same-type period filtering (FIX 4)", () => {
  it("only fetches periods of the same periodType as the ending period", async () => {
    // The query now filters by periodType at DB level (FIX 4)
    // Verify the mock was called with periodType filter
    mockTx.observationPeriod.findMany.mockResolvedValue([
      makePeriod("p1", "2025-Q4", "2025-10-01", "2025-12-31"),
      makePeriod("p2", "2026-Q1", "2026-01-01", "2026-03-31"),
    ]);
    mockTx.observation.findFirst
      .mockResolvedValueOnce(makeObs(10.0))
      .mockResolvedValueOnce(makeObs(8.0));
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    // Verify the findMany call included periodType filter
    const call = mockTx.observationPeriod.findMany.mock.calls[0]![0];
    expect(call.where.periodType).toBe("quarterly"); // same as ending period
    // Result should be valid (not rejected for incompatible types)
    expect(result.trendDirection).not.toBe("unknown");
    expect(result.limitationReason).toBeNull();
  });
});

describe("U-09: separated dimensions", () => {
  it("trendDirection, dataSufficiency, magnitudeOfChange are independent fields", async () => {
    mockTx.observationPeriod.findMany.mockResolvedValue([
      makePeriod("p1", "2025-Q4", "2025-10-01", "2025-12-31"),
      makePeriod("p2", "2026-Q1", "2026-01-01", "2026-03-31"),
      makePeriod("p3", "2026-Q2", "2026-04-01", "2026-06-30"),
    ]);
    mockTx.observation.findFirst
      .mockResolvedValueOnce(makeObs(10.0))
      .mockResolvedValueOnce(makeObs(8.0))
      .mockResolvedValueOnce(makeObs(6.0));
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    expect(result).toHaveProperty("trendDirection");
    expect(result).toHaveProperty("dataSufficiency");
    expect(result).toHaveProperty("magnitudeOfChange");
    // dataSufficiency = sufficient (3 points) but magnitudeOfChange = unknown (no calibrated thresholds)
    expect(result.dataSufficiency).toBe("sufficient");
    expect(result.magnitudeOfChange).toBe("unknown"); // CORRECTION 2: no calibrated thresholds → unknown
  });
});

describe("U-11: attributionLevel always descriptive", () => {
  it("attributionLevel = 'descriptive'", async () => {
    mockTx.observationPeriod.findMany.mockResolvedValue([]);
    const result = await analyzeTemporalTrend(null, { indicatorId: "ind_1", endingBeforePeriodId: "p_end" });
    expect(result.attributionLevel).toBe("descriptive");
  });
});
