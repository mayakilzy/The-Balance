// ============================================================
// state-observatory/early-warning-service.ts
// ------------------------------------------------------------
// Service — advisory early warning assessment (NOT calibrated risk).
//
// Per Mission 02-03 spec + owner CORRECTION 4:
//   - C14: advisory ONLY — NEVER creates Alert records
//   - C15: "none" means "no signal detected" NOT "safe"
//   - CORRECTION 4: no universal severity/risk thresholds; descriptive only
//   - When calibration absent → return descriptive factors with uncalibrated status
//   - When evidence insufficient → INSUFFICIENT_DATA (not NONE)
//   - No predictions, no causal claims, no confidence percentages
// ============================================================
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { writeAuditTx } from "@/lib/audit";
import type { Session } from "next-auth";
import { analyzeTemporalTrend, type TemporalTrend } from "./temporal-trend-service";

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
  isCalibrated: boolean; // false when no indicator-specific calibration exists
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

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // 1. Get temporal trend (periods before the current one)
    const trend: TemporalTrend = await analyzeTemporalTrend(session, {
      indicatorId: params.indicatorId,
      endingBeforePeriodId: params.observationPeriodId,
    });

    // 2. Get current variance record for this period
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

    // 3. Get aggregate independence (from 02-02) for observabilityMode
    // We call it via a lightweight query to avoid circular imports
    // Just check if any observations exist for this indicator+period
    const obsCount = await tx.observation.count({
      where: {
        tenantId,
        indicatorDefinitionId: params.indicatorId,
        observationPeriodId: params.observationPeriodId,
        isCurrent: true,
        geoLevel: "national",
      },
    });

    // Lightweight observabilityMode estimate (full analysis is in aggregate-independence-service)
    // For early warning, we just need to know if data exists
    const observabilityMode: "FULL" | "PARTIAL" | "LOW" =
      obsCount === 0 ? "LOW" : "PARTIAL"; // conservative — full analysis requires the 02-02 service

    // 4. Assemble contributing factors
    const contributingFactors = {
      trendDirection: trend.trendDirection,
      dataSufficiency: trend.dataSufficiency,
      magnitudeOfChange: trend.magnitudeOfChange,
      currentVarianceDirection,
      observabilityMode,
      consistencyIssuesCount: trend.consistencyIssues.length,
      temporalGapsCount: trend.temporalGaps.length,
    };

    // 5. CORRECTION 4: classify warningLevel
    // No universal calibrated thresholds — descriptive only
    let warningLevel: "none" | "watch" | "advisory" | "insufficient_data";
    let warningReason: string;
    let limitationReason: string | null = null;
    const isCalibrated = false; // CORRECTION 4: always uncalibrated in 02-03 (no calibrated risk policy)

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
      // Descriptive advisory: deteriorating trend + current variance worse
      // NOT a prediction — just a descriptive signal
      warningLevel = "advisory";
      warningReason =
        "deteriorating temporal trend combined with current variance in worse direction (descriptive signal, not a prediction)";
    } else if (
      trend.trendDirection === "improving" ||
      (trend.trendDirection === "stable" && currentVarianceDirection !== "worse")
    ) {
      warningLevel = "none";
      warningReason = "no advisory warning signal detected under current descriptive rules";
      // C15: "none" means "no signal" NOT "safe"
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
  });
}
