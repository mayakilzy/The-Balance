// ============================================================
// advisor-service.ts — Development Advisor v1
// ------------------------------------------------------------
// Mission 01-09: Conditional Recommendations
//
// advise(session, { countryId, objectiveIds, alternativeIds }) → AdvisoryReport
//
// AdvisoryReport = {
//   recommendation: string,           // conditional, NEVER prescriptive
//   conditions: string[],             // what must be true for the recommendation to hold
//   risks: string[],                  // risks that could make the recommendation unsound
//   counterEvidence: string[],        // evidence that may weaken the conclusion
//   assumptions: string[],            // assumptions underlying the recommendation
//   alternativeViewpoints: string[],  // dissenting perspectives
//   uncertaintySummary: string,       // sources of uncertainty in natural language
//   simulated: true,                  // ALWAYS true in G01 (StubProvider)
//   disclaimer: "This is a conditional recommendation. Human approval required.",
//   modelVersion: "v1-deterministic",
//   inputSummary: { ... },            // what inputs were used (for reproducibility)
// }
//
// ============================================================
// CORE PRINCIPLE — THE ADVISOR ADVISES. THE HUMAN DECIDES.
// ============================================================
// The advisor does NOT:
//   - Approve or reject any strategy
//   - Modify any StrategyVersion or Program
//   - Create binding government decisions
//   - Override RBAC
//   - Present the report as a binding order
//
// The advisor CAN:
//   - Read comparison results (from 01-08)
//   - Read evidence + programs + budgets
//   - Produce a conditional recommendation with conditions, risks,
//     counterEvidence, assumptions, alternativeViewpoints
//   - Abstain from recommending a specific alternative when evidence
//     is insufficient
//
// Every response includes the mandatory disclaimer:
//   "This is a conditional recommendation. Human approval required."
//
// ============================================================
// ABSTENTION
// ============================================================
// If evidence is insufficient to recommend a specific alternative,
// the advisor says:
//   "Insufficient evidence to recommend a specific alternative."
// This is a CORRECT result, not a failure. The advisor explains what
// data is missing and what would need to be completed before a
// recommendation can be made.
//
// ============================================================
// EVIDENCE INTEGRITY (from 01-08-FIX)
// ============================================================
// The advisor respects the distinction between:
//   - Evidence verification (the evidence's own verificationStatus)
//   - Evidence relevance to a claim (not assessed in v1)
//   - Actual claim support (supportAssessment = "not-assessed")
//
// The advisor NEVER interprets "cites verified evidence" as "claim is
// supported". It uses the honest language from 01-08-FIX.
//
// ============================================================
// COMPARISON INPUT RESOLUTION
// ============================================================
// The mission pack contract mentions `comparisonId`, but 01-08's
// `compareScenarios` is READ-ONLY and does NOT persist a comparison
// object with a stable ID. To avoid inventing a stored comparisonId
// that doesn't exist, the advisor takes `alternativeIds` directly
// and calls `compareScenarios` internally. This is the most honest
// approach — no fake IDs, no phantom storage.
//
// The `countryId` + `objectiveIds` are used for tenant/country scope
// validation (the alternatives must belong to a strategy composed for
// the given country + objectives).
//
// ============================================================
// CAPABILITY REGISTRATION
// ============================================================
// The advisor is registered as a Capability in the G00 Capability Registry:
//   code: "state-builder.advisor"
//   type: "expert"
//   readiness: "stub"
//   requiredPermission: "strategy:read"
//   domains: ["state-builder", "advisory"]
//
// The advisor does NOT create a new permission. It reuses "strategy:read"
// (admin, analyst, reviewer — NOT observer).
//
// ============================================================
// LLM PROVIDER MODE
// ============================================================
// The advisor uses the LLMProvider abstraction with StubProvider in G01.
// The recommendation text is deterministic (derived from the comparison
// matrix, not from LLM text generation). Labeled simulated: true.
// No real LLM is connected in this mission.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { registerCapability } from "@/lib/capability-service";
import type { Session } from "next-auth";
import type { ScenarioComparison } from "@/lib/state-builder/comparison-service";

// ============================================================
// TYPES — Advisory Report
// ============================================================

export const ADVISOR_MODEL_VERSION = "v1-deterministic" as const;
export const ADVISOR_DISCLAIMER = "This is a conditional recommendation. Human approval required." as const;
export const ADVISOR_CAPABILITY_CODE = "state-builder.advisor" as const;

