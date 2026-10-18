import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/lib/permissions", () => ({
  requirePermissionWithCurrentRole: vi.fn().mockResolvedValue(undefined),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    readonly permission: string;
    constructor(p: string) { super(`Permission denied: ${p}`); this.name = "PermissionDeniedError"; this.permission = p; }
  },
}));
vi.mock("@/lib/auth-bootstrap", () => ({
  loadMembershipForTenant: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ writeAuditTx: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/security/tenant-context", () => ({
  withAuthenticatedTenant: vi.fn(async (_s: Session | null, fn: (c: any) => Promise<unknown>) =>
    fn({ tx: { evidence: { findMany: vi.fn().mockResolvedValue([]) } }, userId: "u1", tenantId: "t1", roleCode: "admin" })),
}));

// Mock getObservatorySnapshot
vi.mock("@/lib/state-observatory/observatory-query-service", () => ({
  getObservatorySnapshot: vi.fn(),
}));

import { getPermissionedView } from "@/lib/state-observatory/permissioned-view-service";
import { loadMembershipForTenant } from "@/lib/auth-bootstrap";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { getObservatorySnapshot } from "@/lib/state-observatory/observatory-query-service";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermissionWithCurrentRole).mockResolvedValue(undefined);
  vi.mocked(loadMembershipForTenant).mockResolvedValue({ roleCode: "admin", status: "active" } as any);
  vi.mocked(getObservatorySnapshot).mockResolvedValue({
    indicators: [],
    honesty: { simulatedData: false, limitations: [], noCausalClaims: true as const },
  } as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("P-01: anonymous → public (no RLS)", () => {
  it("returns publication_unavailable for null session", async () => {
    const result = await getPermissionedView(null, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    expect(result.tier).toBe("public");
    expect(result.indicators).toEqual([]);
    expect(result.honesty.publicationGap).toBe(true);
    // Verify no snapshot query was made
    expect(vi.mocked(getObservatorySnapshot)).not.toHaveBeenCalled();
  });
});

describe("P-02: reviewer → government (after DB verification)", () => {
  it("returns government tier for active reviewer", async () => {
    const session = { user: { id: "u1", tenantId: "t1", roleCode: "reviewer", membershipStatus: "active" } } as unknown as Session;
    const result = await getPermissionedView(session, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    expect(result.tier).toBe("government");
    expect(result.honesty.publicationGap).toBe(false);
  });
});

describe("P-03: observer → research (fail-closed)", () => {
  it("returns publication_unavailable for observer", async () => {
    vi.mocked(loadMembershipForTenant).mockResolvedValue({ roleCode: "observer", status: "active" } as any);
    const session = { user: { id: "u1", tenantId: "t1", roleCode: "observer", membershipStatus: "active" } } as unknown as Session;
    const result = await getPermissionedView(session, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    expect(result.tier).toBe("research");
    expect(result.indicators).toEqual([]);
    expect(result.honesty.publicationGap).toBe(true);
    expect(vi.mocked(getObservatorySnapshot)).not.toHaveBeenCalled();
  });
});

describe("P-04: revoked membership → public (fail-closed)", () => {
  it("returns public when membership is revoked", async () => {
    vi.mocked(requirePermissionWithCurrentRole).mockRejectedValue(new Error("Permission denied"));
    const session = { user: { id: "u1", tenantId: "t1", roleCode: "admin", membershipStatus: "active" } } as unknown as Session;
    const result = await getPermissionedView(session, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    expect(result.tier).toBe("public");
    expect(result.honesty.publicationGap).toBe(true);
  });
});

describe("P-05: publication_unavailable response shape", () => {
  it("contains publicationGap=true and limitation message", async () => {
    const result = await getPermissionedView(null, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    expect(result.honesty.publicationGap).toBe(true);
    expect(result.honesty.limitations[0]).toContain("no publication approval mechanism");
  });
});

describe("P-06: government projection preserves descriptive attribution", () => {
  it("attribution.causalAttribution = 'descriptive'", async () => {
    vi.mocked(getObservatorySnapshot).mockResolvedValue({
      indicators: [{
        indicator: { id: "i1", code: "X", displayName: "X", unit: "%", preferredDirection: "decrease" },
        observedFacts: { currentObservation: { observedValue: 9, observedAt: null, isSynthetic: true }, observationHistoryCount: 1, correctionChain: [] },
        calculatedComparisons: { varianceRecord: null },
        uncertainties: { unknowns: [], observabilityMode: "LOW" as const, limitationReason: null, independenceAssessment: { totalSources: 0, independentSourceCount: 0, verifiedEvidenceCount: 0, nationalClaimSupportLevel: "none" as const, geographicCoverageNotEqualsIndependence: true as const } },
        interpretations: { alerts: [] },
        linkedEvidence: { supporting: [], contradictory: [], disputed: [], refuted: [] },
        sourceProvenance: { sourceId: null, sourceCode: null, sourceDisplayName: null, independenceGroup: null, reviewStatus: null, submittedByTenantId: null, provenanceWarnings: [] },
        temporalContext: { trend: null, earlyWarning: null },
      }],
      honesty: { simulatedData: true, limitations: [], noCausalClaims: true as const },
    } as any);
    const session = { user: { id: "u1", tenantId: "t1", roleCode: "admin", membershipStatus: "active" } } as unknown as Session;
    const result = await getPermissionedView(session, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    expect(result.indicators[0]!.attribution.causalAttribution).toBe("descriptive");
  });
});

describe("P-07: fail-closed — missing classification → excluded", () => {
  it("evidence not found in DB is excluded from projection", async () => {
    // Evidence exists in snapshot but NOT in DB (classification unknown) → must be excluded
    vi.mocked(getObservatorySnapshot).mockResolvedValue({
      indicators: [{
        indicator: { id: "i1", code: "X", displayName: "X", unit: "%", preferredDirection: "decrease" },
        observedFacts: { currentObservation: null, observationHistoryCount: 0, correctionChain: [] },
        calculatedComparisons: { varianceRecord: null },
        uncertainties: { unknowns: [], observabilityMode: "LOW" as const, limitationReason: null, independenceAssessment: { totalSources: 0, independentSourceCount: 0, verifiedEvidenceCount: 0, nationalClaimSupportLevel: "none" as const, geographicCoverageNotEqualsIndependence: true as const } },
        interpretations: { alerts: [] },
        linkedEvidence: {
          supporting: [{ id: "ev_missing", claim: "missing evidence", type: "supporting", verificationStatus: "verified", sourceId: null, observedAt: null, relation: "direct" as const }],
          contradictory: [], disputed: [], refuted: [],
        },
        sourceProvenance: { sourceId: null, sourceCode: null, sourceDisplayName: null, independenceGroup: null, reviewStatus: null, submittedByTenantId: null, provenanceWarnings: [] },
        temporalContext: { trend: null, earlyWarning: null },
      }],
      honesty: { simulatedData: false, limitations: [], noCausalClaims: true as const },
    } as any);
    // DB returns empty (evidence not found) → allowlist is empty → all excluded
    const { withAuthenticatedTenant } = await import("@/lib/security/tenant-context");
    vi.mocked(withAuthenticatedTenant).mockImplementation(async (_s: any, fn: any) =>
      fn({ tx: { evidence: { findMany: vi.fn().mockResolvedValue([]) } }, userId: "u1", tenantId: "t1", roleCode: "admin" }) as any
    );
    const session = { user: { id: "u1", tenantId: "t1", roleCode: "admin", membershipStatus: "active" } } as unknown as Session;
    const result = await getPermissionedView(session, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    // CORRECTION 1: fail-closed — evidence not in DB → excluded
    expect(result.indicators[0]!.linkedEvidence.supporting).toHaveLength(0);
  });
});

describe("P-08: government projection documents filtered fields", () => {
  it("filteredFields lists what was excluded", async () => {
    const session = { user: { id: "u1", tenantId: "t1", roleCode: "admin", membershipStatus: "active" } } as unknown as Session;
    const result = await getPermissionedView(session, { strategyVersionId: "sv1", observationPeriodId: "p1" });
    expect(result.honesty.filteredFields).toContain("classified evidence excluded (no explicit clearance policy)");
    expect(result.honesty.filteredFields).toContain("restricted evidence excluded (no explicit clearance policy)");
    expect(result.honesty.filteredFields).toContain("unknown/missing classification evidence excluded (fail-closed)");
  });
});
