// ============================================================
// state-observatory/evidence-independence-service.ts
// ------------------------------------------------------------
// Service — analyzes evidence/source independence for an indicator+period+geo.
//
// Per Mission 02-01 spec (decisions A9, A10, A11, A12, A14):
//   - Count distinct SOURCES, not distinct observations (A9)
//   - Sources sharing a non-null independenceGroup count as ONE group (A10)
//   - Multiple observations from same source count as ONE source (A11)
//   - Only isCurrent=true observations counted (A12 — corrections don't inflate)
//   - Distinguish: source independence, evidence verification, observation verification (A14)
//
// Blueprint §5.4 Observability Modes:
//   - FULL:    ≥2 independent sources AND ≥1 verified/corroborated evidence
//   - PARTIAL: some evidence/sources but doesn't meet FULL criteria
//   - LOW:     0 observations or 0 independent sources
//
// IMPORTANT per owner clarification #8:
//   FULL classification requires verified evidence LINKED TO the observations
//   being analyzed (not unrelated verified evidence elsewhere in the tenant).
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

export interface IndependenceAnalysis {
  indicatorId: string;
  observationPeriodId: string;
  geoLevel: string;
  geoRefId: string | null;
  totalObservations: number; // count of isCurrent=true observations in scope
  totalSources: number; // count of distinct sourceId (excluding null)
  independentSourceCount: number; // count of distinct (independenceGroup || sourceId) groups
  duplicateGroups: Array<{
    independenceGroup: string | null;
    sourceIds: string[];
    observationIds: string[];
  }>;
  verifiedEvidenceCount: number; // count of distinct evidenceId (linked to in-scope observations) with verificationStatus=verified
  observabilityMode: "FULL" | "PARTIAL" | "LOW";
}

export interface AnalyzeIndependenceInput {
  indicatorId: string;
  observationPeriodId: string;
  geoLevel?: string; // default "national"
  geoRefId?: string | null;
}

/**
 * Analyze evidence/source independence for a given (indicator, period, geo) tuple.
 *
 * The analysis is SCOPED: only observations matching all four dimensions
 * (indicator, period, geoLevel, geoRefId) are counted. This prevents
 * mixing observations from different geographic partitions (owner clarification #3).
 *
 * Returns counts + observability mode per Blueprint §5.4.
 */
export async function analyzeIndependence(
  session: Session | null,
  input: AnalyzeIndependenceInput
): Promise<IndependenceAnalysis> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:observation:read"
  );

  const geoLevel = input.geoLevel ?? "national";
  const geoRefId = input.geoRefId ?? null;

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Fetch all isCurrent=true observations in scope (A12)
    const where: Prisma.ObservationWhereInput = {
      tenantId,
      indicatorDefinitionId: input.indicatorId,
      observationPeriodId: input.observationPeriodId,
      geoLevel,
      isCurrent: true,
    };
    if (geoRefId !== null) {
      where.geoRefId = geoRefId;
    } else {
      // Match NULL geoRefId explicitly
      where.geoRefId = null;
    }

    const observations = await tx.observation.findMany({
      where,
      select: {
        id: true,
        sourceId: true,
        evidenceId: true,
        originType: true,
      },
    });

    // Fetch sources (PUBLIC G00 table — no RLS)
    const sourceIds = observations
      .map((o) => o.sourceId)
      .filter((s): s is string => s !== null);
    const uniqueSourceIds = [...new Set(sourceIds)];

    let sources: Array<{
      id: string;
      independenceGroup: string | null;
    }> = [];
    if (uniqueSourceIds.length > 0) {
      sources = await tx.source.findMany({
        where: { id: { in: uniqueSourceIds } },
        select: { id: true, independenceGroup: true },
      });
    }

    // Fetch evidence (RLS-enforced — only tenant's evidence visible)
    const evidenceIds = observations
      .map((o) => o.evidenceId)
      .filter((e): e is string => e !== null);
    const uniqueEvidenceIds = [...new Set(evidenceIds)];

    let evidenceRows: Array<{
      id: string;
      verificationStatus: string;
    }> = [];
    if (uniqueEvidenceIds.length > 0) {
      evidenceRows = await tx.evidence.findMany({
        where: { id: { in: uniqueEvidenceIds } },
        select: { id: true, verificationStatus: true },
      });
    }

    // Build independence group map (A10)
    // Group key = independenceGroup if non-null, else source.id itself
    const groupMap = new Map<
      string, // group key
      { independenceGroup: string | null; sourceIds: Set<string>; observationIds: Set<string> }
    >();

    for (const obs of observations) {
      if (obs.sourceId === null) continue; // observations without a source don't count

      const source = sources.find((s) => s.id === obs.sourceId);
      if (!source) continue; // dangling sourceId — skip (shouldn't happen due to FK)

      const groupKey =
        source.independenceGroup !== null ? source.independenceGroup : source.id;

      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          independenceGroup: source.independenceGroup,
          sourceIds: new Set(),
          observationIds: new Set(),
        });
      }
      const entry = groupMap.get(groupKey)!;
      entry.sourceIds.add(source.id);
      entry.observationIds.add(obs.id);
    }

    const duplicateGroups = Array.from(groupMap.entries()).map(
      ([groupKey, entry]) => ({
        independenceGroup: entry.independenceGroup,
        sourceIds: Array.from(entry.sourceIds),
        observationIds: Array.from(entry.observationIds),
      })
    );

    // A9 + A11: totalSources = distinct sourceIds (already computed)
    // A10: independentSourceCount = count of group keys
    const totalSources = uniqueSourceIds.length;
    const independentSourceCount = groupMap.size;

    // A14 + owner clarification #8: verifiedEvidenceCount = count of distinct
    // evidence LINKED TO in-scope observations (not unrelated tenant-wide evidence)
    const verifiedEvidenceCount = evidenceRows.filter(
      (e) => e.verificationStatus === "verified"
    ).length;

    // Classify observability mode per Blueprint §5.4
    let observabilityMode: "FULL" | "PARTIAL" | "LOW";
    if (observations.length === 0 || independentSourceCount === 0) {
      observabilityMode = "LOW";
    } else if (independentSourceCount >= 2 && verifiedEvidenceCount >= 1) {
      observabilityMode = "FULL";
    } else {
      observabilityMode = "PARTIAL";
    }

    // Audit log (atomic — inside the tx)
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "observatory.independence.analyzed",
      details: {
        indicatorId: input.indicatorId,
        observationPeriodId: input.observationPeriodId,
        geoLevel,
        geoRefId,
        totalObservations: observations.length,
        independentSourceCount,
        observabilityMode,
      },
      status: "ok",
    });

    return {
      indicatorId: input.indicatorId,
      observationPeriodId: input.observationPeriodId,
      geoLevel,
      geoRefId,
      totalObservations: observations.length,
      totalSources,
      independentSourceCount,
      duplicateGroups,
      verifiedEvidenceCount,
      observabilityMode,
    };
  });
}
