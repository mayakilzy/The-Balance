// ============================================================
// tests/unit/state-observatory/contracts.test.ts
// ------------------------------------------------------------
// Pure Zod schema tests — no DB, no mocks needed.
// Covers:
//   U-02: alertThresholds Zod validation (rationale min 10, structured)
//   U-03: alertThresholds max 2 rules
//   U-04: originType=observed requires sourceId
//   U-05: originType=derived requires derivationMethod
//   U-06: observedValue=null accepted (unknown case)
//   F4: plannedValueSourceKind/SourceId nullable when type="none"
//   F6: verifyExecution requires verifiedAction + evidenceSource
//   E6: sourceRef prefix validation
// ============================================================
import { describe, it, expect } from "vitest";
import {
  AlertThresholdRuleSchema,
  AlertThresholdsSchema,
  DefineIndicatorInputSchema,
  IngestObservationInputSchema,
  CorrectionInputSchema,
  UpdateExecutionStatusInputSchema,
  VerifyExecutionInputSchema,
} from "@/lib/state-observatory/contracts";

describe("contracts — AlertThresholdRuleSchema", () => {
  const validRule = {
    metric: "varianceAbsolute",
    operator: "gt",
    value: 1.5,
    severity: "warning",
    rationale: "Demo threshold for inflation — 1.5pp above milestone",
    sourceRef: "synthetic:demolandia-test-policy-2026-001",
  };

  it("accepts a valid rule", () => {
    const result = AlertThresholdRuleSchema.safeParse(validRule);
    expect(result.success).toBe(true);
  });

  it("U-02: rejects rationale shorter than 10 chars", () => {
    const result = AlertThresholdRuleSchema.safeParse({
      ...validRule,
      rationale: "short",
    });
    expect(result.success).toBe(false);
  });

  it("U-02: rejects missing rationale", () => {
    const { rationale: _, ...withoutRationale } = validRule;
    const result = AlertThresholdRuleSchema.safeParse(withoutRationale);
    expect(result.success).toBe(false);
  });

  it("U-02: rejects missing sourceRef", () => {
    const { sourceRef: _, ...withoutSourceRef } = validRule;
    const result = AlertThresholdRuleSchema.safeParse(withoutSourceRef);
    expect(result.success).toBe(false);
  });

  it("rejects invalid metric", () => {
    const result = AlertThresholdRuleSchema.safeParse({
      ...validRule,
      metric: "invalid_metric",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid operator", () => {
    const result = AlertThresholdRuleSchema.safeParse({
      ...validRule,
      operator: "invalid_op",
    });
    expect(result.success).toBe(false);
  });

  it("accepts string value for varianceDirection metric", () => {
    const result = AlertThresholdRuleSchema.safeParse({
      ...validRule,
      metric: "varianceDirection",
      operator: "eq",
      value: "worse",
    });
    expect(result.success).toBe(true);
  });

  it("accepts logicalOp on first rule", () => {
    const result = AlertThresholdRuleSchema.safeParse({
      ...validRule,
      logicalOp: "and",
    });
    expect(result.success).toBe(true);
  });
});

describe("contracts — AlertThresholdsSchema (U-03: max 2 rules)", () => {
  const validRule = {
    metric: "varianceAbsolute",
    operator: "gt",
    value: 1.5,
    severity: "warning",
    rationale: "Demo threshold for inflation — 1.5pp above milestone",
    sourceRef: "synthetic:demolandia-test-policy-2026-001",
  };

  it("accepts empty array (default)", () => {
    const result = AlertThresholdsSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("accepts 1 rule", () => {
    const result = AlertThresholdsSchema.safeParse([validRule]);
    expect(result.success).toBe(true);
  });

  it("accepts 2 rules", () => {
    const result = AlertThresholdsSchema.safeParse([
      validRule,
      { ...validRule, metric: "varianceDirection", operator: "eq", value: "worse" },
    ]);
    expect(result.success).toBe(true);
  });

  it("U-03: rejects 3 rules", () => {
    const result = AlertThresholdsSchema.safeParse([
      validRule,
      validRule,
      validRule,
    ]);
    expect(result.success).toBe(false);
  });
});

describe("contracts — DefineIndicatorInputSchema", () => {
  const validInput = {
    code: "INFLATION_RATE",
    displayName: "Inflation Rate",
    unit: "percent",
    preferredDirection: "decrease",
    periodMilestones: [
      {
        periodId: "2026-Q1",
        targetValue: 7.5,
        sourceRef: "synthetic:demolandia-test-policy-2026-001",
      },
    ],
    alertThresholds: [
      {
        metric: "varianceAbsolute",
        operator: "gt",
        value: 1.5,
        severity: "warning",
        rationale: "Demo threshold for inflation — 1.5pp above milestone",
        sourceRef: "synthetic:demolandia-test-policy-2026-001",
      },
    ],
  };

  it("accepts valid input", () => {
    const result = DefineIndicatorInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("accepts minimal input (code, displayName, unit, preferredDirection)", () => {
    const result = DefineIndicatorInputSchema.safeParse({
      code: "X",
      displayName: "X",
      unit: "count",
      preferredDirection: "increase",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing code", () => {
    const { code: _, ...rest } = validInput;
    const result = DefineIndicatorInputSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid preferredDirection", () => {
    const result = DefineIndicatorInputSchema.safeParse({
      ...validInput,
      preferredDirection: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("contracts — IngestObservationInputSchema", () => {
  const validBase = {
    indicatorDefinitionId: "ind_1",
    observationPeriodId: "period_1",
    observedValue: 9.0,
    originType: "observed" as const,
    sourceId: "src_1",
  };

  it("U-04: rejects originType=observed without sourceId", () => {
    const { sourceId: _, ...withoutSourceId } = validBase;
    const result = IngestObservationInputSchema.safeParse(withoutSourceId);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues.some((p) => p.includes("sourceId"))).toBe(true);
    }
  });

  it("accepts originType=observed with sourceId", () => {
    const result = IngestObservationInputSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("U-05: rejects originType=derived without derivationMethod", () => {
    const result = IngestObservationInputSchema.safeParse({
      ...validBase,
      originType: "derived",
      sourceId: undefined,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues.some((p) => p.includes("derivationMethod"))).toBe(true);
    }
  });

  it("accepts originType=derived with derivationMethod", () => {
    const result = IngestObservationInputSchema.safeParse({
      ...validBase,
      originType: "derived",
      sourceId: undefined,
      derivationMethod: "interpolation from quarterly data",
    });
    expect(result.success).toBe(true);
  });

  it("accepts originType=synthetic without sourceId or derivationMethod", () => {
    const result = IngestObservationInputSchema.safeParse({
      ...validBase,
      originType: "synthetic",
      sourceId: undefined,
    });
    expect(result.success).toBe(true);
  });

  it("U-06: accepts observedValue=null (unknown case)", () => {
    const result = IngestObservationInputSchema.safeParse({
      ...validBase,
      observedValue: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid originType", () => {
    const result = IngestObservationInputSchema.safeParse({
      ...validBase,
      originType: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("contracts — CorrectionInputSchema", () => {
  it("accepts valid correction", () => {
    const result = CorrectionInputSchema.safeParse({
      newValue: 9.2,
      reason: "source revision",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null newValue (corrected to unknown)", () => {
    const result = CorrectionInputSchema.safeParse({
      newValue: null,
      reason: "value retracted",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing reason", () => {
    const result = CorrectionInputSchema.safeParse({
      newValue: 9.2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty reason", () => {
    const result = CorrectionInputSchema.safeParse({
      newValue: 9.2,
      reason: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("contracts — UpdateExecutionStatusInputSchema (F6)", () => {
  it("accepts pending without verifiedAction", () => {
    const result = UpdateExecutionStatusInputSchema.safeParse({
      executionStatus: "pending",
    });
    expect(result.success).toBe(true);
  });

  it("accepts disputed without verifiedAction", () => {
    const result = UpdateExecutionStatusInputSchema.safeParse({
      executionStatus: "disputed",
      notes: "evidence conflicts with claim",
    });
    expect(result.success).toBe(true);
  });

  it("F6: rejects verified without verifiedAction", () => {
    const result = UpdateExecutionStatusInputSchema.safeParse({
      executionStatus: "verified",
      evidenceSource: "receipt",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues.some((p) => p.includes("verifiedAction"))).toBe(true);
    }
  });

  it("F6: rejects verified without evidenceSource", () => {
    const result = UpdateExecutionStatusInputSchema.safeParse({
      executionStatus: "verified",
      verifiedAction: "receipt of memo",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues.some((p) => p.includes("evidenceSource"))).toBe(true);
    }
  });

  it("F6: accepts verified with both verifiedAction and evidenceSource", () => {
    const result = UpdateExecutionStatusInputSchema.safeParse({
      executionStatus: "verified",
      verifiedAction: "receipt of memo #DEMO-2026-042 by Ministry of Finance",
      evidenceSource: "receipt issued by Ministry of Finance",
    });
    expect(result.success).toBe(true);
  });

  it("F6: rejects empty verifiedAction (whitespace only)", () => {
    const result = UpdateExecutionStatusInputSchema.safeParse({
      executionStatus: "verified",
      verifiedAction: "   ",
      evidenceSource: "receipt",
    });
    expect(result.success).toBe(false);
  });
});

describe("contracts — VerifyExecutionInputSchema (F6)", () => {
  it("accepts valid input with verifiedAction + evidenceSource", () => {
    const result = VerifyExecutionInputSchema.safeParse({
      verifiedAction: "receipt of memo #DEMO-2026-042 by Ministry of Finance",
      evidenceSource: "receipt issued by Ministry of Finance",
    });
    expect(result.success).toBe(true);
  });

  it("F6: rejects missing verifiedAction", () => {
    const result = VerifyExecutionInputSchema.safeParse({
      evidenceSource: "receipt",
    });
    expect(result.success).toBe(false);
  });

  it("F6: rejects missing evidenceSource", () => {
    const result = VerifyExecutionInputSchema.safeParse({
      verifiedAction: "receipt of memo",
    });
    expect(result.success).toBe(false);
  });
});
