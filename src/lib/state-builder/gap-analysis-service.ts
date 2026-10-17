// ============================================================
// gap-analysis-service.ts — Gap Analysis Engine
// ------------------------------------------------------------
// Mission 01-02: Gap Analysis Engine
//
// Compares the State Baseline (from 01-01) with human-defined
// Objectives (from 01-00) to identify:
//   - Measurable gaps (sufficient evidence + matching units)
//   - Partial gaps (some evidence, but uncertain)
//   - Unknown gaps (LOW baseline or unparsed indicators)
//   - Evidence-supported blockers
//
// Scientific principles (Blueprint §2, per mission pack):
//   1. LOW baseline or unparsed indicator → don't fabricate gap value
//   2. Don't extract trajectory from a single measurement
//   3. Don't mix percentages/amounts/units into one number
//   4. No fake precision — use ranges or "unknown"
//   5. Preserve counter-evidence + dates + source independence
//   6. Don't present correlation as causation
//   7. Don't treat data absence as evidence of state failure
//   8. Blockers must link to evidence or be labeled as assumptions
//
// Runs as a Durable Task (G00 Task Runtime + claimTaskById):
//   - Fingerprint idempotency (baseline + objectives + evidence state)
//   - claimTaskById respects lease contract
//   - Crash recovery via lease expiry + reclaimStaleTasks
//
// Per ADR-0015. Reuses G00 + 01-00 + 01-01 contracts.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  createTask,
  claimTaskById,
  startTask,
  completeTask,
  failTask,
} from "@/lib/task-service";
import { getLatestBaseline } from "@/lib/state-builder/baseline-service";
import type { BaselineReport, BaselineIndicator, ObservabilityMode } from "@/lib/state-builder/baseline-service";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { createHash } from "node:crypto";

// ============================================================
// TYPES — GapReport
// ============================================================

export type GapType = "measurable" | "partial" | "unknown";

export interface EvidenceRef {
  evidenceId: string;
  claim: string;
  sourceCode: string | null;
  verificationStatus: string;
  supportStance: "supports" | "contradicts" | "neutral" | "uncertain";
  independenceGroup: string | null;
}

export interface Blocker {
  description: string;
  evidenceId: string | null;
  isAssumption: boolean;
  notes: string;
}

export interface GapItem {
  objectiveId: string;
  objectiveTitle: string;
  sector: string;
  // Current state (from baseline)
  currentMode: ObservabilityMode | "none"; // "none" = no matching baseline sector
  currentValue: string | null;
  currentValueConfidence: "structured" | "extracted" | "unparsed" | null;
  currentEvidenceCount: number;
  // Target state (from objective)
  targetMetric: string;
  targetValue: string;
  horizon: number;
  // Gap assessment
  gapType: GapType;
  gapSize: string | null; // e.g., "2.3 percentage points" or null
  gapDirection: "above" | "below" | null; // current is above/below target
  unitMatch: boolean;
  // Evidence
  supportingEvidence: EvidenceRef[];
  counterEvidence: EvidenceRef[];
  blockers: Blocker[];
  // Honesty notes
  notes: string[];
}

export interface GapReport {
  countryId: string;
  computedAt: string;
  taskId: string;
  baselineTaskId: string | null;
  gaps: GapItem[];
  summary: {
    closableGaps: string[]; // objective IDs with measurable gaps
    structuralGaps: string[]; // objective IDs with partial gaps
    unknownGaps: string[]; // objective IDs with unknown gaps
  };
  honesty: {
    fictional: boolean;
    sourceNote: string;
    computedBy: "gap-engine-v1";
    rulesVersion: "adr-0015-v1";
  };
}

export interface ComputeGapsInput {
  countryId: string;
  objectiveIds: string[];
}

// ============================================================
// HELPERS — metric matching + unit detection
// ============================================================

function normalizeMetricName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, " ").trim();
}

function isPercentage(value: string): boolean {
  return /%\s*$/.test(value.trim());
}

function extractNumericValue(value: string): number | null {
  const match = value.match(/(\d+\.?\d*)/);
  if (match && match[1]) {
    const num = parseFloat(match[1]);
    return isNaN(num) ? null : num;
  }
  return null;
}

function isUnparsable(value: string): boolean {
  return value.startsWith("unparsed") || value.includes("qualitative");
}

