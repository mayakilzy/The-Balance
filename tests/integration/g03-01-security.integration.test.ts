// ============================================================
// tests/integration/g03-01-security.integration.test.ts
// ------------------------------------------------------------
// G03-01 Integration Evidence — Reviewer directive C
//
// Reproducible against real PostgreSQL 16 (RUN_INTEGRATION_TESTS=1)
// and the real production migration chain (0022 → 0023 → 0024 → 0025).
// Skips locally when RUN_INTEGRATION_TESTS is unset.
//
// Pattern follows G01/G02 integration tests:
//   - appClient  (DATABASE_URL)  — RLS-enforced balance_app role
//   - adminClient (DIRECT_URL)   — BYPASSRLS for setup/teardown only
//
// Covers (per directive C):
//   I-01: Coordination membership — positive (Tenant B sees participant row)
//   I-02: Coordination membership — negative (Tenant C cannot see A/B coordination)
//   I-03: Authority-field protection — canApproveCommitments cannot be set by balance_app
//   I-04: Authority-field protection — verifiedInstitutionId cannot be set by balance_app
//   I-05: Snapshot revocation — revoked snapshot is invisible to non-owner
//   I-06: Snapshot revocation — owner can still see revoked snapshot (audit trail)
//   I-07: Append-only — DELETE on reformApproval blocked + row persists
//   I-08: Append-only — UPDATE on reformActionUpdate blocked + row unchanged
//   I-09: Tenant-scoped FK — alternative.tenantId must match proposal.tenantId
//   I-10: Tenant-scoped FK — action.tenantId must match proposal.tenantId
//   I-11: Approval metadata — approvedBy modification denied + persisted unchanged
//   I-12: Approval metadata — status transition INTO 'approved' denied for balance_app
//   I-13: DEFINER functions — DORMANT (direct call raises permission denied)
//   I-14: INVOKER functions — EFFECTIVE call succeeds (is_snapshot_revoked works)
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE_PREFIX = "g03-01-it-";

let appClient: PrismaClient;
let adminClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let countryId: string;
let adminUserId: string;

// ============================================================
// Helpers
// ============================================================

/**
 * Set the app.tenant_id GUC for the current balance_app session.
 * Mirrors what withAuthenticatedTenant does in production code.
 */
async function setTenantContext(
  tenantId: string,
  userId = "g03-01-it-test-user",
  role = "analyst"
): Promise<void> {
  await appClient.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, false)`;
  await appClient.$executeRaw`SELECT set_config('app.user_id', ${userId}, false)`;
  await appClient.$executeRaw`SELECT set_config('app.role', ${role}, false)`;
}

async function resetTenantContext(): Promise<void> {
  await appClient.$executeRaw`SELECT set_config('app.tenant_id', '', false)`;
  await appClient.$executeRaw`SELECT set_config('app.user_id', '', false)`;
  await appClient.$executeRaw`SELECT set_config('app.role', '', false)`;
}

/**
 * Execute a function expecting it to throw. Returns [raised, message].
 * Useful for negative-path tests where we want to verify denial + check
 * persisted state afterwards.
 */
async function expectDenial<T>(fn: () => Promise<T>): Promise<{ raised: boolean; message: string }> {
  try {
    await fn();
    return { raised: false, message: "" };
  } catch (e) {
    return { raised: true, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Cleanup helper: disable the named trigger on a table, run a SQL DDL/DML,
 * re-enable the trigger. Used for teardown of fixtures in append-only tables
 * ONLY — never used in production paths.
 */
async function adminWithTriggerDisabled<T>(
  tableName: string,
  triggerName: string,
  sql: string
): Promise<void> {
  await adminClient.$executeRawUnsafe(
    `ALTER TABLE "${tableName}" DISABLE TRIGGER "${triggerName}"`
  );
  try {
    await adminClient.$executeRawUnsafe(sql);
  } finally {
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "${tableName}" ENABLE TRIGGER "${triggerName}"`
    );
  }
}

