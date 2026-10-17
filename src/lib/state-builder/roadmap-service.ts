// ============================================================
// roadmap-service.ts — Implementation Roadmap & Timeline
// ------------------------------------------------------------
// Mission 01-07: Generate a phased implementation timeline with
// milestones, sequencing programs according to the dependency
// graph from 01-05, respecting budget realities from 01-06.
//
// buildRoadmap(session, { strategyAlternativeId }) → ImplementationRoadmap
//
// ImplementationRoadmap = {
//   strategyAlternativeId,
//   phases: RoadmapPhase[],
//   conflicts: ConflictEntry[],      // separated from sequencing (mission pack §2)
//   totalHorizon: number | null,     // from objective horizon; null if unavailable
//   horizonSource: "objective-horizon" | "unavailable",
//   sequencingRationale: string,
//   schedulingDisclaimer: string,    // explicit: no fabricated durations
//   budgetReadiness: BudgetReadinessSummary,
//   simulated: true,
//   modelVersion: "v1-deterministic",
// }
//
// RoadmapPhase = {
//   name: string,                    // "Phase 1", "Phase 2", ...
//   phaseIndex: number,              // 0-based
//   startYear: number | null,        // null when no scheduling data
//   endYear: number | null,          // null when no scheduling data
//   programIds: string[],
//   programs: Array<{ programId, title, sector }>,
//   milestones: Milestone[],
//   assumptions: string[],
//   schedulingGap: boolean,          // true if this phase has no calendar dates
// }
//
// Milestone = {
//   programId,
//   programTitle,
//   kpiName: string | null,          // null when program has no KPI (monitoring gap)
//   kpiTarget: string | null,
//   kpiSourceKind: string | null,
//   kpiFrequency: string | null,
//   description: string,
//   isMonitoringGap: boolean,        // true when no KPI available
//   simulated: true,
// }
//
// ConflictEntry = {
//   fromProgramId, toProgramId, fromProgramTitle, toProgramTitle,
//   rationale, source, simulated,
// }
//
// BudgetReadinessSummary = {
//   programsWithEstimate: number,
//   programsWithoutEstimate: number,
//   programsWithFinancingSources: number,
//   programsWithoutFinancingSources: number,
//   insufficientDataProgramIds: string[],
//   note: string,
// }
//
// ============================================================
// CORE PRINCIPLE — SCIENTIFIC TIMELINE INTEGRITY (mission pack §3)
// ============================================================
// Program ordering does NOT prove execution duration.
//
// If no actual documented durations are available, the roadmap shows
// relative phase ordering (Phase 1, Phase 2, ...) with startYear=null,
// endYear=null, and an explicit schedulingGap flag. We do NOT fabricate
// calendar years to fill the fields.
//
// When scheduling assumptions ARE provided (via program.metadata.scheduling
// with explicit startYear/endYear per program), the roadmap uses them — but
// labels the result as simulated and documents the assumptions.
//
// The structural critical path from 01-05 is NOT used as a temporal critical
// path. It is a dependency chain, not a duration chain.
//
// ============================================================
// SEQUENCING ALGORITHM
// ============================================================
// Topological sort by "level" (longest-path layering):
//   - Level 0 = programs with no requires/enables prerequisites
//   - Level N = programs whose prerequisites are all in levels < N
//   - Each phase = one level
//   - Within a phase, programs are sorted by programId for determinism
//
// This is deterministic: the same inputs always produce the same phase
// structure. Re-running buildRoadmap on the same strategy version returns
// the same roadmap.
//
// conflicts edges are NOT used for sequencing. They are surfaced separately
// in the `conflicts` array as risks requiring human decisions.
//
// ============================================================
// PERMISSIONS
// ============================================================
// buildRoadmap: roadmap:read (admin, analyst, reviewer — NOT observer)
//
// Per ADR-0013. Reuses G00 + 01-00 + 01-03 + 01-04 + 01-05 + 01-06 contracts.
// No new migration, no new table — roadmap is computed on demand.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES — Implementation Roadmap
// ============================================================

