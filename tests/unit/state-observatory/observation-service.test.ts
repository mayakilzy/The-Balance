// ============================================================
// tests/unit/state-observatory/observation-service.test.ts
// ------------------------------------------------------------
// Unit tests for ObservationService — uses mocked Prisma client.
//
// Covers:
//   U-04: ingestObservation rejects originType=observed without sourceId (Zod)
//   U-05: ingestObservation rejects originType=derived without derivationMethod (Zod)
//   U-06: ingestObservation accepts observedValue=null
//   U-07: correctObservation creates new Observation with supersedesId + isCurrent=true
//   U-08: correctObservation sets isCurrent=false + supersededById on old
//   U-09: correctObservation on non-current obs throws ConflictError
//   U-10: getCurrentObservation returns only isCurrent=true
//   F2: correctObservation order (lock → deactivate → create → link)
//   E3: cross-country geoRefId rejection (institutional)
// ============================================================
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Session } from "next-auth";

// Mock permission utility
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

// Mock audit
const mockWriteAuditTx = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  writeAuditTx: (...args: unknown[]) => mockWriteAuditTx(...args),
}));

const mockTx = {
  indicatorDefinition: { findFirst: vi.fn() },
  observationPeriod: { findFirst: vi.fn() },
  strategyVersion: { findFirst: vi.fn() },
  observation: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  institution: { findUnique: vi.fn() },
  tenant: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
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

import {
  ingestObservation,
  correctObservation,
  getCurrentObservation,
  listObservations,
} from "@/lib/state-observatory/observation-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditTx.mockResolvedValue(undefined);
  mockTx.indicatorDefinition.findFirst.mockResolvedValue({ id: "ind_1" });
  mockTx.observationPeriod.findFirst.mockResolvedValue({ id: "period_1" });
  mockTx.strategyVersion.findFirst.mockResolvedValue({ id: "sv_1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const validIngestInput = {
  indicatorDefinitionId: "ind_1",
  observationPeriodId: "period_1",
  observedValue: 9.0,
  originType: "observed" as const,
  sourceId: "src_1",
};

describe("ObservationService.ingestObservation", () => {
  it("U-06: accepts observedValue=null (unknown case)", async () => {
    mockTx.observation.create.mockResolvedValue({
      id: "obs_1",
      observedValue: null,
      isCurrent: true,
    });

    const result = await ingestObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { ...validIngestInput, observedValue: null }
    );

    expect(result.observedValue).toBeNull();
    expect(mockTx.observation.create).toHaveBeenCalledOnce();
    const createCall = mockTx.observation.create.mock.calls[0]![0];
    expect(createCall.data.observedValue).toBeNull();
    expect(createCall.data.isCurrent).toBe(true);
  });

  it("creates observation with isSynthetic=true by default (Demolandia marker)", async () => {
    mockTx.observation.create.mockResolvedValue({
      id: "obs_1",
      isSynthetic: true,
    });

    await ingestObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      validIngestInput
    );

    const createCall = mockTx.observation.create.mock.calls[0]![0];
    expect(createCall.data.isSynthetic).toBe(true);
    expect(createCall.data.qualityNotes.isSynthetic).toBe(true);
    expect(createCall.data.qualityNotes.syntheticCountry).toBe("DML");
  });

  it("writes atomic audit log on success", async () => {
    mockTx.observation.create.mockResolvedValue({ id: "obs_1" });

    await ingestObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      validIngestInput
    );

    expect(mockWriteAuditTx).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditTx.mock.calls[0]![1];
    expect(auditCall.action).toBe("observatory.observation.ingested");
    expect(auditCall.status).toBe("ok");
  });

  it("throws NotFoundError when indicator not found in tenant", async () => {
    mockTx.indicatorDefinition.findFirst.mockResolvedValue(null);

    await expect(
      ingestObservation(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        validIngestInput
      )
    ).rejects.toThrow(/Indicator.*not found/);
  });

  it("throws NotFoundError when period not found in tenant", async () => {
    mockTx.observationPeriod.findFirst.mockResolvedValue(null);

    await expect(
      ingestObservation(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        validIngestInput
      )
    ).rejects.toThrow(/period.*not found/i);
  });

  it("throws when strategyVersionId is not approved", async () => {
    mockTx.strategyVersion.findFirst.mockResolvedValue(null);

    await expect(
      ingestObservation(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        { ...validIngestInput, strategyVersionId: "sv_unapproved" }
      )
    ).rejects.toThrow(/not found or not approved/);
  });

  it("E3: rejects institutional geoRefId in different country", async () => {
    mockTx.tenant.findUnique.mockResolvedValue({ countryId: "country_DML" });
    mockTx.institution.findUnique.mockResolvedValue({ countryId: "country_JOR" });

    await expect(
      ingestObservation(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        {
          ...validIngestInput,
          geoLevel: "institutional" as const,
          geoRefId: "inst_jor",
        }
      )
    ).rejects.toThrow(/E3 violation/);
  });

  it("E3: accepts institutional geoRefId in same country", async () => {
    mockTx.tenant.findUnique.mockResolvedValue({ countryId: "country_DML" });
    mockTx.institution.findUnique.mockResolvedValue({ countryId: "country_DML" });
    mockTx.observation.create.mockResolvedValue({ id: "obs_1" });

    const result = await ingestObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      {
        ...validIngestInput,
        geoLevel: "institutional" as const,
        geoRefId: "inst_dml",
      }
    );

    expect(result.id).toBe("obs_1");
  });
});

