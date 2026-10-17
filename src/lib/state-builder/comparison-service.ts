// ============================================================
// comparison-service.ts — Scenario Comparison Engine
// ------------------------------------------------------------
// Mission 01-08: Compare ≥2 strategy alternatives side-by-side
// on cost, timeline, risk, evidence strength, and sector coverage.
//
// compareScenarios(session, { alternativeIds: [id1, id2, ...] }) → ScenarioComparison
//
// ScenarioComparison = {
//   alternativeIds: string[],
//   alternatives: AlternativeSummary[],
//   matrix: {
//     totalCost: CostComparisonEntry[],
//     timeline: TimelineComparisonEntry[],
//     riskProfile: RiskComparisonEntry[],
//     evidenceStrength: EvidenceStrengthEntry[],
//     sectorCoverage: SectorCoverageEntry[],
//   },
//   tradeoffs: string,            // descriptive, NEVER prescriptive
//   dataGaps: string[],           // explicit list of missing-data gaps
//   simulated: true,
//   modelVersion: "v1-deterministic",
// }
//
// ============================================================
// CORE PRINCIPLE — NEUTRAL BY DESIGN (mission pack §7)
// ============================================================
// "The Balance informs human judgment; it does not replace it."
//
// `tradeoffs` describes differences and trade-offs in plain language.
// It NEVER:
//   - Declares a winner
//   - Recommends automatic adoption
//   - Presents a misleading composite score
//   - Uses phrases like "best alternative" or "recommended choice"
//
// The human decision-maker reads the matrix + tradeoffs and decides.
//
// ============================================================
// HONEST MISSING DATA (mission pack §3, §4, §5)
// ============================================================
// - Missing cost data is NOT zero. It's a gap, surfaced in dataGaps.
// - No cross-currency aggregation. If alternatives have different
//   currencies, the cost comparison notes the gap.
// - "insufficient data" entries from 01-06 are NOT converted to estimates.
// - Missing scheduling data → timeline gap, not fabricated dates.
// - Unsupported claims are visible (unsupportedClaims ≥ 0).
// - Distinct evidence IDs counted (no double-counting).
//
// ============================================================
// READ-ONLY INTEGRITY (mission pack §2, §8)
// ============================================================
// compareScenarios does NOT:
//   - Write any rows
//   - Modify any StrategyVersion or Program
//   - Approve or reject any strategy
//   - Call any write operation (estimateBudgets, buildRoadmap, etc.)
//
// It READS existing data:
//   - StrategyVersion metadata (for programs, objectives, evidence refs)
//   - Program records (for sectors, KPIs, evidence refs)
//   - BudgetLine records (if estimateBudgets was previously called)
//   - Dependency records (for conflicts → risks)
//   - RiskRegister records (if any exist)
//   - Evidence records (for verificationStatus)
//
// ============================================================
// PERMISSIONS
// ============================================================
// compareScenarios: comparison:read (admin, analyst, reviewer — NOT observer)
//
// Per ADR-0013. Reuses G00 + 01-00..01-07 contracts.
// No new migration, no new table — comparison computed on demand.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES — Scenario Comparison
// ============================================================

export const COMPARISON_MODEL_VERSION = "v1-deterministic" as const;

export interface AlternativeSummary {
  altId: string;
  strategyId: string;
  strategyTitle: string;
  versionNumber: number;
  compositionBatchId: string | null;
  status: string;            // "draft"
  programCount: number;
  objectiveCount: number;
}

export interface CostComparisonEntry {
  altId: string;
  // Total cost range = sum of program budget line min/max.
  // NULL when no budget lines exist for this alternative (insufficient data).
  min: string | null;        // string Decimal; null = no data
  max: string | null;
  currency: string | null;   // ISO 4217 code; null = no data
  // How many programs have budget estimates vs how many don't
  programsWithEstimate: number;
  programsWithoutEstimate: number;
  // True if the total is a PARTIAL sum (some programs lack estimates)
  isPartialTotal: boolean;
  // Note explaining the data state
  note: string;
}

