// ============================================================
// tests/unit/state-observatory/threshold-evaluator.test.ts
// ------------------------------------------------------------
// Pure function tests — no DB, no mocks needed.
// Covers:
//   U-16: empty thresholds → no match
//   U-17: 2-rule "and"/"or" logic
//   U-18: code audit (no eval/Function/vm)
//   Plus: single-rule matching, severityMax, variancePercentage
// ============================================================
import { describe, it, expect } from "vitest";
import {
  evaluateThresholdRule,
  evaluateThresholds,
  severityMax,
  computeVariancePercentage,
} from "@/lib/state-observatory/threshold-evaluator";
import type { AlertThresholdRule, VarianceContext } from "@/lib/state-observatory/contracts";

const baseRule: AlertThresholdRule = {
  metric: "varianceAbsolute",
  operator: "gt",
  value: 1.5,
  severity: "warning",
  rationale: "Demo threshold for inflation — 1.5pp above milestone",
  sourceRef: "synthetic:demolandia-test-policy-2026-001",
};

describe("threshold-evaluator — evaluateThresholdRule", () => {
  it("gt operator: actual > expected → true", () => {
    const rule: AlertThresholdRule = { ...baseRule, operator: "gt", value: 1.5 };
    const ctx: VarianceContext = {
      varianceAbsolute: 2.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(true);
  });

  it("gt operator: actual == expected → false", () => {
    const rule: AlertThresholdRule = { ...baseRule, operator: "gt", value: 1.5 };
    const ctx: VarianceContext = {
      varianceAbsolute: 1.5,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(false);
  });

  it("gte operator: actual == expected → true", () => {
    const rule: AlertThresholdRule = { ...baseRule, operator: "gte", value: 1.5 };
    const ctx: VarianceContext = {
      varianceAbsolute: 1.5,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(true);
  });

  it("lt operator: actual < expected → true", () => {
    const rule: AlertThresholdRule = { ...baseRule, operator: "lt", value: 1.5 };
    const ctx: VarianceContext = {
      varianceAbsolute: 1.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(true);
  });

  it("lte operator: actual == expected → true", () => {
    const rule: AlertThresholdRule = { ...baseRule, operator: "lte", value: 1.5 };
    const ctx: VarianceContext = {
      varianceAbsolute: 1.5,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(true);
  });

  it("eq operator with string value: matches direction", () => {
    const rule: AlertThresholdRule = {
      ...baseRule,
      metric: "varianceDirection",
      operator: "eq",
      value: "worse",
    };
    const ctx: VarianceContext = {
      varianceAbsolute: 0.5,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(true);
  });

  it("eq operator with string value: non-match", () => {
    const rule: AlertThresholdRule = {
      ...baseRule,
      metric: "varianceDirection",
      operator: "eq",
      value: "better",
    };
    const ctx: VarianceContext = {
      varianceAbsolute: 0.5,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(false);
  });

  it("null actual with numeric operator → false (no crash)", () => {
    const rule: AlertThresholdRule = { ...baseRule, operator: "gt", value: 1.5 };
    const ctx: VarianceContext = {
      varianceAbsolute: null,
      variancePercentage: null,
      varianceDirection: "unknown",
    };
    expect(evaluateThresholdRule(rule, ctx)).toBe(false);
  });
});

describe("threshold-evaluator — evaluateThresholds", () => {
  it("U-16: empty rules → no match, no severity", () => {
    const ctx: VarianceContext = {
      varianceAbsolute: 5.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([], ctx);
    expect(result.matches).toBe(false);
    expect(result.severity).toBeNull();
  });

  it("single rule matches → returns severity", () => {
    const ctx: VarianceContext = {
      varianceAbsolute: 2.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([baseRule], ctx);
    expect(result.matches).toBe(true);
    expect(result.severity).toBe("warning");
  });

  it("single rule does not match → false", () => {
    const ctx: VarianceContext = {
      varianceAbsolute: 0.5,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([baseRule], ctx);
    expect(result.matches).toBe(false);
    expect(result.severity).toBeNull();
  });

  it("U-17: two rules with 'and' — both match → true", () => {
    const rule1: AlertThresholdRule = {
      ...baseRule,
      logicalOp: "and",
    };
    const rule2: AlertThresholdRule = {
      metric: "varianceDirection",
      operator: "eq",
      value: "worse",
      severity: "warning",
      rationale: "Only raise when direction is worse",
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    };
    const ctx: VarianceContext = {
      varianceAbsolute: 2.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([rule1, rule2], ctx);
    expect(result.matches).toBe(true);
    expect(result.severity).toBe("warning");
  });

  it("U-17: two rules with 'and' — only one matches → false", () => {
    const rule1: AlertThresholdRule = {
      ...baseRule,
      logicalOp: "and",
    };
    const rule2: AlertThresholdRule = {
      metric: "varianceDirection",
      operator: "eq",
      value: "better",
      severity: "warning",
      rationale: "Only raise when direction is better",
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    };
    const ctx: VarianceContext = {
      varianceAbsolute: 2.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([rule1, rule2], ctx);
    expect(result.matches).toBe(false);
    expect(result.severity).toBeNull();
  });

  it("U-17: two rules with 'or' — only one matches → true", () => {
    const rule1: AlertThresholdRule = {
      ...baseRule,
      logicalOp: "or",
    };
    const rule2: AlertThresholdRule = {
      metric: "varianceDirection",
      operator: "eq",
      value: "better",
      severity: "warning",
      rationale: "Only raise when direction is better",
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    };
    const ctx: VarianceContext = {
      varianceAbsolute: 2.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([rule1, rule2], ctx);
    expect(result.matches).toBe(true);
    expect(result.severity).toBe("warning");
  });

  it("two rules with 'and' — returns max severity of matching rules", () => {
    const rule1: AlertThresholdRule = {
      ...baseRule,
      logicalOp: "and",
      severity: "warning",
    };
    const rule2: AlertThresholdRule = {
      metric: "varianceDirection",
      operator: "eq",
      value: "worse",
      severity: "critical",
      rationale: "Critical when direction is worse",
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    };
    const ctx: VarianceContext = {
      varianceAbsolute: 2.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([rule1, rule2], ctx);
    expect(result.matches).toBe(true);
    expect(result.severity).toBe("critical"); // max of warning + critical
  });

  it("default logicalOp is 'and' when not specified", () => {
    const rule1: AlertThresholdRule = { ...baseRule }; // no logicalOp
    const rule2: AlertThresholdRule = {
      metric: "varianceDirection",
      operator: "eq",
      value: "worse",
      severity: "warning",
      rationale: "Only raise when direction is worse",
      sourceRef: "synthetic:demolandia-test-policy-2026-001",
    };
    const ctx: VarianceContext = {
      varianceAbsolute: 2.0,
      variancePercentage: null,
      varianceDirection: "worse",
    };
    const result = evaluateThresholds([rule1, rule2], ctx);
    expect(result.matches).toBe(true); // both match, default "and"
  });
});

describe("threshold-evaluator — severityMax", () => {
  it("info < watch < warning < critical", () => {
    expect(severityMax("info", "watch")).toBe("watch");
    expect(severityMax("watch", "warning")).toBe("warning");
    expect(severityMax("warning", "critical")).toBe("critical");
    expect(severityMax("critical", "info")).toBe("critical");
    expect(severityMax("warning", "warning")).toBe("warning");
  });
});

describe("threshold-evaluator — computeVariancePercentage", () => {
  it("returns null when varianceAbsolute is null", () => {
    expect(computeVariancePercentage(null, 100)).toBeNull();
  });

  it("returns null when plannedValue is null", () => {
    expect(computeVariancePercentage(5, null)).toBeNull();
  });

  it("returns null when plannedValue is 0", () => {
    expect(computeVariancePercentage(5, 0)).toBeNull();
  });

  it("computes percentage correctly", () => {
    expect(computeVariancePercentage(2, 8)).toBe(0.25);
    expect(computeVariancePercentage(-3, 10)).toBe(-0.3);
  });
});

describe("threshold-evaluator — U-18 code audit (no eval/Function/vm)", () => {
  // This test validates the source code by importing the module and
  // checking that no dynamic code execution patterns are referenced.
  // We do this by reading the source file and grepping for forbidden patterns.
  it("source code contains no eval(), new Function(), or vm.runIn* calls", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sourcePath = path.resolve(
      process.cwd(),
      "src/lib/state-observatory/threshold-evaluator.ts"
    );
    const rawSource = fs.readFileSync(sourcePath, "utf-8");

    // Strip comments to avoid false positives in documentation that mentions "eval()"
    const source = rawSource
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Forbidden patterns — use precise patterns to avoid false positives
    // (e.g., "evaluateThresholds(" must NOT match "eval(")
    // The pattern [^a-zA-Z_]eval\s*\( requires "eval(" preceded by a non-identifier char
    expect(source).not.toMatch(/[^a-zA-Z_]eval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\s*\(/);
    expect(source).not.toMatch(/vm\.runIn/);
    expect(source).not.toMatch(/child_process/);

    // Also verify the function is pure (no module-level side effects)
    // by checking it only imports types
    const importLines = rawSource
      .split("\n")
      .filter((l) => l.startsWith("import"));
    for (const line of importLines) {
      // Should only import types
      expect(line).toMatch(/^import\s+type\s+/);
    }
  });

  it("source code of all state-observatory modules is free of dynamic code execution", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const modulesToAudit = [
      "contracts.ts",
      "threshold-evaluator.ts",
      "indicator-registry-service.ts",
      "observation-service.ts",
      "variance-service.ts",
      "alert-service.ts",
      "index.ts",
    ];

    for (const mod of modulesToAudit) {
      const sourcePath = path.resolve(
        process.cwd(),
        "src/lib/state-observatory",
        mod
      );
      const source = fs.readFileSync(sourcePath, "utf-8");

      // Strip comments to avoid false positives in documentation
      const stripped = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

      expect(stripped).not.toMatch(/[^a-zA-Z_]eval\s*\(/);
      expect(stripped).not.toMatch(/new\s+Function\s*\(/);
      expect(stripped).not.toMatch(/vm\.runIn/);
      expect(stripped).not.toMatch(/child_process/);
    }
  });
});