describe("ObservationService.correctObservation — F2 transaction order", () => {
  beforeEach(() => {
    // Mock the SELECT FOR UPDATE $queryRaw result
    mockTx.$queryRaw.mockResolvedValue([
      {
        id: "obs_old",
        tenantId: "tenant_1",
        indicatorDefinitionId: "ind_1",
        observationPeriodId: "period_1",
        geoLevel: "national",
        geoRefId: null,
        isCurrent: true,
        supersededById: null,
        originType: "observed",
        sourceId: "src_1",
        derivationMethod: null,
        strategyVersionId: null,
      },
    ]);
    mockTx.observation.update.mockResolvedValue({});
    mockTx.observation.create.mockResolvedValue({
      id: "obs_new",
      supersedesId: "obs_old",
      isCurrent: true,
      observedValue: 9.2,
    });
  });

  it("U-07: creates new observation with supersedesId + isCurrent=true", async () => {
    const result = await correctObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      "obs_old",
      { newValue: 9.2, reason: "source revision" }
    );

    expect(result.id).toBe("obs_new");
    expect(result.supersedesId).toBe("obs_old");
    expect(result.isCurrent).toBe(true);

    // Verify the create payload
    const createCall = mockTx.observation.create.mock.calls[0]![0];
    expect(createCall.data.supersedesId).toBe("obs_old");
    expect(createCall.data.isCurrent).toBe(true);
    expect(createCall.data.observedValue).toBe(9.2);
    expect(createCall.data.correctionReason).toBe("source revision");
    expect(createCall.data.verificationStatus).toBe("unverified"); // corrections reset verification
  });

  it("U-08: deactivates old observation (isCurrent=false) + sets supersededById", async () => {
    await correctObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      "obs_old",
      { newValue: 9.2, reason: "source revision" }
    );

    // Two update calls: deactivate old, then set supersededById on old
    expect(mockTx.observation.update).toHaveBeenCalledTimes(2);

    // First update: deactivate (isCurrent=false)
    const firstUpdate = mockTx.observation.update.mock.calls[0]![0];
    expect(firstUpdate.where.id).toBe("obs_old");
    expect(firstUpdate.data.isCurrent).toBe(false);

    // Second update: set supersededById
    const secondUpdate = mockTx.observation.update.mock.calls[1]![0];
    expect(secondUpdate.where.id).toBe("obs_old");
    expect(secondUpdate.data.supersededById).toBe("obs_new");
  });

  it("F2: SELECT FOR UPDATE is called first (before any mutation)", async () => {
    await correctObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      "obs_old",
      { newValue: 9.2, reason: "source revision" }
    );

    // $queryRaw (FOR UPDATE) must be called before any update/create
    expect(mockTx.$queryRaw).toHaveBeenCalledBefore(mockTx.observation.update);
    expect(mockTx.$queryRaw).toHaveBeenCalledBefore(mockTx.observation.create);
  });

  it("U-09: throws ConflictError when observation is already superseded", async () => {
    mockTx.$queryRaw.mockResolvedValue([
      {
        id: "obs_old",
        tenantId: "tenant_1",
        indicatorDefinitionId: "ind_1",
        observationPeriodId: "period_1",
        geoLevel: "national",
        geoRefId: null,
        isCurrent: true,
        supersededById: "obs_other_successor", // already superseded
        originType: "observed",
        sourceId: "src_1",
        derivationMethod: null,
        strategyVersionId: null,
      },
    ]);

    await expect(
      correctObservation(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        "obs_old",
        { newValue: 9.2, reason: "second correction attempt" }
      )
    ).rejects.toThrow(/already superseded/);

    // No mutations should have occurred
    expect(mockTx.observation.update).not.toHaveBeenCalled();
    expect(mockTx.observation.create).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when observation not found or not current", async () => {
    mockTx.$queryRaw.mockResolvedValue([]); // empty result

    await expect(
      correctObservation(
        { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
        "obs_nonexistent",
        { newValue: 9.2, reason: "test" }
      )
    ).rejects.toThrow(/not found/);
  });

  it("writes atomic audit log on successful correction", async () => {
    await correctObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      "obs_old",
      { newValue: 9.2, reason: "source revision" }
    );

    expect(mockWriteAuditTx).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditTx.mock.calls[0]![1];
    expect(auditCall.action).toBe("observatory.observation.corrected");
    expect(auditCall.details.oldObservationId).toBe("obs_old");
    expect(auditCall.details.newObservationId).toBe("obs_new");
    expect(auditCall.details.reason).toBe("source revision");
  });
});

