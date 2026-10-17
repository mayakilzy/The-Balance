// ============================================================
// state-observatory/threshold-evaluator.ts
// ------------------------------------------------------------
// Pure deterministic function for evaluating structured alert thresholds.
//
// Per REV-5 FINAL CORRECTED MISSION:
//   - E5: NO eval(), NO new Function(), NO vm, NO child_process.
//   - R3: alertThresholds defined per-indicator ([] = no auto-alert).
//   - Max 2 rules per indicator in 02-00 (simplicity).
//   - logicalOp on first rule binds the two rules.
//
// The evaluator is intentionally minimal and explicit. Adding new metrics
// or operators requires extending this function (no dynamic dispatch).
// ============================================================
import type {
  AlertThresholdRule,
  AlertSeverity,
  VarianceContext,
} from "./contracts";

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  info: 1,
  watch: 2,
  warning: 3,
  critical: 4,
};

/**
 * Evaluate a single threshold rule against a variance context.
 * Returns true if the rule matches, false otherwise.
 *
 * Type narrowing:
 *   - For numeric operators (gt/gte/lt/lte), both actual and expected must be numbers.
 *   - For "eq", supports both numbers and string enum values.
 */
export function evaluateThresholdRule(
  rule: AlertThresholdRule,
  ctx: VarianceContext
): boolean {
  const actual = ctx[rule.metric];
  const expected = rule.value;

  switch (rule.operator) {
    case "gt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual > expected
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual >= expected
      );
    case "lt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual < expected
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual <= expected
      );
    case "eq":
      return actual === expected;
    default:
      // Exhaustive switch — TypeScript would catch this at compile time
      return false;
  }
}

/**
 * Return the higher of two severities.
 */
export function severityMax(
  a: AlertSeverity,
  b: AlertSeverity
): AlertSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

export interface ThresholdEvaluationResult {
  matches: boolean;
  severity: AlertSeverity | null;
}

/**
 * Evaluate an array of threshold rules against a variance context.
 *
 * Rules for combining:
 *   - 0 rules: matches=false, severity=null
 *   - 1 rule: matches = result of that rule; severity = rule.severity if matched
 *   - 2 rules: combined using the FIRST rule's logicalOp (default "and")
 *     - "and": both must match
 *     - "or": either matches
 *   - severity (when matched) = max severity of matching rules
 */
export function evaluateThresholds(
  rules: AlertThresholdRule[],
  ctx: VarianceContext
): ThresholdEvaluationResult {
  if (rules.length === 0) {
    return { matches: false, severity: null };
  }

  if (rules.length === 1) {
    const matched = evaluateThresholdRule(rules[0]!, ctx);
    return {
      matches: matched,
      severity: matched ? rules[0]!.severity : null,
    };
  }

  // 2 rules — use the first rule's logicalOp (default "and")
  const r1 = evaluateThresholdRule(rules[0]!, ctx);
  const r2 = evaluateThresholdRule(rules[1]!, ctx);
  const op = rules[0]!.logicalOp ?? "and";
  const matches = op === "and" ? r1 && r2 : r1 || r2;

  if (!matches) {
    return { matches: false, severity: null };
  }

  // When matched, severity = max of matching rules (or the only matching rule's severity)
  const matchingRules: AlertThresholdRule[] = [];
  if (r1) matchingRules.push(rules[0]!);
  if (r2) matchingRules.push(rules[1]!);

  if (matchingRules.length === 0) {
    // Should not happen if matches=true, but defensive
    return { matches: false, severity: null };
  }
  const severity = matchingRules.reduce<AlertSeverity>(
    (max, r) => severityMax(max, r.severity),
    matchingRules[0]!.severity
  );

  return { matches: true, severity };
}

/**
 * Compute variancePercentage for a VarianceContext.
 * Returns null when plannedValue is 0, null, or varianceAbsolute is null.
 */
export function computeVariancePercentage(
  varianceAbsolute: number | null,
  plannedValue: number | null
): number | null {
  if (varianceAbsolute === null || plannedValue === null || plannedValue === 0) {
    return null;
  }
  return varianceAbsolute / plannedValue;
}
