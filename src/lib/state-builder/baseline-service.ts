// ============================================================
// baseline-service.ts — State Baseline & Observability Modes
// ------------------------------------------------------------
// Mission 01-01: State Baseline & Observability Modes
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
// Runs as a Durable Task (G00 Task Runtime):
//   - Idempotency key prevents duplicate baselines
//   - Crash recovery via lease expiry + reclaimStaleTasks
//   - Tenant isolation via RLS on tasks table
//
// Per ADR-0014. Reuses G00's Evidence Fabric + Task Runtime.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  createTask,
  claimTask,
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
  };
}

export interface ComputeBaselineInput {
  countryId: string;
  // Optional: limit which sectors to compute (default: all sectors with evidence)
  sectors?: string[];
}

// ============================================================
// OBSERVABILITY MODE CLASSIFICATION (per ADR-0014 §1)
// ============================================================
// Thresholds are PUBLIC, AUDITABLE, FALSIFIABLE.
// A reviewer can re-classify by inspecting the raw counts in the report.

interface SectorEvidence {
  sector: string;
  evidence: Array<{
    id: string;
    claim: string;
    type: string; // supporting | counter | neutral
    verificationStatus: string;
    observedAt: Date | null;
    sourceId: string | null;
    sourceCode: string | null;
    independenceGroup: string | null;
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
      // Evidence without a source is its own "group" (cannot verify independence)
      independenceGroups.add(`no-source:${e.id}`);
    } else {
      const group = e.independenceGroup ?? `source:${e.sourceId}`;
      independenceGroups.add(group);
    }
  }
  const independentCount = independenceGroups.size;

  // Check for verified/corroborated evidence
  const hasVerified = evidence.some(
    (e) => e.verificationStatus === "verified" || e.verificationStatus === "corroborated"
  );

  // Check if ALL evidence is disputed/refuted
  const allDisputed = evidence.every(
    (e) => e.verificationStatus === "disputed" || e.verificationStatus === "refuted"
  );

  // FULL: ≥2 independent sources AND ≥1 verified/corroborated
  if (independentCount >= 2 && hasVerified && !allDisputed) {
    return { mode: "FULL", independentCount, gaps: [] };
  }

  // PARTIAL: some evidence, but doesn't meet FULL criteria
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
// BASELINE COMPUTATION (runs inside withAuthenticatedTenant)
// ============================================================