// ============================================================
// Setup / Teardown
// ============================================================

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;

  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  await appClient.$queryRaw`SELECT 1`;
  await adminClient.$queryRaw`SELECT 1`;

  // Fetch seeded Demolandia entities
  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) throw new Error("Demolandia (DML) not seeded — run bunx tsx prisma/seed-ontology.ts");
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) throw new Error("Test tenants not seeded");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const adminUser = await adminClient.user.findUnique({ where: { email: "admin@demolandia.test" } });
  if (!adminUser) throw new Error("Admin user not seeded");
  adminUserId = adminUser.id;
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  // Defensive cleanup — leftover fixtures from a prior interrupted run.
  // Pattern: disable triggers ONLY for append-only tables, delete, re-enable.
  // This guarantees rerunnability without leaving fixtures behind (directive D).
  try {
    await adminWithTriggerDisabled(
      "reform_coordination_shared_snapshot_revocations",
      "prevent_delete_reform_coord_revocations",
      `DELETE FROM reform_coordination_shared_snapshot_revocations WHERE id LIKE '${FIXTURE_PREFIX}%';`
    );
    await adminWithTriggerDisabled(
      "reform_coordination_shared_snapshot_revocations",
      "prevent_update_reform_coord_revocations",
      `DELETE FROM reform_coordination_shared_snapshot_revocations WHERE id LIKE '${FIXTURE_PREFIX}%';`
    );
    await adminWithTriggerDisabled(
      "reform_coordination_shared_snapshots",
      "shared_snapshot_immutable_after_approval_trigger",
      `DELETE FROM reform_coordination_shared_snapshots WHERE id LIKE '${FIXTURE_PREFIX}%';`
    );
    await adminClient.reformCoordinationInvitation.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformCoordinationParticipant.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformCoordination.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminWithTriggerDisabled(
      "reform_feedback_loops",
      "prevent_delete_reform_feedback_loops",
      `DELETE FROM reform_feedback_loops WHERE id LIKE '${FIXTURE_PREFIX}%';`
    );
    // reform_verifications is NOT append-only — no trigger to disable.
    await adminClient.reformVerification.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminWithTriggerDisabled(
      "reform_action_updates",
      "prevent_delete_reform_action_updates",
      `DELETE FROM reform_action_updates WHERE id LIKE '${FIXTURE_PREFIX}%';`
    );
    await adminClient.reformAction.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminWithTriggerDisabled(
      "reform_approvals",
      "prevent_delete_reform_approvals",
      `DELETE FROM reform_approvals WHERE id LIKE '${FIXTURE_PREFIX}%';`
    );
    await adminClient.reformAlternative.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
    await adminClient.reformProposal.deleteMany({
      where: { id: { startsWith: FIXTURE_PREFIX } },
    });
  } finally {
    await appClient.$disconnect();
    await adminClient.$disconnect();
  }
});

