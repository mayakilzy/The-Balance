// ============================================================
// portfolio-service.ts — Portfolio & Dependency Graph
// ------------------------------------------------------------
// Mission 01-05: Build a directed dependency graph linking
// programs across sectors. Detect cycles. Identify critical path.
//
// buildPortfolio(session, { strategyAlternativeId }) → Portfolio
// addDependency(session, input) → PortfolioEdge
//
// Portfolio = {
//   strategyAlternativeId,
//   nodes: PortfolioNode[],            // programs in the alternative
//   edges: PortfolioEdge[],            // directed edges between programs
//   criticalPath: programId[],         // longest requires+enables chain (UNWEIGHTED)
//   cycles: [],                        // ALWAYS empty — cycles rejected at insertion
//   temporalDisclaimer: string,        // explicit caveat: no temporal weights
// }
//
// Edge types (per mission pack §2):
//   - requires  — ordering: A → B means A is the PREREQUISITE, B depends on A.
//                 Semantically: "B requires A to be done first" or "A is required by B".
//   - enables   — ordering: A → B means A is the ENABLER, B is enabled by A.
//                 Semantically: "A's outputs enable B" or "B is enabled by A".
//   - conflicts — non-ordering: A and B are mutually exclusive (resource/policy clash).
//                 Direction is informational; bidirectional conflicts are allowed.
//
// Direction convention (FIX-2 — kept consistent across the codebase):
//   For `requires` and `enables`:
//     edge fromProgramId → toProgramId means:
//       - fromProgramId is the PREREQUISITE / ENABLER (comes first in execution order)
//       - toProgramId is the DEPENDENT (comes after, depends on fromProgramId's outputs)
//     So a chain A → B → C means: A precedes B, B precedes C, in execution order.
//     This matches the standard topological-sort convention (edges point from
//     earlier to later) and is what the critical-path computation assumes.
//
//   For `conflicts`:
//     Direction is informational only — conflicts do NOT participate in cycle
//     detection or critical-path computation. Both A → B and B → A conflicts
//     edges are allowed (and may coexist) to express mutual exclusion.
//
//   Callers specify fromProgramId + toProgramId explicitly. The rationale MUST
//   describe the direction in plain language consistent with this convention
//   (e.g. "Program A's irrigation outputs are a prerequisite for Program B's
//   agricultural expansion" for a requires edge A → B). The service does not
//   second-guess the caller's direction — it validates structural integrity
//   and provenance only.
//
// Cycle detection (per mission pack §4):
//   - Only `requires` + `enables` participate in dependency ordering.
//   - `conflicts` are mutual-exclusion flags, NOT temporal constraints,
//     so they do NOT participate in cycle detection.
//   - DFS from toProgramId after tentatively adding the proposed edge.
//     If toProgramId can reach fromProgramId through existing ordering
//     edges, adding fromProgramId → toProgramId would close a cycle.
//
// Critical path (per mission pack §5):
//   - Longest chain in the DAG of requires+enables edges.
//   - UNWEIGHTED — counts edges, not durations.
//   - temporalDisclaimer explicitly states this. Real temporal critical
//     path requires scheduling data (mission 01-07).
//
// Concurrency (per mission pack §4):
//   - pg_advisory_xact_lock(hashtext(strategyAlternativeId)) serializes
//     concurrent addDependency calls for the SAME alternative.
//   - Different alternatives run in parallel.
//   - This prevents the race where two workers each pass cycle detection
//     and commit edges that together form a cycle.
//
// Idempotency (per mission pack §6):
//   - Unique index on (tenantId, fromProgramId, toProgramId, type)
//     exists from migration 0017. Re-adding the same edge returns the
//     existing record (P2002 recovery pattern, same as program-service).
//   - buildPortfolio is a pure read — calling it twice returns the same
//     result.
//
// Tenant isolation (per mission pack §6):
//   - RLS on dependencies + programs enforces isolation.
//   - Cross-tenant trigger (enforce_dependency_same_tenant) rejects
//     edges where fromProgramId or toProgramId is in a different tenant.
//
// Cross-alternative protection (per mission pack §6):
//   - Both endpoints must belong to the SAME strategyVersionId.
//   - Edges cannot cross alternatives. This is enforced at the service
//     layer (we fetch programs by strategyVersionId and reject if either
//     endpoint isn't in the set).
//
// Simulation labeling (per mission pack §6):
//   - Every edge has a `source` field: "human" | "documented" | "simulated".
//   - `simulated: boolean` is derived: true iff source === "simulated".
//   - The buildPortfolio output exposes both for clarity.
//
// Provenance enforcement (FIX-1):
//   - source="human"      — a human-supplied assertion. NO evidence required.
//                           Treated as an opinion, not a verified fact.
//   - source="documented" — REQUIRES an evidenceRef pointing to a real Evidence
//                           row in the same tenant + country scope. The evidence
//                           is validated (exists, has metadata.countryId matching
//                           the strategy version's country). The evidenceRef is
//                           stored in the edge's metadata and exposed via
//                           PortfolioEdge.evidenceRef.
//                           IMPORTANT: an evidence reference is EXAMINABLE SUPPORT,
//                           not proof of causality. It means "a human cited this
//                           evidence when documenting the relation" — it does NOT
//                           mean the evidence proves the relation is causal.
//   - source="simulated"  — a test/fictional relation. NO evidence required.
//                           Used for fixtures and LLM-simulated inferences.
//
// Per ADR-0013. Reuses G00 + 01-00 + 01-03 + 01-04 contracts.
// No new migration — `dependencies` table + unique index + RLS + cross-tenant
// trigger already exist from migration 0017.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES — Portfolio & Dependency Edge
// ============================================================

