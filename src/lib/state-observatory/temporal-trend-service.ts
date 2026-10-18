// ============================================================
// state-observatory/temporal-trend-service.ts
// ------------------------------------------------------------
// Service — analyzes temporal trend across comparable periods.
//
// Per Mission 02-03 spec (decisions C1-C18 + owner corrections 1-5):
//   - C3: chronological ordering via startAt/endAt (not string sort)
//   - C4: never mix incompatible period types
//   - C5/C6: distinguish missing period / missing obs / null measurement
//   - CORRECTION 3: do NOT bridge temporal gaps — return UNKNOWN when
//     continuity is broken. Report point-to-point changes separately.
//   - C9: separate trendDirection / dataSufficiency / magnitudeOfChange
//   - C10/C11: use measurementConstraints (NOT metadata) for trend config
//   - CORRECTION 2: report actual numeric change; classify magnitude as
//     UNKNOWN when no calibrated thresholds exist
//   - C12: dataSufficiency = sample adequacy (NOT trend strength)
//   - C17: attributionLevel = "descriptive" always
//   - C7: only isCurrent=true observations
//   - C8: distinguish observedAt / retrievedAt / correction history
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Session } from "next-auth";

export interface TemporalTrendDataPoint {
  observationPeriodId: string;
  periodType: string;
  periodValue: string;
  startAt: string;
  endAt: string;
  observedValue: number | null;
  observedAt: string | null;
  retrievedAt: string;
  isSynthetic: boolean;
}

export interface PointToPointChange {
  fromPeriodId: string;
  toPeriodId: string;
  fromValue: number;
  toValue: number;
  absoluteChange: number;
  signedChange: number;
}

export interface TemporalGap {
  expectedPeriodValue: string;
  reason: "missing_period" | "missing_observation" | "null_measurement";
}

export interface TemporalTrend {
  indicatorId: string;
  geoLevel: string;
  geoRefId: string | null;
  trendDirection: "improving" | "deteriorating" | "stable" | "unknown";
  dataSufficiency: "sufficient" | "marginal" | "insufficient";
  magnitudeOfChange: "none" | "minimal" | "moderate" | "significant" | "unknown";
  dataPoints: TemporalTrendDataPoint[];
  pointToPointChanges: PointToPointChange[];
  consistencyIssues: string[];
  temporalGaps: TemporalGap[];
  attributionLevel: "descriptive";
  trendPolicyUsed: string;
  stabilityToleranceUsed: number;
  // CORRECTION 2: actual numeric change in indicator's unit
  averageAbsoluteChange: number | null;
  limitationReason: string | null;
}

interface TrendConfig {
  trendPolicy: string; // "default_all_or_nothing" | custom
  stabilityTolerance: number;
  // CORRECTION 2: optional calibrated magnitude thresholds
  magnitudeMinimalThreshold?: number;
  magnitudeModerateThreshold?: number;
  magnitudeSignificantThreshold?: number;
}

function parseTrendConfig(
  measurementConstraints: unknown,
  unit: string
): TrendConfig {
  const defaults: TrendConfig = {
    trendPolicy: "default_all_or_nothing",
    stabilityTolerance: 0,
  };

  if (typeof measurementConstraints !== "object" || measurementConstraints === null) {
    return defaults;
  }

  const mc = measurementConstraints as Record<string, unknown>;
  const config: TrendConfig = { ...defaults };

  if (typeof mc.trendPolicy === "string") {
    config.trendPolicy = mc.trendPolicy;
  }

  if (typeof mc.stabilityTolerance === "number" && mc.stabilityTolerance >= 0) {
    config.stabilityTolerance = mc.stabilityTolerance;
  }

  // CORRECTION 2: parse calibrated magnitude thresholds if present
  if (typeof mc.magnitudeMinimalThreshold === "number") {
    config.magnitudeMinimalThreshold = mc.magnitudeMinimalThreshold;
  }
  if (typeof mc.magnitudeModerateThreshold === "number") {
    config.magnitudeModerateThreshold = mc.magnitudeModerateThreshold;
  }
  if (typeof mc.magnitudeSignificantThreshold === "number") {
    config.magnitudeSignificantThreshold = mc.magnitudeSignificantThreshold;
  }

  return config;
}

