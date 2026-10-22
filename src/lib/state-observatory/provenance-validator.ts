// ============================================================
// state-observatory/provenance-validator.ts
// ------------------------------------------------------------
// Pure function — validates observation provenance BEFORE insert.
//
// Per Mission 02-01 spec (decisions A2, A7, A8, A13, A15, A16):
//   - Never mutates verificationStatus (A8: no auto-promotion to verified)
//   - candidate source → WARNING (not rejection, not auto-promotion) (A7)
//   - cross-tenant evidence → ERROR (A15)
//   - cross-tenant submitted source → ERROR (A16)
//   - admin-curated source (submittedByTenantId=null) → allowed (A16)
//   - refuted evidence → ERROR (cannot link) (A13)
//   - disputed evidence → WARNING (preserve, flag for review) (A13)
//   - verified observation without source → ERROR (A8)
// ============================================================

export interface ProvenanceContext {
  source: {
    id: string;
    reviewStatus: string; // "candidate" | "approved"
    independenceGroup: string | null;
    submittedByTenantId: string | null;
  } | null;
  evidence: {
    id: string;
    tenantId: string;
    sourceId: string | null;
    verificationStatus: string; // "unverified"|"verified"|"disputed"|"refuted"
    type: string; // "supporting"|"counter"|"neutral"
    metadata: unknown;
  } | null;
  sessionTenantId: string;
  tenantCountryId: string;
}

export interface ProvenanceValidationResult {
  valid: boolean; // false = reject (errors); true = proceed (may have warnings)
  errors: string[]; // blocking — reject the ingest
  warnings: string[]; // non-blocking — log but proceed
}

/**
 * Validate observation provenance BEFORE insert.
 *
 * IMPORTANT (A8): This function NEVER promotes verificationStatus.
 * It only validates the requested state. If the caller requests
 * `verificationStatus="verified"` without satisfying the requirements,
 * the validation fails with an error.
 */
export function validateObservationProvenance(
  observation: {
    originType: "observed" | "derived" | "synthetic";
    verificationStatus: string; // requested status (caller-supplied)
    sourceId: string | null;
    evidenceId: string | null;
    derivationMethod: string | null;
    isSynthetic: boolean;
  },
  ctx: ProvenanceContext
): ProvenanceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Rule 1: originType=observed requires sourceId
  if (
    observation.originType === "observed" &&
    observation.sourceId === null
  ) {
    errors.push(
      "originType='observed' requires a sourceId (Zod should have caught this)"
    );
  }

  // Rule 2: originType=derived requires derivationMethod
  if (
    observation.originType === "derived" &&
    observation.derivationMethod === null
  ) {
    errors.push(
      "originType='derived' requires a derivationMethod (Zod should have caught this)"
    );
  }

  // Rule 3: candidate source → WARNING (A7)
  if (
    observation.sourceId !== null &&
    ctx.source !== null &&
    ctx.source.reviewStatus === "candidate"
  ) {
    warnings.push(
      `source ${ctx.source.id} is in 'candidate' status (not yet reviewed)`
    );
  }

  // Rule 4: requested verified status requires source (A8)
  // (unless originType is synthetic — synthetic observations can be verified
  //  internally without an external source, per R1 in 02-00)
  if (
    observation.verificationStatus === "verified" &&
    observation.sourceId === null &&
    observation.originType !== "synthetic"
  ) {
    errors.push(
      "cannot request verificationStatus='verified' without a sourceId " +
        "(originType='observed' or 'derived' requires a source for verification)"
    );
  }

  // Rule 5: evidenceId provided but evidence not found
  if (observation.evidenceId !== null && ctx.evidence === null) {
    errors.push(
      `evidence ${observation.evidenceId} not found in tenant ${ctx.sessionTenantId} (RLS-filtered)`
    );
  }

  // Rule 6: cross-tenant evidence reference (A15)
  if (
    observation.evidenceId !== null &&
    ctx.evidence !== null &&
    ctx.evidence.tenantId !== ctx.sessionTenantId
  ) {
    errors.push(
      `cross-tenant evidence reference forbidden: evidence ${ctx.evidence.id} belongs to tenant ${ctx.evidence.tenantId}, session is ${ctx.sessionTenantId}`
    );
  }

  // Rule 7: refuted evidence → ERROR (A13)
  if (
    observation.evidenceId !== null &&
    ctx.evidence !== null &&
    ctx.evidence.verificationStatus === "refuted"
  ) {
    errors.push(
      `cannot link observation to refuted evidence ${ctx.evidence.id} (refuted evidence cannot serve as supporting proof)`
    );
  }

  // Rule 8: disputed evidence → WARNING (A13 — preserve, flag for review)
  if (
    observation.evidenceId !== null &&
    ctx.evidence !== null &&
    ctx.evidence.verificationStatus === "disputed"
  ) {
    warnings.push(
      `evidence ${ctx.evidence.id} is disputed — observation flagged for review`
    );
  }

  // Rule 9: real measurement without evidence link → WARNING
  if (
    !observation.isSynthetic &&
    observation.evidenceId === null &&
    observation.originType === "observed"
  ) {
    warnings.push(
      "real measurement (isSynthetic=false) without evidence link — provenance incomplete"
    );
  }

  // Rule 10: cross-tenant source (A16)
  // Source is a PUBLIC G00 table, but candidate sources have submittedByTenantId.
  // Admin-curated sources have submittedByTenantId=null and are globally available.
  if (
    observation.sourceId !== null &&
    ctx.source !== null &&
    ctx.source.submittedByTenantId !== null &&
    ctx.source.submittedByTenantId !== ctx.sessionTenantId
  ) {
    errors.push(
      `cross-tenant source reference forbidden: source ${ctx.source.id} was submitted by tenant ${ctx.source.submittedByTenantId}, session is ${ctx.sessionTenantId}`
    );
  }

  // Rule 11: source/evidence sourceId consistency (owner clarification #6)
  // B15 (02-02): explanatory warning — distinct sources may legitimately support
  // the same observation (e.g., evidence from a meta-analysis citing a different
  // primary source). Preserve both source identifiers; do NOT treat as error.
  if (
    observation.sourceId !== null &&
    observation.evidenceId !== null &&
    ctx.evidence !== null &&
    ctx.evidence.sourceId !== null &&
    ctx.evidence.sourceId !== observation.sourceId
  ) {
    warnings.push(
      `observation.sourceId (${observation.sourceId}) differs from evidence.sourceId (${ctx.evidence.sourceId}) — ` +
        `this is acceptable when evidence cites a different primary source (e.g., meta-analysis). ` +
        `Both sources are preserved for review.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