export interface TimelineComparisonEntry {
  altId: string;
  // Planning horizon from linked objectives (max objective.horizon)
  totalHorizon: number | null;
  horizonSource: "objective-horizon" | "unavailable";
  // Execution duration — only available if scheduling data exists
  // AND passed temporal validation. Null otherwise.
  executionDurationYears: number | null;
  executionDurationSource: "scheduling-data" | "unavailable" | "temporal-violation";
  // Whether the alternative has any scheduling conflicts (from 01-07-FIX)
  hasTemporalViolations: boolean;
  note: string;
}

export interface RiskComparisonEntry {
  altId: string;
  // From RiskRegister records (if any exist) — NOT fabricated
  highRisks: number;         // count of severity="high" or "critical"
  criticalRisks: number;     // count of severity="critical"
  risksWithMitigation: number;
  totalRisks: number;
  // From portfolio conflicts (01-05) — surfaced as risks
  conflictCount: number;
  note: string;
}

export interface EvidenceStrengthEntry {
  altId: string;
  // Distinct evidence IDs cited by this alternative's programs
  distinctEvidenceIds: number;
  // Breakdown by verificationStatus (from Evidence Fabric)
  verifiedEvidence: number;     // verificationStatus="verified"
  unverifiedEvidence: number;   // verificationStatus="unverified"
  disputedEvidence: number;     // verificationStatus="disputed"
  refutedEvidence: number;      // verificationStatus="refuted"
  // Claim counts (a claim = a program's evidenceRef entry)
  totalClaims: number;          // total evidenceRefs across all programs
  supportedClaims: number;      // claims citing verified evidence
  weakClaims: number;           // claims citing unverified/disputed evidence
  unsupportedClaims: number;    // claims citing refuted OR non-existent evidence
  note: string;
}

export interface SectorCoverageEntry {
  altId: string;
  sectorsAddressed: string[];   // distinct sectors from programs
  sectorCount: number;
  note: string;
}

export interface ScenarioComparison {
  alternativeIds: string[];
  alternatives: AlternativeSummary[];
  matrix: {
    totalCost: CostComparisonEntry[];
    timeline: TimelineComparisonEntry[];
    riskProfile: RiskComparisonEntry[];
    evidenceStrength: EvidenceStrengthEntry[];
    sectorCoverage: SectorCoverageEntry[];
  };
  tradeoffs: string;          // descriptive, NEVER prescriptive
  dataGaps: string[];         // explicit list of missing-data gaps
  simulated: true;
  modelVersion: string;
}

// ============================================================
// ERRORS
// ============================================================

export class ComparisonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComparisonValidationError";
  }
}

// ============================================================
// BUILD COMPARISON (public API — read-only, deterministic)
// ============================================================