async function runBaselineComputation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  countryId: string,
  sectorsFilter?: string[]
): Promise<Omit<BaselineReport, "taskId">> {
  // 1. Fetch all evidence for this tenant (RLS-enforced — only this tenant's evidence)
  // We include the source for independence_group lookup.
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

  // 2. Group evidence by sector (from metadata.sector)
  // Evidence without metadata.sector is NOT included in the baseline (documented in sourceNote).
  const sectorMap = new Map<string, SectorEvidence["evidence"]>();
  let untaggedCount = 0;

  for (const e of evidenceRows) {
    const metadata = (e.metadata ?? {}) as unknown as Record<string, unknown>;
    const sector = typeof metadata.sector === "string" ? metadata.sector : null;

    if (!sector) {
      untaggedCount++;
      continue;
    }

    // Apply sector filter if provided
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
    });
  }

  // 3. Build dimensions
  const dimensions: BaselineDimension[] = [];
  for (const [sector, evidence] of sectorMap.entries()) {
    const { mode, independentCount, gaps } = classifyObservabilityMode(evidence);

    // Count counter-evidence (type === "counter")
    const counterEvidenceCount = evidence.filter((e) => e.type === "counter").length;

    // Build indicators (preserve ALL evidence — no silent selection)
    const indicators: BaselineIndicator[] = evidence.map((e) => {
      const metadata = {} as Record<string, unknown>;
      return {
        name: extractIndicatorName(e.claim),
        value: extractIndicatorValue(e.claim),
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

  // 4. Sort dimensions by sector name for deterministic output
  dimensions.sort((a, b) => a.sector.localeCompare(b.sector));

  // 5. Build summary
  const summary = {
    strongSectors: dimensions.filter((d) => d.observabilityMode === "FULL").map((d) => d.sector),
    weakSectors: dimensions.filter((d) => d.observabilityMode === "PARTIAL").map((d) => d.sector),
    unknownSectors: dimensions.filter((d) => d.observabilityMode === "LOW").map((d) => d.sector),
  };

  // 6. Determine if the country is fictional (Demolandia)
  const country = await tx.country.findUnique({ where: { id: countryId } });
  const isFictional = country
    ? country.iso3 === "DML" || country.displayName.toLowerCase().includes("demolandia")
    : false;

  const sourceNote = isFictional
    ? "Fictional fixture country (Demolandia). All evidence is synthetic. Baseline reflects fictional data only."
    : "Baseline computed from tenant-scoped evidence. Sectors without tagged evidence (metadata.sector) are not included.";

  if (untaggedCount > 0) {
    sourceNote.concat(` ${untaggedCount} evidence item(s) without metadata.sector were excluded.`);
  }

  return {
    countryId,
    computedAt: new Date().toISOString(),
    dimensions,
    summary,
    honesty: {
      fictional: isFictional,
      sourceNote,
      computedBy: "baseline-engine-v1",
      rulesVersion: "adr-0014-v1",
    },
  };
}

// ============================================================
// HELPERS — extract indicator name/value from claim text
// ============================================================
// These are deliberately simple text extractors. They do NOT fabricate
// values — they return the claim text as-is if no structured value is found.

function extractIndicatorName(claim: string): string {
  // Try to extract a metric name from the claim.
  // For seeded evidence like "Demolandia's agricultural GDP grew 4.2% in 2024",
  // we return "agricultural GDP growth rate" as a heuristic.
  // This is a SIMPLE heuristic — not an LLM. It returns a best-effort name.
  const lower = claim.toLowerCase();
  if (lower.includes("gdp")) return "GDP metric";
  if (lower.includes("unemployment")) return "unemployment rate";
  if (lower.includes("inflation")) return "inflation rate";
  if (lower.includes("enrollment")) return "enrollment rate";
  if (lower.includes("mortality")) return "mortality metric";
  if (lower.includes("crop yield")) return "crop yield";
  if (lower.includes("reserves")) return "reserves metric";
  if (lower.includes("monetary base")) return "monetary base growth";
  // Fallback: first 60 chars of the claim
  return claim.slice(0, 60) + (claim.length > 60 ? "…" : "");
}

function extractIndicatorValue(claim: string): string {
  // Extract a numeric value + unit from the claim, if present.
  // e.g., "grew 4.2%" → "4.2%", "declined" → "declined (no value)"
  const percentMatch = claim.match(/(\d+\.?\d*)\s*%/);
  if (percentMatch) return `${percentMatch[1]}%`;

  const numberMatch = claim.match(/(\d+\.?\d*)/);
  if (numberMatch && numberMatch[1]) return numberMatch[1];

  // No numeric value — return a description, NOT a fabricated number
  if (/decline|drop|fall|decrease/i.test(claim)) return "declined (qualitative)";
  if (/grow|increase|rise|expand/i.test(claim)) return "grew (qualitative)";
  return "value not extracted from claim text";
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
// COMPUTE BASELINE (public API — runs as Durable Task)
// ============================================================

export async function computeBaseline(
  session: Session,
  input: ComputeBaselineInput
): Promise<{ taskId: string; report: BaselineReport }> {
  // Permission check FIRST (current DB role, not stale JWT)
  await requirePermissionWithCurrentRole(session, "baseline:compute");

  if (!input.countryId || input.countryId.length === 0) {
    throw new Error("countryId is required");
  }

  // 1. Create the Durable Task (idempotent — prevents duplicate baselines)
  const idempotencyKey = `baseline:${input.countryId}:${input.sectors?.join(",") ?? "all"}`;
  const { taskId, created } = await createTask(session, {
    type: "baseline-compute",
    goal: `Compute State Baseline for country ${input.countryId}`,
    input: { countryId: input.countryId, sectors: input.sectors ?? null } as unknown as Record<string, unknown>,
    idempotencyKey,
  });

  // If the task already existed (idempotent), return its output if completed
  if (!created) {
    const existingReport = await getBaselineTaskOutput(session, taskId);
    if (existingReport) {
      return { taskId, report: existingReport };
    }
    // Task exists but not completed — return taskId, caller can poll
    throw new Error(
      `Baseline task ${taskId} already exists but has not completed. Poll getBaselineTask() for status.`
    );
  }

  // 2. Claim + start the task
  const claimed = await claimTask(session, "baseline-worker", 60_000);
  if (!claimed || claimed.taskId !== taskId) {
    // Another worker claimed it — return taskId, caller can poll
    throw new Error(
      `Baseline task ${taskId} was created but could not be claimed (another worker may have it). Poll getBaselineTask() for status.`
    );
  }

  await startTask(session, taskId, "baseline-worker", claimed.claimGeneration);

  // 3. Run the computation (inside tenant-scoped transaction)
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

    // 4. Complete the task with the report
    await completeTask(
      session,
      taskId,
      report as unknown as Record<string, unknown>,
      "baseline-worker",
      claimed.claimGeneration
    );

    return { taskId, report };
  } catch (err) {
    // Fail the task with the error message
    await failTask(
      session,
      taskId,
      err instanceof Error ? err.message : String(err),
      "baseline-worker",
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
  // This helper bypasses the permission check (it's called from computeBaseline
  // which already checked baseline:compute). It reads the task output if completed.
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
    // Find the most recent completed baseline task for this country
    const task = await tx.task.findFirst({
      where: {
        tenantId,
        type: "baseline-compute",
        status: "completed",
        // Filter by countryId in the input JSONB
        // Prisma supports JSON filtering via path
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