export type DependencyType = "requires" | "enables" | "conflicts";

// Source / provenance of the edge — distinguishes documented relations
// from human-supplied and from LLM-simulated inferences.
export type DependencySource = "human" | "documented" | "simulated";

// Evidence reference attached to a `documented` edge.
// Reuses the same shape as strategy-composer-service's EvidenceRef so the
// provenance vocabulary stays consistent across the platform.
export interface DependencyEvidenceRef {
  evidenceId: string;
  claim: string;              // what the evidence says that supports this edge
  sourceCode: string | null;  // optional source code (e.g. "REUTERS", "WORLD_BANK")
}

export interface PortfolioNode {
  programId: string;
  title: string;
  sector: string;
  strategyVersionId: string;
  status: string; // "draft" — we never modify program status in 01-05
  simulated: boolean;
}

export interface PortfolioEdge {
  id: string;
  fromProgramId: string;
  toProgramId: string;
  type: DependencyType;
  rationale: string | null;
  source: DependencySource;
  simulated: boolean; // true iff source === "simulated"
  // evidenceRef is present ONLY when source === "documented". Null otherwise.
  // An evidence reference is examinable support, NOT proof of causality.
  evidenceRef: DependencyEvidenceRef | null;
  createdAt: Date;
}

export interface Portfolio {
  strategyAlternativeId: string;
  nodes: PortfolioNode[];
  edges: PortfolioEdge[];
  criticalPath: string[]; // programIds forming the longest requires+enables chain
  cycles: []; // ALWAYS empty — cycles are rejected at insertion
  temporalDisclaimer: string;
}

export interface AddDependencyInput {
  strategyAlternativeId: string;
  fromProgramId: string;
  toProgramId: string;
  type: DependencyType;
  rationale: string;
  source: DependencySource;
  // evidenceRef is REQUIRED when source === "documented".
  // Must be null/undefined for source === "human" | "simulated".
  // When provided, the evidence is validated against the strategy version's
  // tenant + country scope (fail-closed, same as strategy-composer-service.ts).
  evidenceRef?: DependencyEvidenceRef | null;
}

// ============================================================
// ERRORS
// ============================================================

export class DependencyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyValidationError";
  }
}

export class CycleDetectedError extends Error {
  readonly fromProgramId: string;
  readonly toProgramId: string;
  constructor(fromProgramId: string, toProgramId: string, message: string) {
    super(message);
    this.name = "CycleDetectedError";
    this.fromProgramId = fromProgramId;
    this.toProgramId = toProgramId;
  }
}

export class PortfolioIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioIntegrityError";
  }
}

// ============================================================
// HELPERS — mappers
// ============================================================

function toPortfolioNode(p: {
  id: string;
  title: string;
  sector: string;
  strategyVersionId: string;
  status: string;
  metadata: unknown;
}): PortfolioNode {
  const meta = (p.metadata ?? {}) as Record<string, unknown>;
  return {
    programId: p.id,
    title: p.title,
    sector: p.sector,
    strategyVersionId: p.strategyVersionId,
    status: p.status,
    simulated: (meta.simulated as boolean) ?? true,
  };
}