export interface AdvisoryReport {
  recommendation: string;
  conditions: string[];
  risks: string[];
  counterEvidence: string[];
  assumptions: string[];
  alternativeViewpoints: string[];
  uncertaintySummary: string;
  simulated: true;
  disclaimer: string;
  modelVersion: string;
  inputSummary: {
    countryId: string;
    objectiveIds: string[];
    alternativeIds: string[];
    comparisonAvailable: boolean;
    abstained: boolean;
  };
}

export interface AdviseInput {
  countryId: string;
  objectiveIds: string[];
  alternativeIds: string[];
}

// ============================================================
// ERRORS
// ============================================================

export class AdvisorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorValidationError";
  }
}

// ============================================================
// REGISTER ADVISOR CAPABILITY (G00 Capability Registry)
// ------------------------------------------------------------
// Called during setup/seed to register the advisor as a Capability.
// Idempotent (upsert by code). Uses balance_admin (DIRECT_URL) because
// capabilities are PUBLIC and balance_app cannot INSERT.
// ============================================================

export async function registerAdvisorCapability(): Promise<{ capabilityId: string }> {
  return registerCapability({
    code: ADVISOR_CAPABILITY_CODE,
    displayName: "Development Advisor v1",
    description:
      "Conditional recommendations for strategy alternatives. " +
      "Reads comparison results + evidence + budgets + timelines. " +
      "Produces an AdvisoryReport with conditions, risks, counterEvidence, " +
      "assumptions, alternativeViewpoints, and uncertaintySummary. " +
      "Does NOT approve, decide, or override human judgment. " +
      "The advisor advises. The human decides.",
    type: "expert",
    readiness: "stub",
    inputSchema: {
      countryId: "string (required)",
      objectiveIds: "string[] (required, ≥1)",
      alternativeIds: "string[] (required, ≥2 for comparison)",
    },
    outputSchema: {
      recommendation: "string",
      conditions: "string[]",
      risks: "string[]",
      counterEvidence: "string[]",
      assumptions: "string[]",
      alternativeViewpoints: "string[]",
      uncertaintySummary: "string",
      simulated: "true",
      disclaimer: "string (mandatory, non-removable)",
    },
    requiredPermission: "strategy:read",
    domains: ["state-builder", "advisory"],
    metadata: {
      modelVersion: ADVISOR_MODEL_VERSION,
      mission: "01-09",
      description: "Development Advisor v1 — Conditional Recommendations",
    },
  });
}

// ============================================================
// ADVISE (public API — READ-ONLY, conditional recommendations)
// ============================================================