export async function compareScenarios(
  session: Session,
  input: { alternativeIds: string[] }
): Promise<ScenarioComparison> {
  // Read-only — admin, analyst, reviewer. NOT observer.
  await requirePermissionWithCurrentRole(session, "comparison:read");

  // === INPUT VALIDATION ===
  if (!input.alternativeIds || !Array.isArray(input.alternativeIds)) {
    throw new ComparisonValidationError("alternativeIds must be an array");
  }
  // Must have ≥2 distinct alternatives
  const distinctIds = new Set(input.alternativeIds);
  if (distinctIds.size < 2) {
    throw new ComparisonValidationError(
      `compareScenarios requires at least 2 DISTINCT alternatives. ` +
      `Received ${input.alternativeIds.length} alternativeId(s) with ${distinctIds.size} distinct value(s). ` +
      `Comparison is meaningless with fewer than 2 alternatives.`
    );
  }
  if (input.alternativeIds.length !== distinctIds.size) {
    throw new ComparisonValidationError(
      `alternativeIds contains duplicates. Each alternative must appear at most once. ` +
      `Received ${input.alternativeIds.length} IDs but only ${distinctIds.size} are distinct.`
    );
  }

  const altIds = [...distinctIds];

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // === FETCH ALL ALTERNATIVES (single query, RLS-enforced) ===
    const strategyVersions = await tx.strategyVersion.findMany({
      where: { id: { in: altIds }, tenantId },
      include: { strategy: true },
    });

    // Verify all alternatives were found in this tenant
    if (strategyVersions.length !== altIds.length) {
      const foundIds = new Set(strategyVersions.map((sv) => sv.id));
      const missingIds = altIds.filter((id) => !foundIds.has(id));
      throw new ComparisonValidationError(
        `${missingIds.length} alternative(s) not found in tenant scope: ` +
        `${missingIds.join(", ")}. Cross-tenant comparison is not allowed. ` +
        `All alternatives must belong to the same tenant.`
      );
    }

    // Build a map for quick lookup
    const svMap = new Map(strategyVersions.map((sv) => [sv.id, sv]));

    // === FETCH ALL PROGRAMS FOR ALL ALTERNATIVES (single query) ===
    const allPrograms = await tx.program.findMany({
      where: { tenantId, strategyVersionId: { in: altIds } },
      orderBy: { title: "asc" },
    });
    const programsByAlt = new Map<string, typeof allPrograms>();
    for (const altId of altIds) {
      programsByAlt.set(altId, allPrograms.filter((p) => p.strategyVersionId === altId));
    }

    // === FETCH ALL BUDGET LINES FOR ALL ALTERNATIVES (single query) ===
    const allBudgetLines = await tx.budgetLine.findMany({
      where: {
        tenantId,
        programId: { in: allPrograms.map((p) => p.id) },
        modelVersion: "v1-deterministic",
      },
    });
    const budgetLinesByProgram = new Map<string, typeof allBudgetLines>();
    for (const bl of allBudgetLines) {
      if (!budgetLinesByProgram.has(bl.programId)) {
        budgetLinesByProgram.set(bl.programId, []);
      }
      budgetLinesByProgram.get(bl.programId)!.push(bl);
    }

    // === FETCH ALL DEPENDENCIES (for conflicts → risks) ===
    const allDeps = allPrograms.length === 0
      ? []
      : await tx.dependency.findMany({
          where: {
            tenantId,
            OR: [
              { fromProgramId: { in: allPrograms.map((p) => p.id) } },
              { toProgramId: { in: allPrograms.map((p) => p.id) } },
            ],
          },
        });
    const conflictsByAlt = new Map<string, number>();
    for (const altId of altIds) {
      const altProgramIds = new Set(programsByAlt.get(altId)!.map((p) => p.id));
      const altConflicts = allDeps.filter(
        (d) => d.type === "conflicts" &&
               altProgramIds.has(d.fromProgramId) &&
               altProgramIds.has(d.toProgramId)
      );
      conflictsByAlt.set(altId, altConflicts.length);
    }

    // === FETCH ALL RISK REGISTERS ===
    const allRisks = await tx.riskRegister.findMany({
      where: { tenantId, strategyVersionId: { in: altIds } },
    });
    const risksByAlt = new Map<string, typeof allRisks>();
    for (const altId of altIds) {
      risksByAlt.set(altId, allRisks.filter((r) => r.strategyVersionId === altId));
    }

    // === BUILD ALTERNATIVE SUMMARIES ===
    const alternatives: AlternativeSummary[] = altIds.map((altId) => {
      const sv = svMap.get(altId)!;
      const programs = programsByAlt.get(altId)!;
      const meta = (sv.metadata ?? {}) as Record<string, unknown>;
      const objectives = (meta.objectives as unknown[]) ?? [];
      return {
        altId,
        strategyId: sv.strategyId,
        strategyTitle: sv.strategy.title,
        versionNumber: sv.versionNumber,
        compositionBatchId: sv.strategy.compositionBatchId ?? null,
        status: sv.status,
        programCount: programs.length,
        objectiveCount: objectives.length,
      };
    });

    // === BUILD COST COMPARISON ===
    const totalCost = altIds.map((altId) => buildCostEntry(altId, programsByAlt, budgetLinesByProgram));

    // === BUILD TIMELINE COMPARISON ===
    // Fetch objectives for all alternatives to derive totalHorizon (planning horizon).
    // Collect objectiveIds from each strategy version's metadata.inputSnapshot.
    const allObjectiveIds = new Set<string>();
    const objectiveIdsByAlt = new Map<string, string[]>();
    for (const altId of altIds) {
      const sv = svMap.get(altId)!;
      const svMeta = (sv.metadata ?? {}) as Record<string, unknown>;
      const inputSnapshot = (svMeta.inputSnapshot ?? {}) as Record<string, unknown>;
      const objectiveIdsRaw = inputSnapshot.objectiveIds;
      const objectiveIds: string[] = Array.isArray(objectiveIdsRaw)
        ? objectiveIdsRaw.filter((id): id is string => typeof id === "string")
        : [];
      objectiveIdsByAlt.set(altId, objectiveIds);
      for (const oid of objectiveIds) allObjectiveIds.add(oid);
    }
    // Batch-fetch all objectives to get their horizon values
    const objectiveRecords = allObjectiveIds.size === 0
      ? []
      : await tx.objective.findMany({
          where: { tenantId, id: { in: [...allObjectiveIds] } },
          select: { id: true, horizon: true },
        });
    const objectiveHorizonMap = new Map<string, number>();
    for (const o of objectiveRecords) {
      objectiveHorizonMap.set(o.id, o.horizon);
    }
    // Compute totalHorizon per alternative (max horizon across its objectives)
    const totalHorizonByAlt = new Map<string, number | null>();
    for (const altId of altIds) {
      const oids = objectiveIdsByAlt.get(altId) ?? [];
      if (oids.length === 0) {
        totalHorizonByAlt.set(altId, null);
      } else {
        const horizons = oids.map((oid) => objectiveHorizonMap.get(oid)).filter((h): h is number => h !== undefined);
        totalHorizonByAlt.set(altId, horizons.length > 0 ? Math.max(...horizons) : null);
      }
    }
    const timeline = altIds.map((altId) =>
      buildTimelineEntry(altId, programsByAlt, totalHorizonByAlt.get(altId) ?? null)
    );

    // === BUILD RISK PROFILE ===
    const riskProfile = altIds.map((altId) => buildRiskEntry(altId, risksByAlt, conflictsByAlt));

    // === BUILD EVIDENCE STRENGTH ===
    // First, collect all distinct evidence IDs cited across all alternatives,
    // then batch-fetch their verificationStatus.
    const allEvidenceIds = new Set<string>();
    for (const programs of programsByAlt.values()) {
      for (const p of programs) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        const evidenceRefs = (meta.evidenceRefs as Array<{ evidenceId: string }>) ?? [];
        for (const ref of evidenceRefs) {
          if (ref.evidenceId) allEvidenceIds.add(ref.evidenceId);
        }
      }
    }
    const evidenceRecords = allEvidenceIds.size === 0
      ? []
      : await tx.evidence.findMany({
          where: { tenantId, id: { in: [...allEvidenceIds] } },
          select: { id: true, verificationStatus: true },
        });
    const evidenceStatusMap = new Map<string, string>();
    for (const e of evidenceRecords) {
      evidenceStatusMap.set(e.id, e.verificationStatus);
    }
    const evidenceStrength = altIds.map((altId) =>
      buildEvidenceEntry(altId, programsByAlt, evidenceStatusMap)
    );

    // === BUILD SECTOR COVERAGE ===
    const sectorCoverage = altIds.map((altId) => buildSectorEntry(altId, programsByAlt));

    // === BUILD TRADEOFFS (neutral, descriptive) ===
    const tradeoffs = buildTradeoffs(alternatives, totalCost, timeline, riskProfile, evidenceStrength, sectorCoverage);

    // === BUILD DATA GAPS ===
    const dataGaps = buildDataGaps(alternatives, totalCost, timeline, evidenceStrength);

    return {
      alternativeIds: altIds,
      alternatives,
      matrix: {
        totalCost,
        timeline,
        riskProfile,
        evidenceStrength,
        sectorCoverage,
      },
      tradeoffs,
      dataGaps,
      simulated: true,
      modelVersion: COMPARISON_MODEL_VERSION,
    };
  });
}

