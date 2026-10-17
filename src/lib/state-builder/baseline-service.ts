// ============================================================
// baseline-service.ts — State Baseline & Observability Modes
// ------------------------------------------------------------
// Mission 01-01: State Baseline & Observability Modes
// 01-01-FIX: Baseline Integrity Closure (4 fixes)
//
// Computes a structured snapshot of the country's current state
// per sector, using Evidence Fabric data. Implements National
// Observability Modes per Blueprint §5.4 + ADR-0014:
//   - FULL:    ≥2 independent sources + ≥1 verified/corroborated
//   - PARTIAL: some evidence, but doesn't meet FULL criteria
//   - LOW:     0 evidence → system says "unknown"
//
// Core honesty rules (Blueprint §2):
//   - "unknown" is a valid result — NEVER fabricate values
//   - Counter-evidence is shown side-by-side, not silently selected
//   - Sources in the same independence_group are NOT independent
//   - Every indicator links to its evidence source + date
//
// 01-01-FIX changes:
//   FIX-1: All known sectors appear in the report (LOW/unknown, not absent)
//   FIX-2: Evidence scoped by metadata.countryId (no cross-country mixing)
//   FIX-3: Conservative indicator value extraction (no years as values)
//   FIX-4: Uses claimTaskById (respects lease contract) + dynamic idempotency
//
// Runs as a Durable Task (G00 Task Runtime + claimTaskById extension):
//   - Dynamic idempotency key (reflects evidence state) — no stale reports
//   - claimTaskById respects lease contract (no stealing active tasks)
//   - Crash recovery via lease expiry + reclaimStaleTasks
//   - Tenant isolation via RLS on tasks table
//
// Per ADR-0014. Reuses G00's Evidence Fabric + Task Runtime.
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
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES — BaselineReport (per ADR-0014)
// ============================================================

export type ObservabilityMode = "FULL" | "PARTIAL" | "LOW";

export interface BaselineIndicator {
  name: string;
  value: string;
  // FIX-3: confidence in the extracted value
  valueConfidence: "structured" | "extracted" | "unparsed";
  evidenceId: string;
  sourceId: string | null;
  sourceCode: string | null;
  independenceGroup: string | null;
  verificationStatus: string;
  observedAt: string | null;
  supportStance: "supports" | "contradicts" | "neutral" | "uncertain";
  claim: string;
}

export interface BaselineDimension {
  sector: string;
  observabilityMode: ObservabilityMode;
  indicators: BaselineIndicator[];
  gaps: string[];
  evidenceCount: number;
  independentSourceCount: number;
  counterEvidenceCount: number;
}

export interface BaselineReport {
  countryId: string;
  computedAt: string;
  taskId: string;
  dimensions: BaselineDimension[];
  summary: {
    strongSectors: string[];
    weakSectors: string[];
    unknownSectors: string[];
  };
  honesty: {
    fictional: boolean;
    sourceNote: string;
    computedBy: "baseline-engine-v1";
    rulesVersion: "adr-0014-v1";
    // FIX-2: track unattributed evidence (no metadata.countryId)
    unattributedEvidenceCount: number;
    // FIX-2: track evidence from other countries (excluded)
    otherCountryEvidenceCount: number;
  };
}

export interface ComputeBaselineInput {
  countryId: string;
  // Optional: limit which sectors to compute (default: all sectors from CountryPackConfig)
  sectors?: string[];
}

// ============================================================
// OBSERVABILITY MODE CLASSIFICATION (per ADR-0014 §1)
// ============================================================

interface SectorEvidence {
  sector: string;
  evidence: Array<{
    id: string;
    claim: string;
    type: string;
    verificationStatus: string;
    observedAt: Date | null;
    sourceId: string | null;
    sourceCode: string | null;
    independenceGroup: string | null;
    metadata: Record<string, unknown>;
  }>;
}

