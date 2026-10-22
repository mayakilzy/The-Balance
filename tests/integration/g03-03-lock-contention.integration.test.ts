// ============================================================
// tests/integration/g03-03-lock-contention.integration.test.ts
// ------------------------------------------------------------
// G03-03-R1-PUBLISH — Deterministic lock-contention acceptance tests.
//
// WHEREAS the C1-C7 tests use Promise.all to start competing operations
// concurrently, they do not conclusively demonstrate that operation B
// is actually BLOCKED at the proposal-row lock while operation A holds
// it. Promise.all only ensures both operations START at the same time;
// the actual ordering depends on JS event loop + Prisma query scheduling.
//
// These tests close that gap by using a deterministic synchronization
// primitive: a session-level PostgreSQL advisory lock held by an external
// control connection. Transaction A's database connection acquires the
// proposal-row FOR UPDATE lock, then tries to acquire the advisory lock
// (blocks). Transaction B's service call (on a SEPARATE Prisma
// connection) MUST wait at lockProposalRow because A holds FOR UPDATE.
//
// Pattern:
//   1. controlClient (BYPASSRLS) acquires session-level advisory lock.
//   2. A's transaction (authenticated tenant context set) calls
//      lockProposalRow → acquires FOR UPDATE; then tries advisory lock
//      (blocks because control has it). A holds FOR UPDATE while blocked.
//   3. B's transaction (separate connection) attempts a competing
//      mutation → calls lockProposalRow → MUST WAIT for FOR UPDATE.
//   4. Verify B is still pending (not completed) after a bounded timeout.
//   5. controlClient releases the advisory lock → A finishes (releases
//      FOR UPDATE) → B acquires FOR UPDATE → B proceeds.
//   6. Verify the resulting legal state.
//
// Synchronization: PostgreSQL session-level advisory lock + JS Promise
// resolution. No arbitrary sleeps — the only timing dependency is the
// bounded timeout in step 4, which is generous (1500ms) and asserted as
// "B did not complete within this window".
//
// Test scope:
//   L1: Approval contention (B blocked while A holds proposal-row lock)
//   L1-control: Without FOR UPDATE, B is NOT blocked (proves the lock IS
//               the protection mechanism — by negation)
//   L2: Addition vs submission contention
//   L3: Approval vs withdrawal contention
//   L4: lockProposalRow fails closed (missing $queryRaw, wrong tenant,
//       missing proposal, success path)
//   L5: Atomic audit rollback (transaction-level proof)
//
// These L-tests COMPLEMENT C1-C7 (which remain unchanged). They prove
// that the lock is ACTUALLY CONTENDED, not merely that concurrent
// invocations produce correct final state.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import type { Session } from "next-auth";
import {
  lockProposalRow,
  LockUnavailableError,
} from "@/lib/reform/lock-helper";
import { NotFoundError } from "@/lib/reform/contracts";
import { writeAuditTx } from "@/lib/audit";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-03-lc-";

let adminClient: PrismaClient;
let actorAClient: PrismaClient;
let actorBClient: PrismaClient;
let controlClient: PrismaClient; // dedicated connection for advisory lock control

let tenantAId: string;
let analystUserId: string;
let reviewerUserId: string;
let adminUserId: string;
let strategyVersionId: string;

let createdAlertIds: string[] = [];
let createdProposalIds: string[] = [];
let createdAlternativeIds: string[] = [];