// ============================================================
// HELPERS — build matrix entries
// ============================================================

function buildCostEntry(
  altId: string,
  programsByAlt: Map<string, unknown[]>,
  budgetLinesByProgram: Map<string, unknown[]>
): CostComparisonEntry {
  const programs = programsByAlt.get(altId) as Array<{ id: string }> | undefined ?? [];
  const programIds = programs.map((p) => p.id);

  let programsWithEstimate = 0;
  let programsWithoutEstimate = 0;
  const currencies = new Set<string>();
  let minSum: Prisma.Decimal | null = null;
  let maxSum: Prisma.Decimal | null = null;

  for (const pid of programIds) {
    const lines = budgetLinesByProgram.get(pid) ?? [];
    if (lines.length > 0) {
      // Use the first (and should be only, per unique index) budget line
      const line = lines[0] as { minAmount: Prisma.Decimal; maxAmount: Prisma.Decimal; currency: string };
      programsWithEstimate++;
      currencies.add(line.currency);
      const minD = new Prisma.Decimal(line.minAmount.toString());
      const maxD = new Prisma.Decimal(line.maxAmount.toString());
      minSum = minSum === null ? minD : minSum.add(minD);
      maxSum = maxSum === null ? maxD : maxSum.add(maxD);
    } else {
      programsWithoutEstimate++;
    }
  }

  const isPartialTotal = programsWithoutEstimate > 0 && programsWithEstimate > 0;
  const hasMultipleCurrencies = currencies.size > 1;

  let note: string;
  let minResult: string | null = null;
  let maxResult: string | null = null;
  let currencyResult: string | null = null;

  if (programsWithEstimate === 0) {
    note = `No budget estimates for this alternative (insufficient cost data per 01-06). ` +
           `Missing data is NOT zero — it is a gap. ` +
           `${programsWithoutEstimate} program(s) lack cost estimates.`;
  } else if (hasMultipleCurrencies) {
    // Refuse cross-currency aggregation
    note = `${programsWithEstimate} program(s) have estimates in multiple currencies ` +
           `(${[...currencies].join(", ")}). Cross-currency aggregation is NOT performed ` +
           `without a documented, dated conversion rate. Cost totals are null. ` +
           `${programsWithoutEstimate} program(s) lack estimates.`;
    // Don't return min/max — can't aggregate
  } else {
    // Single currency — safe to aggregate
    currencyResult = [...currencies][0]!;
    minResult = minSum!.toFixed(2);
    maxResult = maxSum!.toFixed(2);
    if (isPartialTotal) {
      note = `PARTIAL total: ${programsWithEstimate} program(s) have estimates, ` +
             `${programsWithoutEstimate} program(s) lack estimates. ` +
             `The total does NOT represent the full alternative cost — ` +
             `it is a partial sum. Treat with caution.`;
    } else {
      note = `Complete total: all ${programsWithEstimate} program(s) have estimates. ` +
             `Total is a sum of program budget line min/max ranges. ` +
             `Simulated (per 01-06) — not a verified financial projection.`;
    }
  }

  return {
    altId,
    min: minResult,
    max: maxResult,
    currency: currencyResult,
    programsWithEstimate,
    programsWithoutEstimate,
    isPartialTotal,
    note,
  };
}

