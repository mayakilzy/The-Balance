// tests/integration/helpers/fixture-tracker.ts
// G02-L21 FIX: Exact fixture ownership tracking.
import type { PrismaClient } from "@prisma/client";

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

  async cleanup(client: PrismaClient): Promise<void> {
    const errors: string[] = [];
    const del = async (set: Set<string>, model: string, fn: (id: string) => Promise<{ count: number }>) => {
      for (const id of set) {
        try {
          const result = await fn(id);
          // deleteMany returns { count: 0 } if already cascade-deleted — that's OK
          // Real database errors throw and are caught below
        } catch (e) {
          const msg = (e as Error).message;
          // "No record found" is expected for cascade-deleted records — not an error
          if (msg.includes("No record was found") || msg.includes("not found")) {
            continue;
          }
          errors.push(`${model} ${id}: ${msg}`);
        }
      }
    };
    // FK-safe order — using deleteMany (idempotent, doesn't throw if already deleted)
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
      throw new Error(`FixtureTracker cleanup failed for ${errors.length} record(s):\n${errors.join("\n")}`);
    }
  }
}