export const ROADMAP_MODEL_VERSION = "v1-deterministic" as const;

export interface Milestone {
  programId: string;
  programTitle: string;
  kpiName: string | null;
  kpiTarget: string | null;
  kpiSourceKind: string | null;
  kpiFrequency: string | null;
  description: string;
  isMonitoringGap: boolean;
  simulated: true;
}

export interface PhaseProgram {
  programId: string;
  title: string;
  sector: string;
}

export interface RoadmapPhase {
  name: string;              // "Phase 1", "Phase 2", ...
  phaseIndex: number;        // 0-based
  startYear: number | null;  // null when no scheduling data
  endYear: number | null;    // null when no scheduling data
  programIds: string[];
  programs: PhaseProgram[];
  milestones: Milestone[];
  assumptions: string[];
  schedulingGap: boolean;    // true if this phase has no calendar dates
}

export interface ConflictEntry {
  fromProgramId: string;
  toProgramId: string;
  fromProgramTitle: string;
  toProgramTitle: string;
  rationale: string | null;
  source: string;
  simulated: boolean;
}

export interface BudgetReadinessSummary {
  programsWithEstimate: number;
  programsWithoutEstimate: number;
  programsWithFinancingSources: number;
  programsWithoutFinancingSources: number;
  insufficientDataProgramIds: string[];
  note: string;
}

export interface ImplementationRoadmap {
  strategyAlternativeId: string;
  phases: RoadmapPhase[];
  conflicts: ConflictEntry[];
  totalHorizon: number | null;     // from objective horizon; null if unavailable
  horizonSource: "objective-horizon" | "unavailable";
  sequencingRationale: string;
  schedulingDisclaimer: string;
  budgetReadiness: BudgetReadinessSummary;
  // 01-07-FIX: temporal validation summary. Always present when the roadmap
  // is returned (violations array is empty — if non-empty, buildRoadmap throws).
  temporalValidation: TemporalValidationSummary;
  simulated: true;
  modelVersion: string;
}

// ============================================================
// ERRORS
// ============================================================

export class RoadmapValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapValidationError";
  }
}

export class RoadmapIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapIntegrityError";
  }
}

// ============================================================
// TYPES — internal (dependency edges for sequencing)
// ============================================================

interface OrderingEdge {
  from: string;  // prerequisite
  to: string;    // dependent
}

interface ProgramSchedulingInput {
  startYear?: number;
  endYear?: number;
  durationYears?: number;
}

// ============================================================
// HELPERS — topological layering (longest-path level assignment)
// ------------------------------------------------------------
// Assigns each program a "level" = longest path from any root.
// Level 0 = no prerequisites. Level N = max(level of prerequisites) + 1.
// Programs in the same level can run in parallel (no ordering constraint
// between them). Each level becomes one phase.
//
// This is deterministic: programs with the same level are sorted by
// programId within the phase.
// ============================================================

function computeTopologicalLevels(
  programIds: Set<string>,
  edges: OrderingEdge[]
): Map<string, number> {
  // Build adjacency: for each node, its list of prerequisites (incoming edges)
  const prerequisites = new Map<string, Set<string>>();
  for (const pid of programIds) prerequisites.set(pid, new Set());
  for (const e of edges) {
    if (!prerequisites.has(e.to)) prerequisites.set(e.to, new Set());
    prerequisites.get(e.to)!.add(e.from);
  }

  // Longest-path level assignment via memoized DFS
  const levelCache = new Map<string, number>();
  function levelOf(pid: string): number {
    if (levelCache.has(pid)) return levelCache.get(pid)!;
    const prereqs = prerequisites.get(pid) ?? new Set<string>();
    if (prereqs.size === 0) {
      levelCache.set(pid, 0);
      return 0;
    }
    let maxPrereqLevel = -1;
    for (const prereq of prereqs) {
      maxPrereqLevel = Math.max(maxPrereqLevel, levelOf(prereq));
    }
    const myLevel = maxPrereqLevel + 1;
    levelCache.set(pid, myLevel);
    return myLevel;
  }

  for (const pid of programIds) levelOf(pid);
  return levelCache;
}

