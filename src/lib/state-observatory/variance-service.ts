// ============================================================
// state-observatory/variance-service.ts
// ------------------------------------------------------------
// Per REV-5 FINAL CORRECTED MISSION:
//   - R2: periodMilestone first; without comparable target → unknown
//   - F4: plannedValueSourceKind/SourceId NULLABLE when plannedValueType="none"
//   - E3: observationId nullable when observation is unknown
//   - attributionLevel = "descriptive" always (no causal claims)
//   - Deterministic computation (no LLM)
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import type {
  IndicatorDefinition,
  VarianceRecord,
  VarianceDirection,
  PlannedValueType,
  PreferredDirection,
} from "./contracts";

interface ComputeVarianceInput {
  strategyVersionId: string;
  observationPeriodId: string;
  indicatorId?: string;
}

interface PlannedValueResolution {
  value: number | null;
  type: PlannedValueType;
  sourceKind: string | null; // F4: nullable
  sourceId: string | null; // F4: nullable
  atPeriodId: string | null;
  snapshot: Record<string, unknown>;
  comparisonValid: boolean;
}

/**
 * R2 + F4 algorithm (deterministic, no LLM):
 *   For each indicator linked to strategyVersionId (or just indicatorId):
 *     a. Find current Observation (isCurrent=true) for (indicator, period, national geo)
 *     b. Find planned value:
 *        - search indicator.periodMilestones for matching periodId
 *          → if found: plannedValueType = "period_milestone", comparisonValid = true
 *        - else if indicator.defaultTargetValue != null:
 *                     plannedValueType = "final", comparisonValid = false
 *        - else (no target at all):
 *                     plannedValueType = "none"
 *                     plannedValueSourceKind = null   ← F4
 *                     plannedValueSourceId = null     ← F4
 *                     comparisonValid = false
 *     c. Compute:
 *        - if observedValue is null OR plannedValue is null:
 *            varianceAbsolute = null, varianceDirection = "unknown"
 *        - else if comparisonValid = false:
 *            varianceAbsolute = observedValue - plannedValue (descriptive only)
 *            varianceDirection = "unknown"  // NO better/worse judgment
 *        - else (comparisonValid = true):
 *            varianceAbsolute = observedValue - plannedValue
 *            varianceDirection = computeDirection(varianceAbsolute, preferredDirection)
 *     d. attributionLevel = "descriptive" (always)
 *     e. Create VarianceRecord with pinned observationId + snapshot
 *     f. writeAuditTx
 *   Return array
 */
export async function computeVariance(
  session: Session | null,
  input: ComputeVarianceInput
): Promise<VarianceRecord[]> {
  await requirePermissionWithCurrentRole(session, "observatory:variance:read");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify the strategy version is approved + in this tenant
      const sv = await tx.strategyVersion.findFirst({
        where: {
          id: input.strategyVersionId,
          tenantId,
          status: "approved",
        },
        select: { id: true },
      });
      if (!sv) {
        throw new Error(
          `StrategyVersion ${input.strategyVersionId} not found or not approved`
        );
      }

      // Verify the period belongs to this tenant
      const period = await tx.observationPeriod.findFirst({
        where: { id: input.observationPeriodId, tenantId },
        select: { id: true },
      });
      if (!period) {
        throw new Error(
          `ObservationPeriod ${input.observationPeriodId} not found in tenant ${tenantId}`
        );
      }

      // Find indicators linked to this strategy version (or just the specified one)
      const indicatorWhere: {
        tenantId: string;
        strategyVersionId: string;
        id?: string;
      } = {
        tenantId,
        strategyVersionId: input.strategyVersionId,
      };
      if (input.indicatorId) {
        indicatorWhere.id = input.indicatorId;
      }

      const indicators = await tx.indicatorDefinition.findMany({
        where: indicatorWhere,
      });

      const results: VarianceRecord[] = [];

      for (const indicator of indicators) {
        const result = await computeVarianceForIndicator(
          tx,
          tenantId,
          userId,
          indicator as unknown as IndicatorDefinition,
          input.strategyVersionId,
          input.observationPeriodId
        );
        if (result) {
          results.push(result);
        }
      }

      return results;
    }
  );
}

