// ============================================================
// src/lib/reform/lock-helper.ts
// ------------------------------------------------------------
// G03-03-R1 — Unified SELECT FOR UPDATE helper for proposal rows.
//
// CONTRACT (fail-closed):
//   1. ALWAYS executes SELECT ... FOR UPDATE on the proposal row
//      scoped to the authenticated tenant. There is NO silent skip.
//   2. If the transaction client lacks $queryRaw (e.g. an incomplete
//      unit-test mock), throws LockUnavailableError. Unit tests MUST
//      provide an explicit $queryRaw mock — missing capabilities
//      never silently disable concurrency protection.
//   3. If the proposal row does not exist OR does not belong to the
//      authenticated tenant, throws NotFoundError immediately. The
//      caller never proceeds on a phantom lock.
//   4. The lock is held until the surrounding transaction commits or
//      rolls back. Per REV-3 unified locking, every mutating operation
//      on a proposal acquires this lock FIRST, before evaluating any
//      mutable state. This produces a single serialization point per
//      proposal → deterministic ordering, no deadlocks across the
//      supported operation set.
//
// Caller obligations:
//   - Must be invoked inside withAuthenticatedTenant (tenantId is the
//     authenticated session tenant, never client-supplied input).
//   - Must hold the surrounding Prisma transaction (tx) for the lock
//     to be meaningful. Locking then committing immediately is a no-op.
//   - Must perform subsequent mutable-state reads via the SAME tx so
//     the row's lock-protected state is observed.
//
// Verified guarantees:
//   - At most one competing mutation proceeds at a time per proposal.
//   - Missing rows reject at the lock boundary, not later in business
//     logic — caller cannot act on a non-existent proposal.
//   - Tenant isolation enforced by WHERE clause AND by RLS policies.
// ============================================================
import type { Prisma } from "@prisma/client";
import { NotFoundError } from "./contracts";

/**
 * Error thrown when the transaction client lacks the $queryRaw capability
 * required for SELECT FOR UPDATE. Production Prisma clients always support
 * $queryRaw; this error surfaces incomplete test mocks that would otherwise
 * silently disable concurrency protection.
 */
export class LockUnavailableError extends Error {
  constructor(
    public readonly resourceName: string,
    public readonly reason: string
  ) {
    super(
      `LockUnavailableError: cannot acquire SELECT FOR UPDATE on ${resourceName}. ` +
        `Reason: ${reason}. ` +
        `Production Prisma clients support $queryRaw; unit tests must mock $queryRaw explicitly.`
    );
    this.name = "LockUnavailableError";
  }
}

/**
 * Acquire SELECT FOR UPDATE on a reform_proposals row scoped to a tenant.
 *
 * Throws:
 *   - LockUnavailableError if $queryRaw is not a function on tx.
 *   - NotFoundError if 0 rows match (proposal does not exist OR wrong tenant).
 *
 * Returns: void. The lock is held for the lifetime of the surrounding tx.
 */
export async function lockProposalRow(
  tx: Prisma.TransactionClient,
  proposalId: string,
  tenantId: string
): Promise<void> {
  const queryRaw = (tx as unknown as {
    $queryRaw?: unknown;
  }).$queryRaw;

  if (typeof queryRaw !== "function") {
    throw new LockUnavailableError(
      "reform_proposals",
      "tx.$queryRaw is not a function (incomplete transaction client mock)"
    );
  }

  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "reform_proposals"
    WHERE id = ${proposalId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new NotFoundError(
      `Proposal ${proposalId} not found in tenant ${tenantId} (lock-acquire boundary)`
    );
  }
}
