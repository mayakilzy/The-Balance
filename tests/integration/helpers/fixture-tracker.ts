// tests/integration/helpers/fixture-tracker.ts
// G02-L21 FIX: Exact fixture ownership tracking.
// FIX B: Only tracks records CREATED by this tracker — never pre-existing records.
// FIX C: Complete tracking — callers must use trackOwned, not track.
// FIX A: cleanup must run BEFORE disconnect (callers manage disconnect in finally).
// FINAL ACCEPTANCE ITEM 1: cleanup surfaces real DB errors (no text-based suppression).
//   deleteMany is already idempotent (count=0 for missing records, no throw),
//   so any thrown exception is a real DB error and must be surfaced.
//   Tracking state is RETAINED after failure so the caller can retry or inspect.
import type { PrismaClient } from "@prisma/client";

export interface OwnedRecord { id: string; createdByThisSuite: boolean; }

export class FixtureTracker {
  private ids = {
    alerts: new Set<string>(), varianceRecords: new Set<string>(),
    observations: new Set<string>(), observationPeriods: new Set<string>(),
    indicatorDefinitions: new Set<string>(), programs: new Set<string>(),
    projects: new Set<string>(), budgetLines: new Set<string>(),
    dependencies: new Set<string>(), evidence: new Set<string>(),
    sources: new Set<string>(), objectives: new Set<string>(),
    strategies: new Set<string>(), strategyVersions: new Set<string>(),
    institutions: new Set<string>(), users: new Set<string>(),
    memberships: new Set<string>(),
  };

  // FIX B: trackOwned only tracks when createdByThisSuite = true
  trackOwned = {
    alert: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.alerts.add(r.id); },
    varianceRecord: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.varianceRecords.add(r.id); },
    observation: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.observations.add(r.id); },
    observationPeriod: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.observationPeriods.add(r.id); },
    indicator: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.indicatorDefinitions.add(r.id); },
    program: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.programs.add(r.id); },
    project: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.projects.add(r.id); },
    budgetLine: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.budgetLines.add(r.id); },
    dependency: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.dependencies.add(r.id); },
    evidence: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.evidence.add(r.id); },
    source: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.sources.add(r.id); },
    objective: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.objectives.add(r.id); },
    strategy: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.strategies.add(r.id); },
    strategyVersion: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.strategyVersions.add(r.id); },
    institution: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.institutions.add(r.id); },
    user: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.users.add(r.id); },
    membership: (r: OwnedRecord) => { if (r.createdByThisSuite) this.ids.memberships.add(r.id); },
  };

  // Direct track (for IDs obtained from service calls that we know created the record)
  track = {
    alert: (id: string) => this.ids.alerts.add(id),
    varianceRecord: (id: string) => this.ids.varianceRecords.add(id),
    observation: (id: string) => this.ids.observations.add(id),
    observationPeriod: (id: string) => this.ids.observationPeriods.add(id),
    indicator: (id: string) => this.ids.indicatorDefinitions.add(id),
    program: (id: string) => this.ids.programs.add(id),
    project: (id: string) => this.ids.projects.add(id),
    budgetLine: (id: string) => this.ids.budgetLines.add(id),
    dependency: (id: string) => this.ids.dependencies.add(id),
    evidence: (id: string) => this.ids.evidence.add(id),
    source: (id: string) => this.ids.sources.add(id),
    objective: (id: string) => this.ids.objectives.add(id),
    strategy: (id: string) => this.ids.strategies.add(id),
    strategyVersion: (id: string) => this.ids.strategyVersions.add(id),
    institution: (id: string) => this.ids.institutions.add(id),
    user: (id: string) => this.ids.users.add(id),
    membership: (id: string) => this.ids.memberships.add(id),
  };

  get trackedCount(): number {
    return Object.values(this.ids).reduce((s, set) => s + set.size, 0);
  }

  /**
   * Delete only tracked records in FK-safe order.
   * FIX A: Caller must run this BEFORE disconnecting Prisma clients.
   * Caller should wrap disconnect in finally block.
   *
   * FINAL ACCEPTANCE ITEM 1 — error propagation:
   *   deleteMany is idempotent (returns { count: 0 } for missing records, no throw).
   *   Therefore ANY thrown exception is a real database error and MUST be surfaced.
   *   The previous text-based suppression (`msg.includes("not found")`) could swallow
   *   real DB errors whose message happened to contain that substring. Removed.
   *
   * State retention:
   *   On failure, `this.ids` is NOT cleared — the caller can retry cleanup or inspect
   *   the remaining tracked IDs to determine which records need manual attention.
   */
  async cleanup(client: PrismaClient): Promise<void> {
    const errors: string[] = [];
    const del = async (set: Set<string>, model: string, fn: (id: string) => Promise<{ count: number }>) => {
      for (const id of set) {
        try {
          await fn(id);
          // deleteMany is idempotent: count=0 if record was cascade-deleted earlier — no exception.
        } catch (e) {
          // Real database error (FK constraint, connection loss, permission, etc.).
          // Surface it — do NOT swallow based on message text.
          errors.push(`${model} ${id}: ${(e as Error).message}`);
        }
      }
    };
    // FK-safe order
    await del(this.ids.alerts, "alert", (id) => client.alert.deleteMany({ where: { id } }));
    await del(this.ids.varianceRecords, "varianceRecord", (id) => client.varianceRecord.deleteMany({ where: { id } }));
    await del(this.ids.observations, "observation", (id) => client.observation.deleteMany({ where: { id } }));
    await del(this.ids.evidence, "evidence", (id) => client.evidence.deleteMany({ where: { id } }));
    await del(this.ids.observationPeriods, "observationPeriod", (id) => client.observationPeriod.deleteMany({ where: { id } }));
    await del(this.ids.indicatorDefinitions, "indicatorDefinition", (id) => client.indicatorDefinition.deleteMany({ where: { id } }));
    await del(this.ids.projects, "project", (id) => client.project.deleteMany({ where: { id } }));
    await del(this.ids.budgetLines, "budgetLine", (id) => client.budgetLine.deleteMany({ where: { id } }));
    await del(this.ids.dependencies, "dependency", (id) => client.dependency.deleteMany({ where: { id } }));
    await del(this.ids.programs, "program", (id) => client.program.deleteMany({ where: { id } }));
    await del(this.ids.objectives, "objective", (id) => client.objective.deleteMany({ where: { id } }));
    await del(this.ids.strategyVersions, "strategyVersion", (id) => client.strategyVersion.deleteMany({ where: { id } }));
    await del(this.ids.strategies, "strategy", (id) => client.strategy.deleteMany({ where: { id } }));
    await del(this.ids.sources, "source", (id) => client.source.deleteMany({ where: { id } }));
    await del(this.ids.institutions, "institution", (id) => client.institution.deleteMany({ where: { id } }));
    await del(this.ids.memberships, "membership", (id) => client.membership.deleteMany({ where: { id } }));
    await del(this.ids.users, "user", (id) => client.user.deleteMany({ where: { id } }));

    if (errors.length === 0) {
      for (const key of Object.keys(this.ids) as Array<keyof typeof this.ids>) this.ids[key].clear();
    } else {
      // Retain tracking state after failure — caller can retry or inspect.
      throw new Error(`FixtureTracker cleanup failed for ${errors.length} record(s):\n${errors.join("\n")}`);
    }
  }
}