export async function advise(
  session: Session,
  input: AdviseInput
): Promise<AdvisoryReport> {
  // The advisor uses strategy:read (NOT a new permission)
  await requirePermissionWithCurrentRole(session, "strategy:read");

  // === INPUT VALIDATION ===
  if (!input.countryId || typeof input.countryId !== "string") {
    throw new AdvisorValidationError("countryId is required");
  }
  if (!input.alternativeIds || !Array.isArray(input.alternativeIds) || input.alternativeIds.length < 2) {
    throw new AdvisorValidationError(
      "alternativeIds must be an array with at least 2 entries " +
      "(the advisor compares alternatives — fewer than 2 is meaningless)."
    );
  }
  if (!input.objectiveIds || !Array.isArray(input.objectiveIds) || input.objectiveIds.length === 0) {
    throw new AdvisorValidationError("objectiveIds must be a non-empty array");
  }

  // === RUN COMPARISON (read-only, reuses 01-08) ===
  const { compareScenarios } = await import("@/lib/state-builder/comparison-service");
  let comparison: ScenarioComparison;
  try {
    comparison = await compareScenarios(session, { alternativeIds: input.alternativeIds });
  } catch (err) {
    // If comparison fails (e.g., cross-tenant, missing alternatives),
    // surface the error — the advisor cannot proceed without a comparison.
    throw new AdvisorValidationError(
      `Comparison failed — the advisor cannot produce a recommendation without a valid comparison. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // === VALIDATE COUNTRY + OBJECTIVE SCOPE ===
  // The alternatives must belong to a strategy composed for the given country.
  // We check this by verifying the strategy version metadata's inputSnapshot.countryId.
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Fetch the strategy versions to verify country scope
    const strategyVersions = await tx.strategyVersion.findMany({
      where: { id: { in: input.alternativeIds }, tenantId },
      select: { id: true, metadata: true, strategyId: true },
    });

    if (strategyVersions.length !== input.alternativeIds.length) {
      throw new AdvisorValidationError(
        `Not all alternatives found in tenant scope. Expected ${input.alternativeIds.length}, ` +
        `found ${strategyVersions.length}. Cross-tenant alternatives are not allowed.`
      );
    }

    // Verify country scope
    for (const sv of strategyVersions) {
      const meta = (sv.metadata ?? {}) as Record<string, unknown>;
      const inputSnapshot = (meta.inputSnapshot ?? {}) as Record<string, unknown>;
      const svCountryId = typeof inputSnapshot.countryId === "string" ? inputSnapshot.countryId : null;
      if (svCountryId !== input.countryId) {
        throw new AdvisorValidationError(
          `Alternative ${sv.id} belongs to country ${svCountryId ?? "unknown"}, ` +
          `but the advisor was called for country ${input.countryId}. ` +
          `Cross-country advisory is not allowed.`
        );
      }
    }

    // === FIX-1: OBJECTIVE SCOPE INTEGRITY ===
    // Verify that every objectiveId in the input:
    //   1. Exists in the tenant scope
    //   2. Belongs to the requested country
    //   3. Is linked to at least one of the alternatives being compared
    //      (via the strategy version's inputSnapshot.objectiveIds)
    const objectiveRecords = await tx.objective.findMany({
      where: { tenantId, id: { in: input.objectiveIds } },
      select: { id: true, countryId: true },
    });
    const objectiveMap = new Map(objectiveRecords.map((o) => [o.id, o]));

    // Check 1: every objectiveId exists in tenant
    const missingObjectives = input.objectiveIds.filter((oid) => !objectiveMap.has(oid));
    if (missingObjectives.length > 0) {
      throw new AdvisorValidationError(
        `${missingObjectives.length} objective(s) not found in tenant scope: ` +
        `${missingObjectives.join(", ")}. ` +
        `All objectiveIds must exist in the same tenant as the alternatives.`
      );
    }

    // Check 2: every objective belongs to the requested country
    const wrongCountryObjectives = input.objectiveIds.filter((oid) => {
      const obj = objectiveMap.get(oid);
      return obj && obj.countryId !== input.countryId;
    });
    if (wrongCountryObjectives.length > 0) {
      throw new AdvisorValidationError(
        `${wrongCountryObjectives.length} objective(s) belong to a different country: ` +
        `${wrongCountryObjectives.join(", ")}. ` +
        `All objectives must belong to country ${input.countryId}.`
      );
    }

    // Check 3: every objective must be linked to at least one alternative
    // (via the strategy version's inputSnapshot.objectiveIds)
    const allLinkedObjectiveIds = new Set<string>();
    for (const sv of strategyVersions) {
      const meta = (sv.metadata ?? {}) as Record<string, unknown>;
      const inputSnapshot = (meta.inputSnapshot ?? {}) as Record<string, unknown>;
      const svObjectiveIds = inputSnapshot.objectiveIds;
      if (Array.isArray(svObjectiveIds)) {
        for (const oid of svObjectiveIds) {
          if (typeof oid === "string") allLinkedObjectiveIds.add(oid);
        }
      }
    }
    const unlinkedObjectives = input.objectiveIds.filter((oid) => !allLinkedObjectiveIds.has(oid));
    if (unlinkedObjectives.length > 0) {
      throw new AdvisorValidationError(
        `${unlinkedObjectives.length} objective(s) are not linked to any of the alternatives ` +
        `being compared: ${unlinkedObjectives.join(", ")}. ` +
        `All objectives must appear in at least one alternative's inputSnapshot.objectiveIds. ` +
        `The advisor cannot produce a recommendation for objectives that were not part of ` +
        `the strategy composition.`
      );
    }

    // === FIX-2: EXTRACT ACTUAL COUNTER-EVIDENCE ===
    // Counter-evidence is stored in the strategy version metadata as an array of
    // { evidenceId, claim, sourceCode }. These are ACTUAL counter-evidence references
    // from the composer (01-03), NOT data-quality warnings about missing/refuted evidence.
    // We extract them here and pass to buildAdvisoryReport.
    const actualCounterEvidence: Array<{
      evidenceId: string;
      claim: string;
      sourceCode: string | null;
      altId: string;
    }> = [];
    for (const sv of strategyVersions) {
      const meta = (sv.metadata ?? {}) as Record<string, unknown>;
      const counterEvidence = (meta.counterEvidence as Array<{
        evidenceId: string;
        claim: string;
        sourceCode: string | null;
      }> | undefined) ?? [];
      for (const ce of counterEvidence) {
        if (ce.evidenceId && ce.claim) {
          actualCounterEvidence.push({
            evidenceId: ce.evidenceId,
            claim: ce.claim,
            sourceCode: ce.sourceCode ?? null,
            altId: sv.id,
          });
        }
      }
    }

    // Also fetch the verificationStatus of each counter-evidence item
    // (to include in the counter-evidence description)
    const counterEvidenceIds = [...new Set(actualCounterEvidence.map((ce) => ce.evidenceId))];
    const counterEvidenceRecords = counterEvidenceIds.length > 0
      ? await tx.evidence.findMany({
          where: { tenantId, id: { in: counterEvidenceIds } },
          select: { id: true, verificationStatus: true, claim: true },
        })
      : [];
    const counterEvidenceStatusMap = new Map<string, { verificationStatus: string; claim: string }>();
    for (const e of counterEvidenceRecords) {
      counterEvidenceStatusMap.set(e.id, { verificationStatus: e.verificationStatus, claim: e.claim });
    }

    // === BUILD THE ADVISORY REPORT ===
    // The advisor analyzes the comparison matrix + produces a conditional
    // recommendation (or abstains if evidence is insufficient).
    const report = buildAdvisoryReport(input, comparison, actualCounterEvidence, counterEvidenceStatusMap);

    return report;
  });
}

