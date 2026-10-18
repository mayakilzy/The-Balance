// ============================================================
// tests/unit/state-observatory/aggregate-independence-service.test.ts
// ------------------------------------------------------------
// Unit tests for analyzeAggregateIndependence (mocked Prisma).
// Covers U-01..U-11 per Mission 02-02 spec + owner corrections.
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
  observation: { findMany: vi.fn() },
  source: { findMany: vi.fn() },
  evidence: { findMany: vi.fn() },
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

import { analyzeAggregateIndependence } from "@/lib/state-observatory/aggregate-independence-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aggregate-independence — U-01: LOW when 0 observations", () => {
  it("returns observabilityMode=LOW when no observations exist", async () => {
    mockTx.observation.findMany.mockResolvedValue([]);
    mockTx.source.findMany.mockResolvedValue([]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.observabilityMode).toBe("LOW");
    expect(result.totalObservations).toBe(0);
    expect(result.limitationReason).toContain("no observations");
  });
});

describe("aggregate-independence — U-02: PARTIAL when only subnational (no national)", () => {
  it("returns PARTIAL + limitationReason when only subnational observations exist", async () => {
    // 5 subnational observations from 5 different geos + 5 different sources
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_1", isSynthetic: true },
      { id: "obs_2", sourceId: "src_2", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_2", isSynthetic: true },
      { id: "obs_3", sourceId: "src_3", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_3", isSynthetic: true },
      { id: "obs_4", sourceId: "src_4", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_4", isSynthetic: true },
      { id: "obs_5", sourceId: "src_5", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_5", isSynthetic: true },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
      { id: "src_2", independenceGroup: null },
      { id: "src_3", independenceGroup: null },
      { id: "src_4", independenceGroup: null },
      { id: "src_5", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    // B4: subnational spread does NOT produce FULL
    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.limitationReason).toContain("no national-level observation");
    expect(result.coverage.distinctGeoRefIds).toBe(5);
    expect(result.sourceDiversity.independentSourceCount).toBe(5);
    expect(result.nationalClaimSupport.level).toBe("none");
  });
});

describe("aggregate-independence — U-03: FULL only via national-level + independent verified evidence", () => {
  it("returns FULL when 1 national obs + 2 independent verified evidence (direct + related)", async () => {
    // 1 national observation with direct evidenceId="ev_1"
    // ev_1 is verified, sourceId="src_1" (independenceGroup=null)
    // ev_2 is related to ev_1 (relatedEvidenceId="ev_1"), verified, sourceId="src_2" (independenceGroup=null)
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_nat", sourceId: "src_1", evidenceId: "ev_1", originType: "observed", geoLevel: "national", geoRefId: null, isSynthetic: true },
    ]);
    // First call: sources for observations
    // Second call: sources for verified linked evidence
    mockTx.source.findMany.mockResolvedValueOnce([
      { id: "src_1", independenceGroup: null },
    ]);
    // evidence findMany first call: direct evidence (ev_1)
    mockTx.evidence.findMany.mockResolvedValueOnce([
      { id: "ev_1", tenantId: "tenant_A", sourceId: "src_1", verificationStatus: "verified", type: "supporting", relatedEvidenceId: null },
    ]);
    // evidence findMany second call: related evidence (ev_2)
    mockTx.evidence.findMany.mockResolvedValueOnce([
      { id: "ev_2", tenantId: "tenant_A", sourceId: "src_2", verificationStatus: "verified", type: "supporting", relatedEvidenceId: "ev_1" },
    ]);
    // source findMany for national sources
    mockTx.source.findMany.mockResolvedValueOnce([
      { id: "src_1", independenceGroup: null },
    ]);
    // source findMany for verified linked evidence sources (src_1 + src_2)
    mockTx.source.findMany.mockResolvedValueOnce([
      { id: "src_1", independenceGroup: null },
      { id: "src_2", independenceGroup: null },
    ]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.observabilityMode).toBe("FULL");
    expect(result.nationalClaimSupport.level).toBe("strong");
    expect(result.limitationReason).toBeNull();
    expect(result.evidenceStrength.independentVerifiedEvidenceLinkedToNationalClaim).toBe(2);
  });
});

describe("aggregate-independence — U-04: subnational spread never creates FULL", () => {
  it("5 subnational obs from 5 independent sources → PARTIAL (not FULL)", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_1", isSynthetic: true },
      { id: "obs_2", sourceId: "src_2", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_2", isSynthetic: true },
      { id: "obs_3", sourceId: "src_3", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_3", isSynthetic: true },
      { id: "obs_4", sourceId: "src_4", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_4", isSynthetic: true },
      { id: "obs_5", sourceId: "src_5", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_5", isSynthetic: true },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
      { id: "src_2", independenceGroup: null },
      { id: "src_3", independenceGroup: null },
      { id: "src_4", independenceGroup: null },
      { id: "src_5", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    // B4 critical: 5 subnational sources ≠ FULL
    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.nationalClaimSupport.level).toBe("none");
    expect(result.limitationReason).toContain("no national-level observation");
  });
});

describe("aggregate-independence — U-05/U-06: coverageRatio", () => {
  it("U-05: coverageRatio computed when totalExpectedGeoRefIds provided (currently null — returns null)", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_1", isSynthetic: true },
      { id: "obs_2", sourceId: "src_1", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_2", isSynthetic: true },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    // U-06: totalExpectedGeoRefIds is null in 02-02 → coverageRatio is null
    expect(result.coverage.totalExpectedGeoRefIds).toBeNull();
    expect(result.coverage.coverageRatio).toBeNull();
    expect(result.coverage.distinctGeoRefIds).toBe(2);
  });
});

describe("aggregate-independence — U-07: independentSourceCount dedup", () => {
  it("3 sources, 2 sharing independenceGroup → independentSourceCount=2", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_1", isSynthetic: true },
      { id: "obs_2", sourceId: "src_2", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_2", isSynthetic: true },
      { id: "obs_3", sourceId: "src_3", evidenceId: null, originType: "observed", geoLevel: "subnational", geoRefId: "geo_3", isSynthetic: true },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: "group-A" },
      { id: "src_2", independenceGroup: "group-A" }, // shares with src_1
      { id: "src_3", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.sourceDiversity.totalSources).toBe(3);
    expect(result.sourceDiversity.independentSourceCount).toBe(2); // group-A + src_3
  });
});

describe("aggregate-independence — U-08: preserves refuted/disputed evidence in counts", () => {
  it("refuted + disputed evidence counted in evidenceStrength (not deleted)", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_nat", sourceId: "src_1", evidenceId: "ev_1", originType: "observed", geoLevel: "national", geoRefId: null, isSynthetic: true },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
    ]);
    // direct evidence ev_1 (disputed) + related ev_2 (refuted)
    mockTx.evidence.findMany.mockResolvedValueOnce([
      { id: "ev_1", tenantId: "tenant_A", sourceId: "src_1", verificationStatus: "disputed", type: "supporting", relatedEvidenceId: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValueOnce([
      { id: "ev_2", tenantId: "tenant_A", sourceId: "src_2", verificationStatus: "refuted", type: "counter", relatedEvidenceId: "ev_1" },
    ]);
    mockTx.source.findMany.mockResolvedValueOnce([
      { id: "src_1", independenceGroup: null },
    ]);
    // verified linked sources: none (both disputed/refuted)
    mockTx.source.findMany.mockResolvedValueOnce([]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.evidenceStrength.disputedEvidenceCount).toBe(1);
    expect(result.evidenceStrength.refutedEvidenceCount).toBe(1);
    expect(result.evidenceStrength.contradictoryEvidenceCount).toBe(1); // ev_2 is type="counter"
    expect(result.evidenceStrength.verifiedEvidenceCount).toBe(0);
    // No verified evidence → PARTIAL
    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.nationalClaimSupport.level).toBe("none");
  });
});

describe("aggregate-independence — U-09/U-10/U-11: nationalClaimSupport levels", () => {
  it("U-09: level=none when 0 verified evidence", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_nat", sourceId: "src_1", evidenceId: "ev_1", originType: "observed", geoLevel: "national", geoRefId: null, isSynthetic: true },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValueOnce([
      { id: "ev_1", tenantId: "tenant_A", sourceId: "src_1", verificationStatus: "unverified", type: "supporting", relatedEvidenceId: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValueOnce([]); // no related
    mockTx.source.findMany.mockResolvedValueOnce([
      { id: "src_1", independenceGroup: null },
    ]);
    mockTx.source.findMany.mockResolvedValueOnce([]); // no verified linked

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.nationalClaimSupport.level).toBe("none");
  });

  it("U-10: level=partial when 1 verified evidence but <2 independent national sources", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_nat", sourceId: "src_1", evidenceId: "ev_1", originType: "observed", geoLevel: "national", geoRefId: null, isSynthetic: true },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValueOnce([
      { id: "ev_1", tenantId: "tenant_A", sourceId: "src_1", verificationStatus: "verified", type: "supporting", relatedEvidenceId: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValueOnce([]); // no related
    mockTx.source.findMany.mockResolvedValueOnce([
      { id: "src_1", independenceGroup: null },
    ]);
    // verified linked sources: only src_1 (1 independent)
    mockTx.source.findMany.mockResolvedValueOnce([
      { id: "src_1", independenceGroup: null },
    ]);

    const result = await analyzeAggregateIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.nationalClaimSupport.level).toBe("partial");
    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.limitationReason).toContain("only 1 independent verified evidence");
  });
});