function makeSession(user: {
  id: string;
  tenantId: string;
  roleCode: string;
  membershipStatus: string;
}): Session {
  return {
    user: {
      id: user.id,
      tenantId: user.tenantId,
      roleCode: user.roleCode,
      membershipStatus: user.membershipStatus,
    },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as unknown as Session;
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;

  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });
  actorAClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  actorBClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  controlClient = new PrismaClient({
    datasources: { db: { url: DIRECT_URL } },
  });

  await adminClient.$queryRaw`SELECT 1`;
  await actorAClient.$queryRaw`SELECT 1`;
  await actorBClient.$queryRaw`SELECT 1`;
  await controlClient.$queryRaw`SELECT 1`;

  const tenantA = await adminClient.tenant.findUnique({
    where: { code: "DML-MOP-TENANT" },
  });
  if (!tenantA) throw new Error("Tenant DML-MOP-TENANT not seeded");
  tenantAId = tenantA.id;

  const adminUser = await adminClient.user.findUnique({
    where: { email: "admin@demolandia.test" },
  });
  const analystUser = await adminClient.user.findUnique({
    where: { email: "analyst@demolandia.test" },
  });
  if (!adminUser || !analystUser) throw new Error("Users not seeded");
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  const reviewer = await adminClient.user.upsert({
    where: { email: "g03-03-lc-reviewer@demolandia.test" },
    update: {},
    create: {
      email: "g03-03-lc-reviewer@demolandia.test",
      name: "G03-03 LC Reviewer",
      passwordHash: await hashPassword("Test1234!"),
      status: "active",
    },
  });
  await adminClient.membership.upsert({
    where: { userId_tenantId: { userId: reviewer.id, tenantId: tenantAId } },
    update: { status: "active", roleCode: "reviewer" },
    create: {
      userId: reviewer.id,
      tenantId: tenantAId,
      roleCode: "reviewer",
      status: "active",
    },
  });
  reviewerUserId = reviewer.id;

  let sv = await adminClient.strategyVersion.findFirst({
    where: { tenantId: tenantAId, status: "approved" },
  });
  if (!sv) {
    const strategy = await adminClient.strategy.create({
      data: {
        tenantId: tenantAId,
        title: "G03-03 LC Test Strategy",
        createdBy: analystUserId,
      },
    });
    sv = await adminClient.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        tenantId: tenantAId,
        versionNumber: 1,
        content: "{}",
        status: "approved",
        approvedBy: adminUserId,
        approvedAt: new Date(),
        metadata: { simulated: true },
        createdBy: analystUserId,
      },
    });
  }
  strategyVersionId = sv.id;
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  try {
    // Release any leftover advisory locks (defensive — should already be released).
    await controlClient.$executeRawUnsafe(`SELECT pg_advisory_unlock_all()`);

    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_action_updates" DISABLE TRIGGER prevent_delete_reform_action_updates`
    );

    await adminClient.reformActionUpdate.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformAction.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformApproval.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformAlternative.deleteMany({
      where: { id: { in: createdAlternativeIds } },
    });
    await adminClient.reformProposal.deleteMany({
      where: { id: { in: createdProposalIds } },
    });
    if (createdAlertIds.length > 0) {
      await adminClient.alert.deleteMany({
        where: { id: { in: createdAlertIds } },
      });
    }

    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals`
    );
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "reform_action_updates" ENABLE TRIGGER prevent_delete_reform_action_updates`
    );
  } finally {
    await adminClient?.$disconnect();
    await actorAClient?.$disconnect();
    await actorBClient?.$disconnect();
    await controlClient?.$disconnect();
  }
}, 60000);