// ============================================================
// GAP CLASSIFICATION
// ============================================================
// Principles:
//   - LOW baseline → unknown (Principle 1)
//   - Unparsed indicator → unknown (Principle 1)
//   - Unit mismatch → unknown (Principle 3)
//   - PARTIAL baseline → partial (even if gap is computable)
//   - FULL baseline + matching units → measurable
//   - Counter-evidence → partial + blocker (Principle 5)

interface GapClassification {
  gapType: GapType;
  gapSize: string | null;
  gapDirection: "above" | "below" | null;
  unitMatch: boolean;
  notes: string[];
}

function classifyGap(
  baselineMode: ObservabilityMode | "none",
  indicator: BaselineIndicator | null,
  targetValue: string
): GapClassification {
  const notes: string[] = [];

  // Principle 1: LOW baseline or no matching sector → unknown
  if (baselineMode === "none") {
    return {
      gapType: "unknown",
      gapSize: null,
      gapDirection: null,
      unitMatch: false,
      notes: ["No matching sector found in the baseline for this objective's target metric."],
    };
  }

  if (baselineMode === "LOW") {
    return {
      gapType: "unknown",
      gapSize: null,
      gapDirection: null,
      unitMatch: false,
      notes: ["Baseline observability is LOW for this sector — insufficient data to assess the gap. Result is 'unknown'."],
    };
  }

  // Principle 1: No matching indicator → unknown
  if (!indicator) {
    return {
      gapType: "unknown",
      gapSize: null,
      gapDirection: null,
      unitMatch: false,
      notes: ["No indicator in the baseline matches this objective's target metric. Result is 'unknown'."],
    };
  }

  // Principle 1: Unparsed indicator value → unknown
  if (indicator.valueConfidence === "unparsed" || isUnparsable(indicator.value)) {
    return {
      gapType: "unknown",
      gapSize: null,
      gapDirection: null,
      unitMatch: false,
      notes: ["The baseline indicator value could not be reliably extracted from the evidence. Result is 'unknown' — no fabricated gap value."],
    };
  }

  // Principle 3: Unit matching — both must be percentages or both plain numbers
  const currentIsPercent = isPercentage(indicator.value);
  const targetIsPercent = isPercentage(targetValue);

  if (currentIsPercent !== targetIsPercent) {
    return {
      gapType: "unknown",
      gapSize: null,
      gapDirection: null,
      unitMatch: false,
      notes: [
        `Unit mismatch: current value "${indicator.value}" and target value "${targetValue}" use different units. Cannot compute a meaningful gap. Result is 'unknown'.`,
      ],
    };
  }

  // Both are percentages or both are plain numbers → compute gap
  const currentNum = extractNumericValue(indicator.value);
  const targetNum = extractNumericValue(targetValue);

  if (currentNum === null || targetNum === null) {
    return {
      gapType: "unknown",
      gapSize: null,
      gapDirection: null,
      unitMatch: true,
      notes: ["Could not parse numeric values from the current and target values. Result is 'unknown'."],
    };
  }

  const difference = currentNum - targetNum;
  const absDifference = Math.abs(difference);
  const direction = difference > 0 ? "above" : difference < 0 ? "below" : "above"; // 0 = at target
  const unitLabel = currentIsPercent ? "percentage points" : "units (verify compatibility)";

  const gapSize = `${absDifference.toFixed(1)} ${unitLabel}`;
  const gapDirection: "above" | "below" = direction;

  // Principle 4: No fake precision — we use 1 decimal place, not more
  notes.push(`Gap computed: current ${indicator.value} is ${absDifference.toFixed(1)} ${unitLabel} ${direction} target ${targetValue}.`);

  // Principle 2: Don't extract trajectory from a single measurement
  notes.push("This gap is a point-in-time comparison. No trajectory or trend is inferred from a single baseline measurement.");

  // If baseline is PARTIAL → gap is partial (uncertain)
  if (baselineMode === "PARTIAL") {
    return {
      gapType: "partial",
      gapSize,
      gapDirection,
      unitMatch: true,
      notes: [...notes, "Baseline observability is PARTIAL — the gap value is computed but carries uncertainty due to insufficient evidence quality or coverage."],
    };
  }

  // FULL baseline → measurable
  return {
    gapType: "measurable",
    gapSize,
    gapDirection,
    unitMatch: true,
    notes,
  };
}

// ============================================================
// FIND MATCHING INDICATOR
// ============================================================
// Match objective.targetMetric to baseline indicator name (both normalized)

