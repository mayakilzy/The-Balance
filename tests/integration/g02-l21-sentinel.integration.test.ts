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

  // ============================================================
  // FINAL ACCEPTANCE ITEM 1 — Cleanup error propagation
  // ============================================================
  //
  // Forces a REAL database error by passing a PrismaClient with an invalid
  // connection URL (127.0.0.1:1 — closed port → ECONNREFUSED immediately).
  //
  // The tracker tracks a real ObservationPeriod (created with the working
  // adminClient). When cleanup() is called with the broken client, the
  // deleteMany call throws a connection error. The test proves:
  //   (a) the error IS surfaced (not swallowed by text-based suppression),
  //   (b) the error message identifies the model and the failing ID,
  //   (c) tracking state is RETAINED after failure (caller can retry or inspect),
  //   (d) the record still exists in the DB (verified with the working client).
  //
  // Rationale for broken-client approach: the Prisma schema's non-cascade FK
  // relations between FixtureTracker-managed models are all OPTIONAL (defaulting
  // to SetNull), so deleting a parent does not throw — it nullifies the child's
  // FK. A broken connection is the most deterministic way to force a real DB
  // error that exercises the cleanup error-handling path.
  it("FINAL-1: cleanup surfaces real DB errors and retains tracking state after failure", async () => {
    // === Create a real record using the working client. ===
    const period = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2097-Q1",
        startAt: new Date(Date.UTC(2097, 0, 1)),
        endAt: new Date(Date.UTC(2097, 2, 31, 23, 59, 59)),
      },
    });

    const tracker = new FixtureTracker();
    tracker.trackOwned.observationPeriod({ id: period.id, createdByThisSuite: true });
    expect(tracker.trackedCount).toBe(1);

    // === Create a PrismaClient with an invalid URL — connection fails immediately. ===
    // 127.0.0.1:1 is a privileged port with no server → ECONNREFUSED is instant on Linux.
    // connect_timeout=1 is a safety net in case the connection attempt hangs.
    const brokenClient = new PrismaClient({
      datasources: { db: { url: "postgresql://nobody:nobody@127.0.0.1:1/nowhere?connect_timeout=1" } },
    });

    try {
      // === Cleanup MUST throw — connection error is surfaced, not swallowed. ===
      await expect(tracker.cleanup(brokenClient)).rejects.toThrow(/FixtureTracker cleanup failed/);

      // === The error message MUST identify the model and the failing ID. ===
      // Re-run to inspect the error message (cleanup is idempotent on failure —
      // tracking state is retained, so the same ID will be retried).
      let caughtMessage: string | null = null;
      try {
        await tracker.cleanup(brokenClient);
      } catch (e) {
        caughtMessage = (e as Error).message;
      }
      expect(caughtMessage).not.toBeNull();
      expect(caughtMessage!).toContain("observationPeriod");
      expect(caughtMessage!).toContain(period.id);

      // === Tracking state is RETAINED after failure. ===
      // Caller can inspect trackedCount to know there are pending records.
      expect(tracker.trackedCount).toBe(1);

      // === The record still exists in the DB (deletion was never attempted). ===
      // We verify with the WORKING client (adminClient), not the broken one.
      const stillExists = await adminClient.observationPeriod.findUnique({
        where: { id: period.id },
      });
      expect(stillExists).not.toBeNull();
      expect(stillExists?.id).toBe(period.id);
    } finally {
      // === Manual cleanup using the working client. ===
      await adminClient.observationPeriod.deleteMany({ where: { id: period.id } });
      // brokenClient.$disconnect() is safe even if never connected.
      await brokenClient.$disconnect().catch(() => {
        /* ignore disconnect errors on a broken client */
      });
    }
  });

  // ============================================================
  // FINAL ACCEPTANCE ITEM 2 — Parallel ownership safety
  // ============================================================
  //
  // Deterministic test exercising OVERLAPPING (concurrent via Promise.all)
  // cleanup operations against independently owned fixtures in the SAME tenant.
  //
  // Two trackers own disjoint sets of ObservationPeriods in tenant A. A third
  // "shared" period (owned by NEITHER tracker) is also created. After parallel
  // cleanup:
  //   - All tracker-owned periods are deleted.
  //   - The shared period SURVIVES (neither tracker touched it).
  //   - Both trackers' state is cleared.
  //
  // The test uses 5 periods (2 per tracker + 1 shared) to ensure overlap.
  it("FINAL-2: parallel cleanup of independent trackers does not cross-delete records", async () => {
    // === Create 5 periods in the same tenant — all independent (no FK between them). ===
    const periods: { id: string; periodValue: string }[] = [];
    for (const q of [1, 2, 3, 4] as const) {
      const p = await adminClient.observationPeriod.create({
        data: {
          tenantId: tenantAId,
          periodType: "quarterly",
          periodValue: `2096-Q${q}`,
          startAt: new Date(Date.UTC(2096, (q - 1) * 3, 1)),
          endAt: new Date(Date.UTC(2096, (q - 1) * 3 + 3, 0, 23, 59, 59)),
        },
      });
      periods.push({ id: p.id, periodValue: p.periodValue });
    }
    // Shared period — owned by NEITHER tracker. Must SURVIVE both cleanups.
    const sharedPeriod = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2096-Q4-shared",
        startAt: new Date(Date.UTC(2096, 9, 1)),
        endAt: new Date(Date.UTC(2096, 11, 31, 23, 59, 59)),
      },
    });

    // Tracker A owns periods 0 and 1 (Q1 and Q2).
    const trackerA = new FixtureTracker();
    trackerA.trackOwned.observationPeriod({ id: periods[0]!.id, createdByThisSuite: true });
    trackerA.trackOwned.observationPeriod({ id: periods[1]!.id, createdByThisSuite: true });
    expect(trackerA.trackedCount).toBe(2);

    // Tracker B owns periods 2 and 3 (Q3 and Q4).
    const trackerB = new FixtureTracker();
    trackerB.trackOwned.observationPeriod({ id: periods[2]!.id, createdByThisSuite: true });
    trackerB.trackOwned.observationPeriod({ id: periods[3]!.id, createdByThisSuite: true });
    expect(trackerB.trackedCount).toBe(2);

    try {
      // === Run both cleanups CONCURRENTLY via Promise.all. ===
      // This is the "overlapping" execution the owner requested.
      // Each cleanup operates on its OWN set of IDs — no shared state.
      // deleteMany by ID is independent: there is no row-level lock conflict
      // because the IDs are disjoint.
      await Promise.all([
        trackerA.cleanup(adminClient),
        trackerB.cleanup(adminClient),
      ]);

      // === All 4 tracker-owned periods are deleted. ===
      for (let i = 0; i < 4; i++) {
        const found = await adminClient.observationPeriod.findUnique({
          where: { id: periods[i]!.id },
        });
        expect(found).toBeNull();
      }

      // === The shared period SURVIVES — neither tracker owned it. ===
      const sharedSurviving = await adminClient.observationPeriod.findUnique({
        where: { id: sharedPeriod.id },
      });
      expect(sharedSurviving).not.toBeNull();
      expect(sharedSurviving?.id).toBe(sharedPeriod.id);

      // === Both trackers' state is cleared. ===
      expect(trackerA.trackedCount).toBe(0);
      expect(trackerB.trackedCount).toBe(0);
    } finally {
      // Defensive manual cleanup (in case the test failed mid-way).
      await adminClient.observationPeriod.deleteMany({ where: { id: sharedPeriod.id } });
      for (const p of periods) {
        await adminClient.observationPeriod.deleteMany({ where: { id: p.id } });
      }
    }
  });

  // ============================================================
  // FINAL ACCEPTANCE ITEM 2 (supplemental) — Parallel cleanup with overlap
  // ============================================================
  //
  // A more aggressive overlap: BOTH trackers track the SAME record (a deliberate
  // misuse). Both call cleanup concurrently. The record should be deleted by
  // whichever tracker runs first; the other tracker's deleteMany returns
  // count=0 (idempotent — no error). Neither tracker's cleanup throws.
  //
  // This proves that parallel cleanup is safe EVEN when trackers accidentally
  // overlap on the same record — the worst case is a benign count=0.
  it("FINAL-2b: parallel cleanup with accidental overlap is safe (idempotent deleteMany)", async () => {
    // Create one period that BOTH trackers will track.
    const sharedBetweenTrackers = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2095-Q1",
        startAt: new Date(Date.UTC(2095, 0, 1)),
        endAt: new Date(Date.UTC(2095, 2, 31, 23, 59, 59)),
      },
    });

    // Create two additional periods — one owned only by A, one owned only by B.
    const onlyA = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2095-Q2",
        startAt: new Date(Date.UTC(2095, 3, 1)),
        endAt: new Date(Date.UTC(2095, 5, 30, 23, 59, 59)),
      },
    });
    const onlyB = await adminClient.observationPeriod.create({
      data: {
        tenantId: tenantAId,
        periodType: "quarterly",
        periodValue: "2095-Q3",
        startAt: new Date(Date.UTC(2095, 6, 1)),
        endAt: new Date(Date.UTC(2095, 8, 30, 23, 59, 59)),
      },
    });

    const trackerA = new FixtureTracker();
    trackerA.trackOwned.observationPeriod({ id: sharedBetweenTrackers.id, createdByThisSuite: true });
    trackerA.trackOwned.observationPeriod({ id: onlyA.id, createdByThisSuite: true });

    const trackerB = new FixtureTracker();
    trackerB.trackOwned.observationPeriod({ id: sharedBetweenTrackers.id, createdByThisSuite: true });
    trackerB.trackOwned.observationPeriod({ id: onlyB.id, createdByThisSuite: true });

    try {
      // Both cleanups run concurrently; both will try to delete `sharedBetweenTrackers`.
      // The second deleteMany returns count=0 (idempotent) — no error.
      await Promise.all([
        trackerA.cleanup(adminClient),
        trackerB.cleanup(adminClient),
      ]);

      // All three periods are deleted.
      const sharedAfter = await adminClient.observationPeriod.findUnique({ where: { id: sharedBetweenTrackers.id } });
      expect(sharedAfter).toBeNull();
      const onlyAAfter = await adminClient.observationPeriod.findUnique({ where: { id: onlyA.id } });
      expect(onlyAAfter).toBeNull();
      const onlyBAfter = await adminClient.observationPeriod.findUnique({ where: { id: onlyB.id } });
      expect(onlyBAfter).toBeNull();

      // Both trackers' state is cleared (both cleanups succeeded).
      expect(trackerA.trackedCount).toBe(0);
      expect(trackerB.trackedCount).toBe(0);
    } finally {
      // Defensive manual cleanup.
      await adminClient.observationPeriod.deleteMany({ where: { id: sharedBetweenTrackers.id } });
      await adminClient.observationPeriod.deleteMany({ where: { id: onlyA.id } });
      await adminClient.observationPeriod.deleteMany({ where: { id: onlyB.id } });
    }
  });
});