async function computeVarianceForIndicator(
  tx: import("@prisma/client").Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  indicator: IndicatorDefinition,
  strategyVersionId: string,
  observationPeriodId: string
): Promise<VarianceRecord | null> {
  // a. Find current observation for this indicator + period + national geo
  const observation = await tx.observation.findFirst({
    where: {
      tenantId,
      indicatorDefinitionId: indicator.id,
      observationPeriodId,
      geoLevel: "national",
      isCurrent: true,
    },
  });

  // b. Find planned value (R2 + F4)
  const planned = resolvePlannedValue(indicator, observationPeriodId);

  // c. Compute
  let varianceAbsolute: number | null = null;
  let varianceDirection: VarianceDirection = "unknown";
  let notes: string | null = null;

  const observedValue = (observation?.observedValue as unknown as number | null) ?? null;

  if (observedValue === null || planned.value === null) {
    // Cannot compute — unknown
    varianceAbsolute = null;
    varianceDirection = "unknown";
  } else if (!planned.comparisonValid) {
    // Have both values but comparison is not period-comparable — descriptive only
    varianceAbsolute = observedValue - planned.value;
    varianceDirection = "unknown";
    notes = "Gap to final target described; no period-comparable target";
  } else {
    // Valid comparison — compute direction
    varianceAbsolute = observedValue - planned.value;
    varianceDirection = computeDirection(
      varianceAbsolute,
      indicator.preferredDirection as PreferredDirection
    );
  }

  // d. attributionLevel = "descriptive" always
  // e. Create VarianceRecord
  const observationSnapshot = observation
    ? {
        id: observation.id,
        observedValue: observation.observedValue?.toString() ?? null,
        originType: observation.originType,
        verificationStatus: observation.verificationStatus,
        isSynthetic: observation.isSynthetic,
        geoLevel: observation.geoLevel,
        observedAt: observation.observedAt?.toISOString() ?? null,
      }
    : {};

  const plannedValueSnapshot =
    planned.value !== null
      ? {
          value: planned.value,
          type: planned.type,
          sourceKind: planned.sourceKind,
          sourceId: planned.sourceId,
        }
      : {};

  const varianceRecord = await tx.varianceRecord.create({
    data: {
      tenantId,
      strategyVersionId,
      indicatorDefinitionId: indicator.id,
      observationPeriodId,
      observationId: observation?.id ?? null,
      observationSnapshot: observationSnapshot as Prisma.InputJsonValue,
      plannedValue: planned.value,
      plannedValueType: planned.type,
      plannedValueSourceKind: planned.sourceKind,
      plannedValueSourceId: planned.sourceId,
      plannedValueAtPeriodId: planned.atPeriodId,
      plannedValueSnapshot: plannedValueSnapshot as Prisma.InputJsonValue,
      varianceAbsolute: varianceAbsolute,
      varianceDirection,
      comparisonValid: planned.comparisonValid,
      attributionLevel: "descriptive", // R: always descriptive in 02-00
      notes,
      metadata: {} as Prisma.InputJsonValue,
      createdBy: userId,
    },
  });

  // f. writeAuditTx (atomic — inside the same transaction)
  await writeAuditTx(tx, {
    tenantId,
    actor: userId,
    action: "observatory.variance.computed",
    details: {
      varianceRecordId: varianceRecord.id,
      indicatorId: indicator.id,
      observationPeriodId,
      varianceDirection,
      comparisonValid: planned.comparisonValid,
    },
    status: "ok",
  });

  return varianceRecord;
}