/**
 * Detect cycles in the ordering edges. If a cycle exists, the topological
 * layering would recurse infinitely — we catch it here and throw.
 * Uses the same DFS-with-color approach as portfolio-service.detectCycles.
 */
function detectCycles(
  programIds: Set<string>,
  edges: OrderingEdge[]
): string[][] {
  const adj = new Map<string, string[]>();
  for (const pid of programIds) adj.set(pid, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const pid of programIds) color.set(pid, WHITE);
  const cycles: string[][] = [];

  function dfs(start: string): void {
    const stack: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];
    const localColor = new Map<string, number>();
    for (const pid of programIds) localColor.set(pid, WHITE);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (localColor.get(top.node) === WHITE) {
        localColor.set(top.node, GRAY);
      }
      const neighbors = adj.get(top.node) ?? [];
      let advanced = false;
      for (const n of neighbors) {
        const nc = localColor.get(n) ?? WHITE;
        if (nc === GRAY) {
          const path = top.path;
          const cycleStart = path.indexOf(n);
          const cycle = path.slice(cycleStart).concat([n]);
          cycles.push(cycle);
          continue;
        }
        if (nc === WHITE) {
          stack.push({ node: n, path: [...top.path, n] });
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        localColor.set(top.node, BLACK);
        stack.pop();
      }
    }
  }

  for (const pid of programIds) {
    if (color.get(pid) === WHITE) {
      dfs(pid);
      color.set(pid, BLACK);
    }
  }
  return cycles;
}

// ============================================================
// TEMPORAL DEPENDENCY INTEGRITY (01-07-FIX)
// ------------------------------------------------------------
// Validate that explicit scheduling data (program.metadata.scheduling)
// respects the dependency ordering. The structural topological sort
// produces correct phase ordering, but when an analyst supplies explicit
// startYear/endYear per program, those dates MUST be consistent with the
// dependency graph — otherwise the roadmap would show dates that contradict
// the ordering, giving decision-makers a false sense of a valid timeline.
//
// Validation rules (per mission pack 01-07-FIX):
//   1. Per-program: if both startYear + endYear are present,
//      startYear <= endYear. (A program can't end before it starts.)
//      startYear + endYear must be finite integers.
//   2. Per ordering edge (requires/enables) where BOTH endpoints have
//      FULL scheduling (startYear + endYear):
//      prereq.endYear < dependent.startYear (STRICT less-than).
//      The prerequisite's outputs must be COMPLETE before the dependent
//      starts. No overlap allowed under the current v1 contract (no
//      partial-dependency or overlap model yet).
//   3. If only ONE side of an edge has scheduling data → NOT a violation.
//      That edge has a "scheduling gap" — the temporal ordering cannot be
//      verified for it. The roadmap still builds; the gap is noted.
//   4. If NEITHER side has scheduling data → NOT a violation. The roadmap
//      builds with schedulingGap=true (structural ordering only).
//
// If ANY violation is found → throw RoadmapValidationError with all
// violations listed. We do NOT return a roadmap with contradictory dates.
// ============================================================

export interface TemporalViolation {
  type: "invalid-program-range" | "dependency-temporal-violation";
  programId?: string;
  programTitle?: string;
  fromProgramId?: string;   // for dependency-temporal-violation (prerequisite)
  toProgramId?: string;     // for dependency-temporal-violation (dependent)
  fromProgramTitle?: string;
  toProgramTitle?: string;
  message: string;
}

export interface TemporalValidationSummary {
  validated: boolean;          // true if validation ran (always true when scheduling data exists)
  checkedEdges: number;        // ordering edges where BOTH endpoints had full scheduling
  skippedEdges: number;        // ordering edges where at least one endpoint lacked scheduling (gap)
  violations: TemporalViolation[]; // empty if valid (if non-empty, buildRoadmap throws)
  note: string;
}

/**
 * Validate scheduling consistency.
 * Returns the list of violations (empty = valid).
 * Does NOT throw — the caller decides whether to throw based on the result.
 */