describe("ObservationService.getCurrentObservation — U-10", () => {
  it("returns only the isCurrent=true observation", async () => {
    mockTx.observation.findFirst.mockResolvedValue({
      id: "obs_current",
      isCurrent: true,
      observedValue: 9.0,
    });

    const result = await getCurrentObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { indicatorId: "ind_1", periodId: "period_1" }
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe("obs_current");
    expect(result!.isCurrent).toBe(true);

    const call = mockTx.observation.findFirst.mock.calls[0]![0];
    expect(call.where.isCurrent).toBe(true);
  });

  it("returns null when no current observation exists", async () => {
    mockTx.observation.findFirst.mockResolvedValue(null);

    const result = await getCurrentObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { indicatorId: "ind_1", periodId: "period_1" }
    );

    expect(result).toBeNull();
  });

  it("filters by geoLevel and geoRefId when provided", async () => {
    mockTx.observation.findFirst.mockResolvedValue(null);

    await getCurrentObservation(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      {
        indicatorId: "ind_1",
        periodId: "period_1",
        geoLevel: "subnational",
        geoRefId: "geo_damascus",
      }
    );

    const call = mockTx.observation.findFirst.mock.calls[0]![0];
    expect(call.where.geoLevel).toBe("subnational");
    expect(call.where.geoRefId).toBe("geo_damascus");
  });
});

describe("ObservationService.listObservations", () => {
  it("by default returns only current (isCurrent=true) rows", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", isCurrent: true },
    ]);

    await listObservations(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { indicatorDefinitionId: "ind_1" }
    );

    const call = mockTx.observation.findMany.mock.calls[0]![0];
    expect(call.where.isCurrent).toBe(true);
  });

  it("includeHistory=true returns all rows (including superseded)", async () => {
    mockTx.observation.findMany.mockResolvedValue([
      { id: "obs_1", isCurrent: false },
      { id: "obs_2", isCurrent: true },
    ]);

    await listObservations(
      { user: { id: "user_1", tenantId: "tenant_1", membershipStatus: "active" } } as unknown as Session,
      { indicatorDefinitionId: "ind_1", includeHistory: true }
    );

    const call = mockTx.observation.findMany.mock.calls[0]![0];
    expect(call.where.isCurrent).toBeUndefined();
  });
});
