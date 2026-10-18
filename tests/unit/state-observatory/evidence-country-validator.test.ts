// ============================================================
// tests/unit/state-observatory/evidence-country-validator.test.ts
// ------------------------------------------------------------
// Pure function tests for verifyEvidenceCountryScope.
// Covers U-09, U-10, U-11 per Mission 02-01 spec.
// ============================================================
import { describe, it, expect } from "vitest";
import { verifyEvidenceCountryScope } from "@/lib/state-observatory/evidence-country-validator";

describe("evidence-country-validator — U-09: valid when countryId matches", () => {
  it("returns valid=true, level=valid when metadata.countryId === tenantCountryId", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: { countryId: "country_DML" },
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("valid");
    expect(result.reason).toBeNull();
    expect(result.evidenceCountryId).toBe("country_DML");
    expect(result.tenantCountryId).toBe("country_DML");
  });
});

describe("evidence-country-validator — U-10: mismatch rejected", () => {
  it("returns valid=false, level=mismatch when countryId differs", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: { countryId: "country_JOR" },
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(false);
    expect(result.level).toBe("mismatch");
    expect(result.reason).toContain("JOR");
    expect(result.reason).toContain("DML");
    expect(result.evidenceCountryId).toBe("country_JOR");
  });
});

describe("evidence-country-validator — U-11: missing countryId → unknown (warning)", () => {
  it("returns valid=true, level=unknown when metadata has no countryId", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: { someOtherField: "value" },
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(true); // warning, not rejection
    expect(result.level).toBe("unknown");
    expect(result.reason).toContain("unknown");
    expect(result.evidenceCountryId).toBeNull();
  });

  it("returns valid=true, level=unknown when metadata is empty object", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: {},
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("unknown");
  });

  it("returns valid=true, level=unknown when metadata is null", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: null,
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("unknown");
  });

  it("returns valid=true, level=unknown when metadata is not an object", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: "not-an-object",
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("unknown");
  });

  it("returns valid=true, level=unknown when countryId is not a string", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: { countryId: 123 },
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("unknown");
  });

  it("returns valid=true, level=unknown when countryId is empty string", () => {
    const result = verifyEvidenceCountryScope({
      evidenceMetadata: { countryId: "" },
      tenantCountryId: "country_DML",
    });
    expect(result.valid).toBe(true);
    expect(result.level).toBe("unknown");
  });
});
