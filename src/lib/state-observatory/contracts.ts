// ============================================================
// state-observatory/contracts.ts — Zod schemas + shared types
// ------------------------------------------------------------
// Per REV-5 FINAL CORRECTED MISSION spec:
//   - R1: Observation.originType SEPARATE FROM verificationStatus
//   - R3 + E5: alertThresholds structured JSON (max 2 rules)
//   - F4: plannedValueSourceKind/SourceId NULLABLE when plannedValueType="none"
//   - F6: verifyExecution requires verifiedAction + evidenceSource
//   - E6: Demolandia sourceRef must start with "synthetic:demolandia-"
// ============================================================
import { z } from "zod";
import type {
  IndicatorDefinition as PrismaIndicatorDefinition,
  Observation as PrismaObservation,
  ObservationPeriod as PrismaObservationPeriod,
  VarianceRecord as PrismaVarianceRecord,
  Alert as PrismaAlert,
} from "@prisma/client";

// Re-export Prisma types for service signatures (single source of truth)
export type IndicatorDefinition = PrismaIndicatorDefinition;
export type Observation = PrismaObservation;
export type ObservationPeriod = PrismaObservationPeriod;
export type VarianceRecord = PrismaVarianceRecord;
export type Alert = PrismaAlert;

// ------------------------------------------------------------
// Alert thresholds (E5 — structured, no eval)
// ------------------------------------------------------------

export const AlertThresholdMetricSchema = z.enum([
  "varianceAbsolute",
  "variancePercentage",
  "varianceDirection",
]);

export const AlertThresholdOperatorSchema = z.enum([
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
]);

export const AlertThresholdValueSchema = z.union([
  z.number(),
  z.enum(["better", "worse", "neutral", "unknown"]),
]);

export const AlertSeveritySchema = z.enum([
  "info",
  "watch",
  "warning",
  "critical",
]);

export const AlertThresholdLogicalOpSchema = z.enum(["and", "or"]);

export const AlertThresholdRuleSchema = z.object({
  metric: AlertThresholdMetricSchema,
  operator: AlertThresholdOperatorSchema,
  value: AlertThresholdValueSchema,
  // logicalOp is only meaningful on the first rule when 2 rules are present.
  logicalOp: AlertThresholdLogicalOpSchema.optional(),
  severity: AlertSeveritySchema,
  // rationale must be at least 10 chars (avoids hand-wavy thresholds).
  rationale: z.string().min(10),
  // sourceRef must start with "synthetic:demolandia-" for Demolandia data (E6).
  sourceRef: z.string().min(1),
});

// Max 2 rules per indicator in 02-00 (simplicity)
export const AlertThresholdsSchema = z
  .array(AlertThresholdRuleSchema)
  .max(2)
  .default([]);

export type AlertThresholdRule = z.infer<typeof AlertThresholdRuleSchema>;
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

// ------------------------------------------------------------
// Period milestones (R2 — period-comparable targets)
// ------------------------------------------------------------

export const PeriodMilestoneSchema = z.object({
  periodId: z.string().min(1),
  targetValue: z.number(),
  sourceRef: z.string().min(1),
});

export type PeriodMilestone = z.infer<typeof PeriodMilestoneSchema>;

// ------------------------------------------------------------
// Variance context (used by threshold evaluator)
// ------------------------------------------------------------

export type VarianceContext = {
  varianceAbsolute: number | null;
  variancePercentage: number | null;
  varianceDirection: "better" | "worse" | "neutral" | "unknown";
};

// ------------------------------------------------------------
// Service input schemas
// ------------------------------------------------------------

export const PreferredDirectionSchema = z.enum(["increase", "decrease", "stable"]);
export type PreferredDirection = z.infer<typeof PreferredDirectionSchema>;

export const TargetTimeHorizonSchema = z.enum(["period", "annual", "multi_year"]);
export type TargetTimeHorizon = z.infer<typeof TargetTimeHorizonSchema>;

export const OriginTypeSchema = z.enum(["observed", "derived", "synthetic"]);
export type OriginType = z.infer<typeof OriginTypeSchema>;

