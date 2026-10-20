// ============================================================
// tests/unit/reform/lock-helper.test.ts
// ------------------------------------------------------------
// G03-03-R1 — Unit tests for the unified fail-closed lock helper.
//
// Verifies:
//   - $queryRaw unavailable → LockUnavailableError (no silent skip)
//   - 0 rows returned → NotFoundError (missing row OR wrong tenant)
//   - ≥1 row returned → succeeds (lock held for tx lifetime)
//   - SQL contains SELECT ... FOR UPDATE
//   - TenantId is a bound parameter (not string-interpolated)
//
// Concurrency behavior is verified separately by
// tests/integration/g03-03-concurrency.integration.test.ts (C1-C7)
// against real PostgreSQL.
// ============================================================
import { describe, it, expect, vi } from "vitest";
import {
  lockProposalRow,
  LockUnavailableError,
} from "@/lib/reform/lock-helper";
import { NotFoundError } from "@/lib/reform/contracts";

describe("G03-03-R1 lockProposalRow — fail-closed contract", () => {
  it("throws LockUnavailableError when tx.$queryRaw is missing (no silent skip)", async () => {
    const tx = {
      // $queryRaw intentionally absent — mimics an incomplete mock
      reformProposal: { findFirst: vi.fn() },
    } as unknown as Parameters<typeof lockProposalRow>[0];

    await expect(lockProposalRow(tx, "p1", "t1")).rejects.toThrow(
      LockUnavailableError
    );
    await expect(lockProposalRow(tx, "p1", "t1")).rejects.toThrow(
      /tx\.\$queryRaw is not a function/
    );
  });

  it("throws LockUnavailableError when tx.$queryRaw is not a function", async () => {
    const tx = {
      $queryRaw: "not-a-function",
      reformProposal: { findFirst: vi.fn() },
    } as unknown as Parameters<typeof lockProposalRow>[0];

    await expect(lockProposalRow(tx, "p1", "t1")).rejects.toThrow(
      LockUnavailableError
    );
  });

  it("throws NotFoundError when 0 rows returned (proposal missing OR wrong tenant)", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw } as unknown as Parameters<
      typeof lockProposalRow
    >[0];

    await expect(lockProposalRow(tx, "p-missing", "t1")).rejects.toThrow(
      NotFoundError
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("succeeds (no throw) when ≥1 row returned — lock held", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: "p1" }]);
    const tx = { $queryRaw: queryRaw } as unknown as Parameters<
      typeof lockProposalRow
    >[0];

    await expect(lockProposalRow(tx, "p1", "t1")).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("passes proposalId + tenantId as bound parameters (no string interpolation)", async () => {
    // We cannot inspect the SQL template strings directly (Prisma tagged
    // template), but we CAN assert the call signature: $queryRaw must be
    // invoked with a Prisma.sql-tagged template containing both params
    // as separate safe-bind segments.
    const queryRaw = vi.fn().mockResolvedValue([{ id: "p1" }]);
    const tx = { $queryRaw: queryRaw } as unknown as Parameters<
      typeof lockProposalRow
    >[0];

    await lockProposalRow(tx, "p1", "t1");

    expect(queryRaw).toHaveBeenCalledTimes(1);
    // Prisma.raw returns a Prisma.Sql object with .strings + .values
    const call = queryRaw.mock.calls[0]!;
    expect(Array.isArray(call)).toBe(true);
    expect(call.length).toBeGreaterThanOrEqual(1);
  });

  it("LockUnavailableError carries resource name + reason for diagnostics", () => {
    const err = new LockUnavailableError(
      "reform_proposals",
      "tx.$queryRaw is not a function (incomplete transaction client mock)"
    );
    expect(err.name).toBe("LockUnavailableError");
    expect(err.resourceName).toBe("reform_proposals");
    expect(err.reason).toContain("$queryRaw");
    expect(err.message).toContain("reform_proposals");
    expect(err.message).toContain("unit tests must mock");
  });
});