function toPortfolioEdge(d: {
  id: string;
  fromProgramId: string;
  toProgramId: string;
  type: string;
  rationale: string | null;
  metadata: unknown;
  createdAt: Date;
}): PortfolioEdge {
  const meta = (d.metadata ?? {}) as Record<string, unknown>;
  const source = (meta.source as DependencySource) ?? "simulated";
  // evidenceRef is stored in metadata only for documented edges.
  // For human/simulated edges, it's null.
  let evidenceRef: DependencyEvidenceRef | null = null;
  if (source === "documented") {
    const raw = meta.evidenceRef as Record<string, unknown> | undefined;
    if (raw && typeof raw.evidenceId === "string" && typeof raw.claim === "string") {
      evidenceRef = {
        evidenceId: raw.evidenceId,
        claim: raw.claim,
        sourceCode: typeof raw.sourceCode === "string" ? raw.sourceCode : null,
      };
    }
  }
  return {
    id: d.id,
    fromProgramId: d.fromProgramId,
    toProgramId: d.toProgramId,
    type: d.type as DependencyType,
    rationale: d.rationale,
    source,
    simulated: source === "simulated",
    evidenceRef,
    createdAt: d.createdAt,
  };
}

// ============================================================
// CYCLE DETECTION — DFS
// ------------------------------------------------------------
// Given the existing requires+enables edges for a strategy version,
// determine whether adding fromProgramId → toProgramId would create
// a cycle. A cycle exists iff toProgramId can already reach
// fromProgramId through existing ordering edges.
//
// Returns true if adding the edge would create a cycle.
// ============================================================

interface OrderingEdge {
  from: string;
  to: string;
}

async function fetchOrderingEdges(
  tx: Prisma.TransactionClient,
  tenantId: string,
  programIds: Set<string>
): Promise<OrderingEdge[]> {
  // Pull all dependencies whose EITHER endpoint is in this strategy version.
  // We filter to both-endpoints-in-set below — this is the cheapest query
  // that the unique indexes (tenantId, fromProgramId) + (tenantId, toProgramId)
  // can serve efficiently.
  const candidateIds = [...programIds];
  if (candidateIds.length === 0) return [];

  const deps = await tx.dependency.findMany({
    where: {
      tenantId,
      OR: [
        { fromProgramId: { in: candidateIds } },
        { toProgramId: { in: candidateIds } },
      ],
    },
    select: { fromProgramId: true, toProgramId: true, type: true },
  });

  // Filter: only requires+enables, and both endpoints in this strategy version.
  return deps
    .filter((d) => d.type === "requires" || d.type === "enables")
    .filter((d) => programIds.has(d.fromProgramId) && programIds.has(d.toProgramId))
    .map((d) => ({ from: d.fromProgramId, to: d.toProgramId }));
}

function buildAdjacency(
  programIds: Set<string>,
  edges: OrderingEdge[]
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const pid of programIds) adj.set(pid, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  return adj;
}

/**
 * Detect whether adding `fromProgramId → toProgramId` to the existing
 * `requires`+`enables` graph would create a cycle.
 *
 * Strategy: DFS from `toProgramId` using existing edges. If we can reach
 * `fromProgramId`, the proposed edge would close a cycle.
 *
 * Iterative DFS (no recursion-depth concerns for typical strategy versions,
 * but defensive against deep chains).
 */
function wouldCreateCycle(
  programIds: Set<string>,
  existingEdges: OrderingEdge[],
  fromProgramId: string,
  toProgramId: string
): boolean {
  if (fromProgramId === toProgramId) return true; // self-loop (DB also rejects this)
  if (!programIds.has(fromProgramId) || !programIds.has(toProgramId)) {
    // Should be caught earlier; defensive.
    return false;
  }

  const adj = buildAdjacency(programIds, existingEdges);
  const visited = new Set<string>();
  const stack: string[] = [toProgramId];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === fromProgramId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    const neighbors = adj.get(node) ?? [];
    for (const n of neighbors) {
      if (!visited.has(n)) stack.push(n);
    }
  }
  return false;
}

/**
 * Defensive cycle detection — used in buildPortfolio to verify integrity.
 * Returns a list of cycles (each cycle is a list of programIds). If the
 * graph is a DAG (the invariant we maintain), this returns [].
 *
 * Uses standard DFS with a "currently in stack" marker to find back-edges.
 */