function validateSchedulingConsistency(
  programMap: Map<string, { id: string; title: string }>,
  orderingEdges: OrderingEdge[],
  schedulingInputs: Map<string, ProgramSchedulingInput>
): TemporalValidationSummary {
  const violations: TemporalViolation[] = [];
  let checkedEdges = 0;
  let skippedEdges = 0;

  // 1. Per-program validation: startYear <= endYear (if both present)
  for (const [pid, si] of schedulingInputs) {
    if (si.startYear !== undefined && si.endYear !== undefined) {
      if (!Number.isInteger(si.startYear) || !Number.isInteger(si.endYear)) {
        violations.push({
          type: "invalid-program-range",
          programId: pid,
          programTitle: programMap.get(pid)?.title,
          message:
            `Program "${programMap.get(pid)?.title ?? pid}" has non-integer scheduling ` +
            `values (startYear=${si.startYear}, endYear=${si.endYear}). ` +
            `Years must be integers.`,
        });
      } else if (si.startYear > si.endYear) {
        violations.push({
          type: "invalid-program-range",
          programId: pid,
          programTitle: programMap.get(pid)?.title,
          message:
            `Program "${programMap.get(pid)?.title ?? pid}" has startYear (${si.startYear}) ` +
            `> endYear (${si.endYear}). A program cannot end before it starts. ` +
            `Fix the scheduling data in program.metadata.scheduling.`,
        });
      }
    }
  }

  // 2. Per-edge validation: prereq.endYear < dependent.startYear (strict)
  for (const edge of orderingEdges) {
    const prereqSched = schedulingInputs.get(edge.from);
    const dependentSched = schedulingInputs.get(edge.to);

    // Both endpoints must have FULL scheduling (startYear + endYear) to check
    if (!prereqSched || !dependentSched ||
        prereqSched.startYear === undefined || prereqSched.endYear === undefined ||
        dependentSched.startYear === undefined || dependentSched.endYear === undefined) {
      skippedEdges++;
      continue;
    }

    checkedEdges++;

    // STRICT: prereq.endYear < dependent.startYear
    // The prerequisite's outputs must be COMPLETE before the dependent starts.
    // No overlap allowed under v1 (no partial-dependency model).
    if (prereqSched.endYear >= dependentSched.startYear) {
      const prereqTitle = programMap.get(edge.from)?.title ?? edge.from;
      const dependentTitle = programMap.get(edge.to)?.title ?? edge.to;
      violations.push({
        type: "dependency-temporal-violation",
        fromProgramId: edge.from,
        toProgramId: edge.to,
        fromProgramTitle: prereqTitle,
        toProgramTitle: dependentTitle,
        message:
          `Temporal dependency violation: program "${prereqTitle}" (prerequisite, ` +
          `ends ${prereqSched.endYear}) does NOT end before program "${dependentTitle}" ` +
          `(dependent, starts ${dependentSched.startYear}). ` +
          `The prerequisite's outputs must be complete before the dependent starts. ` +
          `Under the v1 contract, no overlap is allowed (no partial-dependency model). ` +
          `Either fix the scheduling so ${prereqTitle} ends before ${dependentTitle} starts, ` +
          `or remove the explicit scheduling data to fall back to structural ordering.`,
      });
    }
  }

  const note =
    violations.length > 0
      ? `${violations.length} temporal violation(s) detected. The roadmap cannot be built ` +
        `with contradictory scheduling data. Fix the violations and retry.`
      : checkedEdges > 0
        ? `Temporal validation passed: ${checkedEdges} ordering edge(s) checked, ` +
          `${skippedEdges} edge(s) skipped (scheduling gap on at least one endpoint). ` +
          `All checked edges respect prereq.endYear < dependent.startYear.`
        : `No ordering edges had full scheduling on both endpoints — temporal ` +
          `validation could not check any edge. ${skippedEdges} edge(s) have scheduling ` +
          `gaps. Structural ordering is still valid.`;

  return {
    validated: true,
    checkedEdges,
    skippedEdges,
    violations,
    note,
  };
}

