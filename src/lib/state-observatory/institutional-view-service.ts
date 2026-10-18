// ============================================================
// state-observatory/institutional-view-service.ts
// ------------------------------------------------------------
// Read-only service — institutional observatory view.
//
// CORRECTION 1: National and institutional observations are SEPARATE.
//   No single "measuredOutcome" — two distinct fields.
//   Temporal context identifies its geo scope explicitly.
//   National trend is NOT presented as institutional trend.
//
// CORRECTION 2: Complete linkage validation.
//   Institution → country → tenant.
//   Program → tenant + strategyVersion.
//   Indicator → program + tenant.
//   Observation → exact geo scope.
//
// D3: Program ownership ≠ national outcome achievement.
// D5: Institutional observation = exact geoRefId match.
// D10: executionProgress = "not_tracked" always.
// D11: attributionLevel = "descriptive" always.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Session } from "next-auth";
import { analyzeTemporalTrend } from "./temporal-trend-service";
import { assessEarlyWarning } from "./early-warning-service";

export interface InstitutionalObservationSummary {
  observedValue: number | null;
  observedAt: string | null;
  isSynthetic: boolean;
}

export interface InstitutionalIndicatorView {
  id: string;
  code: string;
  displayName: string;
  unit: string;
  preferredDirection: string;
  // CORRECTION 1: national and institutional are SEPARATE — no single measuredOutcome
  nationalObservation: InstitutionalObservationSummary | null;
  institutionalObservation: InstitutionalObservationSummary | null; // D5: only when geoRefId = institutionId
  // Layer 2: calculated comparisons (national-scoped variance)
  nationalVariance: {
    varianceDirection: string;
    varianceAbsolute: number | null;
    comparisonValid: boolean;
  } | null;
  // Layer 3: uncertainties
  uncertainties: {
    unknowns: string[];
    observabilityMode: "not_computed"; // D7: not fabricated
  };
  // Layer 4: interpretations (period-scoped alerts via varianceRecordId)
  alerts: Array<{
    id: string;
    severity: string;
    lifecycleStage: string;
  }>;
  // D3 + D11: attribution separation (4 independent fields)
  attribution: {
    institutionalResponsibility: "direct" | "none";
    measuredOutcomeScope: "national" | "institutional" | "both" | "unknown";
    executionProgress: "not_tracked"; // D10
    causalAttribution: "descriptive"; // D11
  };
  // CORRECTION 1: temporal context with EXPLICIT geo scope
  temporalContext: {
    nationalTrend: {
      trendDirection: string;
      dataSufficiency: string;
      limitationReason: string | null;
      geoScope: "national"; // explicit label
    } | null;
    institutionalTrend: {
      trendDirection: string;
      dataSufficiency: string;
      limitationReason: string | null;
      geoScope: "institutional"; // explicit label
    } | null;
    // CORRECTION 1: national early-warning labeled NATIONAL, not institutional
    nationalEarlyWarning: {
      warningLevel: string;
      limitationReason: string | null;
      geoScope: "national"; // explicit — do NOT present as institutional
    } | null;
    institutionalEarlyWarning: {
      warningLevel: string;
      limitationReason: string | null;
      geoScope: "institutional";
    } | null; // may be null when institutional data insufficient
  };
}

export interface InstitutionalView {
  institution: {
    id: string;
    code: string;
    displayName: string;
    type: string;
    parentInstitutionId: string | null;
    countryId: string;
  };
  programs: Array<{
    id: string;
    title: string;
    sector: string;
    status: string;
    indicators: InstitutionalIndicatorView[];
  }>;
  // D4: "linked" not "attributed"
  attributionSummary: {
    directResponsibilityCount: number;
    linkedNationalIndicatorsCount: number;
    directInstitutionalObservationsCount: number;
  };
  honesty: {
    noCausalClaims: true;
    attributionBasedOn: "Program.owningInstitutionId + IndicatorDefinition.programId";
    // CORRECTION 3: simulatedData reflects actual inspection
    simulatedData: boolean | null; // null = not inspected
    executionProgressSource: "none — Program.status is not execution verification";
  };
}

