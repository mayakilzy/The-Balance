// ============================================================
// state-observatory/permissioned-view-service.ts
// ------------------------------------------------------------
// Permissioned observatory view — separates government, research
// and public access with fail-closed security.
//
// CORRECTION 1: Classification checking is ALLOWLIST-based (fail-closed).
//   Only evidence explicitly found to be classification="public" is included.
//   Missing/unknown/restricted/classified → excluded.
//
// CORRECTION 2: All classification queries use withAuthenticatedTenant (RLS-safe).
//   No global db client without tenant context.
//
// CORRECTION 3: Conservative clearance — ALL government viewers see only
//   classification="public" evidence. No invented classified clearance.
//   admin/reviewer/analyst all get the same projection in this new service.
//   The existing Observatory Snapshot (02-02) is NOT modified.
//
// CORRECTION 4 (test cleanup): Implemented in test files, not here.
//
// E7: Anonymous path does NOT touch RLS — returns publication_unavailable.
// E13: Publication gap documented as G02-L25.
// ============================================================
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import { loadMembershipForTenant } from "@/lib/auth-bootstrap";
import type { Session } from "next-auth";
import type { ObservatorySnapshot, EvidenceSummary } from "./observatory-query-service";

export type AudienceTier = "government" | "research" | "public";

export interface PermissionedIndicator {
  code: string;
  displayName: string;
  unit: string;
  preferredDirection: string;
  observedFacts: {
    observedValue: number | null;
    observedAt: string | null;
    isSynthetic: boolean;
  };
  calculatedComparisons: {
    varianceDirection: string;
    varianceAbsolute: number | null;
    comparisonValid: boolean;
  };
  uncertainties: {
    unknowns: string[];
    observabilityMode: string;
    limitationReason: string | null;
  };
  interpretations: {
    alerts: Array<{ severity: string; lifecycleStage: string }>;
  };
  linkedEvidence: {
    supporting: Array<{ claim: string; verificationStatus: string }>;
    contradictory: Array<{ claim: string; verificationStatus: string }>;
    disputed: Array<{ claim: string; verificationStatus: string }>;
    refuted: Array<{ claim: string; verificationStatus: string }>;
  };
  attribution: {
    causalAttribution: "descriptive";
  };
}

export interface PermissionedView {
  tier: AudienceTier;
  indicators: PermissionedIndicator[];
  honesty: {
    noCausalClaims: true;
    simulatedData: boolean | null;
    limitations: string[];
    audienceTier: AudienceTier;
    filteredFields: string[];
    publicationGap: boolean;
  };
}

// --- CORRECTION 2: Anonymous path — no RLS, no tenant data ---
function publicationUnavailable(tier: "public" | "research"): PermissionedView {
  return {
    tier,
    indicators: [],
    honesty: {
      noCausalClaims: true as const,
      simulatedData: null,
      limitations: [
        "no publication approval mechanism exists — " +
        (tier === "public" ? "public" : "research") +
        " observatory data is unavailable until a trustworthy publication system is implemented",
      ],
      audienceTier: tier,
      filteredFields: [],
      publicationGap: true,
    },
  };
}

// --- CORRECTION 1: Resolve tier from DB-verified authority ---
async function resolveEffectiveTier(
  session: Session | null
): Promise<{ tier: AudienceTier; canAccessGovernment: boolean }> {
  // CORRECTION 2: anonymous → public, no RLS query
  if (!session || !session.user || session.user.membershipStatus !== "active") {
    return { tier: "public", canAccessGovernment: false };
  }

  const userId = session.user.id;
  const tenantId = session.user.tenantId;
  if (!userId || !tenantId) {
    return { tier: "public", canAccessGovernment: false };
  }

  // CORRECTION 1: verify CURRENT role from DB (not stale JWT)
  try {
    await requirePermissionWithCurrentRole(session, "observatory:observation:read");
  } catch {
    // Revoked/suspended/insufficient → fail-closed to public
    return { tier: "public", canAccessGovernment: false };
  }

  // Read CURRENT role from DB
  const membership = await loadMembershipForTenant(userId, tenantId);
  if (!membership || membership.status !== "active") {
    return { tier: "public", canAccessGovernment: false };
  }

  const currentRoleCode = membership.roleCode;
  if (currentRoleCode === "admin" || currentRoleCode === "analyst" || currentRoleCode === "reviewer") {
    return { tier: "government", canAccessGovernment: true };
  }
  if (currentRoleCode === "observer") {
    // Research tier — but fail-closed (no publication mechanism)
    return { tier: "research", canAccessGovernment: false };
  }
  return { tier: "public", canAccessGovernment: false };
}