// ============================================================
// BUILD ROADMAP (public API — read-only, idempotent)
// ============================================================

export async function buildRoadmap(
  session: Session,
  input: { strategyAlternativeId: string }
): Promise<ImplementationRoadmap> {
  // Read-only — admin, analyst, reviewer. NOT observer.
  await requirePermissionWithCurrentRole(session, "roadmap:read");

  if (!input.strategyAlternativeId) {
    throw new RoadmapValidationError("strategyAlternativeId is required");
  }

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // 1. Validate the strategy version belongs to this tenant
    const strategyVersion = await tx.strategyVersion.findFirst({
      where: { id: input.strategyAlternativeId, tenantId },
      select: { id: true, metadata: true },
    });
    if (!strategyVersion) {
      throw new RoadmapValidationError(
        `Strategy version ${input.strategyAlternativeId} not found in tenant scope. ` +
        `Cannot build a roadmap for a strategy that doesn't belong to this tenant.`
      );
    }

    // 2. Extract the objective horizon from metadata.inputSnapshot.objectiveIds
    //    + fetch the objectives to get their horizon values.
    const svMeta = (strategyVersion.metadata ?? {}) as Record<string, unknown>;
    const inputSnapshot = (svMeta.inputSnapshot ?? {}) as Record<string, unknown>;
    const objectiveIdsRaw = inputSnapshot.objectiveIds;
    const objectiveIds: string[] = Array.isArray(objectiveIdsRaw)
      ? objectiveIdsRaw.filter((id): id is string => typeof id === "string")
      : [];

    let totalHorizon: number | null = null;
    let horizonSource: "objective-horizon" | "unavailable" = "unavailable";
    if (objectiveIds.length > 0) {
      const objectives = await tx.objective.findMany({
        where: { tenantId, id: { in: objectiveIds } },
        select: { horizon: true },
      });
      if (objectives.length > 0) {
        // Use the max horizon across objectives as the planning horizon.
        // Different objectives may have different horizons; the roadmap
        // covers the longest one.
        totalHorizon = objectives.reduce((max, o) => Math.max(max, o.horizon), 0);
        horizonSource = "objective-horizon";
      }
    }

    // 3. Fetch all programs in this strategy version
    const programs = await tx.program.findMany({
      where: { tenantId, strategyVersionId: input.strategyAlternativeId },
      orderBy: { title: "asc" },
    });

    const programIds = new Set(programs.map((p) => p.id));
    const programMap = new Map(programs.map((p) => [p.id, p]));

    // 4. Fetch ordering edges (requires + enables only — conflicts are separate)
    const allDeps = programIds.size === 0
      ? []
      : await tx.dependency.findMany({
          where: {
            tenantId,
            OR: [
              { fromProgramId: { in: [...programIds] } },
              { toProgramId: { in: [...programIds] } },
            ],
          },
        });

    // Filter to both-endpoints-in-this-alternative
    const inScopeDeps = allDeps.filter(
      (d) => programIds.has(d.fromProgramId) && programIds.has(d.toProgramId)
    );

    const orderingEdges: OrderingEdge[] = inScopeDeps
      .filter((d) => d.type === "requires" || d.type === "enables")
      .map((d) => ({ from: d.fromProgramId, to: d.toProgramId }));

    const conflictDeps = inScopeDeps.filter((d) => d.type === "conflicts");

    // 5. Defensive cycle detection — should be impossible (portfolio-service
    //    rejects cycles at insertion), but we verify to avoid infinite recursion
    //    in computeTopologicalLevels.
    const cycles = detectCycles(programIds, orderingEdges);
    if (cycles.length > 0) {
      throw new RoadmapIntegrityError(
        `Roadmap integrity violation: ${cycles.length} cycle(s) detected in ` +
        `strategy version ${input.strategyAlternativeId}. Cycles are rejected at ` +
        `dependency insertion — this indicates DB-level corruption or a bug. ` +
        `First cycle: ${cycles[0]!.join(" → ")}.`
      );
    }

    // 6. Compute topological levels → phases
    const levels = computeTopologicalLevels(programIds, orderingEdges);
    const maxLevel = programIds.size === 0 ? -1 : Math.max(...levels.values());

    // 7. Group programs by level → phases
    const phaseGroups: string[][] = [];
    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const programIdsAtLevel = [...programIds]
        .filter((pid) => levels.get(pid) === lvl)
        .sort(); // deterministic order within phase
      phaseGroups.push(programIdsAtLevel);
    }

    // 8. Fetch budget estimates for budget readiness (from 01-06)
    //    We read existing BudgetLine rows (if estimateBudgets was called)
    //    rather than calling estimateBudgets (which is a write operation).
    //    This keeps buildRoadmap read-only.
    const budgetLines = programIds.size === 0
      ? []
      : await tx.budgetLine.findMany({
          where: {
            tenantId,
            programId: { in: [...programIds] },
            modelVersion: "v1-deterministic",
          },
        });
    const budgetLineProgramIds = new Set(budgetLines.map((b) => b.programId));

    // 9. Parse scheduling inputs from program.metadata.scheduling (optional)
    //    Format: { startYear, endYear, durationYears } per program.
    //    If absent for ALL programs → all phases get schedulingGap=true.
    const schedulingInputs = new Map<string, ProgramSchedulingInput>();
    for (const program of programs) {
      const meta = (program.metadata ?? {}) as Record<string, unknown>;
      const sched = meta.scheduling as Record<string, unknown> | undefined;
      if (sched && typeof sched === "object") {
        const input: ProgramSchedulingInput = {};
        if (typeof sched.startYear === "number" && Number.isFinite(sched.startYear)) {
          input.startYear = sched.startYear;
        }
        if (typeof sched.endYear === "number" && Number.isFinite(sched.endYear)) {
          input.endYear = sched.endYear;
        }
        if (typeof sched.durationYears === "number" && Number.isFinite(sched.durationYears)) {
          input.durationYears = sched.durationYears;
        }
        if (Object.keys(input).length > 0) {
          schedulingInputs.set(program.id, input);
        }
      }
    }
    const hasAnySchedulingData = schedulingInputs.size > 0;

    // 9b. TEMPORAL DEPENDENCY INTEGRITY (01-07-FIX)
    //    Validate that explicit scheduling data respects the dependency ordering.
    //    If any program has startYear > endYear, or any ordering edge has
    //    prereq.endYear >= dependent.startYear (overlap/reversal), throw.
    //    The structural roadmap is still valid, but we refuse to present
    //    contradictory dates as a valid timeline.
    const programMapForValidation = new Map<string, { id: string; title: string }>();
    for (const [pid, p] of programMap) {
      programMapForValidation.set(pid, { id: p.id, title: p.title });
    }
    const temporalValidation = validateSchedulingConsistency(
      programMapForValidation,
      orderingEdges,
      schedulingInputs
    );
    if (temporalValidation.violations.length > 0) {
      const violationMessages = temporalValidation.violations
        .map((v, i) => `  ${i + 1}. [${v.type}] ${v.message}`)
        .join("\n");
      throw new RoadmapValidationError(
        `Temporal dependency validation failed for strategy version ` +
        `${input.strategyAlternativeId}. ${temporalValidation.violations.length} ` +
        `violation(s) detected:\n${violationMessages}\n\n` +
        `The roadmap cannot be built with scheduling data that contradicts the ` +
        `dependency ordering. Either fix the scheduling data in ` +
        `program.metadata.scheduling, or remove it to fall back to structural ` +
        `ordering (schedulingGap=true, no calendar dates).`
      );
    }

    // 10. Build phases
    const phases: RoadmapPhase[] = phaseGroups.map((programIdsAtLevel, index) => {
      const phasePrograms: PhaseProgram[] = programIdsAtLevel.map((pid) => {
        const p = programMap.get(pid)!;
        return { programId: pid, title: p.title, sector: p.sector };
      });

      // Milestones: one per KPI per program; "monitoring gap" if no KPIs
      const milestones: Milestone[] = [];
      for (const pid of programIdsAtLevel) {
        const p = programMap.get(pid)!;
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        const kpis = (meta.kpis as Array<{
          name: string; target: string; frequency: string;
          sourceKind: string; notes?: string;
        }> | undefined) ?? [];

        if (kpis.length === 0) {
          // No KPIs → monitoring gap milestone
          milestones.push({
            programId: pid,
            programTitle: p.title,
            kpiName: null,
            kpiTarget: null,
            kpiSourceKind: null,
            kpiFrequency: null,
            description:
              `Monitoring gap: program "${p.title}" has no KPIs defined. ` +
              `Execution progress cannot be measured against a target without KPIs. ` +
              `Define KPIs (with sourceKind + target) before this program's progress ` +
              `can be tracked.`,
            isMonitoringGap: true,
            simulated: true,
          });
        } else {
          for (const kpi of kpis) {
            milestones.push({
              programId: pid,
              programTitle: p.title,
              kpiName: kpi.name,
              kpiTarget: kpi.target,
              kpiSourceKind: kpi.sourceKind,
              kpiFrequency: kpi.frequency,
              description:
                `Milestone for program "${p.title}": track KPI "${kpi.name}" ` +
                `toward target "${kpi.target}" (${kpi.frequency}). ` +
                `Source kind: ${kpi.sourceKind}.` +
                (kpi.sourceKind === "unspecified"
                  ? ` Note: sourceKind is "unspecified" — this KPI cannot be verified ` +
                    `until a reliable source is designated.`
                  : ""),
              isMonitoringGap: false,
              simulated: true,
            });
          }
        }
      }

      // Phase scheduling: if ALL programs in this phase have scheduling data,
      // compute phase startYear/endYear. Otherwise, schedulingGap=true.
      let phaseStartYear: number | null = null;
      let phaseEndYear: number | null = null;
      let schedulingGap = true;
      if (hasAnySchedulingData && programIdsAtLevel.every((pid) => schedulingInputs.has(pid))) {
        const starts: number[] = [];
        const ends: number[] = [];
        for (const pid of programIdsAtLevel) {
          const si = schedulingInputs.get(pid)!;
          if (si.startYear !== undefined) starts.push(si.startYear);
          if (si.endYear !== undefined) ends.push(si.endYear);
          // If only durationYears is provided, we can't compute calendar years
          // without a base year. Leave start/end null in that case.
        }
        if (starts.length === programIdsAtLevel.length && ends.length === programIdsAtLevel.length) {
          phaseStartYear = Math.min(...starts);
          phaseEndYear = Math.max(...ends);
          schedulingGap = false;
        }
      }

      // Phase assumptions
      const assumptions: string[] = [];
      assumptions.push(
        `Phase ${index + 1} contains ${programIdsAtLevel.length} program(s) with no ` +
        `ordering prerequisites among each other (they can be executed in parallel ` +
        `subject to resource availability, which is not modeled here).`
      );
      if (schedulingGap) {
        assumptions.push(
          `Scheduling gap: this phase has no calendar dates. Program durations are ` +
          `not documented — phase ordering is structural (topological), not temporal. ` +
          `Do not infer a start or end year from the phase index.`
        );
      } else {
        assumptions.push(
          `Phase scheduling derived from program.metadata.scheduling (explicit ` +
          `startYear/endYear per program). Phase start = min(program startYear); ` +
          `phase end = max(program endYear). This is a SIMULATED schedule based on ` +
          `analyst-supplied assumptions, not a verified timeline.`
        );
      }

      return {
        name: `Phase ${index + 1}`,
        phaseIndex: index,
        startYear: phaseStartYear,
        endYear: phaseEndYear,
        programIds: programIdsAtLevel,
        programs: phasePrograms,
        milestones,
        assumptions,
        schedulingGap,
      };
    });

    // 11. Build conflicts array (separated from sequencing)
    const conflicts: ConflictEntry[] = conflictDeps.map((d) => {
      const fromP = programMap.get(d.fromProgramId);
      const toP = programMap.get(d.toProgramId);
      const meta = (d.metadata ?? {}) as Record<string, unknown>;
      return {
        fromProgramId: d.fromProgramId,
        toProgramId: d.toProgramId,
        fromProgramTitle: fromP?.title ?? "",
        toProgramTitle: toP?.title ?? "",
        rationale: d.rationale,
        source: (meta.source as string) ?? "simulated",
        simulated: (meta.simulated as boolean) ?? true,
      };
    });

    // 12. Build budget readiness summary
    let programsWithFinancingSources = 0;
    for (const line of budgetLines) {
      const fs = (line.financingSources as unknown as unknown[]) ?? [];
      if (fs.length > 0) programsWithFinancingSources++;
    }
    const programsWithoutEstimate = [...programIds].filter((pid) => !budgetLineProgramIds.has(pid));
    const budgetReadiness: BudgetReadinessSummary = {
      programsWithEstimate: budgetLineProgramIds.size,
      programsWithoutEstimate: programsWithoutEstimate.length,
      programsWithFinancingSources,
      programsWithoutFinancingSources: budgetLineProgramIds.size - programsWithFinancingSources,
      insufficientDataProgramIds: programsWithoutEstimate,
      note:
        programsWithoutEstimate.length > 0
          ? `${programsWithoutEstimate.length} program(s) have no budget estimate ` +
            `(insufficient cost data per 01-06). Their execution readiness is ` +
            `conditional on documenting cost inputs. Do not assume these programs ` +
            `are funded or fundable without further analysis.`
          : `All programs have budget estimates. Note: estimates are SIMULATED ` +
            `(per 01-06) — having an estimate does NOT mean funding is available. ` +
            `Financing sources must be documented separately.`,
    };

    // 13. Build sequencing rationale
    const sequencingRationale =
      `Programs are sequenced by topological layering of the dependency graph ` +
      `(requires + enables edges only; conflicts are surfaced separately). ` +
      `Phase 1 contains programs with no prerequisites. Phase N contains programs ` +
      `whose prerequisites are all in phases < N. Within each phase, programs are ` +
      `sorted by programId for determinism. This sequencing respects the ` +
      `direction convention from 01-05: edge A → B means A is a prerequisite ` +
      `(A precedes B in execution order). ` +
      (conflicts.length > 0
        ? `${conflicts.length} conflict(s) detected — these are NOT sequencing ` +
          `constraints; they are risks requiring human decisions (resource ` +
          `competition, policy clashes). See the conflicts array.`
        : `No conflicts detected.`);

    const schedulingDisclaimer =
      `IMPORTANT: program ordering does NOT prove execution duration. ` +
      `Phases represent structural dependency ordering, not temporal duration. ` +
      (hasAnySchedulingData
        ? `Some programs carry explicit scheduling assumptions ` +
          `(program.metadata.scheduling) — these are SIMULATED, based on ` +
          `analyst-supplied startYear/endYear, not verified timelines. `
        : `No program carries scheduling data — all phases have schedulingGap=true ` +
          `and startYear/endYear are null. No calendar dates are fabricated. `) +
      `The structural critical path from 01-05 is a dependency chain, not a ` +
      `duration chain. A true temporal critical path requires documented program ` +
      `durations, which is beyond the scope of v1-deterministic.`;

    return {
      strategyAlternativeId: input.strategyAlternativeId,
      phases,
      conflicts,
      totalHorizon,
      horizonSource,
      sequencingRationale,
      schedulingDisclaimer,
      budgetReadiness,
      temporalValidation,
      simulated: true,
      modelVersion: ROADMAP_MODEL_VERSION,
    };
  });
}

// ============================================================
// GET ROADMAP (alias for buildRoadmap — read-only, no persistence)
// ============================================================

export async function getRoadmap(
  session: Session,
  strategyAlternativeId: string
): Promise<ImplementationRoadmap> {
  return buildRoadmap(session, { strategyAlternativeId });
}
