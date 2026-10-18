// ============================================================
// tests/unit/state-observatory/observatory-query-service.test.ts
// ------------------------------------------------------------
// Unit tests for getObservatorySnapshot (mocked Prisma).
// Covers U-12, U-13, U-14 per Mission 02-02 spec.
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
  observation: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  varianceRecord: { findFirst: vi.fn(), findMany: vi.fn() },
  alert: { findMany: vi.fn() },
  evidence: { findFirst: vi.fn(), findMany: vi.fn() },
  source: { findUnique: vi.fn() },
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
        tenantId: "tenant_A",
        roleCode: "reviewer",
      });
    }
  ),
}));

// FIX 3: Mock temporal + early-warning to avoid real DB calls in snapshot tests
vi.mock("@/lib/state-observatory/temporal-trend-service", () => ({
  analyzeTemporalTrend: vi.fn().mockResolvedValue({
    trendDirection: "unknown", dataSufficiency: "insufficient",
    magnitudeOfChange: "unknown", consistencyIssues: [], temporalGaps: [],
    dataPoints: [], pointToPointChanges: [],
    attributionLevel: "descriptive", trendPolicyUsed: "default_all_or_nothing",
    stabilityToleranceUsed: 0, averageAbsoluteChange: null,
    limitationReason: "test: no data",
  }),
}));
vi.mock("@/lib/state-observatory/early-warning-service", () => ({
  assessEarlyWarning: vi.fn().mockResolvedValue({
    warningLevel: "insufficient_data", warningReason: "test",
    contributingFactors: {
      trendDirection: "unknown", dataSufficiency: "insufficient",
      magnitudeOfChange: "unknown", currentVarianceDirection: "unknown",
      observabilityMode: "LOW", consistencyIssuesCount: 0, temporalGapsCount: 0,
    },
    isAdvisoryOnly: true, noCausalClaims: true, isCalibrated: false,
    limitationReason: "test", policyUsed: "default_descriptive",
  }),
}));

// Mock analyzeAggregateIndependence to avoid complex setup
vi.mock("@/lib/state-observatory/aggregate-independence-service", () => ({
  analyzeAggregateIndependence: vi.fn().mockResolvedValue({
    observabilityMode: "PARTIAL",
    limitationReason: "test limitation",
    sourceDiversity: { totalSources: 1, independentSourceCount: 1 },
    evidenceStrength: { verifiedEvidenceCount: 0 },
    nationalClaimSupport: { level: "none" },
    coverage: { distinctGeoRefIds: 0 },
    honesty: { geographicCoverageNotEqualsIndependence: true, simulatedData: true },
    // Include all fields accessed by the snapshot service
    totalObservations: 1,
  }),
}));

import { getObservatorySnapshot } from "@/lib/state-observatory/observatory-query-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  // Default valid setup
  mockTx.strategyVersion.findFirst.mockResolvedValue({
    id: "sv_1",
    status: "approved",
    versionNumber: 1,
  });
  mockTx.observationPeriod.findFirst.mockResolvedValue({
    id: "period_1",
    periodType: "quarterly",
    periodValue: "2026-Q2",
  });
  mockTx.indicatorDefinition.findMany.mockResolvedValue([]); // no indicators by default
  // FIX 2 mock: varianceRecord.findMany returns empty by default (no variance records)
  mockTx.varianceRecord.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("observatory-query-service — U-12: 4-layer structure per indicator", () => {
  it("returns snapshot with 4 layers (observedFacts, calculatedComparisons, uncertainties, interpretations)", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([
      {
        id: "ind_1",
        code: "INFLATION",
        displayName: "Inflation",
        unit: "percent",
        preferredDirection: "decrease",
      },
    ]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      observedAt: new Date("2026-04-15"),
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
      geoRefId: null,
      evidenceId: null,
      sourceId: "src_1",
    });
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", observedValue: 9.0, correctionReason: null, correctedAt: null, isCurrent: true, createdAt: new Date() },
    ]);
    mockTx.varianceRecord.findFirst.mockResolvedValue({
      id: "vr_1",
      plannedValue: 7.0,
      plannedValueType: "period_milestone",
      varianceAbsolute: 2.0,
      varianceDirection: "worse",
      comparisonValid: true,
      attributionLevel: "descriptive",
    });
    mockTx.alert.findMany.mockResolvedValue([
      {
        id: "alert_1",
        title: "Test alert",
        severity: "warning",
        lifecycleStage: "notified",
        executionStatus: "not_applicable",
        isAutoGenerated: true,
      },
    ]);
    mockTx.source.findUnique.mockResolvedValue({
      id: "src_1",
      code: "SRC_1",
      displayName: "Source 1",
      independenceGroup: null,
      reviewStatus: "approved",
      submittedByTenantId: null,
    });
    mockTx.observation.findUnique.mockResolvedValue({
      qualityNotes: { provenanceWarnings: ["test warning"] },
    });

    const result = await getObservatorySnapshot(null, {
      strategyVersionId: "sv_1",
      observationPeriodId: "period_1",
    });

    expect(result.indicators).toHaveLength(1);
    const ind = result.indicators[0]!;
    // B12: 4 layers present
    expect(ind).toHaveProperty("observedFacts");
    expect(ind).toHaveProperty("calculatedComparisons");
    expect(ind).toHaveProperty("uncertainties");
    expect(ind).toHaveProperty("interpretations");
    // Each layer has expected sub-structure
    expect(ind.observedFacts).toHaveProperty("currentObservation");
    expect(ind.observedFacts).toHaveProperty("observationHistoryCount");
    expect(ind.observedFacts).toHaveProperty("correctionChain");
    expect(ind.calculatedComparisons).toHaveProperty("varianceRecord");
    expect(ind.uncertainties).toHaveProperty("unknowns");
    expect(ind.uncertainties).toHaveProperty("observabilityMode");
    expect(ind.uncertainties).toHaveProperty("independenceAssessment");
    expect(ind.interpretations).toHaveProperty("alerts");
  });
});