function classifyObservabilityMode(
  evidence: SectorEvidence["evidence"]
): { mode: ObservabilityMode; independentCount: number; gaps: string[] } {
  const gaps: string[] = [];

  if (evidence.length === 0) {
    return {
      mode: "LOW",
      independentCount: 0,
      gaps: ["No evidence available for this sector. Unable to assess state — result is 'unknown'."],
    };
  }

  // Count independent sources (group by independenceGroup; null = each is its own group)
  const independenceGroups = new Set<string>();
  for (const e of evidence) {
    if (!e.sourceId) {
      independenceGroups.add(`no-source:${e.id}`);
    } else {
      const group = e.independenceGroup ?? `source:${e.sourceId}`;
      independenceGroups.add(group);
    }
  }
  const independentCount = independenceGroups.size;

  const hasVerified = evidence.some(
    (e) => e.verificationStatus === "verified" || e.verificationStatus === "corroborated"
  );

  const allDisputed = evidence.every(
    (e) => e.verificationStatus === "disputed" || e.verificationStatus === "refuted"
  );

  if (independentCount >= 2 && hasVerified && !allDisputed) {
    return { mode: "FULL", independentCount, gaps: [] };
  }

  if (independentCount < 2) {
    gaps.push(
      `Only ${independentCount} independent source(s) — need ≥2 for FULL observability.`
    );
  }
  if (!hasVerified) {
    gaps.push(
      "No verified or corroborated evidence — all evidence is unverified/disputed/refuted."
    );
  }
  if (allDisputed) {
    gaps.push("All evidence is disputed or refuted — unable to determine the state with confidence.");
  }

  return { mode: "PARTIAL", independentCount, gaps };
}

// ============================================================
// FIX-3: CONSERVATIVE INDICATOR VALUE EXTRACTION
// ============================================================
// Never interpret a year or contextual number as an indicator value.
// Priority:
//   1. metadata.indicatorValue (structured) — if present
//   2. Percentage (e.g., "4.2%") — safe, unambiguous
//   3. Qualitative description (e.g., "declined", "grew") — no fabricated number
//   4. "unparsed" — no reliable value could be extracted
//
// We NEVER return a bare number from the claim text as an indicator value,
// because it could be a year (2024), a count (5 sectors), or other context.

function extractIndicatorValue(
  claim: string,
  metadata: Record<string, unknown>
): { value: string; confidence: "structured" | "extracted" | "unparsed" } {
  // 1. Structured value from metadata (highest confidence)
  if (
    metadata.indicatorValue !== undefined &&
    metadata.indicatorValue !== null &&
    typeof metadata.indicatorValue !== "object"
  ) {
    return {
      value: String(metadata.indicatorValue),
      confidence: "structured",
    };
  }

  // 2. Percentage — safe because "%" unambiguously marks a metric value
  const percentMatch = claim.match(/(\d+\.?\d*)\s*%/);
  if (percentMatch && percentMatch[1]) {
    return {
      value: `${percentMatch[1]}%`,
      confidence: "extracted",
    };
  }

  // 3. Qualitative description — no fabricated number
  if (/decline|drop|fall|decrease/i.test(claim)) {
    return { value: "declined (qualitative)", confidence: "extracted" };
  }
  if (/grow|increase|rise|expand/i.test(claim)) {
    return { value: "grew (qualitative)", confidence: "extracted" };
  }

  // 4. Unparsed — we do NOT extract bare numbers (could be years, counts, etc.)
  return { value: "unparsed (no reliable value extracted)", confidence: "unparsed" };
}

function extractIndicatorName(
  claim: string,
  metadata: Record<string, unknown>
): string {
  // 1. Structured name from metadata (highest priority)
  if (
    metadata.indicatorName !== undefined &&
    typeof metadata.indicatorName === "string" &&
    metadata.indicatorName.length > 0
  ) {
    return metadata.indicatorName;
  }

  // 2. Heuristic from claim text (best-effort, documented)
  const lower = claim.toLowerCase();
  if (lower.includes("gdp")) return "GDP metric";
  if (lower.includes("unemployment")) return "unemployment rate";
  if (lower.includes("inflation")) return "inflation rate";
  if (lower.includes("enrollment")) return "enrollment rate";
  if (lower.includes("mortality")) return "mortality metric";
  if (lower.includes("crop yield")) return "crop yield";
  if (lower.includes("reserves")) return "reserves metric";
  if (lower.includes("monetary base")) return "monetary base growth";

  // 3. Fallback: first 60 chars of the claim
  return claim.slice(0, 60) + (claim.length > 60 ? "…" : "");
}

function mapSupportStance(
  type: string
): "supports" | "contradicts" | "neutral" | "uncertain" {
  switch (type) {
    case "supporting":
      return "supports";
    case "counter":
      return "contradicts";
    case "neutral":
      return "neutral";
    default:
      return "uncertain";
  }
}

// ============================================================
// FIX-2: COUNTRY-SPECIFIC EVIDENCE SCOPING
// ============================================================
// Evidence is scoped to a country via metadata.countryId.
// Evidence WITHOUT metadata.countryId is "unattributed" — not used for indicators.
// Evidence WITH metadata.countryId != target countryId is "other country" — excluded.
//
// This prevents a tenant operating on two countries from mixing evidence.