function findMatchingIndicator(
  indicators: BaselineIndicator[],
  targetMetric: string
): BaselineIndicator | null {
  const normalizedTarget = normalizeMetricName(targetMetric);

  // Find all matching indicators
  const matching = indicators.filter(
    (ind) => normalizeMetricName(ind.name) === normalizedTarget
  );

  if (matching.length === 0) return null;

  // Prefer structured > extracted > unparsed
  const priority = { structured: 0, extracted: 1, unparsed: 2 };
  matching.sort((a, b) => priority[a.valueConfidence] - priority[b.valueConfidence]);

  return matching[0]!;
}

// ============================================================
// GAP ANALYSIS COMPUTATION
// ============================================================

async function runGapAnalysis(
  tx: Prisma.TransactionClient,
  tenantId: string,
  countryId: string,
  objectiveIds: string[],
  baseline: BaselineReport
): Promise<Omit<GapReport, "taskId">> {
  // 1. Fetch the objectives (filtered by objectiveIds, tenant-scoped via RLS)
  const objectives = await tx.objective.findMany({
    where: {
      tenantId,
      id: { in: objectiveIds },
    },
  });

  // 2. For each objective, compute the gap
  const gaps: GapItem[] = [];

  for (const obj of objectives) {
    const metadata = (obj.metadata ?? {}) as unknown as Record<string, unknown>;
    const sector = typeof metadata.sector === "string" ? metadata.sector : "unknown";

    // Find the matching baseline dimension
    const baselineDim = baseline.dimensions.find((d) => d.sector === sector);
    const baselineMode: ObservabilityMode | "none" = baselineDim?.observabilityMode ?? "none";

    // Find the matching indicator within the dimension
    const indicator = baselineDim
      ? findMatchingIndicator(baselineDim.indicators, obj.targetMetric)
      : null;

    // Classify the gap
    const classification = classifyGap(baselineMode, indicator, obj.targetValue);

    // Gather evidence (supporting + counter) from the baseline dimension
    const supportingEvidence: EvidenceRef[] = [];
    const counterEvidence: EvidenceRef[] = [];

    if (baselineDim) {
      for (const ind of baselineDim.indicators) {
        const ref: EvidenceRef = {
          evidenceId: ind.evidenceId,
          claim: ind.claim,
          sourceCode: ind.sourceCode,
          verificationStatus: ind.verificationStatus,
          supportStance: ind.supportStance,
          independenceGroup: ind.independenceGroup,
        };
        if (ind.supportStance === "contradicts") {
          counterEvidence.push(ref);
        } else if (ind.supportStance === "supports") {
          supportingEvidence.push(ref);
        }
      }
    }

    // Principle 8: Blockers must link to evidence or be labeled as assumptions
    const blockers: Blocker[] = [];

    // Counter-evidence → evidence-backed blocker
    for (const counter of counterEvidence) {
      blockers.push({
        description: `Counter-evidence present: "${counter.claim.slice(0, 120)}${counter.claim.length > 120 ? "…" : ""}"`,
        evidenceId: counter.evidenceId,
        isAssumption: false,
        notes: `Verification status: ${counter.verificationStatus}. This evidence contradicts the supporting narrative and may impede progress toward the objective.`,
      });
    }

    // LOW baseline → factual blocker (not an assumption — it's a documented data gap)
    if (baselineMode === "LOW") {
      blockers.push({
        description: "Insufficient data to assess the current state of this sector.",
        evidenceId: null,
        isAssumption: false,
        notes: "Baseline observability is LOW. This is a documented data gap, not an assumption. Cannot determine the gap without evidence.",
      });
    }

    // PARTIAL baseline → factual blocker
    if (baselineMode === "PARTIAL") {
      blockers.push({
        description: "Partial data coverage — the gap estimate carries uncertainty.",
        evidenceId: null,
        isAssumption: false,
        notes: "Baseline observability is PARTIAL. The gap value is computed but should be treated as uncertain pending additional evidence.",
      });
    }

    // No matching indicator → factual blocker
    if (baselineMode !== "none" && baselineMode !== "LOW" && !indicator) {
      blockers.push({
        description: `No indicator in the baseline matches the objective's target metric "${obj.targetMetric}".`,
        evidenceId: null,
        isAssumption: false,
        notes: "The objective's target metric is not measured by any evidence in this sector. Consider adding evidence or adjusting the target metric.",
      });
    }

    // Principle 6: Don't present correlation as causation
    if (counterEvidence.length > 0) {
      classification.notes.push(
        "Counter-evidence is shown for transparency. No causal relationship is asserted between the counter-evidence and the objective's feasibility."
      );
    }

    // Principle 7: Don't treat data absence as evidence of state failure
    if (baselineMode === "LOW" || baselineMode === "none") {
      classification.notes.push(
        "Data absence is not evidence of failure. The 'unknown' result reflects insufficient measurement, not a negative assessment."
      );
    }

    gaps.push({
      objectiveId: obj.id,
      objectiveTitle: obj.title,
      sector,
      currentMode: baselineMode,
      currentValue: indicator?.value ?? null,
      currentValueConfidence: indicator?.valueConfidence ?? null,
      currentEvidenceCount: baselineDim?.evidenceCount ?? 0,
      targetMetric: obj.targetMetric,
      targetValue: obj.targetValue,
      horizon: obj.horizon,
      gapType: classification.gapType,
      gapSize: classification.gapSize,
      gapDirection: classification.gapDirection,
      unitMatch: classification.unitMatch,
      supportingEvidence,
      counterEvidence,
      blockers,
      notes: classification.notes,
    });
  }

  // 3. Sort gaps by objective title for deterministic output
  gaps.sort((a, b) => a.objectiveTitle.localeCompare(b.objectiveTitle));

  // 4. Build summary
  const summary = {
    closableGaps: gaps.filter((g) => g.gapType === "measurable").map((g) => g.objectiveId),
    structuralGaps: gaps.filter((g) => g.gapType === "partial").map((g) => g.objectiveId),
    unknownGaps: gaps.filter((g) => g.gapType === "unknown").map((g) => g.objectiveId),
  };

  // 5. Honesty block
  const isFictional = baseline.honesty.fictional;
  const sourceNote = isFictional
    ? "Fictional fixture country (Demolandia). Gap analysis is based on a fictional baseline with synthetic evidence. No real-world policy implications."
    : "Gap analysis compares the State Baseline with human-defined Objectives. Gaps are computed conservatively — 'unknown' is a valid result.";

  return {
    countryId,
    computedAt: new Date().toISOString(),
    baselineTaskId: baseline.taskId,
    gaps,
    summary,
    honesty: {
      fictional: isFictional,
      sourceNote,
      computedBy: "gap-engine-v1",
      rulesVersion: "adr-0015-v1",
    },
  };
}

