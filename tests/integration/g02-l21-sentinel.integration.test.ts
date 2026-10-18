// tests/integration/g02-l21-sentinel.integration.test.ts
// G02-L21 SENTINEL — proves FixtureTracker.cleanup() preserves pre-existing records.
//
// This test exercises the ACTUAL cleanup path against real PostgreSQL (not a mock).
// It verifies the owner's regression criteria:
//   1. Pre-existing ObservationPeriod in the same tenant survives trackOwned + cleanup.
//   2. Observations attached to the pre-existing period survive.
//   3. A NEW ObservationPeriod created by this suite, tracked via trackOwned, IS deleted.
//   4. Tracker state is cleared after a successful cleanup.
//   5. Pre-existing periods that were NEVER tracked are also preserved (defensive).
//   6. Records from a "different suite" (simulated via a second tracker) are not touched.
//
// Test uses periodValue="2099-Q*" to avoid collision with real test fixtures that use 2026-Q2.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { FixtureTracker } from "./helpers/fixture-tracker";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let adminClient: PrismaClient;
let tenantAId: string;
let seededIndicatorId: string | null = null;

/**
 * Replicated ensureQuarterOwned — identical logic to the helper in every G02 test file.
 * Returns { id, createdByThisSuite: boolean }.
 */
async function ensureQuarterOwned(
  tenantId: string,
  year: number,
  quarter: 1 | 2 | 3 | 4,
): Promise<{ id: string; createdByThisSuite: boolean }> {
  const periodValue = `${year}-Q${quarter}`;
  const startMonth = (quarter - 1) * 3;
  const startAt = new Date(Date.UTC(year, startMonth, 1));
  const endAt = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59));
  const existing = await adminClient.observationPeriod.findFirst({
    where: { tenantId, periodType: "quarterly", periodValue },
  });
  if (existing) return { id: existing.id, createdByThisSuite: false };
  const created = await adminClient.observationPeriod.create({
    data: { tenantId, periodType: "quarterly", periodValue, startAt, endAt },
  });
  return { id: created.id, createdByThisSuite: true };
}