/**
 * R2 + F4: Resolve the planned value for an indicator at a specific period.
 *
 * Resolution order:
 *   1. Search periodMilestones for matching periodId
 *      → plannedValueType = "period_milestone", comparisonValid = true
 *   2. Else if defaultTargetValue != null
 *      → plannedValueType = "final", comparisonValid = false
 *   3. Else (no target at all)
 *      → plannedValueType = "none", sourceKind = null, sourceId = null (F4)
 */
function resolvePlannedValue(
  indicator: IndicatorDefinition,
  observationPeriodId: string
): PlannedValueResolution {
  // Type-safe access to JSON fields
  const periodMilestones = (indicator.periodMilestones ?? []) as Array<{
    periodId: string;
    targetValue: number;
    sourceRef: string;
  }>;

  // 1. Look for a period-specific milestone
  const milestone = periodMilestones.find(
    (m) => m.periodId === observationPeriodId
  );

  if (milestone) {
    return {
      value: milestone.targetValue,
      type: "period_milestone",
      sourceKind: "period_milestone",
      sourceId: observationPeriodId,
      atPeriodId: observationPeriodId,
      snapshot: {
        periodId: milestone.periodId,
        targetValue: milestone.targetValue,
        sourceRef: milestone.sourceRef,
      },
      comparisonValid: true,
    };
  }

  // 2. Fall back to defaultTargetValue (final target)
  const defaultTarget = indicator.defaultTargetValue;
  if (defaultTarget !== null && defaultTarget !== undefined) {
    return {
      value: Number(defaultTarget),
      type: "final",
      sourceKind: "indicator_definition",
      sourceId: indicator.id,
      atPeriodId: null,
      snapshot: {
        defaultTargetValue: Number(defaultTarget),
        targetTimeHorizon: indicator.targetTimeHorizon,
      },
      comparisonValid: false,
    };
  }

  // 3. No target at all — F4: sourceKind/sourceId are null
  return {
    value: null,
    type: "none",
    sourceKind: null, // F4
    sourceId: null, // F4
    atPeriodId: null,
    snapshot: {},
    comparisonValid: false,
  };
}

/**
 * Compute the variance direction based on the absolute variance and
 * the indicator's preferred direction.
 *
 *   - "decrease" + varianceAbsolute > 0 → "worse" (value went up)
 *   - "increase" + varianceAbsolute < 0 → "worse" (value went down)
 *   - "stable" → "neutral" unless varianceAbsolute == 0
 *   - exact match (varianceAbsolute == 0) → "neutral"
 */
function computeDirection(
  varianceAbsolute: number,
  preferredDirection: PreferredDirection
): VarianceDirection {
  if (varianceAbsolute === 0) return "neutral";

  switch (preferredDirection) {
    case "increase":
      return varianceAbsolute > 0 ? "better" : "worse";
    case "decrease":
      return varianceAbsolute < 0 ? "better" : "worse";
    case "stable":
      // Any deviation from stable is "neutral" (not better/worse) —
      // "stable" indicators don't have a directional preference.
      return "neutral";
    default:
      return "unknown";
  }
}

/**
 * List variance records, optionally filtered.
 */
export async function listVariance(
  session: Session | null,
  filter: {
    strategyVersionId?: string;
    indicatorId?: string;
    observationPeriodId?: string;
  }
): Promise<VarianceRecord[]> {
  await requirePermissionWithCurrentRole(session, "observatory:variance:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const where: {
      tenantId: string;
      strategyVersionId?: string;
      indicatorDefinitionId?: string;
      observationPeriodId?: string;
    } = { tenantId };
    if (filter.strategyVersionId) where.strategyVersionId = filter.strategyVersionId;
    if (filter.indicatorId) where.indicatorDefinitionId = filter.indicatorId;
    if (filter.observationPeriodId)
      where.observationPeriodId = filter.observationPeriodId;

    const records = await tx.varianceRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    return records;
  });
}

// Re-export Observation type for tests
export type { Observation } from "./contracts";