interface EvidenceScopingResult {
  attributed: SectorEvidence["evidence"]; // evidence for THIS country
  unattributedCount: number; // evidence without metadata.countryId
  otherCountryCount: number; // evidence with a different metadata.countryId
}

function filterAndGroupEvidenceBySector(
  evidenceRows: Array<{
    id: string;
    claim: string;
    type: string;
    verificationStatus: string;
    observedAt: Date | null;
    sourceId: string | null;
    source: { code: string | null; independenceGroup: string | null } | null;
    metadata: Prisma.JsonValue;
  }>,
  targetCountryId: string,
  sectorsFilter?: string[]
): EvidenceScopingResult & { sectorMap: Map<string, SectorEvidence["evidence"]> } {
  const sectorMap = new Map<string, SectorEvidence["evidence"]>();
  let unattributedCount = 0;
  let otherCountryCount = 0;

  for (const e of evidenceRows) {
    const metadata = (e.metadata ?? {}) as unknown as Record<string, unknown>;

    // FIX-2: Check countryId attribution
    const evidenceCountryId =
      typeof metadata.countryId === "string" ? metadata.countryId : null;

    if (!evidenceCountryId) {
      // Unattributed evidence — not used for country-specific indicators
      unattributedCount++;
      continue;
    }

    if (evidenceCountryId !== targetCountryId) {
      // Evidence belongs to a different country — exclude
      otherCountryCount++;
      continue;
    }

    // Check sector
    const sector = typeof metadata.sector === "string" ? metadata.sector : null;
    if (!sector) {
      // Has countryId but no sector — not included in baseline dimensions
      // (but not counted as unattributed since country is known)
      continue;
    }

    if (sectorsFilter && !sectorsFilter.includes(sector)) {
      continue;
    }

    if (!sectorMap.has(sector)) {
      sectorMap.set(sector, []);
    }
    sectorMap.get(sector)!.push({
      id: e.id,
      claim: e.claim,
      type: e.type,
      verificationStatus: e.verificationStatus,
      observedAt: e.observedAt,
      sourceId: e.sourceId,
      sourceCode: e.source?.code ?? null,
      independenceGroup: e.source?.independenceGroup ?? null,
      metadata,
    });
  }

  return {
    attributed: [], // not used — sectorMap holds the grouped data
    unattributedCount,
    otherCountryCount,
    sectorMap,
  };
}

// ============================================================
// BASELINE COMPUTATION (runs inside withAuthenticatedTenant)
// ============================================================

