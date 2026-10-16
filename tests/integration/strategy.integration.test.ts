// ============================================================
// strategy.integration.test.ts
// ------------------------------------------------------------
// Integration tests for the strategy contracts.
// Tests one full workflow cycle:
//   1. Create strategy + initial version
//   2. Create new version
//   3. Approve version (immutable)
//   4. Create decision linked to evidence
//   5. Advance decision (proposed → reviewed → approved)
//   6. Verify evidence snapshot at decision time
//   7. Cross-tenant isolation
//   8. Approved version immutability
//   9. Decision events are append-only
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createStrategy,
  createStrategyVersion,
  approveStrategyVersion,
  createDecision,
  advanceDecision,
  getDecisionDetail,
} from "@/lib/strategy-service";
import { createEvidence } from "@/lib/evidence-service";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let adminClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let adminUserId: string;
let analystUserId: string;
let supportingEvidenceId: string;
let counterEvidenceId: string;

const ADMIN_EMAIL = "admin@demolandia.test";
const ANALYST_EMAIL = "analyst@demolandia.test";

function mockSession(
  userId: string,
  tenantId: string,
  roleCode: string,
  email: string,
  name: string
): Session {
  return {
    user: { id: userId, email, name, tenantId, roleCode, membershipStatus: "active" },
    expires: new Date(Date.now() + 3600000).toISOString(),
  } as Session;
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;

  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  const adminUser = await adminClient.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const analystUser = await adminClient.user.findUnique({ where: { email: ANALYST_EMAIL } });
  if (!tenantA || !tenantB || !adminUser || !analystUser) throw new Error("Seed data not found");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  adminUserId = adminUser.id;
  analystUserId = analystUser.id;

  // Clean up
  await adminClient.decisionEvent.deleteMany({});
  await adminClient.decision.deleteMany({});
  await adminClient.strategyVersion.deleteMany({});
  await adminClient.strategy.deleteMany({});
  await adminClient.event.deleteMany({});
});

afterAll(async () => {
  if (adminClient) {
    await adminClient.decisionEvent.deleteMany({});
    await adminClient.decision.deleteMany({});
    await adminClient.strategyVersion.deleteMany({});
    await adminClient.strategy.deleteMany({});
    await adminClient.event.deleteMany({});
    await adminClient.$disconnect();
  }
});