function buildTimelineEntry(
  altId: string,
  programsByAlt: Map<string, unknown[]>,
  totalHorizon: number | null
): TimelineComparisonEntry {
  const programs = (programsByAlt.get(altId) ?? []) as Array<{ id: string; metadata: unknown }>;
  let hasSchedulingData = false;
  for (const p of programs) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const sched = meta.scheduling as Record<string, unknown> | undefined;
    if (sched && typeof sched === "object" &&
        (typeof sched.startYear === "number" || typeof sched.endYear === "number")) {
      hasSchedulingData = true;
      break;
    }
  }

  // We do NOT call buildRoadmap here (it throws on temporal violations + is
  // a separate read operation). The caller can separately call buildRoadmap
  // to get exact execution duration + temporal validation. Here we only
  // signal whether scheduling data exists.
  const hasTemporalViolations = false; // conservative — would need buildRoadmap

  let executionDurationYears: number | null = null;
  let executionDurationSource: "scheduling-data" | "unavailable" | "temporal-violation";
  if (hasTemporalViolations) {
    executionDurationSource = "temporal-violation";
  } else if (hasSchedulingData) {
    executionDurationSource = "scheduling-data";
    // executionDurationYears stays null — exact duration requires buildRoadmap
  } else {
    executionDurationSource = "unavailable";
  }

  const horizonSource: "objective-horizon" | "unavailable" =
    totalHorizon !== null ? "objective-horizon" : "unavailable";

  const note =
    executionDurationSource === "unavailable"
      ? `No scheduling data for this alternative. Execution duration is unknown — ` +
        `do not infer duration from the planning horizon or dependency chain length. ` +
        (totalHorizon !== null
          ? `Planning horizon: ${totalHorizon} year(s) (from objectives). `
          : `No planning horizon available.`)
      : executionDurationSource === "temporal-violation"
        ? `Temporal violations detected in scheduling data. The schedule is NOT valid — ` +
          `do not present it as a feasible timeline.`
        : `Scheduling data exists for some programs. Execution duration requires ` +
          `buildRoadmap to compute (not run here to keep comparison read-only + ` +
          `avoid throwing on temporal violations). ` +
          (totalHorizon !== null
            ? `Planning horizon: ${totalHorizon} year(s) (from objectives).`
            : `No planning horizon available.`);

  return {
    altId,
    totalHorizon,
    horizonSource,
    executionDurationYears,
    executionDurationSource,
    hasTemporalViolations,
    note,
  };
}