async function createTestAlert(): Promise<string> {
  const alert = await adminClient.alert.create({
    data: {
      id: `${FIXTURE_PREFIX}alert-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      tenantId: tenantAId,
      strategyVersionId,
      title: "G03-03 LC Alert",
      description: "Lock contention test alert",
      severity: "warning",
      lifecycleStage: "reviewed",
      executionStatus: "verified",
      executionVerifiedAction: "test",
      executionVerificationSource: "test",
      executionVerifiedById: reviewerUserId,
      executionVerifiedAt: new Date(),
      createdBy: "system",
      reviewedBy: reviewerUserId,
      reviewedAt: new Date(),
      isAutoGenerated: true,
      metadata: { simulated: true },
    },
  });
  createdAlertIds.push(alert.id);
  return alert.id;
}

async function setupProposalWithSelectedAlt(): Promise<{
  proposalId: string;
  alt1Id: string;
  alt2Id: string;
}> {
  const { createReformProposal } = await import(
    "@/lib/reform/reform-proposal-service"
  );
  const { addReformAlternative, selectAlternative } = await import(
    "@/lib/reform/reform-alternative-service"
  );
  const { submitForReview } = await import(
    "@/lib/reform/reform-proposal-service"
  );
  const analyst = makeSession({
    id: analystUserId,
    tenantId: tenantAId,
    roleCode: "analyst",
    membershipStatus: "active",
  });
  const reviewer = makeSession({
    id: reviewerUserId,
    tenantId: tenantAId,
    roleCode: "reviewer",
    membershipStatus: "active",
  });

  const alertId = await createTestAlert();
  const result = await createReformProposal(analyst, {
    originatingAlertId: alertId,
    title: `${FIXTURE_PREFIX} Proposal ${Date.now()}`,
    problemStatement:
      "Lock contention proposal for G03-03-R1-PUBLISH acceptance testing.",
    hypothesizedCauses: [],
  });
  createdProposalIds.push(result.proposalId);

  const alt1 = await addReformAlternative(analyst, {
    proposalId: result.proposalId,
    title: `${FIXTURE_PREFIX} LC Alt 1`,
    description: "First alternative for lock contention baseline testing.",
    costCurrency: "USD",
    riskLevel: "low",
    feasibilityScore: "high",
    anticipatedOutcomes: [],
    assumptions: [],
  });
  createdAlternativeIds.push(alt1.alternativeId);

  const alt2 = await addReformAlternative(analyst, {
    proposalId: result.proposalId,
    title: `${FIXTURE_PREFIX} LC Alt 2`,
    description: "Second alternative for lock contention baseline testing.",
    costCurrency: "USD",
    riskLevel: "low",
    feasibilityScore: "high",
    anticipatedOutcomes: [],
    assumptions: [],
  });
  createdAlternativeIds.push(alt2.alternativeId);

  await submitForReview(analyst, result.proposalId);
  await selectAlternative(reviewer, { alternativeId: alt1.alternativeId });

  return {
    proposalId: result.proposalId,
    alt1Id: alt1.alternativeId,
    alt2Id: alt2.alternativeId,
  };
}

async function setupDraftProposalWithoutAlt(): Promise<{ proposalId: string }> {
  const { createReformProposal } = await import(
    "@/lib/reform/reform-proposal-service"
  );
  const analyst = makeSession({
    id: analystUserId,
    tenantId: tenantAId,
    roleCode: "analyst",
    membershipStatus: "active",
  });
  const alertId = await createTestAlert();
  const result = await createReformProposal(analyst, {
    originatingAlertId: alertId,
    title: `${FIXTURE_PREFIX} Draft Proposal ${Date.now()}`,
    problemStatement:
      "Lock contention draft proposal for G03-03-R1-PUBLISH testing.",
    hypothesizedCauses: [],
  });
  createdProposalIds.push(result.proposalId);
  return { proposalId: result.proposalId };
}

/**
 * Build a unique advisory-lock key from a fixture proposal ID hash.
 * Must fit in bigint; we hash the proposalId to a small integer space
 * and offset to avoid collision with any other advisory lock usage.
 */
function advisoryKey(proposalId: string): bigint {
  let h = 0n;
  for (const c of proposalId) {
    h = (h * 31n + BigInt(c.charCodeAt(0))) & 0x7fffffffn;
  }
  return 900000000n + h;
}

/**
 * Set the authenticated tenant context INSIDE a Prisma transaction,
 * mirroring what withAuthenticatedTenant does at the start of every
 * service call. This lets us call lockProposalRow directly on a raw
 * tx while still satisfying RLS.
 *
 * Returns void. The setting is transaction-scoped (is_local=true).
 */
async function setTenantContextInTx(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

// ============================================================
// L1 — Approval contention: B is BLOCKED while A holds the proposal lock
// ============================================================
describeIntegration("G03-03-R1-PUBLISH L1: approval contention", () => {
  it("reviewer B cannot complete approveReformProposal while reviewer A holds the proposal-row lock", async () => {
    const { approveReformProposal } = await import(
      "@/lib/reform/reform-proposal-service"
    );

    const { proposalId } = await setupProposalWithSelectedAlt();
    const aKey = advisoryKey(proposalId);

    const reviewerB = makeSession({
      id: reviewerUserId,
      tenantId: tenantAId,
      roleCode: "reviewer",
      membershipStatus: "active",
    });

    // === STEP 1: controlClient acquires session-level advisory lock ===
    await controlClient.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;

    // === STEP 2: A's transaction (actorAClient) acquires FOR UPDATE on the
    // proposal row, then tries to acquire the advisory lock (blocks because
    // control has it). A holds FOR UPDATE while blocked.
    const aPromise = actorAClient
      .$transaction(async (tx) => {
        // Set RLS tenant context (mirrors withAuthenticatedTenant).
        await setTenantContextInTx(tx, tenantAId);
        // Acquire the proposal-row lock — this is what we're proving B waits on.
        await lockProposalRow(tx, proposalId, tenantAId);
        // Now try to acquire the advisory lock. This BLOCKS because control
        // holds it. While we're blocked here, the FOR UPDATE on the proposal
        // row is still held (PostgreSQL holds row locks until COMMIT/ROLLBACK).
        await tx.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;
        return "A done";
      })
      .catch((e) => `A error: ${(e as Error).message}`);

    // Give A a moment to acquire the FOR UPDATE before B starts.
    // (This is NOT a sleep-based synchronization — the FOR UPDATE is held
    // for the duration of A's transaction regardless. We just need B to
    // start AFTER A has acquired the row lock. 200ms is generous.)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // === STEP 3: B's approveReformProposal (actorBClient, separate connection) ===
    // B calls withAuthenticatedTenant → lockProposalRow → SELECT FOR UPDATE.
    // MUST WAIT because A holds FOR UPDATE.
    const bPromise = approveReformProposal(reviewerB, {
      proposalId,
      rationale: "Reviewer B attempting approval while A holds the lock.",
    }).catch((e) => `B error: ${(e as Error).message}`);

    // === STEP 4: Verify B is ACTUALLY BLOCKED ===
    const BLOCK_TIMEOUT_MS = 1500;
    const blockCheck = await Promise.race([
      bPromise.then((v) => ({ completed: true as const, value: v })),
      new Promise<{ completed: false }>((resolve) =>
        setTimeout(() => resolve({ completed: false }), BLOCK_TIMEOUT_MS)
      ),
    ]);

    // B MUST still be pending (not completed). If B completed before we
    // release the advisory lock, the lock is NOT contending — critical defect.
    expect(blockCheck.completed).toBe(false);

    // === STEP 5: Release the advisory lock → A completes → B acquires row lock ===
    await controlClient.$executeRaw`SELECT pg_advisory_unlock(${aKey}::bigint)`;

    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

    // A's transaction completes cleanly (it only held the lock, didn't mutate).
    expect(aResult).toBe("A done");

    // B's approveReformProposal succeeds (A didn't create an approval record).
    expect(typeof bResult).toBe("object");
    expect(bResult).not.toBe("B error: ...");
    expect(
      (bResult as { approvalId?: string }).approvalId
    ).toBeTruthy();

    // Verify final state: exactly ONE immutable approval record.
    const approvals = await adminClient.reformApproval.findMany({
      where: { proposalId, tenantId: tenantAId },
    });
    expect(approvals.length).toBe(1);

    const proposal = await adminClient.reformProposal.findUnique({
      where: { id: proposalId },
    });
    expect(proposal!.status).toBe("approved");
  });

  it("control: WITHOUT the proposal-row lock, B is NOT blocked (proves lock IS the protection)", async () => {
    // This test documents by negation: if A holds ONLY an advisory lock
    // (not the proposal-row FOR UPDATE), B's lockProposalRow completes
    // immediately. This proves FOR UPDATE is what causes B to wait.
    const { proposalId } = await setupProposalWithSelectedAlt();
    const aKey = advisoryKey(proposalId + "-control");

    // controlClient holds the advisory lock.
    await controlClient.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;

    // A's transaction holds ONLY the advisory lock — no FOR UPDATE on proposal.
    const aPromise = actorAClient
      .$transaction(async (tx) => {
        // NOTE: deliberately NOT calling lockProposalRow.
        await tx.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;
        return "A done";
      })
      .catch((e) => `A error: ${(e as Error).message}`);

    // B's transaction calls lockProposalRow → should succeed IMMEDIATELY
    // because no one holds FOR UPDATE on the proposal row.
    const bStart = Date.now();
    const bPromise = actorBClient
      .$transaction(async (tx) => {
        await setTenantContextInTx(tx, tenantAId);
        await lockProposalRow(tx, proposalId, tenantAId);
        return "B locked";
      })
      .catch((e) => `B error: ${(e as Error).message}`);
    const bResult = await bPromise;
    const bElapsed = Date.now() - bStart;

    // B should complete in well under 1 second — proving the row lock is
    // what causes B to wait in L1's main test.
    expect(bElapsed).toBeLessThan(1000);
    expect(bResult).toBe("B locked");

    // Release the advisory lock so A can finish.
    await controlClient.$executeRaw`SELECT pg_advisory_unlock(${aKey}::bigint)`;
    await aPromise;
  });
});

// ============================================================
// L2 — Addition vs submission contention
// ============================================================
describeIntegration("G03-03-R1-PUBLISH L2: addition vs submission contention", () => {
  it("submitForReview cannot complete while addReformAlternative holds the proposal-row lock", async () => {
    const { submitForReview } = await import(
      "@/lib/reform/reform-proposal-service"
    );

    const { proposalId } = await setupDraftProposalWithoutAlt();
    const aKey = advisoryKey(proposalId);

    const analyst = makeSession({
      id: analystUserId,
      tenantId: tenantAId,
      roleCode: "analyst",
      membershipStatus: "active",
    });

    await controlClient.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;

    // A: lock the proposal row, then block on advisory lock.
    const aPromise = actorAClient
      .$transaction(async (tx) => {
        await setTenantContextInTx(tx, tenantAId);
        await lockProposalRow(tx, proposalId, tenantAId);
        await tx.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;
        return "A done";
      })
      .catch((e) => `A error: ${(e as Error).message}`);

    // Give A a moment to acquire FOR UPDATE.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // B: submitForReview must block at lockProposalRow.
    const bPromise = submitForReview(analyst, proposalId).catch(
      (e) => `B error: ${(e as Error).message}`
    );

    const BLOCK_TIMEOUT_MS = 1500;
    const blockCheck = await Promise.race([
      bPromise.then((v) => ({ completed: true as const, value: v })),
      new Promise<{ completed: false }>((resolve) =>
        setTimeout(() => resolve({ completed: false }), BLOCK_TIMEOUT_MS)
      ),
    ]);
    expect(blockCheck.completed).toBe(false);

    await controlClient.$executeRaw`SELECT pg_advisory_unlock(${aKey}::bigint)`;

    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
    expect(aResult).toBe("A done");
    expect(bResult).toEqual({ proposalId, status: "under_review" });

    const proposal = await adminClient.reformProposal.findUnique({
      where: { id: proposalId },
    });
    expect(proposal!.status).toBe("under_review");
  });
});

// ============================================================
// L3 — Approval vs withdrawal contention
// ============================================================
describeIntegration("G03-03-R1-PUBLISH L3: approval vs withdrawal contention", () => {
  it("withdrawAlternative cannot complete while approveReformProposal-equivalent holds the proposal-row lock", async () => {
    const { withdrawAlternative } = await import(
      "@/lib/reform/reform-alternative-service"
    );

    const { proposalId, alt1Id } = await setupProposalWithSelectedAlt();
    const aKey = advisoryKey(proposalId);

    const reviewer = makeSession({
      id: reviewerUserId,
      tenantId: tenantAId,
      roleCode: "reviewer",
      membershipStatus: "active",
    });

    await controlClient.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;

    // A: lock proposal row, then block on advisory lock.
    const aPromise = actorAClient
      .$transaction(async (tx) => {
        await setTenantContextInTx(tx, tenantAId);
        await lockProposalRow(tx, proposalId, tenantAId);
        await tx.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;
        return "A done";
      })
      .catch((e) => `A error: ${(e as Error).message}`);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // B: withdrawAlternative must block at lockProposalRow.
    const bPromise = withdrawAlternative(reviewer, {
      alternativeId: alt1Id,
      withdrawalReason:
        "Withdrawal attempt blocked by proposal-row lock held by A.",
    }).catch((e) => `B error: ${(e as Error).message}`);

    const BLOCK_TIMEOUT_MS = 1500;
    const blockCheck = await Promise.race([
      bPromise.then((v) => ({ completed: true as const, value: v })),
      new Promise<{ completed: false }>((resolve) =>
        setTimeout(() => resolve({ completed: false }), BLOCK_TIMEOUT_MS)
      ),
    ]);
    expect(blockCheck.completed).toBe(false);

    await controlClient.$executeRaw`SELECT pg_advisory_unlock(${aKey}::bigint)`;

    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
    expect(aResult).toBe("A done");
    expect(bResult).toEqual({ alternativeId: alt1Id, status: "withdrawn" });

    const alt = await adminClient.reformAlternative.findUnique({
      where: { id: alt1Id },
    });
    expect(alt!.status).toBe("withdrawn");
  });
});

// ============================================================
// L4 — lockProposalRow fails closed
// ============================================================
describeIntegration("G03-03-R1-PUBLISH L4: lock fails closed when $queryRaw is missing", () => {
  it("throws LockUnavailableError (not silent skip) when tx lacks $queryRaw", async () => {
    const tx = {
      reformProposal: { findFirst: async () => null },
      // $queryRaw intentionally absent
    } as unknown as Prisma.TransactionClient;

    await expect(lockProposalRow(tx, "p1", "t1")).rejects.toThrow(
      LockUnavailableError
    );
    await expect(lockProposalRow(tx, "p1", "t1")).rejects.toThrow(
      /tx\.\$queryRaw is not a function/
    );
  });

  it("throws NotFoundError when proposal is missing OR wrong tenant (real PG)", async () => {
    // Missing proposal.
    await actorAClient.$transaction(async (tx) => {
      await setTenantContextInTx(tx, tenantAId);
      await expect(
        lockProposalRow(tx, "nonexistent-proposal-id", tenantAId)
      ).rejects.toThrow(NotFoundError);
    });

    // Wrong tenant.
    const realProposal = await adminClient.reformProposal.findFirst({
      where: { tenantId: tenantAId },
    });
    if (!realProposal)
      throw new Error("No seeded proposal to test tenant boundary");

    await actorAClient.$transaction(async (tx) => {
      await setTenantContextInTx(tx, tenantAId);
      await expect(
        lockProposalRow(tx, realProposal.id, "wrong-tenant-id-xyz")
      ).rejects.toThrow(NotFoundError);
    });
  });

  it("succeeds when proposal + tenant match (real PG, tenant context set)", async () => {
    const { proposalId } = await setupProposalWithSelectedAlt();
    await actorAClient.$transaction(async (tx) => {
      await setTenantContextInTx(tx, tenantAId);
      await expect(
        lockProposalRow(tx, proposalId, tenantAId)
      ).resolves.toBeUndefined();
    });
  });

  it("lock is held for the duration of the transaction (FOR UPDATE blocks competing reads)", async () => {
    // Prove the lock is actually held: while A's transaction holds FOR UPDATE,
    // B's SELECT ... FOR UPDATE on the same row MUST block.
    const { proposalId } = await setupProposalWithSelectedAlt();
    const aKey = advisoryKey(proposalId + "-held");

    await controlClient.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;

    // A: acquire FOR UPDATE, then block on advisory lock.
    const aPromise = actorAClient
      .$transaction(async (tx) => {
        await setTenantContextInTx(tx, tenantAId);
        await lockProposalRow(tx, proposalId, tenantAId);
        await tx.$executeRaw`SELECT pg_advisory_lock(${aKey}::bigint)`;
        return "A done";
      })
      .catch((e) => `A error: ${(e as Error).message}`);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // B: try a competing SELECT FOR UPDATE on the same row.
    const bPromise = actorBClient
      .$transaction(async (tx) => {
        await setTenantContextInTx(tx, tenantAId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "reform_proposals"
          WHERE id = ${proposalId} AND "tenantId" = ${tenantAId}
          FOR UPDATE NOWAIT
        `;
        return rows;
      })
      .catch((e) => `B error: ${(e as Error).message}`);

    const bResult = await bPromise;
    // NOWAIT means B should fail immediately with "could not obtain lock"
    // because A holds FOR UPDATE. The Prisma error message includes
    // "could not obtain lock on row in relation reform_proposals".
    expect(typeof bResult).toBe("string");
    expect(bResult as string).toMatch(/could not obtain lock/i);

    await controlClient.$executeRaw`SELECT pg_advisory_unlock(${aKey}::bigint)`;
    await aPromise;
  });
});