async function runBaselineComputation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  countryId: string,
  sectorsFilter?: string[]
): Promise<Omit<BaselineReport, "taskId">> {
  // 1. Fetch all evidence for this tenant (RLS-enforced — only this tenant's evidence)
  const evidenceRows = await tx.evidence.findMany({
    where: { tenantId },
    include: {
      source: {
        select: {
          id: true,
          code: true,
          independenceGroup: true,
        },
      },
    },
  });

  // 2. FIX-2: Filter evidence by countryId + group by sector
  const scoping = filterAndGroupEvidenceBySector(
    evidenceRows,
    countryId,
    sectorsFilter
  );

  // 3. FIX-1: Determine the set of "known sectors" for this country
  //    Sectors come from:
  //    a. CountryPackConfig.sectors (this tenant's config for this country)
  //    b. Sectors that have attributed evidence (from step 2)
  //    c. sectorsFilter if provided (explicit request)
  const knownSectors = new Set<string>();

  // 3a. Sectors from CountryPackConfig
  const countryPackConfig = await tx.countryPackConfig.findUnique({
    where: { tenantId_countryId: { tenantId, countryId } },
  });
  if (countryPackConfig) {
    const configSectors = (countryPackConfig.sectors as unknown as string[]) ?? [];
    for (const s of configSectors) {
      if (typeof s === "string") knownSectors.add(s);
    }
  }

  // 3b. Sectors from attributed evidence
  for (const sector of scoping.sectorMap.keys()) {
    knownSectors.add(sector);
  }

  // 3c. If sectorsFilter provided, restrict to those sectors
  if (sectorsFilter) {
    for (const s of knownSectors) {
      if (!sectorsFilter.includes(s)) {
        knownSectors.delete(s);
      }
    }
  }

  // 4. Build dimensions for ALL known sectors (FIX-1: LOW sectors appear, not absent)
  const dimensions: BaselineDimension[] = [];
  for (const sector of knownSectors) {
    const evidence = scoping.sectorMap.get(sector) ?? [];
    const { mode, independentCount, gaps } = classifyObservabilityMode(evidence);

    const counterEvidenceCount = evidence.filter((e) => e.type === "counter").length;

    // Build indicators (preserve ALL evidence — no silent selection)
    const indicators: BaselineIndicator[] = evidence.map((e) => {
      const { value, confidence } = extractIndicatorValue(e.claim, e.metadata);
      return {
        name: extractIndicatorName(e.claim, e.metadata),
        value,
        valueConfidence: confidence,
        evidenceId: e.id,
        sourceId: e.sourceId,
        sourceCode: e.sourceCode,
        independenceGroup: e.independenceGroup,
        verificationStatus: e.verificationStatus,
        observedAt: e.observedAt ? e.observedAt.toISOString() : null,
        supportStance: mapSupportStance(e.type),
        claim: e.claim,
      };
    });

    // If there's counter-evidence, add a gap noting the contradiction
    if (counterEvidenceCount > 0) {
      gaps.push(
        `${counterEvidenceCount} counter-evidence item(s) present — contradictory claims are shown side-by-side, no silent selection.`
      );
    }

    dimensions.push({
      sector,
      observabilityMode: mode,
      indicators,
      gaps,
      evidenceCount: evidence.length,
      independentSourceCount: independentCount,
      counterEvidenceCount,
    });
  }

  // 5. Sort dimensions by sector name for deterministic output
  dimensions.sort((a, b) => a.sector.localeCompare(b.sector));

  // 6. Build summary
  const summary = {
    strongSectors: dimensions.filter((d) => d.observabilityMode === "FULL").map((d) => d.sector),
    weakSectors: dimensions.filter((d) => d.observabilityMode === "PARTIAL").map((d) => d.sector),
    unknownSectors: dimensions.filter((d) => d.observabilityMode === "LOW").map((d) => d.sector),
  };

  // 7. Determine if the country is fictional (Demolandia)
  const country = await tx.country.findUnique({ where: { id: countryId } });
  const isFictional = country
    ? country.iso3 === "DML" || country.displayName.toLowerCase().includes("demolandia")
    : false;

  const sourceNote = isFictional
    ? "Fictional fixture country (Demolandia). All evidence is synthetic. Baseline reflects fictional data only. Sectors without attributed evidence appear as LOW (unknown)."
    : "Baseline computed from tenant-scoped evidence scoped to the target country (metadata.countryId). Sectors without attributed evidence appear as LOW (unknown).";

  let finalSourceNote = sourceNote;
  if (scoping.unattributedCount > 0) {
    finalSourceNote += ` ${scoping.unattributedCount} evidence item(s) without metadata.countryId were excluded (unattributed).`;
  }
  if (scoping.otherCountryCount > 0) {
    finalSourceNote += ` ${scoping.otherCountryCount} evidence item(s) belonging to other countries were excluded.`;
  }

  return {
    countryId,
    computedAt: new Date().toISOString(),
    dimensions,
    summary,
    honesty: {
      fictional: isFictional,
      sourceNote: finalSourceNote,
      computedBy: "baseline-engine-v1",
      rulesVersion: "adr-0014-v1",
      unattributedEvidenceCount: scoping.unattributedCount,
      otherCountryEvidenceCount: scoping.otherCountryCount,
    },
  };
}

// ============================================================
// COMPUTE BASELINE (public API — runs as Durable Task)
// ============================================================
//
// FIX-4 changes:
//   - Dynamic idempotency key: includes evidence state (count + last update)
//     so adding new evidence produces a new task + fresh report.
//   - Uses claimTaskById (G00 extension) instead of inline SQL:
//     * Respects lease contract (never steals active tasks)
//     * Reuses G00's fencing + event logging
//   - If task already completed AND evidence hasn't changed → return cached report
//   - If task already completed BUT evidence changed → create new task + recompute