function detectCycles(
  programIds: Set<string>,
  edges: OrderingEdge[]
): string[][] {
  const adj = buildAdjacency(programIds, edges);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const pid of programIds) color.set(pid, WHITE);

  const cycles: string[][] = [];

  function dfs(start: string): void {
    const stack: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];
    // We need to track the in-stack path to reconstruct the cycle.
    // Standard iterative DFS with color marking.
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
          // Back-edge — found a cycle. Reconstruct from the current path.
          const path = top.path;
          const cycleStart = path.indexOf(n);
          const cycle = path.slice(cycleStart).concat([n]);
          cycles.push(cycle);
          // Continue scanning other neighbors — there may be more cycles.
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
// CRITICAL PATH — Longest chain in DAG
// ------------------------------------------------------------
// Uses Kahn's algorithm (topological sort) with depth tracking.
// For each node, we store the longest path ending at that node.
// When we dequeue a node, we extend the longest path to its neighbors.
//
// Returns the longest path (as a list of programIds). If there are
// multiple paths with the same length, returns the lexicographically
// smallest one (deterministic).
//
// Only requires+enables edges participate. conflicts are NOT considered.
//
// UNWEIGHTED: each edge contributes 1 to the path length. No temporal
// weights. The caller MUST display temporalDisclaimer alongside the
// critical path.
// ============================================================