// ============================================================
// L5 — Atomic audit rollback (transaction-level proof)
// ============================================================
describeIntegration("G03-03-R1-PUBLISH L5: atomic audit rollback (transaction-level)", () => {
  it("writeAuditTx failure rolls back the proposal mutation in the SAME transaction", async () => {
    const { proposalId } = await setupProposalWithSelectedAlt();

    // Snapshot pre-state.
    const proposalBefore = await adminClient.reformProposal.findUnique({
      where: { id: proposalId },
    });
    expect(proposalBefore!.status).toBe("under_review");
    expect(proposalBefore!.rejectedAt).toBeNull();

    // === REVOKE INSERT on audit_log from balance_app ===
    // actorAClient connects as balance_app, so writeAuditTx will fail.
    // (adminClient connects as balance_admin which has BYPASSRLS.)
    await adminClient.$executeRawUnsafe(
      `REVOKE INSERT ON "audit_log" FROM balance_app`
    );

    try {
      // Run a transaction on actorAClient (balance_app role).
      // 1. Set tenant context (RLS requires it).
      // 2. Lock the proposal row.
      // 3. Mutate the proposal (set rejectedAt).
      // 4. writeAuditTx → FAILS (INSERT on audit_log revoked).
      // 5. The ENTIRE transaction rolls back.
      await actorAClient.$transaction(async (tx) => {
        await setTenantContextInTx(tx, tenantAId);
        await lockProposalRow(tx, proposalId, tenantAId);

        // Mutate the proposal.
        await tx.reformProposal.update({
          where: { id: proposalId },
          data: { rejectedAt: new Date() },
        });

        // writeAuditTx MUST throw (INSERT revoked).
        await writeAuditTx(tx, {
          tenantId: tenantAId,
          actor: analystUserId,
          action: "test.audit-failure-rollback",
          details: { proposalId },
          status: "ok",
        });
      });

      // Should NOT reach here.
      throw new Error("Expected writeAuditTx to throw, but it didn't");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      const msg = (e as Error).message.toLowerCase();
      // Should be a permission/RLS error from audit_log INSERT.
      const isPermissionError =
        msg.includes("permission") ||
        msg.includes("denied") ||
        msg.includes("policy") ||
        msg.includes("audit_log") ||
        msg.includes("row-level security");
      expect(isPermissionError).toBe(true);
    } finally {
      // Restore INSERT permission.
      await adminClient.$executeRawUnsafe(
        `GRANT INSERT ON "audit_log" TO balance_app`
      );
    }

    // Verify NO mutation persisted.
    const proposalAfter = await adminClient.reformProposal.findUnique({
      where: { id: proposalId },
    });
    expect(proposalAfter!.status).toBe("under_review");
    expect(proposalAfter!.rejectedAt).toBeNull();

    // No audit_log entry was created.
    const auditRows = await adminClient.auditLog.findMany({
      where: {
        tenantId: tenantAId,
        action: "test.audit-failure-rollback",
      },
    });
    expect(auditRows.length).toBe(0);
  });
});
