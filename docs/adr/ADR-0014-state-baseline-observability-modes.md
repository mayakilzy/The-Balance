# ADR-0014 — State Baseline & Observability Modes

**Date:** 2026-10-17
**Status:** Accepted
**Mission:** 01-01 (State Baseline & Observability Modes)
**Supersedes:** None
**Builds on:** ADR-0009 (Evidence Fabric), ADR-0011 (Task Runtime), ADR-0013 (G01 Domain Model), Master Blueprint §5.4

## Context

Mission 01-01 requires a State Baseline engine that computes a structured snapshot of the country's current state per sector, using Evidence Fabric data. The engine must implement the National Observability Modes from Blueprint §5.4:

- **FULL** — reliable, broad data coverage
- **PARTIAL** — limited coverage (gaps documented)
- **LOW** — insufficient data → system says "unknown"

The founder directive (Blueprint §2) is absolute: "unknown is a valid result." The system must NEVER fabricate values to compensate for missing data. Every indicator value must link to its evidence source + date. Counter-evidence must be shown side-by-side, not silently selected. Sources in the same `independence_group` must NOT be counted as independent (Blueprint §2: Multi-source & independence).

## Decision

### 1. Observability Mode Thresholds (public, auditable, falsifiable)

The thresholds for determining observability mode are **explicit and documented** — not opaque heuristics. They are defined here and enforced in `baseline-service.ts`.

| Mode | Criteria | Meaning |
|------|----------|---------|
| **FULL** | ≥2 independent sources (different `independence_group`) AND ≥1 evidence with `verificationStatus` ∈ {`verified`, `corroborated`} | We have enough cross-verified data to make a defensible statement |
| **PARTIAL** | ≥1 evidence, but doesn't meet FULL criteria (single source, OR multiple non-independent, OR all `unverified`/`disputed`) | We have some data, but coverage or quality is insufficient for confidence |
| **LOW** | 0 evidence for the sector | We don't know — system says "unknown", no fabricated values |

These thresholds are:
- **Public** — documented in this ADR + visible in the baseline report
- **Auditable** — each sector's mode is accompanied by the evidence count + independence count + verification status that determined it
- **Falsifiable** — a sector classified as FULL must list the ≥2 independent sources + ≥1 verified evidence; a reviewer can verify the classification

### 2. BaselineReport Structure

```typescript
interface BaselineReport {
  countryId: string;
  computedAt: string; // ISO-8601
  taskId: string; // The Durable Task that computed this baseline
  dimensions: BaselineDimension[];
  summary: {
    strongSectors: string[];   // FULL
    weakSectors: string[];     // PARTIAL
    unknownSectors: string[];  // LOW
  };
  honesty: {
    fictional: boolean; // true if the country is a fictional fixture
    sourceNote: string;
    computedBy: "baseline-engine-v1";
  };
}

interface BaselineDimension {
  sector: string;
  observabilityMode: "FULL" | "PARTIAL" | "LOW";
  indicators: BaselineIndicator[];
  gaps: string[]; // human-readable description of what's missing
  evidenceCount: number;
  independentSourceCount: number;
  counterEvidenceCount: number;
}

interface BaselineIndicator {
  name: string;        // extracted from evidence.claim or metadata.indicatorName
  value: string;       // the reported value (text — no fabricated precision)
  sourceId: string;
  sourceCode: string | null;
  independenceGroup: string | null;
  verificationStatus: string;
  observedAt: string | null; // ISO-8601 or null
  supportStance: "supports" | "contradicts" | "neutral" | "uncertain";
  // Honesty: link back to the evidence
  evidenceId: string;
  claim: string; // the original claim text
}
```

### 3. Counter-Evidence Handling (Blueprint §2)

When contradictory evidence exists for a sector:
- Both supporting AND contradicting indicators are included in `indicators[]` — no silent selection.
- `supportStance` is preserved per indicator ("supports" / "contradicts" / "neutral" / "uncertain").
- The `gaps[]` array notes when there's unresolved contradiction.
- The observability mode is NOT automatically downgraded due to contradiction — contradiction is information, not absence. However, if ALL evidence is `disputed` or `refuted`, the mode drops to PARTIAL (we know there's a conflict, but not what's true).

### 4. Independence Counting (Blueprint §2: Multi-source & independence)

Sources in the same `independence_group` are counted as ONE independent source. This prevents syndicated news feeds (e.g., Reuters + AP publishing the same story) from inflating the independent source count.

The `independentSourceCount` is computed as:
```
unique independence_groups among evidence sources
(null independence_group = each source is its own group)
```

This reuses G00's `Source.independenceGroup` field (ADR-0009) — no new infrastructure.

### 5. Durable Task Execution