export const VerificationStatusSchema = z.enum([
  "unverified",
  "verified",
  "disputed",
  "rejected",
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const GeoLevelSchema = z.enum([
  "national",
  "sectoral",
  "institutional",
  "subnational",
]);
export type GeoLevel = z.infer<typeof GeoLevelSchema>;

export const PlannedValueTypeSchema = z.enum([
  "period_milestone",
  "interim",
  "final",
  "none",
]);
export type PlannedValueType = z.infer<typeof PlannedValueTypeSchema>;

export const PlannedValueSourceKindSchema = z.enum([
  "indicator_definition",
  "objective",
  "period_milestone",
]);
export type PlannedValueSourceKind = z.infer<typeof PlannedValueSourceKindSchema>;

export const VarianceDirectionSchema = z.enum([
  "better",
  "worse",
  "neutral",
  "unknown",
]);
export type VarianceDirection = z.infer<typeof VarianceDirectionSchema>;

export const AlertLifecycleStageSchema = z.enum([
  "detected",
  "notified",
  "reviewed",
  "decision_documented",
  "closed",
]);
export type AlertLifecycleStage = z.infer<typeof AlertLifecycleStageSchema>;

export const ExecutionStatusSchema = z.enum([
  "not_applicable",
  "pending",
  "verified",
  "disputed",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

// ------------------------------------------------------------
// Service input types
// ------------------------------------------------------------

export const DefineIndicatorInputSchema = z.object({
  code: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  unit: z.string().min(1),
  formula: z.string().optional(),
  preferredDirection: PreferredDirectionSchema,
  preferredDirectionRationale: z.string().optional(),
  geographicLevels: z.array(z.string()).optional(),
  coverage: z.string().optional(),
  frequency: z.string().optional(),
  methodologyDate: z.date().optional(),
  measurementConstraints: z.record(z.string(), z.unknown()).optional(),
  uncertaintyMethod: z.string().optional(),
  usedBy: z.array(z.string()).optional(),
  objectiveId: z.string().optional(),
  programId: z.string().optional(),
  strategyVersionId: z.string().optional(),
  defaultTargetValue: z.number().optional(),
  targetTimeHorizon: TargetTimeHorizonSchema.optional(),
  periodMilestones: z.array(PeriodMilestoneSchema).optional(),
  alertThresholds: AlertThresholdsSchema.optional(),
});
export type DefineIndicatorInput = z.infer<typeof DefineIndicatorInputSchema>;

export const IngestObservationInputSchema = z
  .object({
    indicatorDefinitionId: z.string().min(1),
    observationPeriodId: z.string().min(1),
    strategyVersionId: z.string().optional(),
    observedValue: z.number().nullable(),
    originType: OriginTypeSchema,
    verificationStatus: VerificationStatusSchema.optional(),
    // derivationMethod REQUIRED when originType = "derived"
    derivationMethod: z.string().optional(),
    // sourceId REQUIRED when originType = "observed"
    sourceId: z.string().optional(),
    evidenceId: z.string().optional(),
    isSynthetic: z.boolean().optional(),
    observedAt: z.date().optional(),
    qualityNotes: z.record(z.string(), z.unknown()).optional(),
    geoLevel: GeoLevelSchema.optional(),
    geoRefId: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.originType === "observed" && !val.sourceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceId"],
        message: "sourceId is required when originType = 'observed'",
      });
    }
    if (val.originType === "derived" && !val.derivationMethod) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["derivationMethod"],
        message: "derivationMethod is required when originType = 'derived'",
      });
    }
  });
export type IngestObservationInput = z.infer<typeof IngestObservationInputSchema>;

export const CorrectionInputSchema = z.object({
  newValue: z.number().nullable(),
  reason: z.string().min(1),
  originType: OriginTypeSchema.optional(),
  sourceId: z.string().optional(),
  derivationMethod: z.string().optional(),
});
export type CorrectionInput = z.infer<typeof CorrectionInputSchema>;

export const UpdateExecutionStatusInputSchema = z
  .object({
    executionStatus: z.enum(["pending", "verified", "disputed"]),
    // F6: verifiedAction + evidenceSource REQUIRED when executionStatus = "verified"
    verifiedAction: z.string().optional(),
    evidenceSource: z.string().optional(),
    notes: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.executionStatus === "verified") {
      if (!val.verifiedAction || val.verifiedAction.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedAction"],
          message:
            "verifiedAction is REQUIRED when executionStatus = 'verified'. " +
            "Describe the SPECIFIC action verified (e.g., 'receipt of memo #X'), " +
            "NOT a policy outcome (e.g., 'inflation reduced').",
        });
      }
      if (!val.evidenceSource || val.evidenceSource.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceSource"],
          message:
            "evidenceSource is REQUIRED when executionStatus = 'verified'. " +
            "Provide evidence for the SPECIFIC action being verified.",
        });
      }
    }
  });
export type UpdateExecutionStatusInput = z.infer<
  typeof UpdateExecutionStatusInputSchema
>;

export const VerifyExecutionInputSchema = z.object({
  // F6: REQUIRED — what SPECIFIC action is verified (not a policy outcome)
  verifiedAction: z.string().min(1),
  // F6: REQUIRED — evidence for that specific action
  evidenceSource: z.string().min(1),
  notes: z.string().optional(),
});
export type VerifyExecutionInput = z.infer<typeof VerifyExecutionInputSchema>;

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// Re-export PermissionDeniedError from permissions module for convenience
export { PermissionDeniedError } from "@/lib/permissions";