// ============================================================
// FINGERPRINT — covers ALL inputs that affect the gap report
// ============================================================
// The gap fingerprint includes:
//   - The baseline fingerprint (covers evidence + config)
//   - The objectives state (id, title, targetMetric, targetValue, horizon, status, updatedAt)
//   - Request inputs (countryId, objectiveIds)
//
// If ANY of these change → fingerprint changes → new task → fresh report.

async function computeGapFingerprint(
  session: Session,
  input: ComputeGapsInput,
  baseline: BaselineReport
): Promise<string> {
  const objectivesData = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const objectives = await tx.objective.findMany({
      where: { tenantId, id: { in: input.objectiveIds } },
      orderBy: { id: "asc" },
    });
    return objectives.map((o) => ({
      id: o.id,
      title: o.title,
      targetMetric: o.targetMetric,
      targetValue: o.targetValue,
      horizon: o.horizon,
      status: o.status,
      updatedAt: o.updatedAt.toISOString(),
    }));
  });

  const fingerprintInput = {
    countryId: input.countryId,
    objectiveIds: [...input.objectiveIds].sort(),
    baselineTaskId: baseline.taskId,
    baselineComputedAt: baseline.computedAt,
    objectives: objectivesData,
  };

  const canonicalJson = JSON.stringify(sortKeysDeep(fingerprintInput));
  return createHash("sha256").update(canonicalJson).digest("hex").slice(0, 32);
}

function sortKeysDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const sorted = value.map(sortKeysDeep);
    sorted.sort((a, b) => {
      const aJson = JSON.stringify(a);
      const bJson = JSON.stringify(b);
      return aJson < bJson ? -1 : aJson > bJson ? 1 : 0;
    });
    return sorted as unknown as T;
  }
  if (typeof value === "object") {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sortedObj[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sortedObj as unknown as T;
  }
  return value;
}

// ============================================================
// COMPUTE GAPS (public API — runs as Durable Task)
// ============================================================

