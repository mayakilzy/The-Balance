// ============================================================
// state-observatory/indicator-registry-service.ts
// ------------------------------------------------------------
// Per REV-5 FINAL CORRECTED MISSION:
//   - Q1: 5 tables (this service manages IndicatorDefinition)
//   - E1: 4 implemented services (no NotImplementedError)
//   - E6: Demolandia sourceRef must start with "synthetic:demolandia-"
//   - R3 + E5: alertThresholds structured JSON, max 2 rules
//   - writeAuditTx atomic for all operations
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import {
  DefineIndicatorInputSchema,
  type DefineIndicatorInput,
  type IndicatorDefinition,
  NotFoundError,
} from "./contracts";

/**
 * Define a new indicator linked (optionally) to an approved StrategyVersion.
 *
 * Validations:
 *   - Zod validation on alertThresholds (max 2 rules, structured format)
 *   - strategyVersionId must reference an APPROVED StrategyVersion in same tenant
 *   - objectiveId/programId must reference entities in same tenant (enforced by RLS)
 *   - For Demolandia data: all sourceRef must start with "synthetic:demolandia-"
 *
 * Atomic via withAuthenticatedTenant + writeAuditTx.
 */
export async function defineIndicator(
  session: Session | null,
  input: DefineIndicatorInput
): Promise<IndicatorDefinition> {
  // Authorize — analyst or admin only
  await requirePermissionWithCurrentRole(
    session,
    "observatory:indicator:write"
  );

  // Validate input
  const parsed = DefineIndicatorInputSchema.parse(input);

  // E6: validate sourceRef prefixes for Demolandia data
  // (Demolandia is fictional — we never invent real government decisions)
  validateSourceRefPrefixes(parsed.periodMilestones, parsed.alertThresholds);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // If strategyVersionId provided, verify it exists and is approved
      if (parsed.strategyVersionId) {
        const sv = await tx.strategyVersion.findFirst({
          where: {
            id: parsed.strategyVersionId,
            tenantId,
            status: "approved",
          },
          select: { id: true },
        });
        if (!sv) {
          throw new Error(
            `StrategyVersion ${parsed.strategyVersionId} not found or not approved in tenant ${tenantId}`
          );
        }
      }

      // If objectiveId provided, verify it belongs to this tenant
      if (parsed.objectiveId) {
        const obj = await tx.objective.findFirst({
          where: { id: parsed.objectiveId, tenantId },
          select: { id: true },
        });
        if (!obj) {
          throw new Error(
            `Objective ${parsed.objectiveId} not found in tenant ${tenantId}`
          );
        }
      }

      // If programId provided, verify it belongs to this tenant
      if (parsed.programId) {
        const prog = await tx.program.findFirst({
          where: { id: parsed.programId, tenantId },
          select: { id: true },
        });
        if (!prog) {
          throw new Error(
            `Program ${parsed.programId} not found in tenant ${tenantId}`
          );
        }
      }

      // Create the indicator definition
      const indicator = await tx.indicatorDefinition.create({
        data: {
          tenantId,
          code: parsed.code,
          displayName: parsed.displayName,
          description: parsed.description ?? null,
          unit: parsed.unit,
          formula: parsed.formula ?? null,
          preferredDirection: parsed.preferredDirection,
          preferredDirectionRationale: parsed.preferredDirectionRationale ?? null,
          geographicLevels: (parsed.geographicLevels ?? []) as Prisma.InputJsonValue,
          coverage: parsed.coverage ?? null,
          frequency: parsed.frequency ?? null,
          methodologyDate: parsed.methodologyDate ?? null,
          measurementConstraints: (parsed.measurementConstraints ?? {}) as Prisma.InputJsonValue,
          uncertaintyMethod: parsed.uncertaintyMethod ?? null,
          usedBy: (parsed.usedBy ?? []) as Prisma.InputJsonValue,
          objectiveId: parsed.objectiveId ?? null,
          programId: parsed.programId ?? null,
          strategyVersionId: parsed.strategyVersionId ?? null,
          defaultTargetValue: parsed.defaultTargetValue ?? null,
          targetTimeHorizon: parsed.targetTimeHorizon ?? "annual",
          periodMilestones: (parsed.periodMilestones ?? []) as Prisma.InputJsonValue,
          alertThresholds: (parsed.alertThresholds ?? []) as Prisma.InputJsonValue,
          status: "draft",
          createdBy: userId,
        },
      });

      // Atomic audit log
      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "observatory.indicator.defined",
        details: {
          indicatorId: indicator.id,
          code: indicator.code,
          strategyVersionId: parsed.strategyVersionId ?? null,
        },
        status: "ok",
      });

      return indicator;
    }
  );
}

/**
 * List indicators, optionally filtered by strategyVersionId or status.
 */
export async function listIndicators(
  session: Session | null,
  filter?: { strategyVersionId?: string; status?: string }
): Promise<IndicatorDefinition[]> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:indicator:read"
  );

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const where: { tenantId: string; strategyVersionId?: string; status?: string } = {
      tenantId,
    };
    if (filter?.strategyVersionId) {
      where.strategyVersionId = filter.strategyVersionId;
    }
    if (filter?.status) {
      where.status = filter.status;
    }
    const indicators = await tx.indicatorDefinition.findMany({ where });
    return indicators;
  });
}

/**
 * Retire an indicator (status -> "retired"). Does not delete historical observations.
 */
export async function retireIndicator(
  session: Session | null,
  id: string,
  reason: string
): Promise<IndicatorDefinition> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:indicator:write"
  );

  if (!reason || reason.trim().length === 0) {
    throw new Error("Retire reason is required");
  }

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      const existing = await tx.indicatorDefinition.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        throw new NotFoundError(`Indicator ${id} not found in tenant ${tenantId}`);
      }

      const updated = await tx.indicatorDefinition.update({
        where: { id },
        data: { status: "retired" },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "observatory.indicator.retired",
        details: { indicatorId: id, reason },
        status: "ok",
      });

      return updated;
    }
  );
}

/**
 * E6: Validate that all sourceRef values in periodMilestones and alertThresholds
 * start with "synthetic:demolandia-" when isSynthetic context applies.
 *
 * For 02-00, all data is Demolandia (fictional), so all sourceRef must be
 * synthetic. In future missions with real country data, this check would
 * need to be country-aware.
 */
function validateSourceRefPrefixes(
  periodMilestones: DefineIndicatorInput["periodMilestones"],
  alertThresholds: DefineIndicatorInput["alertThresholds"]
): void {
  const PREFIX = "synthetic:demolandia-";
  const violations: string[] = [];

  if (periodMilestones) {
    for (const m of periodMilestones) {
      if (!m.sourceRef.startsWith(PREFIX)) {
        violations.push(
          `periodMilestone sourceRef "${m.sourceRef}" must start with "${PREFIX}"`
        );
      }
    }
  }

  if (alertThresholds) {
    for (const r of alertThresholds) {
      if (!r.sourceRef.startsWith(PREFIX)) {
        violations.push(
          `alertThreshold sourceRef "${r.sourceRef}" must start with "${PREFIX}"`
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `E6 violation: sourceRef prefix check failed:\n${violations.join("\n")}`
    );
  }
}