function buildRiskEntry(
  altId: string,
  risksByAlt: Map<string, unknown[]>,
  conflictsByAlt: Map<string, number>
): RiskComparisonEntry {
  const risks = (risksByAlt.get(altId) ?? []) as Array<{
    severity: string; mitigation: string | null;
  }>;
  const highRisks = risks.filter((r) => r.severity === "high" || r.severity === "critical").length;
  const criticalRisks = risks.filter((r) => r.severity === "critical").length;
  const risksWithMitigation = risks.filter((r) => r.mitigation && r.mitigation.trim().length > 0).length;
  const conflictCount = conflictsByAlt.get(altId) ?? 0;

  const note =
    risks.length === 0
      ? `No registered risks for this alternative. ` +
        `This is NOT proof of absence of risks — it means none have been documented. ` +
        `${conflictCount} conflict(s) detected from the dependency graph (surfaced as risks).`
      : `${risks.length} risk(s) registered: ${highRisks} high/critical, ${criticalRisks} critical. ` +
        `${risksWithMitigation} have mitigation plans. ` +
        `${conflictCount} conflict(s) from dependency graph.`;

  return {
    altId,
    highRisks,
    criticalRisks,
    risksWithMitigation,
    totalRisks: risks.length,
    conflictCount,
    note,
  };
}