export async function computeGaps(
  session: Session,
  input: ComputeGapsInput
): Promise<{ taskId: string; report: GapReport }> {
  // Permission check — reuse baseline:compute (gap analysis depends on baseline)
  await requirePermissionWithCurrentRole(session, "baseline:compute");

  if (!input.countryId || input.countryId.length === 0) {
    throw new Error("countryId is required");
  }
  if (!input.objectiveIds || input.objectiveIds.length === 0) {
    throw new Error("objectiveIds is required (at least one objective)");
  }

  // 1. Get the latest baseline for this country (must exist)
  const baselineResult = await getLatestBaseline(session, input.countryId);
  if (!baselineResult) {
    throw new Error(
      `No baseline found for country ${input.countryId}. Compute a baseline first using computeBaseline().`
    );
  }
  const baseline = baselineResult.report;

  // 2. Compute the gap fingerprint
  const fingerprint = await computeGapFingerprint(session, input, baseline);

  // 3. Create the Durable Task (idempotent — keyed by fingerprint)
  const idempotencyKey = `gap:${input.countryId}:fp-${fingerprint}`;
  const { taskId, created } = await createTask(session, {
    type: "gap-analysis",
    goal: `Compute Gap Analysis for country ${input.countryId} (${input.objectiveIds.length} objectives, fingerprint: ${fingerprint.slice(0, 12)})`,
    input: {
      countryId: input.countryId,
      objectiveIds: input.objectiveIds,
      fingerprint,
      baselineTaskId: baseline.taskId,
    } as unknown as Record<string, unknown>,
    idempotencyKey,
  });

  // If the task already existed (same fingerprint), return its output if completed
  if (!created) {
    const existingReport = await getGapTaskOutput(session, taskId);
    if (existingReport) {
      return { taskId, report: existingReport };
    }
  }

  // 4. Claim the task by ID (respects lease contract)
  const workerId = "gap-worker";
  const leaseDurationMs = 60_000;

  const claimed = await claimTaskById(session, taskId, workerId, leaseDurationMs);
  if (!claimed) {
    const existingReport = await getGapTaskOutput(session, taskId);
    if (existingReport) {
      return { taskId, report: existingReport };
    }
    throw new Error(
      `Gap analysis task ${taskId} could not be claimed (may be held by another worker with a valid lease). Poll getGapTask() for status.`
    );
  }

  // 5. Start the task
  await startTask(session, taskId, workerId, claimed.claimGeneration);

  // 6. Run the computation
  try {
    const report = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
      const computed = await runGapAnalysis(
        tx,
        tenantId,
        input.countryId,
        input.objectiveIds,
        baseline
      );
      return { ...computed, taskId } as GapReport;
    });

    // 7. Complete the task
    await completeTask(
      session,
      taskId,
      report as unknown as Record<string, unknown>,
      workerId,
      claimed.claimGeneration
    );

    return { taskId, report };
  } catch (err) {
    await failTask(
      session,
      taskId,
      err instanceof Error ? err.message : String(err),
      workerId,
      claimed.claimGeneration
    );
    throw err;
  }
}

// ============================================================
// GET GAP TASK (poll status + output)
// ============================================================

export async function getGapTask(
  session: Session,
  taskId: string
): Promise<{
  taskId: string;
  status: string;
  progress: number;
  error: string | null;
  report: GapReport | null;
}> {
  await requirePermissionWithCurrentRole(session, "gap:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const task = await tx.task.findFirst({
      where: { id: taskId, tenantId },
    });
    if (!task) {
      throw new Error("Gap analysis task not found in tenant scope");
    }

    let report: GapReport | null = null;
    if (task.status === "completed" && task.output) {
      report = task.output as unknown as GapReport;
    }

    return {
      taskId: task.id,
      status: task.status,
      progress: task.progress,
      error: task.error,
      report,
    };
  });
}

// ============================================================
// GET GAP TASK OUTPUT (helper)
// ============================================================

async function getGapTaskOutput(
  session: Session,
  taskId: string
): Promise<GapReport | null> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const task = await tx.task.findFirst({
      where: { id: taskId, tenantId },
    });
    if (!task || task.status !== "completed" || !task.output) {
      return null;
    }
    return task.output as unknown as GapReport;
  });
}

// ============================================================
// GET LATEST GAP REPORT FOR A COUNTRY (convenience)
// ============================================================

export async function getLatestGapReport(
  session: Session,
  countryId: string
): Promise<{ taskId: string; report: GapReport } | null> {
  await requirePermissionWithCurrentRole(session, "gap:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const task = await tx.task.findFirst({
      where: {
        tenantId,
        type: "gap-analysis",
        status: "completed",
        input: { path: ["countryId"], equals: countryId } as never,
      },
      orderBy: { completedAt: "desc" },
    });

    if (!task || !task.output) {
      return null;
    }

    return {
      taskId: task.id,
      report: task.output as unknown as GapReport,
    };
  });
}