// --- Main entry point ---
export async function getPermissionedView(
  session: Session | null,
  params: { strategyVersionId: string; observationPeriodId: string }
): Promise<PermissionedView> {
  // Step 1: resolve effective tier from DB-verified authority
  const { tier, canAccessGovernment } = await resolveEffectiveTier(session);

  // Step 2: anonymous/research → publication_unavailable (no RLS query)
  if (!canAccessGovernment) {
    return publicationUnavailable(tier === "research" ? "research" : "public");
  }

  // Step 3: government tier — fetch snapshot using existing service
  // getObservatorySnapshot uses withAuthenticatedTenant internally (RLS-safe)
  const { getObservatorySnapshot } = await import("./observatory-query-service");
  const snapshot: ObservatorySnapshot = await getObservatorySnapshot(session, {
    strategyVersionId: params.strategyVersionId,
    observationPeriodId: params.observationPeriodId,
  });

  // Step 4: CORRECTION 1+2+3 — project with fail-closed classification filter
  // Use withAuthenticatedTenant for RLS-safe classification queries
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Audit
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "observatory.permissioned_view.generated",
      details: { tier, strategyVersionId: params.strategyVersionId, observationPeriodId: params.observationPeriodId },
      status: "ok",
    });

    // Build allowlisted projection
    const indicators: PermissionedIndicator[] = [];

    for (const ind of snapshot.indicators) {
      // CORRECTION 1+2: Fetch classification for ALL linked evidence IDs
      // using the RLS-scoped transaction (tx)
      const allEvidenceIds = [
        ...ind.linkedEvidence.supporting,
        ...ind.linkedEvidence.contradictory,
        ...ind.linkedEvidence.disputed,
        ...ind.linkedEvidence.refuted,
      ].map((e) => e.id);

      // CORRECTION 1: ALLOWLIST — only include evidence explicitly found as classification="public"
      // Missing/unknown/restricted/classified → excluded (fail-closed)
      let allowedEvidenceIds: Set<string> = new Set();
      if (allEvidenceIds.length > 0) {
        const evidenceRecords = await tx.evidence.findMany({
          where: { id: { in: allEvidenceIds }, tenantId },
          select: { id: true, classification: true },
        });
        // CORRECTION 1: ALLOWLIST — only "public" classification is permitted
        // CORRECTION 3: conservative — ALL government viewers get same projection
        allowedEvidenceIds = new Set(
          evidenceRecords
            .filter((e) => e.classification === "public")
            .map((e) => e.id)
        );
      }

      // Filter evidence by allowlist (fail-closed)
      const filterByAllowlist = (e: EvidenceSummary) => allowedEvidenceIds.has(e.id);
      const toProjection = (e: EvidenceSummary) => ({
        claim: e.claim,
        verificationStatus: e.verificationStatus,
      });

      indicators.push({
        code: ind.indicator.code,
        displayName: ind.indicator.displayName,
        unit: ind.indicator.unit,
        preferredDirection: ind.indicator.preferredDirection,
        observedFacts: {
          observedValue: ind.observedFacts.currentObservation?.observedValue ?? null,
          observedAt: ind.observedFacts.currentObservation?.observedAt ?? null,
          isSynthetic: ind.observedFacts.currentObservation?.isSynthetic ?? true,
        },
        calculatedComparisons: {
          varianceDirection: ind.calculatedComparisons.varianceRecord?.varianceDirection ?? "unknown",
          varianceAbsolute: ind.calculatedComparisons.varianceRecord?.varianceAbsolute ?? null,
          comparisonValid: ind.calculatedComparisons.varianceRecord?.comparisonValid ?? false,
        },
        uncertainties: {
          unknowns: ind.uncertainties.unknowns,
          observabilityMode: ind.uncertainties.observabilityMode,
          limitationReason: ind.uncertainties.limitationReason,
        },
        interpretations: {
          alerts: ind.interpretations.alerts.map((a) => ({
            severity: a.severity,
            lifecycleStage: a.lifecycleStage,
          })),
        },
        linkedEvidence: {
          supporting: ind.linkedEvidence.supporting.filter(filterByAllowlist).map(toProjection),
          contradictory: ind.linkedEvidence.contradictory.filter(filterByAllowlist).map(toProjection),
          disputed: ind.linkedEvidence.disputed.filter(filterByAllowlist).map(toProjection),
          refuted: ind.linkedEvidence.refuted.filter(filterByAllowlist).map(toProjection),
        },
        attribution: {
          causalAttribution: "descriptive" as const,
        },
      });
    }

    return {
      tier: "government" as const,
      indicators,
      honesty: {
        noCausalClaims: true as const,
        simulatedData: snapshot.honesty.simulatedData,
        limitations: [
          ...snapshot.honesty.limitations,
          "government projection includes only classification='public' evidence — classified/restricted evidence excluded pending explicit clearance policy",
        ],
        audienceTier: "government" as const,
        filteredFields: [
          "classified evidence excluded (no explicit clearance policy)",
          "restricted evidence excluded (no explicit clearance policy)",
          "unknown/missing classification evidence excluded (fail-closed)",
        ],
        publicationGap: false,
      },
    };
  });
}