// ============================================================
// BUILD ADVISORY REPORT (deterministic, from comparison matrix)
// ------------------------------------------------------------
// This function is the "advisor brain" — it reads the comparison
// matrix and produces a conditional recommendation. In v1, this is
// deterministic (StubProvider mode). The logic is transparent and
// reproducible: same comparison → same report.
// ============================================================

function buildAdvisoryReport(
  input: AdviseInput,
  comparison: ScenarioComparison,
  actualCounterEvidence: Array<{
    evidenceId: string;
    claim: string;
    sourceCode: string | null;
    altId: string;
  }>,
  counterEvidenceStatusMap: Map<string, { verificationStatus: string; claim: string }>
): AdvisoryReport {
  const conditions: string[] = [];
  const risks: string[] = [];
  const counterEvidence: string[] = [];
  const assumptions: string[] = [];
  const alternativeViewpoints: string[] = [];
  const uncertaintySources: string[] = [];

  // === ANALYZE THE COMPARISON MATRIX ===

  // 1. Cost data completeness
  const altsWithoutCost = comparison.matrix.totalCost.filter(
    (c) => c.programsWithoutEstimate > 0
  );
  const altsWithMultipleCurrencies = comparison.matrix.totalCost.filter(
    (c) => c.currency === null && c.programsWithEstimate > 0
  );
  if (altsWithoutCost.length > 0) {
    uncertaintySources.push(
      `${altsWithoutCost.length} alternative(s) have programs without budget estimates — ` +
      `cost totals are partial or unavailable.`
    );
    conditions.push(
      `Complete budget estimates for all programs before adopting any alternative. ` +
      `${altsWithoutCost.length} alternative(s) currently have cost data gaps.`
    );
  }
  if (altsWithMultipleCurrencies.length > 0) {
    uncertaintySources.push(
      `${altsWithMultipleCurrencies.length} alternative(s) have multiple currencies — ` +
      `cross-currency cost aggregation was not performed.`
    );
    conditions.push(
      `Resolve cross-currency cost data (pre-convert to a single currency with a ` +
      `documented, dated conversion rate) before comparing total costs.`
    );
  }

  // 2. Timeline / temporal status
  const altsWithInvalidTimeline = comparison.matrix.timeline.filter(
    (t) => t.temporalStatus === "invalid"
  );
  const altsWithNotVerifiedTimeline = comparison.matrix.timeline.filter(
    (t) => t.temporalStatus === "not-verified"
  );
  if (altsWithInvalidTimeline.length > 0) {
    risks.push(
      `${altsWithInvalidTimeline.length} alternative(s) have INVALID schedules ` +
      `(temporal violations detected). These schedules cannot be presented as feasible timelines.`
    );
    uncertaintySources.push(
      `${altsWithInvalidTimeline.length} alternative(s) have temporal violations — ` +
      `their execution timelines are contradictory and cannot be verified.`
    );
  }
  if (altsWithNotVerifiedTimeline.length > 0) {
    uncertaintySources.push(
      `${altsWithNotVerifiedTimeline.length} alternative(s) have unverified timelines — ` +
      `insufficient scheduling data to confirm temporal consistency.`
    );
  }

  // 3. Evidence strength — FIX-2: data-quality warnings go to risks/uncertainty, NOT counterEvidence
  const altsWithMissingEvidence = comparison.matrix.evidenceStrength.filter(
    (e) => e.citationsOfMissingEvidence > 0 || e.citationsOfRefutedEvidence > 0
  );
  if (altsWithMissingEvidence.length > 0) {
    // FIX-2: This is a DATA-QUALITY WARNING, not counter-evidence.
    // Move to risks + uncertainty (was incorrectly in counterEvidence before).
    uncertaintySources.push(
      `${altsWithMissingEvidence.length} alternative(s) cite missing or refuted evidence — ` +
      `some claims lack evidentiary support.`
    );
    risks.push(
      `${altsWithMissingEvidence.length} alternative(s) have evidence references pointing to ` +
      `missing or refuted evidence. These claims should be treated with caution. ` +
      `(This is a data-quality warning, not counter-evidence.)`
    );
  }
  // Always add the evidence-integrity caveat (from 01-08-FIX)
  assumptions.push(
    `Evidence support assessment is "not-assessed" for all alternatives — ` +
    `citing verified evidence does NOT mean the claim is supported. ` +
    `The claim-to-evidence support relationship has not been verified.`
  );

  // === FIX-2: ACTUAL COUNTER-EVIDENCE ===
  // Counter-evidence is extracted from the strategy version metadata (by the caller).
  // These are actual references to Evidence rows that were identified as counter-evidence
  // by the composer (01-03). We present them with their evidenceId, claim, sourceCode,
  // and verificationStatus.
  //
  // IMPORTANT: a counter-evidence reference is NOT the same as a refuted evidence citation.
  // Counter-evidence is evidence that CONTRADICTS or WEAKENS a strategic claim.
  // Refuted evidence is evidence whose own verification failed.
  // We do NOT assume that refuted evidence is counter-evidence for a different claim.
  if (actualCounterEvidence.length > 0) {
    for (const ce of actualCounterEvidence) {
      const status = counterEvidenceStatusMap.get(ce.evidenceId);
      const verificationStatus = status?.verificationStatus ?? "unknown";
      const evidenceClaim = status?.claim ?? ce.claim;
      counterEvidence.push(
        `Counter-evidence (from alternative ${ce.altId}): evidenceId=${ce.evidenceId}, ` +
        `sourceCode=${ce.sourceCode ?? "unknown"}, verificationStatus="${verificationStatus}". ` +
        `Claim: "${evidenceClaim}". ` +
        `Note: this is an actual counter-evidence reference from the strategy composition (01-03), ` +
        `not a data-quality warning. The counter-evidence's verificationStatus reflects the ` +
        `evidence's own verification, NOT a verification that it contradicts any specific claim.`
      );
    }
  } else {
    // No actual counter-evidence was found in the strategy version metadata.
    // This is NOT a claim that no counter-evidence exists in reality.
    counterEvidence.push(
      `No counter-evidence references were found in the strategy version metadata. ` +
      `This is NOT a claim that no counter-evidence exists in reality — ` +
      `it means the system did not find registered counter-evidence within the scope ` +
      `of the data used. Additional counter-evidence may exist outside the system.`
    );
  }

  // 4. Risk profile
  const altsWithHighRisks = comparison.matrix.riskProfile.filter(
    (r) => r.highRisks > 0
  );
  if (altsWithHighRisks.length > 0) {
    risks.push(
      `${altsWithHighRisks.length} alternative(s) have high/critical registered risks. ` +
      `Review the risk register before adopting.`
    );
  }
  const altsWithConflicts = comparison.matrix.riskProfile.filter(
    (r) => r.conflictCount > 0
  );
  if (altsWithConflicts.length > 0) {
    risks.push(
      `${altsWithConflicts.length} alternative(s) have program conflicts (resource competition, ` +
      `policy clashes) that require human decisions.`
    );
  }

  // 5. Sector coverage
  const sectorCounts = comparison.matrix.sectorCoverage.map((s) => s.sectorCount);
  const maxSectors = Math.max(...sectorCounts);
  const minSectors = Math.min(...sectorCounts);
  if (maxSectors !== minSectors) {
    alternativeViewpoints.push(
      `Sector coverage varies across alternatives (from ${minSectors} to ${maxSectors} sectors). ` +
      `More sectors does not mean better — it may indicate broader scope with thinner coverage per sector. ` +
      `A decision-maker might prefer fewer sectors with deeper coverage over many sectors with shallow coverage.`
    );
  }

  // === FIX-3: DETERMINE ABSTENTION (no arbitrary 50% threshold) ===
  // The advisor abstains from recommending a specific alternative ONLY when:
  //   - ANY alternative has an invalid timeline (temporal violations make the
  //     timeline recommendation indefensible)
  //   - ALL alternatives lack cost data (financial comparison is impossible —
  //     a key dimension of the comparison is entirely missing)
  //
  // The previous >50% evidence-gap threshold was arbitrary and unsupported.
  // Evidence gaps are surfaced as risks + uncertainty, NOT as automatic
  // abstention triggers. A single alternative with evidence gaps does NOT
  // prevent the advisor from analyzing the other alternatives.
  //
  // When some alternatives have data gaps but others don't, the advisor
  // produces a PARTIAL recommendation (conditional, with caveats about
  // the alternatives that lack data).
  const hasInvalidTimeline = altsWithInvalidTimeline.length > 0;
  const allLackCost = comparison.matrix.totalCost.every((c) => c.programsWithEstimate === 0);

  const abstained = hasInvalidTimeline || allLackCost;

  // === BUILD RECOMMENDATION TEXT ===
  let recommendation: string;
  if (abstained) {
    const reasons: string[] = [];
    if (hasInvalidTimeline) {
      reasons.push(
        `${altsWithInvalidTimeline.length} alternative(s) have invalid (contradictory) schedules ` +
        `— temporal recommendations are indefensible`
      );
    }
    if (allLackCost) {
      reasons.push("no alternative has budget estimates — financial comparison is impossible");
    }
    recommendation =
      `Insufficient evidence to recommend a specific alternative. ` +
      `The advisor abstains because: ${reasons.join("; ")}. ` +
      `To enable a recommendation: resolve the identified issues, complete the missing data, ` +
      `and re-run the advisory. This abstention is a CORRECT result, not a failure — ` +
      `it reflects the honest state of the evidence.`;
  } else {
    // Produce a conditional recommendation based on the comparison
    // The recommendation is descriptive — it describes trade-offs, never declares a winner
    const costComplete = comparison.matrix.totalCost.filter((c) => !c.isPartialTotal && c.programsWithEstimate > 0);
    const evidenceRich = comparison.matrix.evidenceStrength.filter((e) => e.citationsOfVerifiedEvidence > 0);
    const riskLow = comparison.matrix.riskProfile.filter((r) => r.highRisks === 0 && r.conflictCount === 0);

    // FIX-3: distinguish between "all alternatives have complete data" vs "some have gaps"
    const someLackCost = altsWithoutCost.length > 0 && !allLackCost;
    const partialNote = someLackCost
      ? ` NOTE: ${altsWithoutCost.length} alternative(s) have partial cost data — ` +
        `the financial comparison is incomplete. The recommendation is conditional on ` +
        `completing the missing cost estimates.`
      : "";

    recommendation =
      `Conditional recommendation: the comparison matrix is available for ${comparison.alternatives.length} alternatives. ` +
      `${costComplete.length} alternative(s) have complete cost data, ` +
      `${evidenceRich.length} cite verified evidence, ` +
      `${riskLow.length} have no high/critical risks or conflicts. ` +
      `The advisor does NOT declare a winner — the decision is the human's responsibility. ` +
      `Review the conditions, risks, counterEvidence, and alternativeViewpoints before deciding. ` +
      `All recommendations are conditional on verifying the assumptions and resolving the identified data gaps.` +
      partialNote;
  }

  // === BUILD UNCERTAINTY SUMMARY ===
  // Natural language, NO percentages (no confidence calibration in v1)
  let uncertaintySummary: string;
  if (uncertaintySources.length === 0) {
    uncertaintySummary =
      `No major sources of uncertainty detected in the comparison data. ` +
      `However, the advisor's recommendation is based on a StubProvider (simulated) — ` +
      `it does not represent advanced AI reasoning. ` +
      `Evidence support has not been assessed (supportAssessment = "not-assessed"). ` +
      `The absence of detected uncertainty is NOT proof of certainty.`;
  } else {
    uncertaintySummary =
      `Sources of uncertainty: ${uncertaintySources.join("; ")}. ` +
      `Additionally, the advisor's recommendation is based on a StubProvider (simulated) — ` +
      `it does not represent advanced AI reasoning. ` +
      `Evidence support has not been assessed (supportAssessment = "not-assessed"). ` +
      `Do not interpret this report as a certainty — it is a conditional advisory ` +
      `based on the current state of the data.`;
  }

  // === ADD STANDARD ASSUMPTIONS ===
  assumptions.push(
    `The advisor uses StubProvider (simulated) — the recommendation text is deterministic, ` +
    `derived from the comparison matrix, not from advanced AI reasoning.`
  );
  assumptions.push(
    `The comparison matrix was produced by 01-08's compareScenarios, which is read-only ` +
    `and does not modify any strategy or program.`
  );
  assumptions.push(
    `No real LLM was used. The recommendation is labeled simulated: true.`
  );

  // === ADD STANDARD ALTERNATIVE VIEWPOINTS ===
  alternativeViewpoints.push(
    `A decision-maker might prioritize cost minimization over sector coverage, or vice versa. ` +
    `The advisor does not weight these dimensions — that is a human judgment.`
  );
  alternativeViewpoints.push(
    `A decision-maker might accept higher risk for faster execution, or prefer lower risk ` +
    `with a longer timeline. The advisor does not prescribe a risk tolerance.`
  );
  if (abstained) {
    alternativeViewpoints.push(
      `The advisor abstained from recommending a specific alternative. A human decision-maker ` +
      `might still choose to proceed with one alternative based on political, social, or ` +
      `strategic considerations beyond the data modeled here. The abstention reflects the ` +
      `evidence state, not a prohibition on human action.`
    );
  }

  // === COUNTER-EVIDENCE ===
  // If no counter-evidence was detected from the comparison, say so honestly.
  if (counterEvidence.length === 0) {
    counterEvidence.push(
      `No counter-evidence was detected from the comparison data. ` +
      `This is NOT a claim that no counter-evidence exists in reality — ` +
      `it means the system did not find registered counter-evidence within the scope ` +
      `of the data used. Additional counter-evidence may exist outside the system.`
    );
  }

  return {
    recommendation,
    conditions: conditions.length > 0 ? conditions : [
      `No specific conditions identified — the comparison data does not surface ` +
      `blocking conditions. However, human review is still required before adoption.`,
    ],
    risks: risks.length > 0 ? risks : [
      `No specific risks identified from the comparison data. ` +
      `This is NOT proof of safety — it means no risks were registered in the system. ` +
      `Additional risks may exist outside the system.`,
    ],
    counterEvidence,
    assumptions,
    alternativeViewpoints,
    uncertaintySummary,
    simulated: true,
    disclaimer: ADVISOR_DISCLAIMER,
    modelVersion: ADVISOR_MODEL_VERSION,
    inputSummary: {
      countryId: input.countryId,
      objectiveIds: input.objectiveIds,
      alternativeIds: input.alternativeIds,
      comparisonAvailable: true,
      abstained,
    },
  };
}

// ============================================================
// GET ADVISOR CAPABILITY INFO (helper for API routes / tests)
// ============================================================

export async function getAdvisorCapabilityInfo(session: Session): Promise<{
  code: string;
  displayName: string;
  readiness: string;
  requiredPermission: string;
} | null> {
  await requirePermissionWithCurrentRole(session, "strategy:read");
  const { discoverCapabilities } = await import("@/lib/capability-service");
  const caps = await discoverCapabilities(session, { type: "expert" });
  return caps.find((c) => c.code === ADVISOR_CAPABILITY_CODE) ?? null;
}
