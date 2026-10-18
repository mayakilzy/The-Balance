// ============================================================
// tests/unit/state-observatory/evidence-independence-service.test.ts
// ------------------------------------------------------------
// Unit tests for analyzeIndependence (mocked Prisma).
// Covers the algorithm logic (A9, A10, A11, A12, A14) + Blueprint §5.4.
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
  tenant: { findUnique: vi.fn() },
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

import { analyzeIndependence } from "@/lib/state-observatory/evidence-independence-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  mockTx.tenant.findUnique.mockResolvedValue({ countryId: "country_DML" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analyzeIndependence — A10: dedup by independenceGroup", () => {
  it("counts 2 sources sharing independenceGroup as 1 independent", async () => {
    // 3 observations from 3 sources; 2 share independenceGroup="group-A"
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed" },
      { id: "obs_2", sourceId: "src_2", evidenceId: null, originType: "observed" },
      { id: "obs_3", sourceId: "src_3", evidenceId: null, originType: "observed" },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: "group-A" },
      { id: "src_2", independenceGroup: "group-A" }, // shares with src_1
      { id: "src_3", independenceGroup: null }, // independent
    ]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.totalSources).toBe(3);
    expect(result.independentSourceCount).toBe(2); // group-A counts as 1 + src_3 = 2
    expect(result.duplicateGroups).toHaveLength(2);
    // Group-A should have 2 sourceIds and 2 observationIds
    const groupA = result.duplicateGroups.find(
      (g) => g.independenceGroup === "group-A"
    );
    expect(groupA).toBeDefined();
    expect(groupA!.sourceIds).toHaveLength(2);
    expect(groupA!.observationIds).toHaveLength(2);
  });
});

describe("analyzeIndependence — A11: multiple obs from same source = 1 source", () => {
  it("counts 2 observations from same source as 1 source", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed" },
      { id: "obs_2", sourceId: "src_1", evidenceId: null, originType: "observed" },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.totalObservations).toBe(2);
    expect(result.totalSources).toBe(1); // distinct sourceIds
    expect(result.independentSourceCount).toBe(1);
  });
});

describe("analyzeIndependence — A12: only isCurrent=true counted", () => {
  it("the where clause includes isCurrent: true", async () => {
    mockTx.observation.findMany.mockResolvedValue([]);
    mockTx.source.findMany.mockResolvedValue([]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    const call = mockTx.observation.findMany.mock.calls[0]![0];
    expect(call.where.isCurrent).toBe(true);
  });
});

describe("analyzeIndependence — Blueprint §5.4: FULL/PARTIAL/LOW", () => {
  it("LOW: 0 observations", async () => {
    mockTx.observation.findMany.mockResolvedValue([]);
    mockTx.source.findMany.mockResolvedValue([]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.observabilityMode).toBe("LOW");
    expect(result.independentSourceCount).toBe(0);
  });

  it("LOW: 0 independent sources (observations without sourceId)", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: null, evidenceId: null, originType: "synthetic" },
    ]);
    mockTx.source.findMany.mockResolvedValue([]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.observabilityMode).toBe("LOW");
    expect(result.independentSourceCount).toBe(0);
  });

  it("PARTIAL: 1 independent source, 0 verified evidence", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: "ev_1", originType: "observed" },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([
      { id: "ev_1", verificationStatus: "unverified" },
    ]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.observabilityMode).toBe("PARTIAL");
    expect(result.independentSourceCount).toBe(1);
    expect(result.verifiedEvidenceCount).toBe(0);
  });

  it("FULL: 2 independent sources + 1 verified evidence", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: "ev_1", originType: "observed" },
      { id: "obs_2", sourceId: "src_2", evidenceId: null, originType: "observed" },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
      { id: "src_2", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([
      { id: "ev_1", verificationStatus: "verified" },
    ]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.observabilityMode).toBe("FULL");
    expect(result.independentSourceCount).toBe(2);
    expect(result.verifiedEvidenceCount).toBe(1);
  });

  it("PARTIAL: 2 independent sources but 0 verified evidence", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed" },
      { id: "obs_2", sourceId: "src_2", evidenceId: null, originType: "observed" },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
      { id: "src_2", independenceGroup: null },
    ]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.observabilityMode).toBe("PARTIAL"); // 2 sources but 0 verified evidence
    expect(result.independentSourceCount).toBe(2);
    expect(result.verifiedEvidenceCount).toBe(0);
  });
});

describe("analyzeIndependence — A14: verified evidence must be linked to in-scope obs", () => {
  it("does NOT count verified evidence that is not linked to in-scope observations", async () => {
    // Only 1 observation, with NO evidence link
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", sourceId: "src_1", evidenceId: null, originType: "observed" },
    ]);
    mockTx.source.findMany.mockResolvedValue([
      { id: "src_1", independenceGroup: null },
    ]);
    // evidence findMany returns empty because no evidenceId in observations
    mockTx.evidence.findMany.mockResolvedValue([]);

    const result = await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(result.verifiedEvidenceCount).toBe(0);
    expect(result.observabilityMode).toBe("PARTIAL"); // 1 source, 0 verified
  });
});

describe("analyzeIndependence — geo scoping", () => {
  it("passes geoLevel and geoRefId to where clause", async () => {
    mockTx.observation.findMany.mockResolvedValue([]);
    mockTx.source.findMany.mockResolvedValue([]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
      geoLevel: "subnational",
      geoRefId: "geo_damascus",
    });

    const call = mockTx.observation.findMany.mock.calls[0]![0];
    expect(call.where.geoLevel).toBe("subnational");
    expect(call.where.geoRefId).toBe("geo_damascus");
  });

  it("defaults to geoLevel=national, geoRefId=null", async () => {
    mockTx.observation.findMany.mockResolvedValue([]);
    mockTx.source.findMany.mockResolvedValue([]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    const call = mockTx.observation.findMany.mock.calls[0]![0];
    expect(call.where.geoLevel).toBe("national");
    expect(call.where.geoRefId).toBeNull();
  });
});

describe("analyzeIndependence — audit log", () => {
  it("writes audit_log with action=observatory.independence.analyzed", async () => {
    mockTx.observation.findMany.mockResolvedValue([]);
    mockTx.source.findMany.mockResolvedValue([]);
    mockTx.evidence.findMany.mockResolvedValue([]);

    await analyzeIndependence(null, {
      indicatorId: "ind_1",
      observationPeriodId: "period_1",
    });

    expect(mockWriteAuditTx).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditTx.mock.calls[0]![1];
    expect(auditCall.action).toBe("observatory.independence.analyzed");
    expect(auditCall.status).toBe("ok");
  });
});