function buildEvidenceEntry(
  altId: string,
  programsByAlt: Map<string, unknown[]>,
  evidenceStatusMap: Map<string, string>
): EvidenceStrengthEntry {
  const programs = (programsByAlt.get(altId) ?? []) as Array<{
    id: string; metadata: unknown;
  }>;
  const citedEvidenceIds = new Set<string>();
  let totalClaims = 0;
  let supportedClaims = 0;     // citing verified evidence
  let weakClaims = 0;          // citing unverified/disputed evidence
  let unsupportedClaims = 0;   // citing refuted OR non-existent evidence

  for (const p of programs) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const evidenceRefs = (meta.evidenceRefs as Array<{ evidenceId: string }>) ?? [];
    for (const ref of evidenceRefs) {
      totalClaims++;
      const eid = ref.evidenceId;
      if (!eid) {
        unsupportedClaims++;
        continue;
      }
      citedEvidenceIds.add(eid);
      const status = evidenceStatusMap.get(eid);
      if (!status) {
        // Evidence doesn't exist in tenant scope → unsupported
        unsupportedClaims++;
      } else if (status === "verified") {
        supportedClaims++;
      } else if (status === "unverified" || status === "disputed") {
        weakClaims++;
      } else if (status === "refuted") {
        unsupportedClaims++;
      } else {
        // Unknown status → treat as weak (conservative)
        weakClaims++;
      }
    }
  }

  // Breakdown by verificationStatus (distinct evidence IDs, no double-counting)
  let verifiedEvidence = 0;
  let unverifiedEvidence = 0;
  let disputedEvidence = 0;
  let refutedEvidence = 0;
  for (const eid of citedEvidenceIds) {
    const status = evidenceStatusMap.get(eid);
    if (status === "verified") verifiedEvidence++;
    else if (status === "unverified") unverifiedEvidence++;
    else if (status === "disputed") disputedEvidence++;
    else if (status === "refuted") refutedEvidence++;
    // If status is missing (evidence doesn't exist), it's not counted in any
    // of these — it shows up in unsupportedClaims instead.
  }

  const note =
    citedEvidenceIds.size === 0
      ? `No evidence cited by this alternative's programs. ` +
        `All claims lack evidentiary support.`
      : `${citedEvidenceIds.size} distinct evidence item(s) cited across ${totalClaims} claim(s). ` +
        `Supported (verified evidence): ${supportedClaims}. ` +
        `Weak (unverified/disputed): ${weakClaims}. ` +
        `Unsupported (refuted/non-existent): ${unsupportedClaims}. ` +
        `Note: verified evidence does NOT automatically prove the strategic claim — ` +
        `it is examinable support, not proof of causality.`;

  return {
    altId,
    distinctEvidenceIds: citedEvidenceIds.size,
    verifiedEvidence,
    unverifiedEvidence,
    disputedEvidence,
    refutedEvidence,
    totalClaims,
    supportedClaims,
    weakClaims,
    unsupportedClaims,
    note,
  };
}

function buildSectorEntry(
  altId: string,
  programsByAlt: Map<string, unknown[]>
): SectorCoverageEntry {
  const programs = (programsByAlt.get(altId) ?? []) as Array<{ sector: string }>;
  const sectors = new Set(programs.map((p) => p.sector));
  const sectorsAddressed = [...sectors].sort();

  const note =
    sectorsAddressed.length === 0
      ? `No programs → no sectors addressed.`
      : `${sectorsAddressed.length} sector(s) addressed: ${sectorsAddressed.join(", ")}. ` +
        `Note: sector coverage does NOT imply sector success — a program addressing ` +
        `a sector does not prove the sector's problems are solved.`;

  return {
    altId,
    sectorsAddressed,
    sectorCount: sectorsAddressed.length,
    note,
  };
}

// ============================================================
// HELPERS — build tradeoffs (NEUTRAL, descriptive)
// ============================================================

