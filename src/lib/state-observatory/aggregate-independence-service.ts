// ============================================================
// state-observatory/aggregate-independence-service.ts
// ------------------------------------------------------------
// Service — analyzes evidence/source independence at AGGREGATE level
// (across all geo tuples for a given indicator+period).
//
// Per Mission 02-02 spec (decisions B4, B5, B6, B7, B8, B9):
//   - Geographic coverage ≠ source independence (B4 — owner critical directive)
//   - FULL requires either:
//     (a) ≥2 national-level observations from independent sources [FORBIDDEN by F1]
//     (b) 1 national-level observation + ≥2 independent evidence linked via
//         Observation.evidenceId (direct) OR Evidence.relatedEvidenceId (transitive)
//   - If FULL is unreachable, return PARTIAL with limitationReason (B7)
//   - NEVER manufacture FULL from subnational geographic spread (B4)
//
// KEY DESIGN (per owner corrections):
//   The Observation schema has a SINGLE evidenceId field. To establish
//   ≥2 independent evidence without violating F1, we use Evidence.relatedEvidenceId:
//   - The observation's direct evidence (Observation.evidenceId) is evidence #1
//   - Evidence linked to it via relatedEvidenceId (Evidence.relatedBy) is evidence #2, #3, ...
//   - These must be from INDEPENDENT sources (deduplicated by independenceGroup)
//   - These must have verificationStatus="verified" to count toward FULL
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

export interface AggregateIndependenceInput {
  indicatorId: string;
  observationPeriodId: string;
  // Analyzes ALL geo tuples (national + subnational) for this (indicator, period)
  // but reports them as COVERAGE, not as independent confirmation.
}

export interface GeographicCoverage {
  distinctGeoRefIds: number; // count of distinct subnational geoRefIds with isCurrent=true obs
  distinctGeoLevels: string[]; // e.g., ["national", "subnational"]
  totalExpectedGeoRefIds: number | null; // null if no CountryPackConfig defines expected coverage
  coverageRatio: number | null; // distinctGeoRefIds / totalExpectedGeoRefIds
}

export interface SourceDiversity {
  totalSources: number; // distinct sourceId across ALL geo tuples
  independentSourceCount: number; // distinct (independenceGroup || sourceId) groups
  duplicateGroups: Array<{
    independenceGroup: string | null;
    sourceIds: string[];
    observationIds: string[];
  }>;
}

export interface EvidenceStrength {
  verifiedEvidenceCount: number; // distinct evidenceId with verificationStatus=verified
  disputedEvidenceCount: number;
  refutedEvidenceCount: number; // preserved (A13) but counted separately
  contradictoryEvidenceCount: number; // evidence.type="counter"
  // B6 correction: independent VERIFIED evidence linked to the national observation
  // via direct evidenceId OR Evidence.relatedEvidenceId
  independentVerifiedEvidenceLinkedToNationalClaim: number;
}

export interface NationalClaimSupport {
  level: "none" | "partial" | "strong";
  reasoning: string;
  nationalLevelSourceCount: number; // sources from observations with geoLevel="national"
  nationalLevelIndependentSourceCount: number;
  // B6 correction: evidence-based path to FULL
  // (1 national obs + ≥2 independent verified evidence via relatedEvidenceId)
  nationalObsLinkedIndependentVerifiedEvidenceCount: number;
}

export interface AggregateIndependenceAnalysis {
  indicatorId: string;
  observationPeriodId: string;
  coverage: GeographicCoverage;
  sourceDiversity: SourceDiversity;
  evidenceStrength: EvidenceStrength;
  nationalClaimSupport: NationalClaimSupport;
  observabilityMode: "FULL" | "PARTIAL" | "LOW";
  limitationReason: string | null; // non-null when FULL is unreachable (B7)
  totalObservations: number;
  honesty: {
    geographicCoverageNotEqualsIndependence: true; // B4
    simulatedData: boolean;
  };
}

