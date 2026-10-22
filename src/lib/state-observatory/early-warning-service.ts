// ============================================================
// state-observatory/early-warning-service.ts
// ------------------------------------------------------------
// Service — advisory early warning assessment (NOT calibrated risk).
//
// FIX 1 (02-03 corrective): NO nested transactions.
//   assessEarlyWarning uses its OWN single withAuthenticatedTenant.
//   It does NOT call analyzeTemporalTrend (which opens its own tx).
//   Instead, it calls an internal computation function that accepts
//   an existing tx context.
//
// FIX 2 (02-03 corrective): Uses REAL aggregate independence analysis
//   from 02-02, not a lightweight observation count.
//
// C14: advisory ONLY — NEVER creates Alert records
// C15: "none" means "no signal detected" NOT "safe"
// CORRECTION 4: no universal severity/risk thresholds; descriptive only
// ============================================================
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { analyzeTemporalTrend, type TemporalTrend } from "./temporal-trend-service";
import { analyzeAggregateIndependence, type AggregateIndependenceAnalysis } from "./aggregate-independence-service";

export interface EarlyWarning {
  indicatorId: string;
  observationPeriodId: string;
  warningLevel: "none" | "watch" | "advisory" | "insufficient_data";
  warningReason: string;
  contributingFactors: {
    trendDirection: "improving" | "deteriorating" | "stable" | "unknown";
    dataSufficiency: "sufficient" | "marginal" | "insufficient";
    magnitudeOfChange: "none" | "minimal" | "moderate" | "significant" | "unknown";
    currentVarianceDirection: "better" | "worse" | "neutral" | "unknown";
    observabilityMode: "FULL" | "PARTIAL" | "LOW";
    consistencyIssuesCount: number;
    temporalGapsCount: number;
  };
  isAdvisoryOnly: true;
  noCausalClaims: true;
  isCalibrated: boolean;
  limitationReason: string | null;
  policyUsed: string;
}

export async function assessEarlyWarning(
  session: Session | null,
  params: {
    indicatorId: string;
    observationPeriodId: string;
    strategyVersionId: string;
  }
): Promise<EarlyWarning> {
  await requirePermissionWithCurrentRole(session, "observatory:observation:read");

  // FIX 1: analyzeTemporalTrend opens its own transaction — call it
  // BEFORE entering our own withAuthenticatedTenant to avoid nesting.
  const trend: TemporalTrend = await analyzeTemporalTrend(session, {
    indicatorId: params.indicatorId,
    endingBeforePeriodId: params.observationPeriodId,
  });

  // FIX 2: analyzeAggregateIndependence also opens its own transaction.
  // Call it BEFORE our tx to avoid nesting.
  //
  // FINAL FIX (02-03 corrective closeout): do NOT catch errors from
  // analyzeAggregateIndependence. Database failures, authorization errors,
  // and integrity violations must PROPAGATE — they must NOT be silently
  // converted to observabilityMode="LOW". A legitimate LOW is returned
  // by the service itself as a valid result; an exception means something
  // broke, and the caller must know.
  const aggregateAnalysis: AggregateIndependenceAnalysis = await analyzeAggregateIndependence(
    session,
    {
      indicatorId: params.indicatorId,
      observationPeriodId: params.observationPeriodId,
    }
  );

  // Now enter our own single transaction for the remaining DB queries
  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Fetch variance record for current period
      const varianceRecord = await tx.varianceRecord.findFirst({
        where: {
          tenantId,
          indicatorDefinitionId: params.indicatorId,
          observationPeriodId: params.observationPeriodId,
        },
        select: { varianceDirection: true },
        orderBy: { createdAt: "desc" },
      });

      const currentVarianceDirection: "better" | "worse" | "neutral" | "unknown" =
        (varianceRecord?.varianceDirection as "better" | "worse" | "neutral" | "unknown") ?? "unknown";

      // FIX 2: Use REAL observabilityMode from aggregate independence analysis.
      // FINAL FIX: aggregateAnalysis is never null (errors propagate, not caught).
      // A legitimate LOW comes from the service itself; we never fabricate it.
      const observabilityMode: "FULL" | "PARTIAL" | "LOW" =
        aggregateAnalysis.observabilityMode;

      // Assemble contributing factors
      const contributingFactors = {
        trendDirection: trend.trendDirection,
        dataSufficiency: trend.dataSufficiency,
        magnitudeOfChange: trend.magnitudeOfChange,
        currentVarianceDirection,
        observabilityMode,
        consistencyIssuesCount: trend.consistencyIssues.length,
        temporalGapsCount: trend.temporalGaps.length,
      };

      // CORRECTION 4: classify warningLevel
      let warningLevel: "none" | "watch" | "advisory" | "insufficient_data";
      let warningReason: string;
      let limitationReason: string | null = null;
      const isCalibrated = false;

      if (
        trend.dataSufficiency === "insufficient" ||
        observabilityMode === "LOW"
      ) {
        warningLevel = "insufficient_data";
        warningReason = "insufficient data for advisory assessment";
        limitationReason = `dataSufficiency=${trend.dataSufficiency}, observabilityMode=${observabilityMode}`;
      } else if (trend.temporalGaps.length > 0) {
        warningLevel = "watch";
        warningReason = `${trend.temporalGaps.length} temporal gap(s) detected — data quality concern`;
        limitationReason = "temporal continuity broken";
      } else if (trend.consistencyIssues.length > 0) {
        warningLevel = "watch";
        warningReason = `${trend.consistencyIssues.length} consistency issue(s) detected`;
      } else if (
        trend.trendDirection === "deteriorating" &&
        currentVarianceDirection === "worse"
      ) {
        warningLevel = "advisory";
        warningReason =
          "deteriorating temporal trend combined with current variance in worse direction (descriptive signal, not a prediction)";
      } else if (
        trend.trendDirection === "improving" ||
        (trend.trendDirection === "stable" && currentVarianceDirection !== "worse")
      ) {
        warningLevel = "none";
        warningReason = "no advisory warning signal detected under current descriptive rules";
        limitationReason =
          'warningLevel="none" means no advisory signal detected — it does NOT mean the situation is safe';
      } else {
        warningLevel = "watch";
        warningReason = `mixed signals: trend=${trend.trendDirection}, variance=${currentVarianceDirection}`;
      }

      // Audit
      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "observatory.early_warning.assessed",
        details: {
          indicatorId: params.indicatorId,
          observationPeriodId: params.observationPeriodId,
          warningLevel,
          isCalibrated,
          observabilityMode,
        },
        status: "ok",
      });

      return {
        indicatorId: params.indicatorId,
        observationPeriodId: params.observationPeriodId,
        warningLevel,
        warningReason,
        contributingFactors,
        isAdvisoryOnly: true,
        noCausalClaims: true,
        isCalibrated,
        limitationReason,
        policyUsed: "default_descriptive",
      };
    }
  );
}