export async function getInstitutionalView(
  session: Session | null,
  params: { institutionId: string; strategyVersionId: string; observationPeriodId: string }
): Promise<InstitutionalView> {
  await requirePermissionWithCurrentRole(session, "observatory:observation:read");
  await requirePermissionWithCurrentRole(session, "observatory:variance:read");
  await requirePermissionWithCurrentRole(session, "observatory:alert:read");

  // Build the view inside a single transaction (no nesting)
  const view = await withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // CORRECTION 2: validate Institution belongs to tenant's country
      const institution = await tx.institution.findUnique({
        where: { id: params.institutionId },
        select: { id: true, code: true, displayName: true, type: true, parentId: true, countryId: true },
      });
      if (!institution) {
        throw new Error(`Institution ${params.institutionId} not found`);
      }

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { countryId: true },
      });
      if (!tenant) {
        throw new Error(`Tenant ${tenantId} not found`);
      }
      if (institution.countryId !== tenant.countryId) {
        throw new Error(
          `Institution ${institution.id} belongs to country ${institution.countryId}, tenant belongs to ${tenant.countryId}`
        );
      }

      // CORRECTION 2: validate StrategyVersion belongs to tenant
      const sv = await tx.strategyVersion.findFirst({
        where: { id: params.strategyVersionId, tenantId, status: "approved" },
        select: { id: true },
      });
      if (!sv) {
        throw new Error(`StrategyVersion ${params.strategyVersionId} not approved in tenant ${tenantId}`);
      }

      // CORRECTION 2: validate ObservationPeriod belongs to tenant
      const period = await tx.observationPeriod.findFirst({
        where: { id: params.observationPeriodId, tenantId },
        select: { id: true },
      });
      if (!period) {
        throw new Error(`ObservationPeriod ${params.observationPeriodId} not found in tenant`);
      }

      // Fetch programs owned by this institution (CORRECTION 2: tenant + strategyVersion scoped)
      const programs = await tx.program.findMany({
        where: {
          tenantId,
          owningInstitutionId: params.institutionId,
          strategyVersionId: params.strategyVersionId,
        },
        select: { id: true, title: true, sector: true, status: true },
      });

      let anySimulated = false;
      let simulatedInspected = false;
      const programViews: InstitutionalView["programs"] = [];

      for (const program of programs) {
        // Fetch indicators linked to this program (CORRECTION 2: tenant scoped)
        const indicators = await tx.indicatorDefinition.findMany({
          where: { tenantId, programId: program.id },
          select: {
            id: true, code: true, displayName: true, unit: true,
            preferredDirection: true,
          },
        });

        const indicatorViews: InstitutionalIndicatorView[] = [];

        for (const indicator of indicators) {
          // CORRECTION 1: fetch national observation SEPARATELY
          const nationalObs = await tx.observation.findFirst({
            where: {
              tenantId, indicatorDefinitionId: indicator.id,
              observationPeriodId: params.observationPeriodId,
              geoLevel: "national", isCurrent: true,
            },
            select: { id: true, observedValue: true, observedAt: true, isSynthetic: true },
          });

          // CORRECTION 1 + D5: fetch institutional observation with EXACT geoRefId match
          const institutionalObs = await tx.observation.findFirst({
            where: {
              tenantId, indicatorDefinitionId: indicator.id,
              observationPeriodId: params.observationPeriodId,
              geoLevel: "institutional",
              geoRefId: params.institutionId, // D5: exact match
              isCurrent: true,
            },
            select: { id: true, observedValue: true, observedAt: true, isSynthetic: true },
          });

          if (nationalObs?.isSynthetic || institutionalObs?.isSynthetic) {
            anySimulated = true;
            simulatedInspected = true;
          }

          // Fetch variance (national-scoped)
          const variance = await tx.varianceRecord.findFirst({
            where: {
              tenantId, indicatorDefinitionId: indicator.id,
              observationPeriodId: params.observationPeriodId,
            },
            select: { varianceDirection: true, varianceAbsolute: true, comparisonValid: true },
            orderBy: { createdAt: "desc" },
          });

          // Fetch alerts (period-scoped via varianceRecordId — FIX 2 from 02-02)
          const periodVRs = await tx.varianceRecord.findMany({
            where: {
              tenantId, indicatorDefinitionId: indicator.id,
              observationPeriodId: params.observationPeriodId,
            },
            select: { id: true },
          });
          const vrIds = periodVRs.map((v) => v.id);
          const alerts = vrIds.length > 0
            ? await tx.alert.findMany({
                where: {
                  tenantId, indicatorDefinitionId: indicator.id,
                  strategyVersionId: params.strategyVersionId,
                  varianceRecordId: { in: vrIds },
                },
                select: { id: true, severity: true, lifecycleStage: true },
              })
            : [];

          // Build unknowns
          const unknowns: string[] = [];
          if (!nationalObs) unknowns.push("no national observation");
          if (!institutionalObs) unknowns.push("no institutional observation (geoRefId mismatch or missing)");
          if (nationalObs?.observedValue === null) unknowns.push("national observedValue is null");
          if (institutionalObs?.observedValue === null) unknowns.push("institutional observedValue is null");

          // D3 + D11: attribution
          const measuredOutcomeScope: "national" | "institutional" | "both" | "unknown" =
            nationalObs && institutionalObs ? "both"
            : nationalObs ? "national"
            : institutionalObs ? "institutional"
            : "unknown";

          indicatorViews.push({
            id: indicator.id,
            code: indicator.code,
            displayName: indicator.displayName,
            unit: indicator.unit,
            preferredDirection: indicator.preferredDirection,
            nationalObservation: nationalObs ? {
              observedValue: nationalObs.observedValue !== null ? Number(nationalObs.observedValue) : null,
              observedAt: nationalObs.observedAt?.toISOString() ?? null,
              isSynthetic: nationalObs.isSynthetic,
            } : null,
            institutionalObservation: institutionalObs ? {
              observedValue: institutionalObs.observedValue !== null ? Number(institutionalObs.observedValue) : null,
              observedAt: institutionalObs.observedAt?.toISOString() ?? null,
              isSynthetic: institutionalObs.isSynthetic,
            } : null,
            nationalVariance: variance ? {
              varianceDirection: variance.varianceDirection,
              varianceAbsolute: variance.varianceAbsolute !== null ? Number(variance.varianceAbsolute) : null,
              comparisonValid: variance.comparisonValid,
            } : null,
            uncertainties: {
              unknowns,
              observabilityMode: "not_computed", // D7
            },
            alerts: alerts.map((a) => ({
              id: a.id, severity: a.severity, lifecycleStage: a.lifecycleStage,
            })),
            attribution: {
              institutionalResponsibility: "direct", // we found the program via owningInstitutionId
              measuredOutcomeScope,
              executionProgress: "not_tracked", // D10
              causalAttribution: "descriptive", // D11
            },
            // Temporal context placeholder — enriched outside transaction (CORRECTION 1)
            temporalContext: {
              nationalTrend: null,
              institutionalTrend: null,
              nationalEarlyWarning: null,
              institutionalEarlyWarning: null,
            },
          });
        }

        programViews.push({
          id: program.id,
          title: program.title,
          sector: program.sector,
          status: program.status,
          indicators: indicatorViews,
        });
      }

      // Build attribution summary
      let linkedNationalCount = 0;
      let directInstitutionalCount = 0;
      for (const prog of programViews) {
        for (const ind of prog.indicators) {
          if (ind.nationalObservation) linkedNationalCount++;
          if (ind.institutionalObservation) directInstitutionalCount++;
        }
      }

      // Audit
      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "observatory.institutional_view.generated",
        details: {
          institutionId: params.institutionId,
          strategyVersionId: params.strategyVersionId,
          observationPeriodId: params.observationPeriodId,
          programCount: programViews.length,
        },
        status: "ok",
      });

      return {
        institution: {
          id: institution.id,
          code: institution.code,
          displayName: institution.displayName,
          type: institution.type,
          parentInstitutionId: institution.parentId,
          countryId: institution.countryId,
        },
        programs: programViews,
        attributionSummary: {
          directResponsibilityCount: programViews.length,
          linkedNationalIndicatorsCount: linkedNationalCount, // D4: "linked" not "attributed"
          directInstitutionalObservationsCount: directInstitutionalCount,
        },
        honesty: {
          noCausalClaims: true as const,
          attributionBasedOn: "Program.owningInstitutionId + IndicatorDefinition.programId" as const,
          // CORRECTION 3: reflect actual inspection
          simulatedData: simulatedInspected ? anySimulated : null, // null = not inspected
          executionProgressSource: "none — Program.status is not execution verification" as const,
        },
      };
    }
  );

  // CORRECTION 1: enrich temporal context OUTSIDE the transaction (no nesting)
  // For each indicator, compute:
  //   - national trend (geoLevel="national")
  //   - institutional trend (geoLevel="institutional", geoRefId=institutionId) — CORRECTION 1
  //   - national early warning (labeled NATIONAL)
  //   - institutional early warning (may be not_computed if insufficient institutional data)
  for (const prog of view.programs) {
    for (const ind of prog.indicators) {
      // National trend
      try {
        const natTrend = await analyzeTemporalTrend(session, {
          indicatorId: ind.id,
          endingBeforePeriodId: params.observationPeriodId,
          geoLevel: "national", // CORRECTION 1: explicit geo scope
        });
        ind.temporalContext.nationalTrend = {
          trendDirection: natTrend.trendDirection,
          dataSufficiency: natTrend.dataSufficiency,
          limitationReason: natTrend.limitationReason,
          geoScope: "national",
        };
      } catch (err) {
        throw new Error(
          `National temporal trend failed for indicator ${ind.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Institutional trend — CORRECTION 1: pass explicit geoLevel + geoRefId
      try {
        const instTrend = await analyzeTemporalTrend(session, {
          indicatorId: ind.id,
          endingBeforePeriodId: params.observationPeriodId,
          geoLevel: "institutional",
          geoRefId: params.institutionId, // D5: exact institution
        });
        ind.temporalContext.institutionalTrend = {
          trendDirection: instTrend.trendDirection,
          dataSufficiency: instTrend.dataSufficiency,
          limitationReason: instTrend.limitationReason,
          geoScope: "institutional",
        };
      } catch (err) {
        throw new Error(
          `Institutional temporal trend failed for indicator ${ind.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // National early warning — CORRECTION 1: labeled NATIONAL
      try {
        const natEW = await assessEarlyWarning(session, {
          indicatorId: ind.id,
          observationPeriodId: params.observationPeriodId,
          strategyVersionId: params.strategyVersionId,
        });
        ind.temporalContext.nationalEarlyWarning = {
          warningLevel: natEW.warningLevel,
          limitationReason: natEW.limitationReason,
          geoScope: "national", // CORRECTION 1: explicit — do NOT present as institutional
        };
      } catch (err) {
        throw new Error(
          `National early warning failed for indicator ${ind.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Institutional early warning — CORRECTION 1: may be not_computed
      // The early warning service uses aggregate independence which is national-scoped.
      // For institutional scope, we don't have a separate aggregate independence analysis.
      // Per CORRECTION 1: "If the existing early-warning function only supports national
      // assessment, label it NATIONAL explicitly or return institutional warning not_computed."
      ind.temporalContext.institutionalEarlyWarning = {
        warningLevel: "not_computed",
        limitationReason: "institutional early warning not computed — existing early-warning service supports national scope only",
        geoScope: "institutional",
      };
    }
  }

  return view;
}