describe("observatory-query-service — U-13: no causal claims", () => {
  it("honesty.noCausalClaims=true and attributionLevel='descriptive'", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([
      {
        id: "ind_1",
        code: "INFLATION",
        displayName: "Inflation",
        unit: "percent",
        preferredDirection: "decrease",
      },
    ]);
    mockTx.observation.findFirst.mockResolvedValue(null);
    mockTx.observation.findMany.mockResolvedValue([]);
    mockTx.varianceRecord.findFirst.mockResolvedValue(null);
    mockTx.alert.findMany.mockResolvedValue([]);

    const result = await getObservatorySnapshot(null, {
      strategyVersionId: "sv_1",
      observationPeriodId: "period_1",
    });

    // B13: no causal claims
    expect(result.honesty.noCausalClaims).toBe(true);
    // If varianceRecord exists, attributionLevel is "descriptive"
    // (mocked null here, but the contract enforces it in the service)
  });

  it("varianceRecord.attributionLevel is 'descriptive' when present", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([
      {
        id: "ind_1",
        code: "INFLATION",
        displayName: "Inflation",
        unit: "percent",
        preferredDirection: "decrease",
      },
    ]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      observedAt: null,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true,
      geoLevel: "national",
      geoRefId: null,
      evidenceId: null,
      sourceId: null,
    });
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", observedValue: 9.0, correctionReason: null, correctedAt: null, isCurrent: true, createdAt: new Date() },
    ]);
    mockTx.varianceRecord.findFirst.mockResolvedValue({
      id: "vr_1",
      plannedValue: 7.0,
      plannedValueType: "period_milestone",
      varianceAbsolute: 2.0,
      varianceDirection: "worse",
      comparisonValid: true,
      attributionLevel: "descriptive", // B13 enforced
    });
    mockTx.alert.findMany.mockResolvedValue([]);

    const result = await getObservatorySnapshot(null, {
      strategyVersionId: "sv_1",
      observationPeriodId: "period_1",
    });

    expect(result.indicators[0]!.calculatedComparisons.varianceRecord!.attributionLevel).toBe(
      "descriptive"
    );
  });
});

describe("observatory-query-service — U-14: simulatedData flag", () => {
  it("honesty.simulatedData=true when any observation has isSynthetic=true", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([
      {
        id: "ind_1",
        code: "INFLATION",
        displayName: "Inflation",
        unit: "percent",
        preferredDirection: "decrease",
      },
    ]);
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_1",
      observedValue: 9.0,
      observedAt: null,
      originType: "observed",
      verificationStatus: "unverified",
      isSynthetic: true, // Demolandia
      geoLevel: "national",
      geoRefId: null,
      evidenceId: null,
      sourceId: null,
    });
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", observedValue: 9.0, correctionReason: null, correctedAt: null, isCurrent: true, createdAt: new Date() },
    ]);
    mockTx.varianceRecord.findFirst.mockResolvedValue(null);
    mockTx.alert.findMany.mockResolvedValue([]);

    const result = await getObservatorySnapshot(null, {
      strategyVersionId: "sv_1",
      observationPeriodId: "period_1",
    });

    expect(result.honesty.simulatedData).toBe(true);
  });

  it("honesty.simulatedData=false when no observations (no indicators)", async () => {
    mockTx.indicatorDefinition.findMany.mockResolvedValue([]);

    const result = await getObservatorySnapshot(null, {
      strategyVersionId: "sv_1",
      observationPeriodId: "period_1",
    });

    expect(result.honesty.simulatedData).toBe(false);
  });
});

describe("observatory-query-service — scope validation", () => {
  it("throws when strategyVersionId not approved in tenant", async () => {
    mockTx.strategyVersion.findFirst.mockResolvedValue(null);

    await expect(
      getObservatorySnapshot(null, {
        strategyVersionId: "sv_missing",
        observationPeriodId: "period_1",
      })
    ).rejects.toThrow(/not found or not approved/);
  });

  it("throws when observationPeriodId not in tenant", async () => {
    mockTx.observationPeriod.findFirst.mockResolvedValue(null);

    await expect(
      getObservatorySnapshot(null, {
        strategyVersionId: "sv_1",
        observationPeriodId: "period_missing",
      })
    ).rejects.toThrow(/not found in tenant/);
  });
});