`computeBaseline()` runs as a Durable Task using G00's Task Runtime:
1. `createTask({ type: "baseline-compute", goal, input: { countryId }, idempotencyKey })` — idempotency key prevents duplicate baselines for the same country if the task is re-submitted.
2. `claimTask()` — claim the task.
3. `startTask()` — begin computation.
4. Run the computation (read evidence, aggregate per sector, classify modes).
5. `completeTask({ output: BaselineReport })` — store the report in the task's output.

The task is tenant-scoped (RLS enforced). Cross-tenant access to baseline tasks is blocked by G00's RLS policies on the `tasks` table.

**Crash recovery:** if the computation crashes mid-task, the lease expires (60s default) and `reclaimStaleTasks()` re-queues it. The idempotency key ensures the re-claimed task produces the same baseline (deterministic computation from the same evidence). No duplicate output.

### 6. Permissions (per mission pack §6)

- `baseline:read` — admin, analyst, reviewer, observer (all roles) — view baseline reports
- `baseline:compute` — admin, analyst — trigger baseline computation

`computeBaseline()` requires `baseline:compute`. `getBaselineTask()` / `getLatestBaseline()` require `baseline:read`.

### 7. "unknown" is a Valid Result

When a sector has 0 evidence:
- `observabilityMode = "LOW"`
- `indicators = []`
- `gaps = ["No evidence available for this sector. Unable to assess state."]`
- The sector appears in `summary.unknownSectors`
- **No fabricated values** — the system explicitly says "unknown"

This is the core honesty mechanism. The baseline report NEVER invents indicator values to fill gaps.

### 8. Sector Identification

Evidence is grouped by sector using `evidence.metadata.sector` (a string field). Evidence without a `metadata.sector` is NOT included in the baseline (it's unstructured data). This is documented in the report's `honesty.sourceNote`.

For 01-01, the seed adds evidence with `metadata.sector` set to: `agriculture`, `finance`, `education`, `health`. Sectors with no tagged evidence → LOW.

## Alternatives considered

### AI-generated baseline summary (rejected)
- **Considered**: Use the LLM Provider to generate a natural-language summary of the baseline.
- **Rejected for 01-01**: The baseline engine must be deterministic and auditable. LLM summaries are Simulated (StubProvider) and would introduce non-determinism. The structured `BaselineReport` is the source of truth; LLM summaries can be added in a later mission (01-09 Development Advisor) as a Simulated overlay, clearly labeled.

### Storing baseline reports in a new table (deferred)
- **Considered**: A `baseline_reports` table to persist computed baselines for historical comparison.
- **Deferred to 01-02+**: For 01-01, the baseline is stored in the task's `output` JSONB column. This is sufficient for T1. A dedicated table for historical baselines (with `supersedes` semantics) can be added in Gap Analysis (01-02) or later. YAGNI for now.

### Computing baseline synchronously without a task (rejected)
- **Considered**: A simple `computeBaselineSync()` function that returns the report immediately.
- **Rejected**: The mission pack explicitly requires "Baseline computation runs as a Durable Task (uses G00 Task Runtime)". This enables crash recovery, idempotency, and future long-running computations. The task overhead is small (~100ms) for the current data volume.

## Consequences

### Positive
- Deterministic, auditable baseline computation — every classification can be traced to specific evidence.
- "unknown" is a first-class result, not an error — Blueprint §2 satisfied.
- Counter-evidence is preserved, not hidden — Blueprint §2 satisfied.
- Reuses G00's Evidence Fabric (independence_group) + Task Runtime (fencing, idempotency, reclaim) — no new infrastructure.
- Tenant isolation inherited from G00's RLS policies.

### Negative
- The observability mode thresholds are heuristic (≥2 independent + ≥1 verified = FULL). They're documented and auditable, but a reviewer might disagree with the thresholds themselves. Mitigated by: the thresholds are public in this ADR, and the baseline report includes the raw counts so a reviewer can re-classify if needed.
- Sectors without `metadata.sector` on evidence are invisible to the baseline. This is documented in the report's `sourceNote` and is acceptable for 01-01 (the seed tags all evidence with sectors).

### Future impact
- 01-02 (Gap Analysis) will compare the baseline against objectives to identify gaps.
- 01-03 (Strategy Composer) will use the baseline + gaps to generate strategy alternatives.
- Historical baseline comparison (trend analysis) requires a `baseline_reports` table — deferred to a later mission.

## Verification (planned for 01-01)

1. Country with no evidence for a sector → LOW + "unknown" in gaps
2. Sector with 1 evidence → PARTIAL
3. Sector with ≥2 independent + ≥1 verified → FULL
4. Sector with 2 evidence from same independence_group → PARTIAL (not FULL)
5. Sector with contradictory evidence → both shown, no silent selection
6. Cross-tenant: Tenant B cannot read Tenant A's baseline task
7. Task crash mid-computation → lease expires → reclaim → no duplicate output
8. `baseline:compute` required (observer rejected)
9. `baseline:read` required for reading (unauthenticated rejected)