describeIntegration("Strategy Contracts — Full Workflow", () => {
  let strategyId: string;
  let version1Id: string;
  let version2Id: string;
  let decisionId: string;

  // ============================================================
  // 1. CREATE STRATEGY + INITIAL VERSION
  // ============================================================
  it("createStrategy creates strategy + v1 draft", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await createStrategy(session, {
      title: "Demolandia Agricultural Modernization 2025",
      description: "Strategy for modernizing agricultural sector",
      initialContent: "Initial draft: Focus on drip irrigation and climate-smart crops.",
    });

    expect(result.strategyId).toBeTruthy();
    expect(result.versionId).toBeTruthy();
    strategyId = result.strategyId;
    version1Id = result.versionId;

    const strategy = await adminClient.strategy.findUnique({
      where: { id: strategyId },
      include: { versions: true },
    });
    expect(strategy?.status).toBe("draft");
    expect(strategy?.versions.length).toBe(1);
    expect(strategy?.versions[0]?.versionNumber).toBe(1);
    expect(strategy?.versions[0]?.status).toBe("draft");
  });

  // ============================================================
  // 2. CREATE NEW VERSION
  // ============================================================
  it("createStrategyVersion creates v2 draft", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await createStrategyVersion(session, strategyId, {
      content: "Revised draft: Added soil regeneration techniques and weather insurance.",
    });

    expect(result.versionNumber).toBe(2);
    version2Id = result.versionId;
  });

  // ============================================================
  // 3. APPROVE VERSION (immutable once approved)
  // ============================================================
  it("approveStrategyVersion marks v2 as approved + supersedes v1", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await approveStrategyVersion(session, version2Id, "Approved with minor revisions.");

    expect(result.status).toBe("approved");
    expect(result.approvedBy).toBe(adminUserId);

    // Strategy status should be "approved"
    const strategy = await adminClient.strategy.findUnique({ where: { id: strategyId } });
    expect(strategy?.status).toBe("approved");

    // v1 should still be "draft" (not approved, so not superseded)
    const v1 = await adminClient.strategyVersion.findUnique({ where: { id: version1Id } });
    expect(v1?.status).toBe("draft");
  });

  // ============================================================
  // 4. APPROVED VERSION IS IMMUTABLE — cannot re-approve
  // ============================================================
  it("cannot approve an already-approved version (immutable)", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    await expect(
      approveStrategyVersion(session, version2Id, "Second approval attempt")
    ).rejects.toThrow(/already approved|immutable/i);
  });

  // ============================================================
  // 5. CREATE DECISION LINKED TO EVIDENCE
  // ============================================================
  it("createDecision captures evidence snapshot at decision time", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create supporting + counter evidence first
    const supportingResult = await createEvidence(session, {
      claim: "Agricultural GDP grew 4.2% in 2024.",
      type: "supporting",
      source: {
        code: "DECISION-SRC-001",
        displayName: "Decision Source",
        type: "international_org",
      },
    });
    supportingEvidenceId = supportingResult.evidenceId;

    const counterResult = await createEvidence(session, {
      claim: "Farmers report crop decline due to drought.",
      type: "counter",
      source: {
        code: "DECISION-SRC-002",
        displayName: "Counter Source",
        type: "media",
      },
    });
    counterEvidenceId = counterResult.evidenceId;

    // Create decision
    const result = await createDecision(session, {
      strategyVersionId: version2Id,
      title: "Approve Agricultural Modernization Strategy v2",
      rationale: "Based on evidence of agricultural growth and acknowledging counter-evidence about drought risks.",
      supportingEvidenceIds: [supportingEvidenceId],
      counterEvidenceIds: [counterEvidenceId],
    });

    expect(result.decisionId).toBeTruthy();
    decisionId = result.decisionId;

    // Verify evidence snapshot was captured
    const decision = await adminClient.decision.findUnique({ where: { id: decisionId } });
    expect(decision?.supportingEvidence).toBeTruthy();
    expect(decision?.counterEvidence).toBeTruthy();
    // The supportingEvidence JSONB should contain the evidence ID + verification status
    const supporting = decision?.supportingEvidence as unknown as Array<{ evidenceId: string; verificationStatus: string }>;
    expect(supporting.length).toBe(1);
    expect(supporting[0]?.evidenceId).toBe(supportingEvidenceId);
    expect(supporting[0]?.verificationStatus).toBe("unverified"); // At decision time
  });

  // ============================================================
  // 6. ADVANCE DECISION: proposed → reviewed → approved
  // ============================================================
  it("advanceDecision: proposed → reviewed → approved", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // reviewed
    const reviewed = await advanceDecision(session, decisionId, "reviewed", "Reviewed by strategy team.");
    expect(reviewed.status).toBe("reviewed");

    // approved
    const approved = await advanceDecision(session, decisionId, "approved", "Approved by minister.");
    expect(approved.status).toBe("approved");
  });

  // ============================================================
  // 7. DECISION EVENT TRAIL (append-only)
  // ============================================================
  it("getDecisionDetail returns full event trail", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const detail = await getDecisionDetail(session, decisionId);

    expect(detail.decision.status).toBe("approved");
    expect(detail.events.length).toBeGreaterThanOrEqual(3); // proposed + reviewed + approved
    expect(detail.events[0]?.eventType).toBe("proposed");
    expect(detail.events[1]?.eventType).toBe("reviewed");
    expect(detail.events[2]?.eventType).toBe("approved");
  });

  // ============================================================
  // 8. DECISION EVENTS ARE APPEND-ONLY (cannot UPDATE/DELETE)
  // ============================================================
  it("balance_app cannot UPDATE or DELETE decision events (append-only)", async () => {
    const { withTenant } = await import("@/lib/security/tenant-context");
    const firstEventId = (await adminClient.decisionEvent.findFirst({
      where: { decisionId },
      orderBy: { at: "asc" },
    }))?.id;

    expect(firstEventId).toBeTruthy();

    // Attempt UPDATE → should fail (REVOKE'd)
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.decisionEvent.update({
          where: { id: firstEventId! },
          data: { notes: "tampered" },
        });
      })
    ).rejects.toThrow(/permission denied/i);

    // Attempt DELETE → should fail
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.decisionEvent.delete({ where: { id: firstEventId! } });
      })
    ).rejects.toThrow(/permission denied/i);
  });

  // ============================================================
  // 9. CROSS-TENANT ISOLATION — Tenant B cannot see Tenant A's strategies
  // ============================================================
  it("Tenant B cannot see Tenant A's strategies (RLS)", async () => {
    // Create a session for Tenant B (admin has membership in both via E2E test setup)
    // But admin's first membership is in Tenant A, so use a mock session for B
    const sessionB = mockSession(adminUserId, tenantBId, "admin", ADMIN_EMAIL, "Test Admin");

    // Attempt to read Tenant A's strategy via Tenant B context
    await expect(
      createStrategyVersion(sessionB, strategyId, { content: "cross-tenant attempt" })
    ).rejects.toThrow(); // Strategy not found in Tenant B's scope (RLS)
  });

  // ============================================================
  // 10. ANALYST CAN CREATE STRATEGY BUT CANNOT APPROVE
  // ============================================================
  it("analyst can create strategy but cannot approve (RBAC)", async () => {
    const analystSession = mockSession(analystUserId, tenantAId, "analyst", ANALYST_EMAIL, "Test Analyst");

    // Analyst can create strategy
    const createResult = await createStrategy(analystSession, {
      title: "Analyst Draft Strategy",
      initialContent: "Draft by analyst.",
    });
    expect(createResult.strategyId).toBeTruthy();

    // Analyst CANNOT approve (requires strategy:approve)
    await expect(
      approveStrategyVersion(analystSession, createResult.versionId)
    ).rejects.toThrow(/Permission denied/);
  });

  // ============================================================
  // 11. EVIDENCE SNAPSHOT PRESERVES VERIFICATION STATUS AT DECISION TIME
  // ============================================================
  it("evidence snapshot preserves verification status at decision time", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Verify the supporting evidence AFTER the decision was made
    const { verifyEvidence } = await import("@/lib/evidence-service");
    await verifyEvidence(session, supportingEvidenceId, "verified", "Cross-checked.");

    // Get decision detail — the snapshot should still show "unverified"
    const detail = await getDecisionDetail(session, decisionId);
    const snapshot = detail.decision.supportingEvidence[0];
    expect(snapshot?.verificationStatus).toBe("unverified"); // At decision time, not current
  });

  // ============================================================
  // 12. APPROVED VERSION IMMUTABILITY — cannot UPDATE content (DB trigger)
  // ============================================================
  it("cannot UPDATE content of approved strategy version (DB trigger)", async () => {
    const { withTenant } = await import("@/lib/security/tenant-context");
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // version2Id was approved in test 3
    // Attempt to UPDATE its content via balance_app
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.strategyVersion.update({
          where: { id: version2Id },
          data: { content: "TAMPERED CONTENT" },
        });
      })
    ).rejects.toThrow(/immutable|cannot modify/i);
  });

  // ============================================================
  // 13. DECISION TRANSITION — cannot skip proposed → implemented
  // ============================================================
  it("cannot skip decision states: proposed → implemented rejected", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create a fresh decision (status = proposed)
    const result = await createDecision(session, {
      title: "Transition test decision",
      rationale: "Testing state transition rules.",
    });

    // Attempt: proposed → implemented (INVALID — must go through reviewed → approved first)
    await expect(
      advanceDecision(session, result.decisionId, "implemented")
    ).rejects.toThrow(/Invalid decision state transition/i);
  });

  // ============================================================
  // 14. DECISION TRANSITION — reversed → approved rejected
  // ============================================================
  it("cannot transition reversed → approved (invalid)", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create + advance to approved + reverse
    const result = await createDecision(session, {
      title: "Reversal test decision",
      rationale: "Testing reversal transition.",
    });
    await advanceDecision(session, result.decisionId, "reviewed");
    await advanceDecision(session, result.decisionId, "approved");
    await advanceDecision(session, result.decisionId, "reversed");

    // Attempt: reversed → approved (INVALID — reversed can only go to proposed)
    await expect(
      advanceDecision(session, result.decisionId, "approved")
    ).rejects.toThrow(/Invalid decision state transition/i);
  });

  // ============================================================
  // 15. EVIDENCE COMPLETENESS — missing evidence ID rejected
  // ============================================================
  it("createDecision rejects when supporting evidence ID not found", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Use a real evidence ID + a fake one
    await expect(
      createDecision(session, {
        title: "Incomplete evidence test",
        rationale: "Should fail due to missing evidence.",
        supportingEvidenceIds: [supportingEvidenceId, "nonexistent-evidence-id"],
      })
    ).rejects.toThrow(/Evidence completeness violation/i);
  });

  // ============================================================
  // 16. EVIDENCE COMPLETENESS — cross-tenant evidence rejected
  // ============================================================
  it("createDecision rejects when evidence belongs to different tenant", async () => {
    // Create evidence in Tenant B (via admin client)
    const tenantBEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantBId,
        claim: "Tenant B private evidence for cross-tenant decision test.",
      },
    });

    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Attempt: create decision in Tenant A referencing Tenant B's evidence
    await expect(
      createDecision(session, {
        title: "Cross-tenant evidence test",
        rationale: "Should fail — evidence from Tenant B.",
        supportingEvidenceIds: [tenantBEvidence.id],
      })
    ).rejects.toThrow(/Evidence completeness violation/i);

    // Cleanup
    await adminClient.evidence.delete({ where: { id: tenantBEvidence.id } });
  });

  // ============================================================
  // 17. STRATEGY VERSION CROSS-TENANT — cannot link decision to other tenant's version
  // ============================================================
  it("createDecision rejects when strategyVersionId belongs to different tenant", async () => {
    // Create a strategy + version in Tenant B (via admin client)
    const tenantBStrategy = await adminClient.strategy.create({
      data: { tenantId: tenantBId, title: "Tenant B strategy", createdBy: adminUserId },
    });
    const tenantBVersion = await adminClient.strategyVersion.create({
      data: {
        strategyId: tenantBStrategy.id,
        tenantId: tenantBId,
        versionNumber: 1,
        content: "Tenant B version content",
        createdBy: adminUserId,
      },
    });

    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Attempt: create decision in Tenant A linked to Tenant B's version
    await expect(
      createDecision(session, {
        title: "Cross-tenant version test",
        rationale: "Should fail — version from Tenant B.",
        strategyVersionId: tenantBVersion.id,
      })
    ).rejects.toThrow(/not found in tenant scope/i);

    // Cleanup
    await adminClient.strategyVersion.delete({ where: { id: tenantBVersion.id } });
    await adminClient.strategy.delete({ where: { id: tenantBStrategy.id } });
  });

  // ============================================================
  // 18. SUPERSESSION CYCLE — approve v1, create v2, approve v2, v1 superseded
  // ------------------------------------------------------------
  // Founder directive (00-05 final supersession check):
  // Prove that approving a new version supersedes the previous approved
  // version WITHOUT modifying its content or approval records.
  // Also verify Prisma's auto-update of `updatedAt` doesn't trigger
  // the immutability protection.
  // ============================================================
  it("supersession cycle: approve v1 → create v2 → approve v2 → v1 superseded", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // 1. Create strategy + v1
    const createResult = await createStrategy(session, {
      title: "Supersession Test Strategy",
      description: "Testing approved version supersession",
      initialContent: "V1 content — original approved version.",
    });

    // 2. Approve v1
    const approveV1 = await approveStrategyVersion(session, createResult.versionId, "V1 approved.");
    expect(approveV1.status).toBe("approved");

    // Capture v1 state BEFORE supersession
    const v1Before = await adminClient.strategyVersion.findUnique({
      where: { id: createResult.versionId },
    });
    expect(v1Before?.status).toBe("approved");
    expect(v1Before?.content).toBe("V1 content — original approved version.");
    expect(v1Before?.approvedBy).toBe(adminUserId);
    expect(v1Before?.approvedAt).toBeTruthy();
    const v1ApprovedAt = v1Before?.approvedAt!;
    const v1ApprovalNotes = v1Before?.approvalNotes;

    // 3. Create v2
    const v2Result = await createStrategyVersion(session, createResult.strategyId, {
      content: "V2 content — revised version.",
    });

    // 4. Approve v2 — this should supersede v1
    const approveV2 = await approveStrategyVersion(session, v2Result.versionId, "V2 approved, supersedes V1.");
    expect(approveV2.status).toBe("approved");

    // 5. Verify v1 is now 'superseded'
    const v1After = await adminClient.strategyVersion.findUnique({
      where: { id: createResult.versionId },
    });
    expect(v1After?.status).toBe("superseded");

    // 6. Verify v1 content + approval records are UNCHANGED
    expect(v1After?.content).toBe("V1 content — original approved version.");
    expect(v1After?.approvedBy).toBe(adminUserId);
    expect(v1After?.approvedAt).toEqual(v1ApprovedAt); // Exact same timestamp
    expect(v1After?.approvalNotes).toBe(v1ApprovalNotes); // Unchanged

    // 7. Verify v2 is 'approved'
    const v2After = await adminClient.strategyVersion.findUnique({
      where: { id: v2Result.versionId },
    });
    expect(v2After?.status).toBe("approved");
    expect(v2After?.content).toBe("V2 content — revised version.");

    // 8. Verify event was recorded for v2 approval
    const events = await adminClient.event.findMany({
      where: {
        tenantId: tenantAId,
        entityType: "strategy_version",
        entityId: v2Result.versionId,
      },
      orderBy: { at: "asc" },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.eventType === "strategy.version_approved")).toBe(true);
  });
});
