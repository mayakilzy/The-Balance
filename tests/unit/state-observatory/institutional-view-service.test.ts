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
  institution: { findUnique: vi.fn() },
  tenant: { findUnique: vi.fn() },
  strategyVersion: { findFirst: vi.fn() },
  observationPeriod: { findFirst: vi.fn() },
  program: { findMany: vi.fn() },
  indicatorDefinition: { findMany: vi.fn() },
  observation: { findFirst: vi.fn(), count: vi.fn() },
  varianceRecord: { findFirst: vi.fn(), findMany: vi.fn() },
  alert: { findMany: vi.fn() },
};

vi.mock("@/lib/security/tenant-context", () => ({
  withAuthenticatedTenant: vi.fn(async (_s: Session | null, fn: (c: { tx: typeof mockTx; userId: string; tenantId: string; roleCode: string }) => Promise<unknown>) =>
    fn({ tx: mockTx, userId: "u1", tenantId: "t1", roleCode: "reviewer" })),
}));


vi.mock("@/lib/state-observatory/temporal-trend-service", () => ({
  analyzeTemporalTrend: vi.fn().mockResolvedValue({
    trendDirection: "unknown", dataSufficiency: "insufficient",
    limitationReason: "test", magnitudeOfChange: "unknown",
    consistencyIssues: [], temporalGaps: [], dataPoints: [],
    pointToPointChanges: [], attributionLevel: "descriptive",
    trendPolicyUsed: "default", stabilityToleranceUsed: 0,
    averageAbsoluteChange: null,
  }),
}));
vi.mock("@/lib/state-observatory/early-warning-service", () => ({
  assessEarlyWarning: vi.fn().mockResolvedValue({
    warningLevel: "insufficient_data", limitationReason: "test",
    isAdvisoryOnly: true, noCausalClaims: true, isCalibrated: false,
  }),
}));