function computeCriticalPath(
  programIds: Set<string>,
  edges: OrderingEdge[]
): string[] {
  if (programIds.size === 0) return [];

  const adj = buildAdjacency(programIds, edges);
  const indegree = new Map<string, number>();
  for (const pid of programIds) indegree.set(pid, 0);
  for (const e of edges) {
    if (!indegree.has(e.to)) indegree.set(e.to, 0);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  // longestPath[node] = longest path (list of programIds) ending at `node`
  const longestPath = new Map<string, string[]>();
  // Process nodes in a deterministic order — sort by programId
  const sortedPids = [...programIds].sort();

  // Initialize queue with all zero-indegree nodes
  // Use a sorted queue for determinism
  let queue: string[] = sortedPids.filter((pid) => (indegree.get(pid) ?? 0) === 0);
  for (const pid of queue) longestPath.set(pid, [pid]);

  let bestPath: string[] = [];
  // Track which path is best — when tied on length, lexicographically smallest
  function consider(path: string[]): void {
    if (path.length > bestPath.length) {
      bestPath = path;
    } else if (path.length === bestPath.length && path.length > 0) {
      // Tie-break: lexicographically smaller path
      for (let i = 0; i < path.length; i++) {
        const a = path[i] ?? "";
        const b = bestPath[i] ?? "";
        if (a < b) { bestPath = path; break; }
        if (a > b) break;
      }
    }
  }

  while (queue.length > 0) {
    // Always pick the lexicographically smallest node from the queue for determinism
    queue.sort();
    const node = queue.shift()!;
    const currentPath = longestPath.get(node) ?? [node];
    consider(currentPath);

    const neighbors = (adj.get(node) ?? []).slice().sort();
    for (const neighbor of neighbors) {
      const newPath = [...currentPath, neighbor];
      const existing = longestPath.get(neighbor);
      if (!existing || newPath.length > existing.length ||
          (newPath.length === existing.length && newPath.join("") < existing.join(""))) {
        longestPath.set(neighbor, newPath);
      }
      const newIndegree = (indegree.get(neighbor) ?? 1) - 1;
      indegree.set(neighbor, newIndegree);
      if (newIndegree === 0 && !queue.includes(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  // If bestPath is empty (e.g., isolated nodes with no edges), pick the
  // lex-smallest single node so the result is always defined.
  if (bestPath.length === 0 && sortedPids.length > 0) {
    bestPath = [sortedPids[0]!];
  }

  return bestPath;
}

// ============================================================
// BUILD PORTFOLIO (public READ API — idempotent)
// ============================================================

export async function buildPortfolio(
  session: Session,
  input: { strategyAlternativeId: string }
): Promise<Portfolio> {
  // Read-only — admin, analyst, reviewer. NOT observer.
  await requirePermissionWithCurrentRole(session, "program:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // 1. Validate the strategy version belongs to this tenant
    const version = await tx.strategyVersion.findFirst({
      where: { id: input.strategyAlternativeId, tenantId },
      select: { id: true },
    });
    if (!version) {
      throw new Error(
        `Strategy version ${input.strategyAlternativeId} not found in tenant scope. ` +
        `Cannot build a portfolio for a strategy that doesn't belong to this tenant.`
      );
    }

    // 2. Fetch all programs in this strategy version (nodes)
    const programs = await tx.program.findMany({
      where: { tenantId, strategyVersionId: input.strategyAlternativeId },
      orderBy: { title: "asc" },
    });

    const programIds = new Set(programs.map((p) => p.id));

    // 3. Fetch all dependencies where BOTH endpoints are in this strategy version.
    // This is the cross-alternative protection: edges cannot cross alternatives.
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
          orderBy: { createdAt: "asc" },
        });

    // Filter to both-endpoints-in-this-alternative
    const edges = allDeps.filter(
      (d) => programIds.has(d.fromProgramId) && programIds.has(d.toProgramId)
    );

    // 4. Build ordering edges (requires + enables only) for cycle check + critical path
    const orderingEdges: OrderingEdge[] = edges
      .filter((d) => d.type === "requires" || d.type === "enables")
      .map((d) => ({ from: d.fromProgramId, to: d.toProgramId }));

    // 5. Defensive integrity check: verify NO cycles exist.
    // Cycles should be impossible because addDependency rejects them. If we find
    // any here, it indicates a bug (or someone bypassed the service layer).
    const detectedCycles = detectCycles(programIds, orderingEdges);
    if (detectedCycles.length > 0) {
      throw new PortfolioIntegrityError(
        `Portfolio integrity violation: ${detectedCycles.length} cycle(s) detected in ` +
        `strategy version ${input.strategyAlternativeId}. Cycles are rejected at ` +
        `insertion — this indicates a bug or DB-level corruption. ` +
        `First cycle: ${detectedCycles[0]!.join(" → ")}.`
      );
    }

    // 6. Compute critical path (longest requires+enables chain — UNWEIGHTED)
    const criticalPath = computeCriticalPath(programIds, orderingEdges);

    // 7. Build the Portfolio object
    return {
      strategyAlternativeId: input.strategyAlternativeId,
      nodes: programs.map(toPortfolioNode),
      edges: edges.map(toPortfolioEdge),
      criticalPath,
      cycles: [] as const, // ALWAYS empty — invariant enforced at insertion
      temporalDisclaimer:
        "Critical path is STRUCTURAL and UNWEIGHTED. It counts dependency edges, " +
        "not program durations. A true temporal critical path requires scheduling " +
        "data (planned start/end years per program), which is introduced in " +
        "mission 01-07 (Implementation Roadmap). Until then, treat this path as " +
        "the longest dependency chain — not the longest-duration chain.",
    };
  });
}

// ============================================================
// ADD DEPENDENCY (public WRITE API — single edge)
// ------------------------------------------------------------
// Validates:
//   1. Permission: strategy:write (analyst + admin)
//   2. Both programs exist in the same tenant (RLS-enforced)
//   3. Both programs belong to the SAME strategyVersionId
//      (cross-alternative protection)
//   4. fromProgramId !== toProgramId (self-loop — DB also CHECKs this)
//   5. For requires+enables: adding the edge would NOT create a cycle
//      (DFS check on existing ordering edges)
//   6. Idempotent: if the same (from, to, type) edge exists, return it
//      (P2002 recovery pattern — same as program-service)
//   7. FIX-1: If source="documented", an evidenceRef MUST be provided and
//      validated against the strategy version's tenant + country scope
//      (fail-closed — evidence without metadata.countryId is rejected,
//      same as strategy-composer-service.ts). The evidenceRef is stored
//      in the edge's metadata and exposed via PortfolioEdge.evidenceRef.
//      An evidence reference is examinable support, NOT proof of causality.
//
// Concurrency:
//   pg_advisory_xact_lock(hashtext(strategyAlternativeId)) serializes
//   concurrent addDependency calls for the SAME alternative. Different
//   alternatives run in parallel. This prevents the race where two
//   workers each pass cycle detection and commit edges that together
//   form a cycle.
// ============================================================

export async function addDependency(
  session: Session,
  input: AddDependencyInput
): Promise<PortfolioEdge> {
  // Write — admin + analyst only
  await requirePermissionWithCurrentRole(session, "strategy:write");

  // Basic input validation
  if (!input.strategyAlternativeId) {
    throw new DependencyValidationError("strategyAlternativeId is required");
  }
  if (!input.fromProgramId || !input.toProgramId) {
    throw new DependencyValidationError("fromProgramId and toProgramId are required");
  }
  if (input.fromProgramId === input.toProgramId) {
    throw new DependencyValidationError(
      `Self-loops are not allowed: fromProgramId and toProgramId are both ${input.fromProgramId}. ` +
      `A program cannot depend on itself.`
    );
  }
  if (!["requires", "enables", "conflicts"].includes(input.type)) {
    throw new DependencyValidationError(
      `Invalid dependency type: "${input.type}". Must be one of: requires, enables, conflicts.`
    );
  }
  if (!input.rationale || input.rationale.trim().length === 0) {
    throw new DependencyValidationError(
      "rationale is required — every dependency edge must document why it exists."
    );
  }
  if (!["human", "documented", "simulated"].includes(input.source)) {
    throw new DependencyValidationError(
      `Invalid source: "${input.source}". Must be one of: human, documented, simulated.`
    );
  }

  // === FIX-1: PROVENANCE ENFORCEMENT (pre-transaction structural check) ===
  // - source="documented" REQUIRES a non-empty evidenceRef with evidenceId + claim.
  // - source="human" | "simulated" must NOT carry an evidenceRef (would be misleading).
  // - The actual evidence existence + country-scope check happens inside the
  //   transaction below (needs the strategy version's countryId).
  if (input.source === "documented") {
    if (!input.evidenceRef ||
        !input.evidenceRef.evidenceId ||
        input.evidenceRef.evidenceId.trim().length === 0 ||
        !input.evidenceRef.claim ||
        input.evidenceRef.claim.trim().length === 0) {
      throw new DependencyValidationError(
        `source="documented" requires an evidenceRef with a non-empty evidenceId and claim. ` +
        `A rationale text alone does not constitute documentation — a verifiable evidence ` +
        `reference is required. Use source="human" for human-supplied assertions without ` +
        `evidence, or source="simulated" for test/fictional relations.`
      );
    }
  } else {
    // source is "human" or "simulated" — evidenceRef must NOT be provided.
    // Allowing it would blur the provenance distinction: a "human" edge with
    // an evidenceRef might be mistaken for a "documented" edge.
    if (input.evidenceRef) {
      throw new DependencyValidationError(
        `source="${input.source}" must not include an evidenceRef. ` +
        `evidenceRef is reserved for source="documented" edges. ` +
        `If you have evidence to cite, use source="documented" instead.`
      );
    }
  }

  try {
    return await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
      // === CONCURRENCY SERIALIZATION ===
      // Acquire a transaction-scoped advisory lock keyed on the strategy version.
      // This ensures that two concurrent addDependency calls for the SAME
      // alternative serialize — the second waits for the first to commit/rollback
      // before running its cycle check. This prevents the race where two workers
      // each pass cycle detection independently and commit edges that together
      // form a cycle.
      //
      // hashtext() returns a 32-bit int — collisions across versions are possible
      // but harmless (they just cause unnecessary serialization). Within a version,
      // the lock is consistent.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.strategyAlternativeId}))`;

      // === VALIDATE ENDPOINTS ===
      // Both programs must exist in this tenant AND belong to the SAME
      // strategy version (cross-alternative protection).
      const [fromProgram, toProgram] = await Promise.all([
        tx.program.findFirst({
          where: {
            id: input.fromProgramId,
            tenantId,
            strategyVersionId: input.strategyAlternativeId,
          },
          select: { id: true, title: true },
        }),
        tx.program.findFirst({
          where: {
            id: input.toProgramId,
            tenantId,
            strategyVersionId: input.strategyAlternativeId,
          },
          select: { id: true, title: true },
        }),
      ]);

      if (!fromProgram) {
        throw new DependencyValidationError(
          `fromProgram ${input.fromProgramId} not found in tenant ${tenantId} ` +
          `for strategy version ${input.strategyAlternativeId}. ` +
          `Cross-tenant and cross-alternative dependencies are not allowed.`
        );
      }
      if (!toProgram) {
        throw new DependencyValidationError(
          `toProgram ${input.toProgramId} not found in tenant ${tenantId} ` +
          `for strategy version ${input.strategyAlternativeId}. ` +
          `Cross-tenant and cross-alternative dependencies are not allowed.`
        );
      }

      // === FIX-1: EVIDENCE VALIDATION (for source="documented") ===
      // Fail-closed policy, same as strategy-composer-service.ts:
      //   1. Fetch the strategy version to get the countryId from
      //      metadata.inputSnapshot.countryId.
      //   2. Verify the cited evidence exists in the same tenant (RLS-enforced).
      //   3. Verify the evidence has metadata.countryId matching the strategy
      //      version's country. Evidence WITHOUT metadata.countryId is REJECTED
      //      (unattributed evidence cannot be used as documentation).
      //   4. Cross-country evidence is REJECTED.
      //
      // IMPORTANT: this validates that the evidence EXISTS and is in scope.
      // It does NOT verify that the evidence actually proves the causal
      // relation between the two programs. An evidence reference is examinable
      // support — a human cited it — not proof of causality.
      let validatedEvidenceRef: DependencyEvidenceRef | null = null;
      if (input.source === "documented") {
        // We already checked input.evidenceRef is non-empty in the pre-transaction
        // validation. Re-assert here for type narrowing.
        const ref = input.evidenceRef!;

        // 1. Fetch the strategy version to get countryId
        const strategyVersion = await tx.strategyVersion.findFirst({
          where: { id: input.strategyAlternativeId, tenantId },
          select: { id: true, metadata: true },
        });
        if (!strategyVersion) {
          throw new DependencyValidationError(
            `Strategy version ${input.strategyAlternativeId} not found in tenant ${tenantId}. ` +
            `Cannot validate evidence scope without the strategy version.`
          );
        }
        const svMeta = (strategyVersion.metadata ?? {}) as Record<string, unknown>;
        const inputSnapshot = (svMeta.inputSnapshot ?? {}) as Record<string, unknown>;
        const strategyCountryId = typeof inputSnapshot.countryId === "string"
          ? inputSnapshot.countryId : null;
        if (!strategyCountryId) {
          throw new DependencyValidationError(
            `Strategy version ${input.strategyAlternativeId} has no countryId in metadata.inputSnapshot. ` +
            `Cannot validate evidence country scope. This indicates a corrupted strategy version ` +
            `(composer should always set inputSnapshot.countryId).`
          );
        }

        // 2. Verify the evidence exists in tenant scope (RLS enforces tenant isolation)
        const evidence = await tx.evidence.findFirst({
          where: { id: ref.evidenceId, tenantId },
          select: { id: true, metadata: true, sourceId: true, source: { select: { code: true } } },
        });
        if (!evidence) {
          throw new DependencyValidationError(
            `Evidence ${ref.evidenceId} not found in tenant ${tenantId}. ` +
            `Cannot use a non-existent evidence reference as documentation. ` +
            `Cross-tenant evidence references are not allowed.`
          );
        }

        // 3. Fail-closed: evidence MUST have metadata.countryId
        const evMeta = (evidence.metadata ?? {}) as Record<string, unknown>;
        const evidenceCountryId = typeof evMeta.countryId === "string"
          ? evMeta.countryId : null;
        if (!evidenceCountryId) {
          throw new DependencyValidationError(
            `Evidence ${ref.evidenceId} has no metadata.countryId. ` +
            `Fail-closed policy: evidence must be explicitly attributed to a country. ` +
            `Unattributed evidence cannot be used as documentation for a dependency edge.`
          );
        }

        // 4. Cross-country evidence is rejected
        if (evidenceCountryId !== strategyCountryId) {
          throw new DependencyValidationError(
            `Evidence ${ref.evidenceId} belongs to country ${evidenceCountryId}, ` +
            `but strategy version ${input.strategyAlternativeId} is for country ${strategyCountryId}. ` +
            `Cross-country evidence references are not allowed.`
          );
        }

        // Evidence is valid and in scope. Normalize the evidenceRef for storage.
        // Use the source code from the evidence's source if available (more
        // reliable than the caller-supplied sourceCode).
        validatedEvidenceRef = {
          evidenceId: ref.evidenceId,
          claim: ref.claim,
          sourceCode: evidence.source?.code ?? ref.sourceCode ?? null,
        };
      }

      // === IDEMPOTENT RESUME — check if the same edge already exists ===
      const existing = await tx.dependency.findFirst({
        where: {
          tenantId,
          fromProgramId: input.fromProgramId,
          toProgramId: input.toProgramId,
          type: input.type,
        },
      });
      if (existing) {
        // Same edge already exists — return it (idempotent).
        // We don't update rationale/source on re-add: the first writer wins.
        return toPortfolioEdge(existing);
      }

      // === CYCLE DETECTION (only for requires + enables) ===
      // conflicts are mutual-exclusion flags, NOT temporal constraints —
      // they do NOT participate in cycle detection.
      if (input.type === "requires" || input.type === "enables") {
        // Fetch all programs in this strategy version (for the programIds set)
        const allPrograms = await tx.program.findMany({
          where: { tenantId, strategyVersionId: input.strategyAlternativeId },
          select: { id: true },
        });
        const programIds = new Set(allPrograms.map((p) => p.id));
        programIds.add(input.fromProgramId);
        programIds.add(input.toProgramId);

        const orderingEdges = await fetchOrderingEdges(tx, tenantId, programIds);

        if (wouldCreateCycle(programIds, orderingEdges, input.fromProgramId, input.toProgramId)) {
          throw new CycleDetectedError(
            input.fromProgramId,
            input.toProgramId,
            `Adding "${input.type}" edge ${input.fromProgramId} → ${input.toProgramId} ` +
            `would create a cycle in strategy version ${input.strategyAlternativeId}. ` +
            `There is already a dependency path from ${input.toProgramId} back to ` +
            `${input.fromProgramId}. Cycles in dependency ordering are not allowed — ` +
            `revise the rationale or remove the conflicting edge first.`
          );
        }
      }

      // === INSERT ===
      try {
        const metadata: Record<string, unknown> = {
          source: input.source,
          simulated: input.source === "simulated",
          strategyVersionId: input.strategyAlternativeId, // denormalized for audit
          createdAt: new Date().toISOString(),
        };
        // FIX-1: store the validated evidenceRef in metadata for documented edges.
        // This is the verifiable provenance trail — anyone reading the edge
        // can follow the evidenceId to the actual Evidence row.
        if (validatedEvidenceRef) {
          metadata.evidenceRef = {
            evidenceId: validatedEvidenceRef.evidenceId,
            claim: validatedEvidenceRef.claim,
            sourceCode: validatedEvidenceRef.sourceCode,
          };
        }
        const created = await tx.dependency.create({
          data: {
            tenantId,
            fromProgramId: input.fromProgramId,
            toProgramId: input.toProgramId,
            type: input.type,
            rationale: input.rationale,
            metadata: metadata as unknown as Prisma.InputJsonValue,
          },
        });
        return toPortfolioEdge(created);
      } catch (createErr) {
        // P2002 = unique constraint violation on
        // (tenantId, fromProgramId, toProgramId, type).
        // A concurrent worker inserted the same edge between our findFirst
        // and our create. The transaction is now ABORTED in PostgreSQL.
        // We throw a sentinel that the outer catch handles by opening a NEW
        // transaction and reading the winning edge.
        if (createErr && typeof createErr === "object" && "code" in createErr &&
            (createErr as { code: string }).code === "P2002") {
          throw {
            _p2002: true,
            _key: {
              fromProgramId: input.fromProgramId,
              toProgramId: input.toProgramId,
              type: input.type,
            },
          };
        }
        throw createErr;
      }
    });
  } catch (err) {
    // === P2002 RECOVERY (outside the failed transaction) ===
    // Open a NEW transaction and read the winning edge. No recursive retry —
    // a single recovery attempt. If the edge can't be found, throw a clear error.
    if (err && typeof err === "object" && "_p2002" in err) {
      const key = (err as unknown as { _key: { fromProgramId: string; toProgramId: string; type: string } })._key;
      return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
        const existing = await tx.dependency.findFirst({
          where: {
            tenantId,
            fromProgramId: key.fromProgramId,
            toProgramId: key.toProgramId,
            type: key.type,
          },
        });
        if (!existing) {
          throw new Error(
            `P2002 recovery: concurrent insert of dependency ` +
            `${key.fromProgramId} → ${key.toProgramId} (${key.type}) was detected, ` +
            `but no existing edge was found in tenant ${tenantId}. ` +
            `The concurrent worker may have rolled back. No retry loop — please retry manually.`
          );
        }
        return toPortfolioEdge(existing);
      });
    }
    throw err;
  }
}

// ============================================================
// GET DEPENDENCIES (read-only — for inspection / API routes)
// ============================================================

export async function getDependencies(
  session: Session,
  strategyAlternativeId: string
): Promise<PortfolioEdge[]> {
  await requirePermissionWithCurrentRole(session, "program:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const programs = await tx.program.findMany({
      where: { tenantId, strategyVersionId: strategyAlternativeId },
      select: { id: true },
    });
    const programIds = programs.map((p) => p.id);
    if (programIds.length === 0) return [];

    const deps = await tx.dependency.findMany({
      where: {
        tenantId,
        OR: [
          { fromProgramId: { in: programIds } },
          { toProgramId: { in: programIds } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });

    const pidSet = new Set(programIds);
    return deps
      .filter((d) => pidSet.has(d.fromProgramId) && pidSet.has(d.toProgramId))
      .map(toPortfolioEdge);
  });
}