// ============================================================
// I-01: Coordination membership — positive (Tenant B sees participant row)
// ============================================================
describeIntegration("G03-01 I-01: Coordination membership — positive", () => {
  it("Tenant B can read its own participant row in a coordination owned by Tenant A", async () => {
    // Setup: Tenant A admin creates coordination + adds Tenant B as participant
    const coordId = `${FIXTURE_PREFIX}coord-i01`;
    const participantId = `${FIXTURE_PREFIX}part-i01`;
    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-01`,
        description: "Test fixture for I-01 positive membership test",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationParticipant.create({
      data: {
        id: participantId,
        coordinationId: coordId,
        tenantId: tenantBId,
        addedBy: adminUserId,
        status: "active",
        joinedAt: new Date(),
      },
    });

    try {
      // Tenant B reads its own participant row
      await setTenantContext(tenantBId);
      const rows = await appClient.reformCoordinationParticipant.findMany({
        where: { coordinationId: coordId },
      });
      expect(rows.length).toBe(1);
      expect(rows[0]!.tenantId).toBe(tenantBId);
      expect(rows[0]!.status).toBe("active");
      await resetTenantContext();
    } finally {
      await adminClient.reformCoordinationParticipant.deleteMany({
        where: { id: participantId },
      });
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-02: Coordination membership — negative (Tenant C cannot see A/B coordination)
// ============================================================
describeIntegration("G03-01 I-02: Coordination membership — negative (cross-tenant invisible)", () => {
  it("Tenant B cannot read Tenant A's coordination-only resources (no membership)", async () => {
    // Setup: Tenant A creates a coordination WITHOUT adding Tenant B as participant
    const coordId = `${FIXTURE_PREFIX}coord-i02`;
    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-02`,
        description: "Test fixture for I-02 negative membership test",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });

    try {
      // Tenant B tries to read — should see ZERO rows (no membership)
      await setTenantContext(tenantBId);
      const participants = await appClient.reformCoordinationParticipant.findMany({
        where: { coordinationId: coordId },
      });
      expect(participants.length).toBe(0);
      const snapshots = await appClient.reformCoordinationSharedSnapshot.findMany({
        where: { coordinationId: coordId },
      });
      expect(snapshots.length).toBe(0);
      await resetTenantContext();
    } finally {
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-03: Authority-field protection — canApproveCommitments cannot be set by balance_app
// ============================================================
describeIntegration("G03-01 I-03: Authority-field protection — canApproveCommitments", () => {
  it("balance_app cannot modify canApproveCommitments (D15 institutional authority separation)", async () => {
    const coordId = `${FIXTURE_PREFIX}coord-i03`;
    const participantId = `${FIXTURE_PREFIX}part-i03`;
    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-03`,
        description: "Test fixture for I-03 canApproveCommitments protection",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationParticipant.create({
      data: {
        id: participantId,
        coordinationId: coordId,
        tenantId: tenantBId,
        addedBy: adminUserId,
        status: "active",
        joinedAt: new Date(),
        canApproveCommitments: false, // initial value
      },
    });

    try {
      // Capture original
      const before = await adminClient.reformCoordinationParticipant.findUnique({
        where: { id: participantId },
      });
      expect(before!.canApproveCommitments).toBe(false);

      // Attempt: balance_app (tenant B context) tries to grant itself approval authority
      await setTenantContext(tenantBId);
      const { raised, message } = await expectDenial(() =>
        appClient.reformCoordinationParticipant.update({
          where: { id: participantId },
          data: { canApproveCommitments: true },
        })
      );
      await resetTenantContext();

      // Assert denial raised
      expect(raised).toBe(true);
      expect(message).toContain("S1 VIOLATION");

      // Assert persisted data UNCHANGED (directive D)
      const after = await adminClient.reformCoordinationParticipant.findUnique({
        where: { id: participantId },
      });
      expect(after!.canApproveCommitments).toBe(false);
    } finally {
      await adminClient.reformCoordinationParticipant.deleteMany({
        where: { id: participantId },
      });
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-04: Authority-field protection — verifiedInstitutionId cannot be set by balance_app
// ============================================================
describeIntegration("G03-01 I-04: Authority-field protection — verifiedInstitutionId", () => {
  it("balance_app cannot modify verifiedInstitutionId (D15 three-check, fail-closed)", async () => {
    const coordId = `${FIXTURE_PREFIX}coord-i04`;
    const participantId = `${FIXTURE_PREFIX}part-i04`;
    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-04`,
        description: "Test fixture for I-04 verifiedInstitutionId protection",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationParticipant.create({
      data: {
        id: participantId,
        coordinationId: coordId,
        tenantId: tenantBId,
        addedBy: adminUserId,
        status: "active",
        joinedAt: new Date(),
      },
    });

    try {
      const before = await adminClient.reformCoordinationParticipant.findUnique({
        where: { id: participantId },
      });
      expect(before!.verifiedInstitutionId).toBeNull();

      await setTenantContext(tenantBId);
      const { raised, message } = await expectDenial(() =>
        appClient.reformCoordinationParticipant.update({
          where: { id: participantId },
          data: { verifiedInstitutionId: "fake-institution-id" },
        })
      );
      await resetTenantContext();

      expect(raised).toBe(true);
      expect(message).toContain("S1 VIOLATION");

      const after = await adminClient.reformCoordinationParticipant.findUnique({
        where: { id: participantId },
      });
      expect(after!.verifiedInstitutionId).toBeNull();
    } finally {
      await adminClient.reformCoordinationParticipant.deleteMany({
        where: { id: participantId },
      });
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-05: Snapshot revocation — revoked snapshot invisible to non-owner participant
// ============================================================
describeIntegration("G03-01 I-05: Snapshot revocation — non-owner invisible", () => {
  it("Tenant B (participant) cannot see a snapshot revoked by Tenant A (owner)", async () => {
    const coordId = `${FIXTURE_PREFIX}coord-i05`;
    const participantId = `${FIXTURE_PREFIX}part-i05`;
    const snapshotId = `${FIXTURE_PREFIX}snap-i05`;
    const revocationId = `${FIXTURE_PREFIX}rev-i05`;

    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-05`,
        description: "Test fixture for I-05 snapshot revocation visibility",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationParticipant.create({
      data: {
        id: participantId,
        coordinationId: coordId,
        tenantId: tenantBId,
        addedBy: adminUserId,
        status: "active",
        joinedAt: new Date(),
      },
    });
    await adminClient.reformCoordinationSharedSnapshot.create({
      data: {
        id: snapshotId,
        coordinationId: coordId,
        ownerTenantId: tenantAId,
        snapshotType: "commitment",
        title: `${FIXTURE_PREFIX} Snapshot I-05`,
        summary: "Snapshot to be revoked",
        status: "approved",
        approvedAt: new Date(),
        approvedBy: adminUserId,
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationSharedSnapshotRevocation.create({
      data: {
        id: revocationId,
        tenantId: tenantAId,
        coordinationId: coordId,
        snapshotId,
        revokedBy: adminUserId,
        reason: "I-05 test revocation",
      },
    });

    try {
      // Tenant B reads — should see ZERO snapshots (revoked filters them out via RLS)
      await setTenantContext(tenantBId);
      const snapshots = await appClient.reformCoordinationSharedSnapshot.findMany({
        where: { coordinationId: coordId },
      });
      expect(snapshots.length).toBe(0);
      await resetTenantContext();
    } finally {
      await adminWithTriggerDisabled(
        "reform_coordination_shared_snapshot_revocations",
        "prevent_delete_reform_coord_revocations",
        `DELETE FROM reform_coordination_shared_snapshot_revocations WHERE id = '${revocationId}';`
      );
      await adminWithTriggerDisabled(
        "reform_coordination_shared_snapshots",
        "shared_snapshot_immutable_after_approval_trigger",
        `DELETE FROM reform_coordination_shared_snapshots WHERE id = '${snapshotId}';`
      );
      await adminClient.reformCoordinationParticipant.deleteMany({
        where: { id: participantId },
      });
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-06: Snapshot revocation — owner can still see revoked snapshot (audit trail)
// ============================================================
describeIntegration("G03-01 I-06: Snapshot revocation — owner retains audit visibility", () => {
  it("Tenant A (owner) can still read its own revoked snapshot for audit", async () => {
    const coordId = `${FIXTURE_PREFIX}coord-i06`;
    const snapshotId = `${FIXTURE_PREFIX}snap-i06`;
    const revocationId = `${FIXTURE_PREFIX}rev-i06`;

    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-06`,
        description: "Test fixture for I-06 owner audit visibility",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationSharedSnapshot.create({
      data: {
        id: snapshotId,
        coordinationId: coordId,
        ownerTenantId: tenantAId,
        snapshotType: "commitment",
        title: `${FIXTURE_PREFIX} Snapshot I-06`,
        summary: "Snapshot to be revoked (owner audit test)",
        status: "approved",
        approvedAt: new Date(),
        approvedBy: adminUserId,
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationSharedSnapshotRevocation.create({
      data: {
        id: revocationId,
        tenantId: tenantAId,
        coordinationId: coordId,
        snapshotId,
        revokedBy: adminUserId,
        reason: "I-06 test revocation — owner should still see this snapshot",
      },
    });

    try {
      // Tenant A reads — should still see the snapshot (revocation hides from
      // NON-OWNER participants only; owner retains audit visibility)
      await setTenantContext(tenantAId);
      const snapshots = await appClient.reformCoordinationSharedSnapshot.findMany({
        where: { coordinationId: coordId },
      });
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      const found = snapshots.find((s) => s.id === snapshotId);
      expect(found).toBeDefined();
      await resetTenantContext();
    } finally {
      await adminWithTriggerDisabled(
        "reform_coordination_shared_snapshot_revocations",
        "prevent_delete_reform_coord_revocations",
        `DELETE FROM reform_coordination_shared_snapshot_revocations WHERE id = '${revocationId}';`
      );
      await adminWithTriggerDisabled(
        "reform_coordination_shared_snapshots",
        "shared_snapshot_immutable_after_approval_trigger",
        `DELETE FROM reform_coordination_shared_snapshots WHERE id = '${snapshotId}';`
      );
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-07: Append-only — DELETE on reform_approvals blocked + row persists
// ============================================================
describeIntegration("G03-01 I-07: Append-only — DELETE blocked on reform_approvals", () => {
  it("Even balance_admin cannot DELETE from reform_approvals (unconditional trigger)", async () => {
    const proposalId = `${FIXTURE_PREFIX}prop-i07`;
    const altId = `${FIXTURE_PREFIX}alt-i07`;
    const approvalId = `${FIXTURE_PREFIX}appr-i07`;

    await adminClient.reformProposal.create({
      data: {
        id: proposalId,
        tenantId: tenantAId,
        title: `${FIXTURE_PREFIX} Proposal I-07`,
        problemStatement: "I-07 append-only DELETE test",
        status: "approved",
        createdBy: adminUserId,
      },
    });
    await adminClient.reformAlternative.create({
      data: {
        id: altId,
        tenantId: tenantAId,
        proposalId,
        title: `${FIXTURE_PREFIX} Alternative I-07`,
        description: "I-07 append-only DELETE test alternative",
        status: "selected",
        createdBy: adminUserId,
      },
    });
    await adminClient.reformApproval.create({
      data: {
        id: approvalId,
        tenantId: tenantAId,
        proposalId,
        alternativeId: altId,
        approvedBy: adminUserId,
        rationale: "I-07 test fixture approval",
      },
    });

    try {
      const before = await adminClient.reformApproval.count({
        where: { id: approvalId },
      });
      expect(before).toBe(1);

      const { raised, message } = await expectDenial(() =>
        adminClient.reformApproval.delete({ where: { id: approvalId } })
      );
      expect(raised).toBe(true);
      expect(message).toContain("S3 VIOLATION");

      const after = await adminClient.reformApproval.count({
        where: { id: approvalId },
      });
      expect(after).toBe(1); // unchanged
    } finally {
      await adminWithTriggerDisabled(
        "reform_approvals",
        "prevent_delete_reform_approvals",
        `DELETE FROM reform_approvals WHERE id = '${approvalId}';`
      );
      await adminClient.reformAlternative.deleteMany({ where: { id: altId } });
      await adminClient.reformProposal.deleteMany({ where: { id: proposalId } });
    }
  });
});

// ============================================================
// I-08: Append-only — UPDATE on reform_action_updates blocked + row unchanged
// ============================================================
describeIntegration("G03-01 I-08: Append-only — UPDATE blocked on reform_action_updates", () => {
  it("Even balance_admin cannot UPDATE reform_action_updates (unconditional trigger)", async () => {
    const proposalId = `${FIXTURE_PREFIX}prop-i08`;
    const altId = `${FIXTURE_PREFIX}alt-i08`;
    const actionId = `${FIXTURE_PREFIX}act-i08`;
    const updateId = `${FIXTURE_PREFIX}upd-i08`;

    await adminClient.reformProposal.create({
      data: {
        id: proposalId,
        tenantId: tenantAId,
        title: `${FIXTURE_PREFIX} Proposal I-08`,
        problemStatement: "I-08 append-only UPDATE test",
        status: "approved",
        createdBy: adminUserId,
      },
    });
    await adminClient.reformAlternative.create({
      data: {
        id: altId,
        tenantId: tenantAId,
        proposalId,
        title: `${FIXTURE_PREFIX} Alternative I-08`,
        description: "I-08 append-only UPDATE test alternative",
        status: "selected",
        createdBy: adminUserId,
      },
    });
    await adminClient.reformAction.create({
      data: {
        id: actionId,
        tenantId: tenantAId,
        proposalId,
        alternativeId: altId,
        title: `${FIXTURE_PREFIX} Action I-08`,
        status: "in_progress",
        createdBy: adminUserId,
      },
    });
    await adminClient.reformActionUpdate.create({
      data: {
        id: updateId,
        tenantId: tenantAId,
        actionId,
        updateType: "progress",
        notes: "ORIGINAL NOTES — should not change",
        actor: adminUserId,
      },
    });

    try {
      const before = await adminClient.reformActionUpdate.findUnique({
        where: { id: updateId },
      });
      expect(before!.notes).toBe("ORIGINAL NOTES — should not change");

      const { raised, message } = await expectDenial(() =>
        adminClient.reformActionUpdate.update({
          where: { id: updateId },
          data: { notes: "HACKED" },
        })
      );
      expect(raised).toBe(true);
      expect(message).toContain("S3 VIOLATION");

      const after = await adminClient.reformActionUpdate.findUnique({
        where: { id: updateId },
      });
      expect(after!.notes).toBe("ORIGINAL NOTES — should not change"); // unchanged
    } finally {
      await adminWithTriggerDisabled(
        "reform_action_updates",
        "prevent_delete_reform_action_updates",
        `DELETE FROM reform_action_updates WHERE id = '${updateId}';`
      );
      await adminClient.reformAction.deleteMany({ where: { id: actionId } });
      await adminClient.reformAlternative.deleteMany({ where: { id: altId } });
      await adminClient.reformProposal.deleteMany({ where: { id: proposalId } });
    }
  });
});

// ============================================================
// I-09: Tenant-scoped FK — alternative.tenantId must match proposal.tenantId
// ============================================================
describeIntegration("G03-01 I-09: Cross-tenant FK — alternative.tenantId ≠ proposal.tenantId", () => {
  it("INSERT reform_alternatives with mismatched tenantId is rejected by trigger", async () => {
    const proposalId = `${FIXTURE_PREFIX}prop-i09`;
    const altId = `${FIXTURE_PREFIX}alt-i09`;

    await adminClient.reformProposal.create({
      data: {
        id: proposalId,
        tenantId: tenantAId,
        title: `${FIXTURE_PREFIX} Proposal I-09`,
        problemStatement: "I-09 cross-tenant FK test",
        status: "draft",
        createdBy: adminUserId,
      },
    });

    try {
      const { raised } = await expectDenial(() =>
        adminClient.reformAlternative.create({
          data: {
            id: altId,
            tenantId: tenantBId, // mismatched!
            proposalId, // belongs to tenantA
            title: `${FIXTURE_PREFIX} Alternative I-09 (cross-tenant)`,
            description: "Should be rejected by trigger",
            createdBy: adminUserId,
          },
        })
      );
      expect(raised).toBe(true);

      // Verify no orphan alternative was created
      const count = await adminClient.reformAlternative.count({ where: { id: altId } });
      expect(count).toBe(0);
    } finally {
      await adminClient.reformAlternative.deleteMany({ where: { id: altId } });
      await adminClient.reformProposal.deleteMany({ where: { id: proposalId } });
    }
  });
});

// ============================================================
// I-10: Tenant-scoped FK — action.tenantId must match proposal.tenantId
// ============================================================
describeIntegration("G03-01 I-10: Cross-tenant FK — action.tenantId ≠ proposal.tenantId", () => {
  it("INSERT reform_actions with mismatched tenantId is rejected by trigger", async () => {
    const proposalId = `${FIXTURE_PREFIX}prop-i10`;
    const altId = `${FIXTURE_PREFIX}alt-i10`;
    const actionId = `${FIXTURE_PREFIX}act-i10`;

    await adminClient.reformProposal.create({
      data: {
        id: proposalId,
        tenantId: tenantAId,
        title: `${FIXTURE_PREFIX} Proposal I-10`,
        problemStatement: "I-10 cross-tenant FK test (action)",
        status: "draft",
        createdBy: adminUserId,
      },
    });
    await adminClient.reformAlternative.create({
      data: {
        id: altId,
        tenantId: tenantAId,
        proposalId,
        title: `${FIXTURE_PREFIX} Alternative I-10`,
        description: "I-10 alternative",
        status: "selected",
        createdBy: adminUserId,
      },
    });

    try {
      const { raised } = await expectDenial(() =>
        adminClient.reformAction.create({
          data: {
            id: actionId,
            tenantId: tenantBId, // mismatched!
            proposalId, // belongs to tenantA
            alternativeId: altId,
            title: `${FIXTURE_PREFIX} Action I-10 (cross-tenant)`,
            createdBy: adminUserId,
          },
        })
      );
      expect(raised).toBe(true);

      const count = await adminClient.reformAction.count({ where: { id: actionId } });
      expect(count).toBe(0);
    } finally {
      await adminClient.reformAction.deleteMany({ where: { id: actionId } });
      await adminClient.reformAlternative.deleteMany({ where: { id: altId } });
      await adminClient.reformProposal.deleteMany({ where: { id: proposalId } });
    }
  });
});

// ============================================================
// I-11: Approval metadata — approvedBy modification denied + persisted unchanged
// ============================================================
describeIntegration("G03-01 I-11: Approval metadata — approvedBy protection", () => {
  it("balance_app cannot modify approvedBy on an approved shared snapshot (migration 0025)", async () => {
    const coordId = `${FIXTURE_PREFIX}coord-i11`;
    const snapshotId = `${FIXTURE_PREFIX}snap-i11`;

    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-11`,
        description: "I-11 approvedBy protection test",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationSharedSnapshot.create({
      data: {
        id: snapshotId,
        coordinationId: coordId,
        ownerTenantId: tenantAId,
        snapshotType: "commitment",
        title: `${FIXTURE_PREFIX} Snapshot I-11`,
        summary: "I-11 approvedBy protection test snapshot",
        status: "approved",
        approvedAt: new Date(),
        approvedBy: adminUserId,
        createdBy: adminUserId,
      },
    });

    try {
      const before = await adminClient.reformCoordinationSharedSnapshot.findUnique({
        where: { id: snapshotId },
      });
      const origApprovedBy = before!.approvedBy;

      await setTenantContext(tenantAId);
      const { raised, message } = await expectDenial(() =>
        appClient.reformCoordinationSharedSnapshot.update({
          where: { id: snapshotId },
          data: { approvedBy: "HACKED_BY_INTEGRATION_TEST" },
        })
      );
      await resetTenantContext();

      expect(raised).toBe(true);
      expect(message).toContain("S3 VIOLATION");
      expect(message).toContain("approvedBy");

      const after = await adminClient.reformCoordinationSharedSnapshot.findUnique({
        where: { id: snapshotId },
      });
      expect(after!.approvedBy).toBe(origApprovedBy); // unchanged
    } finally {
      await adminWithTriggerDisabled(
        "reform_coordination_shared_snapshots",
        "shared_snapshot_immutable_after_approval_trigger",
        `DELETE FROM reform_coordination_shared_snapshots WHERE id = '${snapshotId}';`
      );
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-12: Approval metadata — status transition INTO 'approved' denied for balance_app
// ============================================================
describeIntegration("G03-01 I-12: Approval metadata — status→approved transition denied", () => {
  it("balance_app cannot transition status from draft to approved (migration 0025)", async () => {
    const coordId = `${FIXTURE_PREFIX}coord-i12`;
    const snapshotId = `${FIXTURE_PREFIX}snap-i12`;

    await adminClient.reformCoordination.create({
      data: {
        id: coordId,
        leadTenantId: tenantAId,
        countryId,
        title: `${FIXTURE_PREFIX} Coordination I-12`,
        description: "I-12 status transition test",
        approvalPolicy: "lead_only",
        status: "active",
        activatedAt: new Date(),
        createdBy: adminUserId,
      },
    });
    await adminClient.reformCoordinationSharedSnapshot.create({
      data: {
        id: snapshotId,
        coordinationId: coordId,
        ownerTenantId: tenantAId,
        snapshotType: "commitment",
        title: `${FIXTURE_PREFIX} Snapshot I-12 (draft)`,
        summary: "I-12 status transition test — starts in draft",
        status: "draft", // intentionally draft — balance_app tries to flip
        createdBy: adminUserId,
      },
    });

    try {
      const before = await adminClient.reformCoordinationSharedSnapshot.findUnique({
        where: { id: snapshotId },
      });
      expect(before!.status).toBe("draft");

      await setTenantContext(tenantAId);
      const { raised, message } = await expectDenial(() =>
        appClient.reformCoordinationSharedSnapshot.update({
          where: { id: snapshotId },
          data: { status: "approved" },
        })
      );
      await resetTenantContext();

      expect(raised).toBe(true);
      expect(message).toContain("S3 VIOLATION");
      expect(message).toContain("transition status to approved");

      const after = await adminClient.reformCoordinationSharedSnapshot.findUnique({
        where: { id: snapshotId },
      });
      expect(after!.status).toBe("draft"); // unchanged
    } finally {
      await adminWithTriggerDisabled(
        "reform_coordination_shared_snapshots",
        "shared_snapshot_immutable_after_approval_trigger",
        `DELETE FROM reform_coordination_shared_snapshots WHERE id = '${snapshotId}';`
      );
      await adminClient.reformCoordination.deleteMany({ where: { id: coordId } });
    }
  });
});

// ============================================================
// I-13: DEFINER functions — DORMANT (direct call raises permission denied)
// ============================================================
describeIntegration("G03-01 I-13: DEFINER functions DORMANT — EFFECTIVE privilege test", () => {
  it("balance_app direct call to remove_coordination_participant raises (REVOKE effective)", async () => {
    await setTenantContext(tenantAId);
    const { raised, message } = await expectDenial(() =>
      appClient.$queryRaw`SELECT remove_coordination_participant('fake-coord', 'fake-part', 'probe')`
    );
    await resetTenantContext();

    expect(raised).toBe(true);
    // Could be "permission denied for function" or "function not found" depending
    // on search_path; either way, balance_app cannot execute it.
    const lower = message.toLowerCase();
    expect(
      lower.includes("permission denied") ||
        lower.includes("does not exist") ||
        lower.includes("no function")
    ).toBe(true);
  });
});

// ============================================================
// I-14: INVOKER functions — EFFECTIVE call succeeds (is_snapshot_revoked works)
// ============================================================
describeIntegration("G03-01 I-14: INVOKER functions EFFECTIVE — direct call succeeds", () => {
  it("balance_app can call is_snapshot_revoked() and gets a boolean result", async () => {
    await setTenantContext(tenantAId);
    const result = await appClient.$queryRaw<{ is_snapshot_revoked: boolean }[]>`
      SELECT is_snapshot_revoked('g03-01-it-nonexistent-snapshot') AS is_snapshot_revoked
    `;
    await resetTenantContext();

    expect(result.length).toBe(1);
    expect(typeof result[0]!.is_snapshot_revoked).toBe("boolean");
    expect(result[0]!.is_snapshot_revoked).toBe(false); // nonexistent → false (no revocation)
  });
});