import { getInstitutionalView } from "@/lib/state-observatory/institutional-view-service";
import { analyzeTemporalTrend } from "@/lib/state-observatory/temporal-trend-service";
import { assessEarlyWarning } from "@/lib/state-observatory/early-warning-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  // Re-establish mock return values (clearAllMocks clears them)
  vi.mocked(analyzeTemporalTrend).mockResolvedValue({ trendDirection: "unknown", dataSufficiency: "insufficient", limitationReason: "test", magnitudeOfChange: "unknown", consistencyIssues: [], temporalGaps: [], dataPoints: [], pointToPointChanges: [], attributionLevel: "descriptive", trendPolicyUsed: "default", stabilityToleranceUsed: 0, averageAbsoluteChange: null } as any);
  vi.mocked(assessEarlyWarning).mockResolvedValue({ warningLevel: "insufficient_data", limitationReason: "test", isAdvisoryOnly: true, noCausalClaims: true, isCalibrated: false } as any);
  // Default mocks
  mockTx.institution.findUnique.mockResolvedValue({ id: "inst_1", code: "MIN_EDU", displayName: "Ministry of Education", type: "ministry", parentId: null, countryId: "country_DML" });
  mockTx.tenant.findUnique.mockResolvedValue({ countryId: "country_DML" });
  mockTx.strategyVersion.findFirst.mockResolvedValue({ id: "sv_1" });
  mockTx.observationPeriod.findFirst.mockResolvedValue({ id: "p1" });
  mockTx.program.findMany.mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("V-01: returns only programs with matching owningInstitutionId", () => {
  it("returns programs owned by the requested institution", async () => {
    mockTx.program.findMany.mockResolvedValue([{ id: "prog_1", title: "Program 1", sector: "education", status: "active" }]);
    mockTx.indicatorDefinition.findMany.mockResolvedValue([]);
    const result = await getInstitutionalView(null, { institutionId: "inst_1", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    expect(result.programs).toHaveLength(1);
    expect(result.programs[0]!.id).toBe("prog_1");
    const call = mockTx.program.findMany.mock.calls[0]![0];
    expect(call.where.owningInstitutionId).toBe("inst_1");
  });
});

describe("V-02: national indicator labeled 'linked' not 'attributed'", () => {
  it("uses linkedNationalIndicatorsCount", async () => {
    mockTx.program.findMany.mockResolvedValue([{ id: "prog_1", title: "P1", sector: "ed", status: "active" }]);
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{ id: "ind_1", code: "X", displayName: "X", unit: "%", preferredDirection: "decrease" }]);
    mockTx.observation.findFirst.mockResolvedValue({ id: "obs_1", observedValue: BigInt(90000), observedAt: new Date(), isSynthetic: true });
    mockTx.varianceRecord.findFirst.mockResolvedValue(null);
    mockTx.varianceRecord.findMany.mockResolvedValue([]);
    const result = await getInstitutionalView(null, { institutionId: "inst_1", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    expect(result.attributionSummary).toHaveProperty("linkedNationalIndicatorsCount");
    expect(result.attributionSummary).not.toHaveProperty("nationalIndicatorsAttributed");
  });
});

describe("V-04: causalAttribution always 'descriptive'", () => {
  it("attribution.causalAttribution = 'descriptive'", async () => {
    mockTx.program.findMany.mockResolvedValue([{ id: "prog_1", title: "P1", sector: "ed", status: "active" }]);
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{ id: "ind_1", code: "X", displayName: "X", unit: "%", preferredDirection: "decrease" }]);
    mockTx.observation.findFirst.mockResolvedValue(null);
    mockTx.varianceRecord.findFirst.mockResolvedValue(null);
    mockTx.varianceRecord.findMany.mockResolvedValue([]);
    const result = await getInstitutionalView(null, { institutionId: "inst_1", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    expect(result.programs[0]!.indicators[0]!.attribution.causalAttribution).toBe("descriptive");
  });
});

describe("V-05: executionProgress always 'not_tracked'", () => {
  it("executionProgress = 'not_tracked' even when Program.status='completed'", async () => {
    mockTx.program.findMany.mockResolvedValue([{ id: "prog_1", title: "P1", sector: "ed", status: "completed" }]);
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{ id: "ind_1", code: "X", displayName: "X", unit: "%", preferredDirection: "decrease" }]);
    mockTx.observation.findFirst.mockResolvedValue(null);
    mockTx.varianceRecord.findFirst.mockResolvedValue(null);
    mockTx.varianceRecord.findMany.mockResolvedValue([]);
    const result = await getInstitutionalView(null, { institutionId: "inst_1", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    expect(result.programs[0]!.status).toBe("completed");
    expect(result.programs[0]!.indicators[0]!.attribution.executionProgress).toBe("not_tracked");
  });
});

describe("V-08: institution from different country → error", () => {
  it("throws when institution countryId ≠ tenant countryId", async () => {
    mockTx.institution.findUnique.mockResolvedValue({ id: "inst_jor", code: "JOR_MIN", displayName: "Jordan Ministry", type: "ministry", parentId: null, countryId: "country_JOR" });
    mockTx.tenant.findUnique.mockResolvedValue({ countryId: "country_DML" });
    await expect(
      getInstitutionalView(null, { institutionId: "inst_jor", strategyVersionId: "sv_1", observationPeriodId: "p1" })
    ).rejects.toThrow(/country/);
  });
});

describe("CORRECTION 1: national and institutional temporal contexts are separate", () => {
  it("temporalContext has separate nationalTrend + institutionalTrend with geoScope labels", async () => {
    mockTx.program.findMany.mockResolvedValue([{ id: "prog_1", title: "P1", sector: "ed", status: "active" }]);
    mockTx.indicatorDefinition.findMany.mockResolvedValue([{ id: "ind_1", code: "X", displayName: "X", unit: "%", preferredDirection: "decrease" }]);
    mockTx.observation.findFirst.mockResolvedValue(null);
    mockTx.varianceRecord.findFirst.mockResolvedValue(null);
    mockTx.varianceRecord.findMany.mockResolvedValue([]);
    const result = await getInstitutionalView(null, { institutionId: "inst_1", strategyVersionId: "sv_1", observationPeriodId: "p1" });
    const tc = result.programs[0]!.indicators[0]!.temporalContext;
    expect(tc.nationalTrend).not.toBeNull();
    expect(tc.nationalTrend!.geoScope).toBe("national");
    expect(tc.institutionalTrend).not.toBeNull();
    expect(tc.institutionalTrend!.geoScope).toBe("institutional");
    expect(tc.nationalEarlyWarning!.geoScope).toBe("national");
    expect(tc.institutionalEarlyWarning!.warningLevel).toBe("not_computed");
  });
});
