// ============================================================
// tests/unit/state-observatory/provenance-validator.test.ts
// ------------------------------------------------------------
// Pure function tests for validateObservationProvenance.
// Covers U-01..U-12 per Mission 02-01 spec.
// ============================================================
import { describe, it, expect } from "vitest";
import {
  validateObservationProvenance,
  type ProvenanceContext,
} from "@/lib/state-observatory/provenance-validator";

const baseContext: ProvenanceContext = {
  source: {
    id: "src_1",
    reviewStatus: "approved",
    independenceGroup: null,
    submittedByTenantId: null, // admin-curated
  },
  evidence: null,
  sessionTenantId: "tenant_A",
  tenantCountryId: "country_DML",
};

const baseObservation = {
  originType: "observed" as const,
  verificationStatus: "unverified",
  sourceId: "src_1" as string | null,
  evidenceId: null as string | null,
  derivationMethod: null as string | null,
  isSynthetic: true,
};

describe("provenance-validator — U-01: observed requires sourceId", () => {
  it("errors when originType=observed but sourceId=null", () => {
    const result = validateObservationProvenance(
      { ...baseObservation, sourceId: null },
      { ...baseContext, source: null }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("observed"))).toBe(true);
  });
});

describe("provenance-validator — U-02: candidate source warns (not rejects)", () => {
  it("warns when source.reviewStatus=candidate", () => {
    const result = validateObservationProvenance(baseObservation, {
      ...baseContext,
      source: {
        id: "src_1",
        reviewStatus: "candidate",
        independenceGroup: null,
        submittedByTenantId: null,
      },
    });
    expect(result.valid).toBe(true); // not rejected
    expect(result.warnings.some((w) => w.includes("candidate"))).toBe(true);
  });
});

describe("provenance-validator — U-03: refuted evidence rejected", () => {
  it("errors when evidence.verificationStatus=refuted", () => {
    const result = validateObservationProvenance(
      { ...baseObservation, evidenceId: "ev_1" },
      {
        ...baseContext,
        evidence: {
          id: "ev_1",
          tenantId: "tenant_A",
          sourceId: null,
          verificationStatus: "refuted",
          type: "supporting",
          metadata: {},
        },
      }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("refuted"))).toBe(true);
  });
});

describe("provenance-validator — U-04: disputed evidence warns (not rejects)", () => {
  it("warns when evidence.verificationStatus=disputed", () => {
    const result = validateObservationProvenance(
      { ...baseObservation, evidenceId: "ev_1" },
      {
        ...baseContext,
        evidence: {
          id: "ev_1",
          tenantId: "tenant_A",
          sourceId: null,
          verificationStatus: "disputed",
          type: "supporting",
          metadata: {},
        },
      }
    );
    expect(result.valid).toBe(true); // not rejected
    expect(result.warnings.some((w) => w.includes("disputed"))).toBe(true);
  });
});

describe("provenance-validator — U-05: cross-tenant evidence rejected (A15)", () => {
  it("errors when evidence.tenantId !== session.tenantId", () => {
    const result = validateObservationProvenance(
      { ...baseObservation, evidenceId: "ev_1" },
      {
        ...baseContext,
        evidence: {
          id: "ev_1",
          tenantId: "tenant_B", // different tenant
          sourceId: null,
          verificationStatus: "verified",
          type: "supporting",
          metadata: {},
        },
      }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cross-tenant"))).toBe(true);
  });
});

describe("provenance-validator — U-06: cross-tenant source rejected (A16)", () => {
  it("errors when source.submittedByTenantId !== session.tenantId (non-null)", () => {
    const result = validateObservationProvenance(baseObservation, {
      ...baseContext,
      source: {
        id: "src_1",
        reviewStatus: "approved",
        independenceGroup: null,
        submittedByTenantId: "tenant_B", // different tenant
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cross-tenant source"))).toBe(
      true
    );
  });
});

describe("provenance-validator — U-07: admin-curated source allowed (A16)", () => {
  it("allows source with submittedByTenantId=null", () => {
    const result = validateObservationProvenance(baseObservation, {
      ...baseContext,
      source: {
        id: "src_1",
        reviewStatus: "approved",
        independenceGroup: null,
        submittedByTenantId: null, // admin-curated → globally available
      },
    });
    expect(result.valid).toBe(true);
  });
});

describe("provenance-validator — U-08: verified without source rejected (A8)", () => {
  it("errors when verificationStatus=verified but sourceId=null and originType≠synthetic", () => {
    const result = validateObservationProvenance(
      {
        ...baseObservation,
        originType: "observed",
        sourceId: null,
        verificationStatus: "verified",
      },
      { ...baseContext, source: null }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("verified"))).toBe(true);
  });

  it("allows verificationStatus=verified for synthetic without source", () => {
    const result = validateObservationProvenance(
      {
        ...baseObservation,
        originType: "synthetic",
        sourceId: null,
        verificationStatus: "verified",
      },
      { ...baseContext, source: null }
    );
    // Synthetic observations can be internally verified without external source
    expect(result.valid).toBe(true);
  });
});

describe("provenance-validator — U-12: never auto-promotes verificationStatus", () => {
  it("does not mutate observation.verificationStatus (function is pure)", () => {
    const observation = {
      ...baseObservation,
      verificationStatus: "unverified",
    };
    const result = validateObservationProvenance(observation, baseContext);
    expect(result.valid).toBe(true);
    // The function returns a result object; it does NOT modify the input
    expect(observation.verificationStatus).toBe("unverified");
  });

  it("does not return any 'promoted' field in the result", () => {
    const result = validateObservationProvenance(baseObservation, baseContext);
    expect(result).not.toHaveProperty("promotedStatus");
    expect(result).not.toHaveProperty("newVerificationStatus");
  });
});

describe("provenance-validator — additional edge cases", () => {
  it("errors when evidenceId provided but evidence is null (not found in tenant)", () => {
    const result = validateObservationProvenance(
      { ...baseObservation, evidenceId: "ev_missing" },
      { ...baseContext, evidence: null }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("warns when real measurement (isSynthetic=false) has no evidence link", () => {
    const result = validateObservationProvenance(
      { ...baseObservation, isSynthetic: false, evidenceId: null },
      baseContext
    );
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("without evidence link"))
    ).toBe(true);
  });

  it("warns when observation.sourceId ≠ evidence.sourceId (provenance inconsistency)", () => {
    const result = validateObservationProvenance(
      { ...baseObservation, sourceId: "src_1", evidenceId: "ev_1" },
      {
        ...baseContext,
        source: {
          id: "src_1",
          reviewStatus: "approved",
          independenceGroup: null,
          submittedByTenantId: null,
        },
        evidence: {
          id: "ev_1",
          tenantId: "tenant_A",
          sourceId: "src_DIFFERENT", // mismatch
          verificationStatus: "verified",
          type: "supporting",
          metadata: {},
        },
      }
    );
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some((w) =>
        w.includes("does not match evidence.sourceId")
      )
    ).toBe(true);
  });
});
