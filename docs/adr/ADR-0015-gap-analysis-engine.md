# ADR-0015 — Gap Analysis Engine

**Date:** 2026-10-17
**Status:** Accepted
**Mission:** 01-02 (Gap Analysis Engine)
**Builds on:** ADR-0009 (Evidence Fabric), ADR-0014 (State Baseline), ADR-0013 (G01 Domain Model)

## Context

Mission 01-02 requires a Gap Analysis Engine that compares the State Baseline (from 01-01) with human-defined Objectives (from 01-00) to identify measurable gaps, partial gaps, unknown gaps, and evidence-supported blockers. The engine must follow Blueprint §2 scientific principles strictly: "unknown" is a valid result, no fabricated values, no causal claims from correlation, no mixing of incompatible units.

## Decision

### 1. GapReport Structure

```typescript
interface GapReport {
  countryId, computedAt, taskId, baselineTaskId
  gaps: GapItem[]
  summary: { closableGaps[], structuralGaps[], unknownGaps[] }
  honesty: { fictional, sourceNote, computedBy, rulesVersion }
}

interface GapItem {
  objectiveId, objectiveTitle, sector
  currentMode: FULL | PARTIAL | LOW | "none"
  currentValue, currentValueConfidence, currentEvidenceCount
  targetMetric, targetValue, horizon
  gapType: "measurable" | "partial" | "unknown"
  gapSize: string | null  // e.g., "2.3 percentage points"
  gapDirection: "above" | "below" | null
  unitMatch: boolean
  supportingEvidence[], counterEvidence[], blockers[]
  notes: string[]  // honesty notes
}
```

### 2. Gap Classification Rules

| Condition | gapType | gapSize |
|-----------|---------|---------|
| Baseline sector = LOW | unknown | null |
| No matching baseline sector | unknown | null |
| No matching indicator (targetMetric ≠ indicator name) | unknown | null |
| Indicator value = "unparsed" | unknown | null |
| Unit mismatch (% vs non-%) | unknown | null |
| Baseline = PARTIAL + matching units | partial | computed (with uncertainty note) |
| Baseline = FULL + matching units | measurable | computed |

### 3. Unit Matching (Principle 3)

Both current value and target value must be percentages (end with "%") OR both must be plain numbers. If one is "%" and the other isn't → unknown (incomparable). This prevents mixing percentages with raw counts or different units.

### 4. Metric Matching

Objective's `targetMetric` is normalized (lowercase, replace `_`/`-` with spaces) and compared to the baseline indicator's `name` (also normalized). If multiple indicators match, prefer structured > extracted > unparsed confidence.

### 5. Blockers (Principle 8)

- Counter-evidence in the same sector → evidence-backed blocker (evidenceId provided)
- LOW baseline → factual blocker ("insufficient data", not an assumption)
- PARTIAL baseline → factual blocker ("partial coverage", not an assumption)
- No matching indicator → factual blocker
- **Never fabricate blockers** without evidence or a clear "assumption" label

### 6. Durable Task + Fingerprint Idempotency

The gap fingerprint covers:
- Baseline task ID + computedAt (proxy for baseline state)
- Objectives state (id, title, targetMetric, targetValue, horizon, status, updatedAt)
- Request inputs (countryId, objectiveIds)

If baseline changes → new baseline task ID → new gap fingerprint → new gap task → fresh report. If objectives change → new fingerprint → fresh report. If nothing changes → same task (idempotent).

### 7. Permissions

- `computeGaps()` → reuses `baseline:compute` (admin + analyst) — gap analysis depends on baseline
- `getGapTask()` / `getLatestGapReport()` → `gap:read` (admin, analyst, reviewer — NOT observer, per mission pack §6)

## Alternatives Considered

### Compute trajectory/trend from baseline (rejected)
- **Considered**: Infer a trend from the baseline indicators to project future state.
- **Rejected**: Principle 2 — "Don't extract trajectory from a single measurement without explicit methodology." The baseline is a point-in-time snapshot. Trend analysis requires multiple data points over time, which is a future mission (Observatory).

### Auto-compute baseline if none exists (rejected)
- **Considered**: If no baseline exists, compute one on-the-fly inside `computeGaps()`.
- **Rejected**: Separation of concerns. The user should explicitly compute a baseline first. This keeps the gap analysis focused on comparison, not baseline computation. The error message guides the user to compute a baseline.

## Verification (planned for 01-02)

1. Baseline LOW → gap unknown
2. Unparsed indicator → no fabricated numeric gap
3. Reliable indicator + matching units → correctly computed gap
4. Unit mismatch → unknown (incomparable)
5. Multiple objectives in same sector → organized report
6. Contradictory evidence → shown + restricts conclusion
7. Cross-tenant isolation
8. Unauthorized access rejected
9. Task integrity after crash/restore
10. Recompute when inputs change (fingerprint idempotency)