export async function computeBaseline(
  session: Session,
  input: ComputeBaselineInput
): Promise<{ taskId: string; report: BaselineReport }> {
  // Permission check FIRST (current DB role, not stale JWT)
  await requirePermissionWithCurrentRole(session, "baseline:compute");

  if (!input.countryId || input.countryId.length === 0) {
    throw new Error("countryId is required");
  }

  // FIX-4: Compute evidence state snapshot for dynamic idempotency key
  // If evidence changes (new evidence added), the key changes → new task → fresh report
  const evidenceState = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Count evidence for this tenant scoped to this country (via metadata.countryId)
    // + get the max updatedAt
    const result = await tx.$queryRaw<{ count: bigint; maxUpdate: Date | null }[]>`
      SELECT
        COUNT(*)::text::bigint AS "count",
        MAX("updatedAt") AS "maxUpdate"
      FROM "evidence"
      WHERE "tenantId" = ${tenantId}
        AND (metadata->>'countryId') = ${input.countryId}
    `;
    return {
      count: Number(result[0]?.count ?? 0),
      maxUpdate: result[0]?.maxUpdate ? result[0].maxUpdate.toISOString() : "none",
    };
  });

  // Dynamic idempotency key: country + sectors + evidence state
  // If evidence changes → key changes → new task → fresh report
  const sectorsPart = input.sectors?.join(",") ?? "all";
  const idempotencyKey = `baseline:${input.countryId}:${sectorsPart}:ev-${evidenceState.count}:${evidenceState.maxUpdate}`;

  // 1. Create the Durable Task (idempotent — prevents duplicate baselines for same evidence state)
  const { taskId, created } = await createTask(session, {
    type: "baseline-compute",
    goal: `Compute State Baseline for country ${input.countryId} (evidence: ${evidenceState.count} items, last update: ${evidenceState.maxUpdate})`,
    input: {
      countryId: input.countryId,
      sectors: input.sectors ?? null,
      evidenceSnapshot: { count: evidenceState.count, maxUpdate: evidenceState.maxUpdate },
    } as unknown as Record<string, unknown>,
    idempotencyKey,
  });

  // If the task already existed (same evidence state), return its output if completed
  if (!created) {
    const existingReport = await getBaselineTaskOutput(session, taskId);
    if (existingReport) {
      return { taskId, report: existingReport };
    }
    // Task exists but not completed — fall through to claim + compute
  }

  // 2. FIX-4: Claim the SPECIFIC task by ID using G00's claimTaskById
  //    This respects the lease contract (never steals active tasks)
  const workerId = "baseline-worker";
  const leaseDurationMs = 60_000;

  const claimed = await claimTaskById(session, taskId, workerId, leaseDurationMs);

  if (!claimed) {
    // Task could not be claimed — either already completed, or held by active worker
    const existingReport = await getBaselineTaskOutput(session, taskId);
    if (existingReport) {
      return { taskId, report: existingReport };
    }
    throw new Error(
      `Baseline task ${taskId} could not be claimed (may be held by another worker with a valid lease). Poll getBaselineTask() for status.`
    );
  }

  // 3. Start the task (G00 contract: startTask verifies claimGeneration + lease)
  await startTask(session, taskId, workerId, claimed.claimGeneration);

  // 4. Run the computation (inside tenant-scoped transaction)
  try {
    const report = await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
      // Verify the country exists (PUBLIC table — readable by all tenants)
      const country = await tx.country.findUnique({ where: { id: input.countryId } });
      if (!country) {
        throw new Error(`Country not found: ${input.countryId}`);
      }

      const computed = await runBaselineComputation(
        tx,
        tenantId,
        input.countryId,
        input.sectors
      );

      return { ...computed, taskId } as BaselineReport;
    });

    // 5. Complete the task (G00 contract: completeTask verifies claimGeneration + lease)
    await completeTask(
      session,
      taskId,
      report as unknown as Record<string, unknown>,
      workerId,
      claimed.claimGeneration
    );

    return { taskId, report };
  } catch (err) {
    // Fail the task with the error message
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
// GET BASELINE TASK (poll status + output)
// ============================================================

export async function getBaselineTask(
  session: Session,
  taskId: string
): Promise<{
  taskId: string;
  status: string;
  progress: number;
  error: string | null;
  report: BaselineReport | null;
}> {
  await requirePermissionWithCurrentRole(session, "baseline:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const task = await tx.task.findFirst({
      where: { id: taskId, tenantId },
    });
    if (!task) {
      throw new Error("Baseline task not found in tenant scope");
    }

    let report: BaselineReport | null = null;
    if (task.status === "completed" && task.output) {
      report = task.output as unknown as BaselineReport;
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
// GET BASELINE TASK OUTPUT (helper — returns report if completed)
// ============================================================

async function getBaselineTaskOutput(
  session: Session,
  taskId: string
): Promise<BaselineReport | null> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const task = await tx.task.findFirst({
      where: { id: taskId, tenantId },
    });
    if (!task || task.status !== "completed" || !task.output) {
      return null;
    }
    return task.output as unknown as BaselineReport;
  });
}

// ============================================================
// GET LATEST BASELINE FOR A COUNTRY (convenience)
// ============================================================

export async function getLatestBaseline(
  session: Session,
  countryId: string
): Promise<{ taskId: string; report: BaselineReport } | null> {
  await requirePermissionWithCurrentRole(session, "baseline:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const task = await tx.task.findFirst({
      where: {
        tenantId,
        type: "baseline-compute",
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
      report: task.output as unknown as BaselineReport,
    };
  });
}