export async function analyzeAggregateIndependence(
  session: Session | null,
  input: AggregateIndependenceInput
): Promise<AggregateIndependenceAnalysis> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:observation:read"
  );

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // 1. Fetch ALL isCurrent=true observations for (indicator, period) across ALL geos
    const observations = await tx.observation.findMany({
      where: {
        tenantId,
        indicatorDefinitionId: input.indicatorId,
        observationPeriodId: input.observationPeriodId,
        isCurrent: true,
      },
      select: {
        id: true,
        sourceId: true,
        evidenceId: true,
        originType: true,
        geoLevel: true,
        geoRefId: true,
        isSynthetic: true,
      },
    });

    // 2. Geographic coverage (B8)
    const geoRefIdSet = new Set<string>();
    const geoLevelSet = new Set<string>();
    for (const obs of observations) {
      geoLevelSet.add(obs.geoLevel);
      if (obs.geoLevel !== "national" && obs.geoRefId) {
        geoRefIdSet.add(obs.geoRefId);
      }
    }
    // totalExpectedGeoRefIds: null (no CountryPackConfig lookup in 02-02 to avoid scope creep)
    const totalExpectedGeoRefIds: number | null = null;
    const coverageRatio: number | null =
      totalExpectedGeoRefIds !== null && totalExpectedGeoRefIds > 0
        ? geoRefIdSet.size / totalExpectedGeoRefIds
        : null;

    // 3. Source diversity (A9, A10, A11)
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

    const groupMap = new Map<
      string,
      { independenceGroup: string | null; sourceIds: Set<string>; observationIds: Set<string> }
    >();
    for (const obs of observations) {
      if (obs.sourceId === null) continue;
      const source = sources.find((s) => s.id === obs.sourceId);
      if (!source) continue;
      const groupKey =
        source.independenceGroup !== null ? source.independenceGroup : source.id;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          independenceGroup: source.independenceGroup,
          sourceIds: new Set(),
          observationIds: new Set(),
        });
      }
      groupMap.get(groupKey)!.sourceIds.add(source.id);
      groupMap.get(groupKey)!.observationIds.add(obs.id);
    }

    const duplicateGroups = Array.from(groupMap.entries()).map(
      ([, entry]) => ({
        independenceGroup: entry.independenceGroup,
        sourceIds: Array.from(entry.sourceIds),
        observationIds: Array.from(entry.observationIds),
      })
    );

    // 4. Evidence strength (B8 + B6 correction)
    // Gather all evidenceIds referenced directly by observations
    const directEvidenceIds = observations
      .map((o) => o.evidenceId)
      .filter((e): e is string => e !== null);
    const uniqueDirectEvidenceIds = [...new Set(directEvidenceIds)];

    let directEvidenceRows: Array<{
      id: string;
      tenantId: string;
      sourceId: string | null;
      verificationStatus: string;
      type: string;
      relatedEvidenceId: string | null;
    }> = [];
    if (uniqueDirectEvidenceIds.length > 0) {
      directEvidenceRows = await tx.evidence.findMany({
        where: { id: { in: uniqueDirectEvidenceIds }, tenantId },
        select: {
          id: true,
          tenantId: true,
          sourceId: true,
          verificationStatus: true,
          type: true,
          relatedEvidenceId: true,
        },
      });
    }

    // B6 correction: gather RELATED evidence (via relatedEvidenceId) — evidence
    // that is linked to the direct evidence via the EvidenceRelations self-relation.
    // These are evidence records whose relatedEvidenceId points to one of the direct evidence.
    const relatedByEvidenceRows: Array<{
      id: string;
      tenantId: string;
      sourceId: string | null;
      verificationStatus: string;
      type: string;
      relatedEvidenceId: string | null;
    }> = [];
    if (uniqueDirectEvidenceIds.length > 0) {
      // Find evidence that points TO the direct evidence (relatedBy direction)
      const related = await tx.evidence.findMany({
        where: {
          tenantId,
          relatedEvidenceId: { in: uniqueDirectEvidenceIds },
        },
        select: {
          id: true,
          tenantId: true,
          sourceId: true,
          verificationStatus: true,
          type: true,
          relatedEvidenceId: true,
        },
      });
      relatedByEvidenceRows.push(...related);
    }

    // Combine all linked evidence (direct + related)
    const allLinkedEvidence = [...directEvidenceRows, ...relatedByEvidenceRows];
    const uniqueAllEvidenceIds = [...new Set(allLinkedEvidence.map((e) => e.id))];

    const verifiedEvidenceCount = allLinkedEvidence.filter(
      (e) => e.verificationStatus === "verified"
    ).length;
    const disputedEvidenceCount = allLinkedEvidence.filter(
      (e) => e.verificationStatus === "disputed"
    ).length;
    const refutedEvidenceCount = allLinkedEvidence.filter(
      (e) => e.verificationStatus === "refuted"
    ).length;
    const contradictoryEvidenceCount = allLinkedEvidence.filter(
      (e) => e.type === "counter"
    ).length;

    // 5. National claim support (B6 + B9 correction)
    // Find the NATIONAL-level observation (F1 allows only 1)
    const nationalObs = observations.find((o) => o.geoLevel === "national");

    let nationalLevelSourceCount = 0;
    let nationalLevelIndependentSourceCount = 0;
    let nationalObsLinkedIndependentVerifiedEvidenceCount = 0;

    if (nationalObs) {
      // National-level sources
      const nationalSourceIds = observations
        .filter((o) => o.geoLevel === "national" && o.sourceId !== null)
        .map((o) => o.sourceId as string);
      const uniqueNationalSourceIds = [...new Set(nationalSourceIds)];
      nationalLevelSourceCount = uniqueNationalSourceIds.length;

      const nationalSources = await tx.source.findMany({
        where: { id: { in: uniqueNationalSourceIds } },
        select: { id: true, independenceGroup: true },
      });
      const nationalGroupKeys = new Set<string>();
      for (const s of nationalSources) {
        nationalGroupKeys.add(s.independenceGroup !== null ? s.independenceGroup : s.id);
      }
      nationalLevelIndependentSourceCount = nationalGroupKeys.size;

      // B6 correction: independent VERIFIED evidence linked to the national observation
      // via direct evidenceId OR Evidence.relatedEvidenceId
      if (nationalObs.evidenceId) {
        const directNatEvidence = directEvidenceRows.find(
          (e) => e.id === nationalObs.evidenceId
        );
        // Collect all evidence linked to the national observation's claim:
        // (a) the direct evidence itself
        // (b) evidence related to it via relatedEvidenceId (relatedBy direction)
        const linkedToNationalClaim: Array<{
          id: string;
          sourceId: string | null;
          verificationStatus: string;
        }> = [];
        if (directNatEvidence) {
          linkedToNationalClaim.push({
            id: directNatEvidence.id,
            sourceId: directNatEvidence.sourceId,
            verificationStatus: directNatEvidence.verificationStatus,
          });
        }
        for (const rel of relatedByEvidenceRows) {
          if (rel.relatedEvidenceId === nationalObs.evidenceId) {
            linkedToNationalClaim.push({
              id: rel.id,
              sourceId: rel.sourceId,
              verificationStatus: rel.verificationStatus,
            });
          }
        }

        // Filter to VERIFIED only, then deduplicate by independence group
        const verifiedLinked = linkedToNationalClaim.filter(
          (e) => e.verificationStatus === "verified" && e.sourceId !== null
        );
        const verifiedLinkedSourceIds = verifiedLinked.map((e) => e.sourceId as string);
        const verifiedLinkedSources = await tx.source.findMany({
          where: { id: { in: verifiedLinkedSourceIds } },
          select: { id: true, independenceGroup: true },
        });
        const verifiedIndependentGroupKeys = new Set<string>();
        for (const s of verifiedLinkedSources) {
          verifiedIndependentGroupKeys.add(
            s.independenceGroup !== null ? s.independenceGroup : s.id
          );
        }
        nationalObsLinkedIndependentVerifiedEvidenceCount =
          verifiedIndependentGroupKeys.size;
      }
    }

    // 6. National claim support level (B9 + B6 correction)
    let nationalClaimSupportLevel: "none" | "partial" | "strong";
    let reasoning: string;

    if (verifiedEvidenceCount === 0) {
      nationalClaimSupportLevel = "none";
      reasoning = "no verified evidence linked to observations";
    } else if (
      nationalObsLinkedIndependentVerifiedEvidenceCount >= 2 ||
      nationalLevelIndependentSourceCount >= 2
    ) {
      nationalClaimSupportLevel = "strong";
      reasoning =
        nationalObsLinkedIndependentVerifiedEvidenceCount >= 2
          ? `${nationalObsLinkedIndependentVerifiedEvidenceCount} independent verified evidence linked to national claim via direct + related evidence`
          : `${nationalLevelIndependentSourceCount} independent national-level sources`;
    } else {
      nationalClaimSupportLevel = "partial";
      reasoning = `only ${nationalLevelIndependentSourceCount} national-level independent source(s) and ${nationalObsLinkedIndependentVerifiedEvidenceCount} independent verified evidence linked to national claim (need ≥2 for strong)`;
    }

    // 7. Observability mode (B6 + B7)
    let observabilityMode: "FULL" | "PARTIAL" | "LOW";
    let limitationReason: string | null = null;

    if (observations.length === 0) {
      observabilityMode = "LOW";
      limitationReason = "no observations in scope";
    } else if (nationalClaimSupportLevel === "strong") {
      observabilityMode = "FULL";
    } else {
      observabilityMode = "PARTIAL";
      // B7: explain why FULL is unreachable
      if (!nationalObs) {
        limitationReason =
          "no national-level observation; FULL requires a national-level observation with ≥2 independent verified evidence linked via direct or related evidence";
      } else if (nationalObsLinkedIndependentVerifiedEvidenceCount < 2) {
        limitationReason = `only ${nationalObsLinkedIndependentVerifiedEvidenceCount} independent verified evidence linked to national claim (need ≥2 for FULL); F1 forbids multiple national observations for the same (indicator, period)`;
      } else if (nationalLevelIndependentSourceCount < 2) {
        limitationReason = `only ${nationalLevelIndependentSourceCount} national-level independent source(s) (need ≥2 for FULL via source path)`;
      } else {
        limitationReason = "FULL criteria not met";
      }
    }

    // 8. Audit
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "observatory.independence.aggregate_analyzed",
      details: {
        indicatorId: input.indicatorId,
        observationPeriodId: input.observationPeriodId,
        observabilityMode,
        nationalClaimSupportLevel,
        limitationReason,
      },
      status: "ok",
    });

    // 9. Detect simulated data
    const anySimulated = observations.some((o) => o.isSynthetic);

    return {
      indicatorId: input.indicatorId,
      observationPeriodId: input.observationPeriodId,
      coverage: {
        distinctGeoRefIds: geoRefIdSet.size,
        distinctGeoLevels: Array.from(geoLevelSet),
        totalExpectedGeoRefIds,
        coverageRatio,
      },
      sourceDiversity: {
        totalSources: uniqueSourceIds.length,
        independentSourceCount: groupMap.size,
        duplicateGroups,
      },
      evidenceStrength: {
        verifiedEvidenceCount,
        disputedEvidenceCount,
        refutedEvidenceCount,
        contradictoryEvidenceCount,
        independentVerifiedEvidenceLinkedToNationalClaim:
          nationalObsLinkedIndependentVerifiedEvidenceCount,
      },
      nationalClaimSupport: {
        level: nationalClaimSupportLevel,
        reasoning,
        nationalLevelSourceCount,
        nationalLevelIndependentSourceCount,
        nationalObsLinkedIndependentVerifiedEvidenceCount,
      },
      observabilityMode,
      limitationReason,
      totalObservations: observations.length,
      honesty: {
        geographicCoverageNotEqualsIndependence: true,
        simulatedData: anySimulated,
      },
    };
  });
}
