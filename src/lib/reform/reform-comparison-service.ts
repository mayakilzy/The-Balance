// ============================================================
// src/lib/reform/reform-comparison-service.ts
// ------------------------------------------------------------
// G03-04 — Deterministic Reform Comparison Service (no LLM)
//
// Per G03-00 §7.4 frozen acceptance criterion:
//   "Comparison service returns descriptive matrix
//    (no ranking, no recommendation)"
//
// Per OD-3 (PRE-02 corrected):
//   - Fixed descriptive dimensions
//   - Actual available source content (assumptions[], anticipatedOutcomes[])
//   - Preserve known counts (assumptionCount, anticipatedOutcomeCount)
//   - Provenance per alternative (draftedVia, simulated, provider)
//   - Honesty block distinguishing known/missing/unverified/simulated
//   - NO ranking, NO recommendation, NO confidence score
//
// Read-only — no DB writes, no audit log entry, no LLM call.
// ============================================================
import type { Session } from "next-auth";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { NotFoundError } from "./contracts";
import type { AlternativeComparison } from "./contracts";

const COMPARISON_DIMENSIONS = [
  "cost",
  "risk",
  "feasibility",
  "assumptions",
  "anticipatedOutcomes",
] as const;

/**
 * Returns a descriptive comparison matrix for a proposal's alternatives.
 *
 * Reads all alternatives (including withdrawn — reviewer sees full picture)
 * via the authenticated tenant context. Returns actual content (assumption
 * text, outcome text, cost values) + provenance per alternative + honesty
 * block distinguishing known/missing/unverified/simulated.
 *
 * No ranking, no recommendation, no automatic selection.
 */
export async function compareReformAlternatives(
  session: Session | null,
  proposalId: string
): Promise<AlternativeComparison> {
  await requirePermissionWithCurrentRole(session, "reform:alternative:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Verify proposal exists + belongs to tenant
    const proposal = await tx.reformProposal.findFirst({
      where: { id: proposalId, tenantId },
      select: { id: true },
    });
    if (!proposal) {
      throw new NotFoundError(
        `Proposal ${proposalId} not found in tenant ${tenantId}`
      );
    }

    // Read all alternatives (regardless of status — reviewer sees full picture)
    const alternatives = await tx.reformAlternative.findMany({
      where: { proposalId, tenantId },
      orderBy: { createdAt: "asc" },
    });

    const alternativeViews = alternatives.map((alt) => {
      const assumptions = Array.isArray(alt.assumptions)
        ? (alt.assumptions as string[])
        : [];
      const anticipatedOutcomes = Array.isArray(alt.anticipatedOutcomes)
        ? (alt.anticipatedOutcomes as string[])
        : [];

      return {
        alternativeId: alt.id,
        title: alt.title,
        status: alt.status as "draft" | "selected" | "withdrawn",
        costRange:
          alt.costEstimateMin !== null || alt.costEstimateMax !== null
            ? {
                min:
                  alt.costEstimateMin !== null
                    ? Number(alt.costEstimateMin)
                    : null,
                max:
                  alt.costEstimateMax !== null
                    ? Number(alt.costEstimateMax)
                    : null,
                currency: alt.costCurrency,
              }
            : null, // null = entire cost range missing
        riskLevel: alt.riskLevel as "low" | "medium" | "high",
        feasibilityScore: alt.feasibilityScore as
          | "unknown"
          | "low"
          | "medium"
          | "high",
        assumptions, // ACTUAL text (PRE-02 correction)
        anticipatedOutcomes, // ACTUAL text (PRE-02 correction)
        assumptionCount: assumptions.length, // preserved (frozen interface)
        anticipatedOutcomeCount: anticipatedOutcomes.length, // preserved (frozen interface)
        provenance: {
          draftedVia: alt.draftedVia as "human" | "llm_advisory" | "hybrid",
          simulated: alt.simulated,
          provider:
            (alt.metadata as { provider?: string } | null)?.provider ?? null,
        },
      };
    });

    const hasSimulated = alternativeViews.some(
      (a) => a.provenance.simulated
    );

    const knownLimitations: string[] = [
      "Cost estimates are analyst-provided, not market-verified.",
      "Risk levels are analyst-assigned, not quantitatively measured.",
    ];
    if (hasSimulated) {
      knownLimitations.push(
        "Some alternatives were drafted with LLM assistance (simulated = true indicates StubProvider)."
      );
    } else {
      knownLimitations.push("No LLM-assisted drafts in this proposal.");
    }

    return {
      proposalId,
      alternatives: alternativeViews,
      comparisonMatrix: {
        dimensions: [...COMPARISON_DIMENSIONS],
        notes:
          "Descriptive comparison only. The reviewer selects — the system does not recommend.",
      },
      honestyBlock: {
        simulatedData: hasSimulated,
        knownLimitations,
      },
    };
  });
}
