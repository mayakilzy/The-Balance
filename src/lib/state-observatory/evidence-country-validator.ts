// ============================================================
// state-observatory/evidence-country-validator.ts
// ------------------------------------------------------------
// Pure function — validates evidence country scope.
//
// Per Mission 02-01 spec (decisions A4, A5, A6):
//   - Use Evidence.metadata.countryId (string) — DO NOT modify G00 schema (A4)
//   - Missing countryId → WARNING ("unknown"), NOT rejection (A5)
//   - Explicit mismatch → ERROR (rejection) (A6)
// ============================================================

export interface CountryScopeResult {
  valid: boolean;
  reason: string | null;
  evidenceCountryId: string | null;
  tenantCountryId: string;
  level: "valid" | "unknown" | "mismatch";
}

/**
 * Verify that evidence's declared country matches the tenant's country.
 *
 * Uses Evidence.metadata.countryId (A4 — no schema change).
 *
 * Returns:
 *   - level="valid" + valid=true: countryId matches tenantCountryId
 *   - level="unknown" + valid=true: countryId missing/non-string (warning, not rejection) (A5)
 *   - level="mismatch" + valid=false: countryId explicitly different (rejection) (A6)
 */
export function verifyEvidenceCountryScope(params: {
  evidenceMetadata: unknown;
  tenantCountryId: string;
}): CountryScopeResult {
  const { evidenceMetadata, tenantCountryId } = params;

  // Parse metadata.countryId safely
  const countryId = extractCountryId(evidenceMetadata);

  if (countryId === null) {
    return {
      valid: true, // A5: warning, not rejection
      reason:
        "evidence has no explicit metadata.countryId — country scope unknown",
      evidenceCountryId: null,
      tenantCountryId,
      level: "unknown",
    };
  }

  if (countryId === tenantCountryId) {
    return {
      valid: true,
      reason: null,
      evidenceCountryId: countryId,
      tenantCountryId,
      level: "valid",
    };
  }

  return {
    valid: false, // A6: explicit mismatch → rejection
    reason: `evidence metadata.countryId (${countryId}) does not match tenant countryId (${tenantCountryId})`,
    evidenceCountryId: countryId,
    tenantCountryId,
    level: "mismatch",
  };
}

/**
 * Safely extract countryId from evidence metadata.
 * Returns null if:
 *   - metadata is not an object
 *   - countryId field is missing
 *   - countryId is not a string
 *   - countryId is empty string
 */
function extractCountryId(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }

  const obj = metadata as Record<string, unknown>;
  const countryId = obj.countryId;

  if (typeof countryId !== "string" || countryId.length === 0) {
    return null;
  }

  return countryId;
}