export async function analyzeTemporalTrend(
  session: Session | null,
  params: {
    indicatorId: string;
    geoLevel?: string;
    geoRefId?: string | null;
    endingBeforePeriodId: string;
    lookbackPeriods?: number;
  }
): Promise<TemporalTrend> {
  await requirePermissionWithCurrentRole(session, "observatory:observation:read");

  const geoLevel = params.geoLevel ?? "national";
  const geoRefId = params.geoRefId ?? null;
  const lookback = params.lookbackPeriods ?? 4;

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Fetch the ending period to get its endAt boundary (C3)
    const endingPeriod = await tx.observationPeriod.findFirst({
      where: { id: params.endingBeforePeriodId, tenantId },
      select: { id: true, endAt: true, periodType: true, periodValue: true },
    });
    if (!endingPeriod) {
      throw new Error(`ObservationPeriod ${params.endingBeforePeriodId} not found in tenant`);
    }

    // Fetch indicator to get preferredDirection + measurementConstraints (CORRECTION 1)
    const indicator = await tx.indicatorDefinition.findFirst({
      where: { id: params.indicatorId, tenantId },
      select: {
        id: true,
        preferredDirection: true,
        unit: true,
        measurementConstraints: true,
      },
    });
    if (!indicator) {
      throw new Error(`Indicator ${params.indicatorId} not found in tenant`);
    }

    const config = parseTrendConfig(indicator.measurementConstraints, indicator.unit);

    // C3: fetch periods with endAt < endingPeriod.endAt, ordered by startAt DESC
    const periods = await tx.observationPeriod.findMany({
      where: {
        tenantId,
        endAt: { lt: endingPeriod.endAt },
      },
      select: {
        id: true,
        periodType: true,
        periodValue: true,
        startAt: true,
        endAt: true,
      },
      orderBy: { startAt: "desc" },
      take: lookback,
    });

    // C4: check all periods have the same periodType
    const periodTypes = new Set(periods.map((p) => p.periodType));
    if (periodTypes.size > 1) {
      return {
        indicatorId: params.indicatorId,
        geoLevel,
        geoRefId,
        trendDirection: "unknown",
        dataSufficiency: "insufficient",
        magnitudeOfChange: "unknown",
        dataPoints: [],
        pointToPointChanges: [],
        consistencyIssues: [`incompatible period types in lookback range: ${Array.from(periodTypes).join(", ")}`],
        temporalGaps: [],
        attributionLevel: "descriptive",
        trendPolicyUsed: config.trendPolicy,
        stabilityToleranceUsed: config.stabilityTolerance,
        averageAbsoluteChange: null,
        limitationReason: "incompatible period types in lookback range",
      };
    }

    if (periods.length === 0) {
      return {
        indicatorId: params.indicatorId,
        geoLevel,
        geoRefId,
        trendDirection: "unknown",
        dataSufficiency: "insufficient",
        magnitudeOfChange: "unknown",
        dataPoints: [],
        pointToPointChanges: [],
        consistencyIssues: [],
        temporalGaps: [],
        attributionLevel: "descriptive",
        trendPolicyUsed: config.trendPolicy,
        stabilityToleranceUsed: config.stabilityTolerance,
        averageAbsoluteChange: null,
        limitationReason: "no periods found in lookback range",
      };
    }

    // Sort periods chronologically (ascending by startAt) for trend analysis
    const sortedPeriods = [...periods].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

    // Fetch isCurrent=true observations for each period (C7)
    const dataPoints: TemporalTrendDataPoint[] = [];
    const temporalGaps: TemporalGap[] = [];

    for (const period of sortedPeriods) {
      const where: {
        tenantId: string;
        indicatorDefinitionId: string;
        observationPeriodId: string;
        geoLevel: string;
        isCurrent: boolean;
        geoRefId?: string;
      } = {
        tenantId,
        indicatorDefinitionId: params.indicatorId,
        observationPeriodId: period.id,
        geoLevel,
        isCurrent: true,
      };
      if (geoRefId !== null) {
        where.geoRefId = geoRefId;
      } else {
        where.geoRefId = null as unknown as string; // match null explicitly
      }

      const obs = await tx.observation.findFirst({
        where,
        select: {
          id: true,
          observedValue: true,
          observedAt: true,
          retrievedAt: true,
          isSynthetic: true,
        },
      });

      if (!obs) {
        temporalGaps.push({
          expectedPeriodValue: period.periodValue,
          reason: "missing_observation",
        });
        continue;
      }

      if (obs.observedValue === null) {
        temporalGaps.push({
          expectedPeriodValue: period.periodValue,
          reason: "null_measurement",
        });
        continue;
      }

      dataPoints.push({
        observationPeriodId: period.id,
        periodType: period.periodType,
        periodValue: period.periodValue,
        startAt: period.startAt.toISOString(),
        endAt: period.endAt.toISOString(),
        observedValue: Number(obs.observedValue),
        observedAt: obs.observedAt?.toISOString() ?? null,
        retrievedAt: obs.retrievedAt.toISOString(),
        isSynthetic: obs.isSynthetic,
      });
    }

    // C12: classify dataSufficiency (sample adequacy, NOT trend strength)
    let dataSufficiency: "sufficient" | "marginal" | "insufficient";
    if (dataPoints.length < 2) {
      dataSufficiency = "insufficient";
    } else if (dataPoints.length === 2) {
      dataSufficiency = "marginal";
    } else {
      dataSufficiency = "sufficient";
    }

    // If insufficient → unknown
    if (dataSufficiency === "insufficient") {
      return {
        indicatorId: params.indicatorId,
        geoLevel,
        geoRefId,
        trendDirection: "unknown",
        dataSufficiency,
        magnitudeOfChange: "unknown",
        dataPoints,
        pointToPointChanges: [],
        consistencyIssues: temporalGaps.map((g) => `${g.expectedPeriodValue}: ${g.reason}`),
        temporalGaps,
        attributionLevel: "descriptive",
        trendPolicyUsed: config.trendPolicy,
        stabilityToleranceUsed: config.stabilityTolerance,
        averageAbsoluteChange: null,
        limitationReason: `insufficient data points (${dataPoints.length} usable, need ≥2)`,
      };
    }

    // CORRECTION 3: if there are temporal gaps in the consecutive series,
    // return trend UNKNOWN — do NOT bridge gaps
    if (temporalGaps.length > 0) {
      // Compute point-to-point changes for available data (descriptive, separate from trend)
      const changes = computePointToPointChanges(dataPoints);
      const avgChange = changes.length > 0
        ? changes.reduce((sum, c) => sum + c.absoluteChange, 0) / changes.length
        : null;

      return {
        indicatorId: params.indicatorId,
        geoLevel,
        geoRefId,
        trendDirection: "unknown",
        dataSufficiency,
        magnitudeOfChange: "unknown",
        dataPoints,
        pointToPointChanges: changes,
        consistencyIssues: [
          ...temporalGaps.map((g) => `${g.expectedPeriodValue}: ${g.reason}`),
          "temporal continuity broken — trend classification requires consecutive periods without gaps",
        ],
        temporalGaps,
        attributionLevel: "descriptive",
        trendPolicyUsed: config.trendPolicy,
        stabilityToleranceUsed: config.stabilityTolerance,
        averageAbsoluteChange: avgChange,
        limitationReason: `temporal gaps detected (${temporalGaps.length} gap(s)) — trend requires continuous consecutive series`,
      };
    }

    // All periods have usable data points — compute trend
    const changes = computePointToPointChanges(dataPoints);
    const avgChange = changes.length > 0
      ? changes.reduce((sum, c) => sum + c.absoluteChange, 0) / changes.length
      : null;

    // C10: classify trendDirection using default_all_or_nothing policy
    let trendDirection: "improving" | "deteriorating" | "stable" | "unknown";
    const preferredDirection = indicator.preferredDirection as "increase" | "decrease" | "stable";

    if (config.trendPolicy === "default_all_or_nothing") {
      const allWithinTolerance = changes.every(
        (c) => Math.abs(c.signedChange) <= config.stabilityTolerance
      );
      const allImproving = changes.every((c) => {
        if (preferredDirection === "decrease") return c.signedChange < -config.stabilityTolerance;
        if (preferredDirection === "increase") return c.signedChange > config.stabilityTolerance;
        return false;
      });
      const allDeteriorating = changes.every((c) => {
        if (preferredDirection === "decrease") return c.signedChange > config.stabilityTolerance;
        if (preferredDirection === "increase") return c.signedChange < -config.stabilityTolerance;
        return false;
      });

      if (allImproving) {
        trendDirection = "improving";
      } else if (allDeteriorating) {
        trendDirection = "deteriorating";
      } else if (allWithinTolerance) {
        trendDirection = "stable";
      } else {
        trendDirection = "unknown"; // mixed signals
      }
    } else {
      // Unknown policy → conservative
      trendDirection = "unknown";
    }

    // CORRECTION 2: classify magnitudeOfChange
    // Only classify when explicit calibrated thresholds exist in measurementConstraints
    let magnitudeOfChange: "none" | "minimal" | "moderate" | "significant" | "unknown";
    if (avgChange === null || avgChange === 0) {
      magnitudeOfChange = "none";
    } else if (
      config.magnitudeMinimalThreshold !== undefined &&
      config.magnitudeModerateThreshold !== undefined &&
      config.magnitudeSignificantThreshold !== undefined
    ) {
      // Calibrated thresholds available
      if (avgChange <= config.magnitudeMinimalThreshold) {
        magnitudeOfChange = "minimal";
      } else if (avgChange <= config.magnitudeModerateThreshold) {
        magnitudeOfChange = "moderate";
      } else {
        magnitudeOfChange = "significant";
      }
    } else {
      // CORRECTION 2: no calibrated thresholds → UNKNOWN (do NOT use tolerance multiples)
      magnitudeOfChange = "unknown";
    }

    // Consistency issues: sudden reversals (change > 50% between consecutive points)
    const consistencyIssues: string[] = [];
    for (const change of changes) {
      if (change.fromValue !== 0) {
        const pctChange = Math.abs(change.signedChange / change.fromValue);
        if (pctChange > 0.5) {
          consistencyIssues.push(
            `sudden reversal: ${change.fromValue} → ${change.toValue} (${(pctChange * 100).toFixed(1)}% change between ${change.fromPeriodId} and ${change.toPeriodId})`
          );
        }
      }
      // C8: late-recorded observation warning
      // (observedAt differs from retrievedAt by >30 days)
      const fromDP = dataPoints.find((dp) => dp.observationPeriodId === change.fromPeriodId);
      const toDP = dataPoints.find((dp) => dp.observationPeriodId === change.toPeriodId);
      for (const dp of [fromDP, toDP]) {
        if (dp && dp.observedAt && dp.retrievedAt) {
          const daysDiff = Math.abs(
            (new Date(dp.retrievedAt).getTime() - new Date(dp.observedAt).getTime()) / (1000 * 60 * 60 * 24)
          );
          if (daysDiff > 30) {
            consistencyIssues.push(
              `late-recorded observation in ${dp.periodValue}: observedAt and retrievedAt differ by ${daysDiff.toFixed(0)} days`
            );
          }
        }
      }
    }

    let limitationReason: string | null = null;
    if (trendDirection === "unknown") {
      limitationReason = "mixed directional signals — no clear trend under default_all_or_nothing policy";
    }

    // Audit
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "observatory.trend.analyzed",
      details: {
        indicatorId: params.indicatorId,
        endingBeforePeriodId: params.endingBeforePeriodId,
        trendDirection,
        dataSufficiency,
        temporalGapsCount: temporalGaps.length,
      },
      status: "ok",
    });

    return {
      indicatorId: params.indicatorId,
      geoLevel,
      geoRefId,
      trendDirection,
      dataSufficiency,
      magnitudeOfChange,
      dataPoints,
      pointToPointChanges: changes,
      consistencyIssues,
      temporalGaps,
      attributionLevel: "descriptive",
      trendPolicyUsed: config.trendPolicy,
      stabilityToleranceUsed: config.stabilityTolerance,
      averageAbsoluteChange: avgChange,
      limitationReason,
    };
  });
}

function computePointToPointChanges(dataPoints: TemporalTrendDataPoint[]): PointToPointChange[] {
  const changes: PointToPointChange[] = [];
  for (let i = 1; i < dataPoints.length; i++) {
    const from = dataPoints[i - 1]!;
    const to = dataPoints[i]!;
    if (from.observedValue !== null && to.observedValue !== null) {
      changes.push({
        fromPeriodId: from.observationPeriodId,
        toPeriodId: to.observationPeriodId,
        fromValue: from.observedValue,
        toValue: to.observedValue,
        absoluteChange: Math.abs(to.observedValue - from.observedValue),
        signedChange: to.observedValue - from.observedValue,
      });
    }
  }
  return changes;
}