describeIntegration("G02-L21 sentinel: FixtureTracker ownership semantics on real PostgreSQL", () => {
  beforeAll(async () => {
    adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
    await adminClient.$queryRaw`SELECT 1`;
    const tenant = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
    if (!tenant) throw new Error("DML-MOP-TENANT not seeded");
    tenantAId = tenant.id;
    // Find any existing indicator in tenant A (do not create one — we don't want to track it)
    const indicator = await adminClient.indicatorDefinition.findFirst({ where: { tenantId: tenantAId } });
    seededIndicatorId = indicator?.id ?? null;
  });

  afterAll(async () => {
    if (adminClient) {
      await adminClient.$disconnect();
    }
  });

  // Helper: manual cleanup of sentinel artifacts (the tracker correctly does NOT delete these)
  async function manualCleanupPeriod(periodId: string): Promise<void> {
    if (!periodId) return;
    await adminClient.observation.deleteMany({ where: { observationPeriodId: periodId } });
    await adminClient.observationPeriod.deleteMany({ where: { id: periodId } });
  }

  it("pre-existing ObservationPeriod survives trackOwned + cleanup; newly-created is deleted", async () => {
    // === Step 1: Create a pre-existing ObservationPeriod directly (simulating another suite's seed). ===
    const preExistingPeriod = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2099-Q1",
        startAt: new Date(Date.UTC(2099, 0, 1)),
        endAt: new Date(Date.UTC(2099, 2, 31, 23, 59, 59)),
      },
    });

    // === Step 2: Create an Observation attached to the pre-existing period (if we have an indicator). ===
    let preExistingObservationId: string | null = null;
    if (seededIndicatorId) {
      // Find any user in tenant A to satisfy the `createdBy` FK.
      const anyUser = await adminClient.user.findFirst({
        where: { memberships: { some: { tenantId: tenantAId } } },
      });
      if (anyUser) {
        const obs = await adminClient.observation.create({
          data: {
            tenantId: tenantAId,
            indicatorDefinitionId: seededIndicatorId,
            observationPeriodId: preExistingPeriod.id,
            observedValue: 1.0,
            originType: "observed",
            isSynthetic: true,
            createdBy: anyUser.id,
          },
        });
        preExistingObservationId = obs.id;
      }
    }

    try {
      // === Step 3: Invoke ensureQuarterOwned for the SAME period — should return createdByThisSuite=false. ===
      const result = await ensureQuarterOwned(tenantAId, 2099, 1);
      expect(result.createdByThisSuite).toBe(false);
      expect(result.id).toBe(preExistingPeriod.id);

      // === Step 4: Set up a FixtureTracker (simulating a test suite). ===
      const tracker = new FixtureTracker();

      // Call trackOwned on the pre-existing period (createdByThisSuite=false → must NOT be tracked).
      tracker.trackOwned.observationPeriod(result);

      // === Step 5: Create a NEW period in the same suite, track it as owned. ===
      const newPeriodResult = await ensureQuarterOwned(tenantAId, 2099, 2);
      const newPeriodId = newPeriodResult.id;
      expect(newPeriodResult.createdByThisSuite).toBe(true);
      tracker.trackOwned.observationPeriod(newPeriodResult);

      // === Step 6: Run the ACTUAL cleanup path. ===
      await tracker.cleanup(adminClient);

      // === Step 7: Pre-existing period SURVIVES. ===
      const survivingPreExisting = await adminClient.observationPeriod.findUnique({
        where: { id: preExistingPeriod.id },
      });
      expect(survivingPreExisting).not.toBeNull();
      expect(survivingPreExisting?.id).toBe(preExistingPeriod.id);

      // === Step 8: Pre-existing observation SURVIVES. ===
      if (preExistingObservationId) {
        const survivingObs = await adminClient.observation.findUnique({
          where: { id: preExistingObservationId },
        });
        expect(survivingObs).not.toBeNull();
        expect(survivingObs?.id).toBe(preExistingObservationId);
      }

      // === Step 9: NEW period was DELETED by cleanup. ===
      const deletedNew = await adminClient.observationPeriod.findUnique({
        where: { id: newPeriodId },
      });
      expect(deletedNew).toBeNull();

      // === Step 10: Tracker state cleared after successful cleanup. ===
      expect(tracker.trackedCount).toBe(0);
    } finally {
      // Manual cleanup of sentinel artifacts (the tracker correctly did NOT delete the pre-existing records).
      if (preExistingObservationId) {
        await adminClient.observation.deleteMany({ where: { id: preExistingObservationId } });
      }
      await manualCleanupPeriod(preExistingPeriod.id);
    }
  });

  it("two trackers do not interfere — second tracker's records survive first tracker's cleanup", async () => {
    // Simulate two test suites running in sequence (each with its own FixtureTracker).
    const suiteA = new FixtureTracker();
    const suiteB = new FixtureTracker();

    // Suite A creates a period.
    const periodAResult = await ensureQuarterOwned(tenantAId, 2099, 3);
    expect(periodAResult.createdByThisSuite).toBe(true);
    suiteA.trackOwned.observationPeriod(periodAResult);

    // Suite B creates a different period.
    const periodBResult = await ensureQuarterOwned(tenantAId, 2099, 4);
    expect(periodBResult.createdByThisSuite).toBe(true);
    suiteB.trackOwned.observationPeriod(periodBResult);

    try {
      // Suite A cleans up — should only delete periodA, not periodB.
      await suiteA.cleanup(adminClient);

      const periodAAfter = await adminClient.observationPeriod.findUnique({
        where: { id: periodAResult.id },
      });
      expect(periodAAfter).toBeNull();

      const periodBAfter = await adminClient.observationPeriod.findUnique({
        where: { id: periodBResult.id },
      });
      expect(periodBAfter).not.toBeNull();
      expect(periodBAfter?.id).toBe(periodBResult.id);

      // Suite B cleans up — should delete periodB.
      await suiteB.cleanup(adminClient);
      const periodBAfterFull = await adminClient.observationPeriod.findUnique({
        where: { id: periodBResult.id },
      });
      expect(periodBAfterFull).toBeNull();
    } finally {
      // Defensive manual cleanup in case the test failed mid-way.
      await manualCleanupPeriod(periodAResult.id);
      await manualCleanupPeriod(periodBResult.id);
    }
  });

  it("trackOwned with createdByThisSuite=false is a no-op (record not registered for deletion)", async () => {
    // Create a pre-existing period.
    const preExisting = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2099-Q3",
        startAt: new Date(Date.UTC(2099, 6, 1)),
        endAt: new Date(Date.UTC(2099, 8, 30, 23, 59, 59)),
      },
    });

    try {
      const tracker = new FixtureTracker();
      // Track with createdByThisSuite=false — should be a no-op.
      tracker.trackOwned.observationPeriod({ id: preExisting.id, createdByThisSuite: false });

      // trackedCount must be 0 because nothing was actually tracked.
      expect(tracker.trackedCount).toBe(0);

      // Cleanup is a no-op.
      await tracker.cleanup(adminClient);

      // Pre-existing period SURVIVES.
      const surviving = await adminClient.observationPeriod.findUnique({
        where: { id: preExisting.id },
      });
      expect(surviving).not.toBeNull();
    } finally {
      await manualCleanupPeriod(preExisting.id);
    }
  });

  it("FixtureTracker.cleanup is idempotent — calling twice does not error and does not delete untracked records", async () => {
    // Create a pre-existing period.
    const preExisting = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2099-Q4",
        startAt: new Date(Date.UTC(2099, 9, 1)),
        endAt: new Date(Date.UTC(2099, 11, 31, 23, 59, 59)),
      },
    });

    try {
      const tracker = new FixtureTracker();
      // Create a new period owned by this tracker.
      const newPeriod = await ensureQuarterOwned(tenantAId, 2098, 1);
      expect(newPeriod.createdByThisSuite).toBe(true);
      tracker.trackOwned.observationPeriod(newPeriod);

      // First cleanup — deletes the new period.
      await tracker.cleanup(adminClient);
      expect(tracker.trackedCount).toBe(0);

      // Second cleanup — no-op (state cleared), must not throw.
      await tracker.cleanup(adminClient);

      // Pre-existing period still SURVIVES both cleanups.
      const surviving = await adminClient.observationPeriod.findUnique({
        where: { id: preExisting.id },
      });
      expect(surviving).not.toBeNull();

      // New period was deleted by the first cleanup.
      const newPeriodAfter = await adminClient.observationPeriod.findUnique({
        where: { id: newPeriod.id },
      });
      expect(newPeriodAfter).toBeNull();
    } finally {
      await manualCleanupPeriod(preExisting.id);
    }
  });
});