function buildTradeoffs(
  alternatives: AlternativeSummary[],
  totalCost: CostComparisonEntry[],
  timeline: TimelineComparisonEntry[],
  riskProfile: RiskComparisonEntry[],
  evidenceStrength: EvidenceStrengthEntry[],
  sectorCoverage: SectorCoverageEntry[]
): string {
  const lines: string[] = [];

  lines.push(
    `This comparison describes differences between ${alternatives.length} alternatives. ` +
    `It does NOT recommend a winner — the decision is the human's responsibility.`
  );

  // Sector coverage differences
  const sectorCounts = sectorCoverage.map((s) => ({ altId: s.altId, count: s.sectorCount }));
  const maxSectors = Math.max(...sectorCounts.map((s) => s.count));
  const minSectors = Math.min(...sectorCounts.map((s) => s.count));
  if (maxSectors !== minSectors) {
    const maxAlts = sectorCounts.filter((s) => s.count === maxSectors).map((s) => s.altId);
    const minAlts = sectorCounts.filter((s) => s.count === minSectors).map((s) => s.altId);
    lines.push(
      `Sector coverage varies: alternative(s) ${maxAlts.join(", ")} address ${maxSectors} sector(s), ` +
      `while ${minAlts.join(", ")} address ${minSectors}. ` +
      `More sectors does not mean better — it may indicate broader scope with thinner coverage per sector.`
    );
  }

  // Cost data gaps
  const costGaps = totalCost.filter((c) => c.programsWithoutEstimate > 0);
  if (costGaps.length > 0) {
    lines.push(
      `Cost data gaps: ${costGaps.length} alternative(s) have programs without budget estimates. ` +
      `Alternatives with more complete cost data may appear to have higher totals simply because ` +
      `more programs were estimated — do not interpret lower totals as lower cost without checking ` +
      `the programsWithEstimate / programsWithoutEstimate counts.`
    );
  }

  // Evidence strength differences
  const evidenceStrong = evidenceStrength.filter((e) => e.supportedClaims > 0);
  const evidenceWeak = evidenceStrength.filter((e) => e.unsupportedClaims > 0);
  if (evidenceStrong.length > 0 && evidenceWeak.length > 0) {
    lines.push(
      `Evidence strength varies: some alternatives have more claims backed by verified evidence, ` +
      `while others have more unsupported claims. Verified evidence is examinable support, ` +
      `NOT proof that the strategic claim is correct.`
    );
  }

  // Risk differences
  const highRiskAlts = riskProfile.filter((r) => r.highRisks > 0);
  if (highRiskAlts.length > 0) {
    lines.push(
      `Risk profile: ${highRiskAlts.length} alternative(s) have high/critical registered risks. ` +
      `Absence of registered risks is NOT proof of safety — it may mean risks haven't been assessed.`
    );
  }

  // Conflicts
  const conflictAlts = riskProfile.filter((r) => r.conflictCount > 0);
  if (conflictAlts.length > 0) {
    lines.push(
      `Dependency conflicts: ${conflictAlts.length} alternative(s) have program conflicts ` +
      `(resource competition, policy clashes) that require human decisions.`
    );
  }

  // Timeline gaps
  const timelineGaps = timeline.filter((t) => t.executionDurationSource === "unavailable");
  if (timelineGaps.length > 0) {
    lines.push(
      `Timeline gaps: ${timelineGaps.length} alternative(s) lack scheduling data. ` +
      `Execution duration cannot be compared without scheduling data — ` +
      `do not infer duration from planning horizon or dependency chain length.`
    );
  }

  lines.push(
    `Decision guidance: weigh sector coverage against cost completeness, evidence strength against ` +
    `risk profile, and timeline feasibility against conflict count. No single dimension determines ` +
    `the best choice — trade-offs are inherent and require human judgment.`
  );

  return lines.join("\n\n");
}

function buildDataGaps(
  alternatives: AlternativeSummary[],
  totalCost: CostComparisonEntry[],
  timeline: TimelineComparisonEntry[],
  evidenceStrength: EvidenceStrengthEntry[]
): string[] {
  const gaps: string[] = [];

  for (const cost of totalCost) {
    if (cost.programsWithoutEstimate > 0) {
      const alt = alternatives.find((a) => a.altId === cost.altId);
      gaps.push(
        `Alternative "${alt?.strategyTitle ?? cost.altId}": ${cost.programsWithoutEstimate} ` +
        `program(s) lack budget estimates. Cost total is ${cost.isPartialTotal ? "PARTIAL" : "unavailable"}.`
      );
    }
    if (cost.currency === null && cost.programsWithEstimate > 0) {
      gaps.push(
        `Alternative "${alternatives.find((a) => a.altId === cost.altId)?.strategyTitle ?? cost.altId}": ` +
        `multiple currencies in budget estimates — cross-currency aggregation not performed.`
      );
    }
  }

  for (const t of timeline) {
    if (t.executionDurationSource === "unavailable") {
      const alt = alternatives.find((a) => a.altId === t.altId);
      gaps.push(
        `Alternative "${alt?.strategyTitle ?? t.altId}": no scheduling data — ` +
        `execution duration unknown.`
      );
    }
    if (t.hasTemporalViolations) {
      gaps.push(
        `Alternative "${alternatives.find((a) => a.altId === t.altId)?.strategyTitle ?? t.altId}": ` +
        `temporal violations in scheduling data — schedule is NOT valid.`
      );
    }
  }

  for (const e of evidenceStrength) {
    if (e.unsupportedClaims > 0) {
      const alt = alternatives.find((a) => a.altId === e.altId);
      gaps.push(
        `Alternative "${alt?.strategyTitle ?? e.altId}": ${e.unsupportedClaims} ` +
        `claim(s) cite refuted or non-existent evidence.`
      );
    }
  }

  return gaps;
}
