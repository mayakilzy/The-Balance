// ============================================================
// evidence.integration.test.ts
// ------------------------------------------------------------
// Integration tests for the evidence fabric.
// Runs in CI against real PostgreSQL 16 + pgvector.
//
// Covers:
//   1. Evidence CRUD (create, read, list)
//   2. Supporting + counter-evidence linking
//   3. Vector search (pgvector similarity)
//   4. Source dedup + independence counting
//   5. Cross-tenant isolation (RLS)
//   6. Provenance fields (observedAt, retrievedAt, extractionMethod)
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createEvidence, searchEvidence, countIndependentSources, hashUrl, verifyEvidence } from "@/lib/evidence-service";
import { withAuthenticatedTenant, withTenant } from "@/lib/security/tenant-context";
import type { Session } from "next-auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let appClient: PrismaClient;
let adminClient: PrismaClient;
let tenantAId: string;
let tenantBId: string;
let adminUserId: string;
let evidence1Id: string;

const ADMIN_EMAIL = "admin@demolandia.test";

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

  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  const adminUser = await adminClient.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!tenantA || !tenantB || !adminUser) throw new Error("Seed data not found");
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  adminUserId = adminUser.id;

  // Clean up evidence from previous runs
  await adminClient.evidenceEmbedding.deleteMany({});
  await adminClient.evidence.deleteMany({});
});

afterAll(async () => {
  if (adminClient) {
    await adminClient.evidenceEmbedding.deleteMany({});
    await adminClient.evidence.deleteMany({});
    await adminClient.$disconnect();
  }
  if (appClient) await appClient.$disconnect();
});

describeIntegration("Evidence Fabric", () => {
  // ============================================================
  // 1. CREATE EVIDENCE with provenance
  // ============================================================
  it("createEvidence creates evidence with full provenance + embedding", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await createEvidence(session, {
      claim: "Test evidence claim for integration testing.",
      summary: "A test evidence record.",
      type: "supporting",
      observedAt: new Date("2024-06-15"),
      extractionMethod: "manual",
      classification: "public",
      confidenceNotes: "Test confidence notes.",
      source: {
        code: "TEST-SRC-001",
        displayName: "Test Source",
        type: "academic",
        url: "https://example.com/test-001",
      },
    });

    expect(result.evidenceId).toBeTruthy();
    expect(result.embeddingGenerated).toBe(true);
    evidence1Id = result.evidenceId;

    // Verify the evidence was created with all fields
    const evidence = await adminClient.evidence.findUnique({
      where: { id: result.evidenceId },
      include: { source: true },
    });
    expect(evidence).toBeTruthy();
    expect(evidence?.claim).toBe("Test evidence claim for integration testing.");
    expect(evidence?.type).toBe("supporting");
    expect(evidence?.verificationStatus).toBe("unverified");
    expect(evidence?.observedAt).toBeTruthy();
    expect(evidence?.extractionMethod).toBe("manual");
    expect(evidence?.source?.code).toBe("TEST-SRC-001");
  });

  // ============================================================
  // 2. COUNTER-EVIDENCE linking
  // ============================================================
  it("addCounterEvidence creates counter-evidence linked to original", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await createEvidence(session, {
      claim: "Counter-evidence: test results were inconclusive.",
      type: "counter",
      relatedEvidenceId: evidence1Id,
      source: {
        code: "TEST-SRC-002",
        displayName: "Counter Source",
        type: "media",
      },
    });

    expect(result.evidenceId).toBeTruthy();

    const counter = await adminClient.evidence.findUnique({
      where: { id: result.evidenceId },
    });
    expect(counter?.type).toBe("counter");
    expect(counter?.relatedEvidenceId).toBe(evidence1Id);
  });

  // ============================================================
  // 3. VECTOR SEARCH (pgvector similarity)
  // ============================================================
  it("searchEvidence returns results via pgvector similarity", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const results = await searchEvidence(session, "test evidence claim", 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.evidenceId).toBeTruthy();
    expect(results[0]?.claim).toBeTruthy();
    expect(results[0]?.similarity).toBeGreaterThan(0);
    expect(results[0]?.similarity).toBeLessThanOrEqual(1);
  });

  // ============================================================
  // 4. SOURCE DEDUP + INDEPENDENCE
  // ============================================================
  it("hashUrl produces consistent hash for same URL", () => {
    const hash1 = hashUrl("https://example.com/test");
    const hash2 = hashUrl("https://example.com/test");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it("countIndependentSources counts unique independence groups", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create 2 sources in the SAME independence group (syndicated)
    const result1 = await createEvidence(session, {
      claim: "Syndicated report 1.",
      source: {
        code: "SYND-001",
        displayName: "Syndicated Source 1",
        type: "media",
        url: "https://syndicate.com/1",
        independenceGroup: "same-group",
      },
    });
    const result2 = await createEvidence(session, {
      claim: "Syndicated report 2.",
      source: {
        code: "SYND-002",
        displayName: "Syndicated Source 2",
        type: "media",
        url: "https://syndicate.com/2",
        independenceGroup: "same-group", // SAME group
      },
    });

    // Create 1 source in a DIFFERENT group
    const result3 = await createEvidence(session, {
      claim: "Independent report.",
      source: {
        code: "INDEP-001",
        displayName: "Independent Source",
        type: "academic",
        url: "https://independent.org/1",
        independenceGroup: "different-group",
      },
    });

    const counts = await countIndependentSources(session, [
      result1.evidenceId,
      result2.evidenceId,
      result3.evidenceId,
    ]);

    // 3 total sources, but only 2 independent groups
    expect(counts.totalSources).toBe(3);
    expect(counts.independentSources).toBe(2);
  });

  // ============================================================
  // 5. CROSS-TENANT ISOLATION (RLS)
  // ============================================================
  it("Tenant A cannot see Tenant B's evidence (RLS)", async () => {
    // Create evidence in Tenant B (via admin client)
    const tenantBEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantBId,
        claim: "Tenant B private evidence.",
        type: "neutral",
      },
    });

    // Tenant A searches — should NOT see Tenant B's evidence
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");
    const results = await searchEvidence(session, "Tenant B private evidence", 10);

    const found = results.find((r) => r.evidenceId === tenantBEvidence.id);
    expect(found).toBeUndefined(); // RLS blocked cross-tenant access

    // Cleanup
    await adminClient.evidence.delete({ where: { id: tenantBEvidence.id } });
  });

  // ============================================================
  // 6. PROVENANCE — observedAt vs retrievedAt
  // ============================================================
  it("evidence has distinct observedAt + retrievedAt", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const observedAt = new Date("2024-01-15");
    const result = await createEvidence(session, {
      claim: "Provenance test evidence.",
      observedAt,
      extractionMethod: "api",
    });

    const evidence = await adminClient.evidence.findUnique({
      where: { id: result.evidenceId },
    });

    expect(evidence?.observedAt).toEqual(observedAt);
    expect(evidence?.retrievedAt).toBeTruthy();
    expect(evidence?.retrievedAt.getTime()).toBeGreaterThan(observedAt.getTime());
  });

  // ============================================================
  // 7. EMBEDDING created for every evidence
  // ============================================================
  it("every evidence has an embedding row", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await createEvidence(session, {
      claim: "Embedding verification test.",
    });

    const embedding = await adminClient.evidenceEmbedding.findUnique({
      where: { evidenceId: result.evidenceId },
    });

    expect(embedding).toBeTruthy();
    expect(embedding?.model).toBeTruthy();
  });

  // ============================================================
  // 8. CROSS-TENANT relatedEvidenceId BLOCKED (trigger)
  // ============================================================
  it("cannot create evidence with relatedEvidenceId pointing to different tenant", async () => {
    // Create evidence in Tenant B (via admin client)
    const tenantBEvidence = await adminClient.evidence.create({
      data: {
        tenantId: tenantBId,
        claim: "Tenant B evidence for cross-tenant test.",
      },
    });

    // Attempt: create evidence in Tenant A linking to Tenant B's evidence
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");
    await expect(
      createEvidence(session, {
        claim: "Attempt to link cross-tenant.",
        type: "counter",
        relatedEvidenceId: tenantBEvidence.id,
      })
    ).rejects.toThrow(/same tenant|relation violation/i);

    // Cleanup
    await adminClient.evidence.delete({ where: { id: tenantBEvidence.id } });
  });

  // ============================================================
  // 9. EVIDENCE_EMBEDDINGS tenantId consistency (trigger)
  // ============================================================
  it("cannot create embedding with tenantId different from evidence tenantId", async () => {
    // Create evidence in Tenant A
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");
    const result = await createEvidence(session, {
      claim: "Embedding consistency test.",
    });

    // Attempt: insert embedding with Tenant B's tenantId (via admin raw SQL)
    await expect(
      adminClient.$executeRaw`
        INSERT INTO "evidence_embeddings" ("id", "evidenceId", "tenantId", "embedding", "model", "createdAt")
        VALUES (gen_random_uuid()::text, ${result.evidenceId}, ${tenantBId}, '[0.1, 0.2]'::vector, 'test', NOW())
      `
    ).rejects.toThrow(/tenant mismatch|consistency/i);
  });

  // ============================================================
  // 10. VERIFICATION STATUS FORCED TO "unverified" on create
  // ============================================================
  it("createEvidence forces verificationStatus to 'unverified' (cannot self-verify)", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Attempt to pass verificationStatus (typed as `never`, but test raw)
    const result = await createEvidence(session, {
      claim: "Self-verification attempt test.",
      // @ts-expect-error — testing that even if passed, it's ignored
      verificationStatus: "verified",
    });

    const evidence = await adminClient.evidence.findUnique({
      where: { id: result.evidenceId },
    });

    // Must be "unverified" regardless of input
    expect(evidence?.verificationStatus).toBe("unverified");
  });

  // ============================================================
  // 11. VERIFY EVIDENCE via separate operation (requires permission)
  // ============================================================
  it("verifyEvidence changes status from unverified to verified", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    // Create evidence (unverified by default)
    const createResult = await createEvidence(session, {
      claim: "Evidence to be verified.",
    });

    // Verify it via separate operation
    const verifyResult = await verifyEvidence(
      session,
      createResult.evidenceId,
      "verified",
      "Cross-checked with World Bank data."
    );

    expect(verifyResult.verificationStatus).toBe("verified");

    // Confirm in DB
    const evidence = await adminClient.evidence.findUnique({
      where: { id: createResult.evidenceId },
    });
    expect(evidence?.verificationStatus).toBe("verified");
  });

  // ============================================================
  // 12. OBSERVER cannot verify evidence (RBAC)
  // ============================================================
  it("observer role cannot verify evidence (requires evidence:verify)", async () => {
    // Observer session
    const observerSession = mockSession(adminUserId, tenantAId, "observer", ADMIN_EMAIL, "Test Admin");

    // Create evidence as admin first
    const adminSession = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");
    const createResult = await createEvidence(adminSession, {
      claim: "Evidence for observer verify test.",
    });

    // Observer attempts to verify → should be rejected by requirePermissionWithCurrentRole
    // (verifyEvidence itself doesn't check permission; the API route does.
    // Here we test the permission check directly.)
    const { requirePermissionWithCurrentRole } = await import("@/lib/permissions");
    await expect(
      requirePermissionWithCurrentRole(observerSession, "evidence:verify")
    ).rejects.toThrow(/Permission denied/);
  });

  // ============================================================
  // 13. SEARCH RESULTS include embedding provider disclosure
  // ============================================================
  it("searchEvidence results include embeddingProvider + similarityDisclaimer", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const results = await searchEvidence(session, "test", 5);

    if (results.length > 0) {
      expect(results[0]?.embeddingProvider).toBeTruthy();
      expect(results[0]?.similarityDisclaimer).toBeTruthy();
      expect(results[0]?.similarityDisclaimer).toMatch(/SIMULATED|provider/i);
    }
  });

  // ============================================================
  // 14. CANDIDATE SOURCES — tenant-submitted sources are "candidate"
  // ============================================================
  it("new sources created by balance_app are 'candidate' (not approved)", async () => {
    const session = mockSession(adminUserId, tenantAId, "admin", ADMIN_EMAIL, "Test Admin");

    const result = await createEvidence(session, {
      claim: "Evidence with new source.",
      source: {
        code: "CANDIDATE-TEST-001",
        displayName: "Candidate Test Source",
        type: "media",
        url: "https://candidate-test.example.com/001",
      },
    });

    // Find the source that was created
    const evidence = await adminClient.evidence.findUnique({
      where: { id: result.evidenceId },
      include: { source: true },
    });

    expect(evidence?.source?.reviewStatus).toBe("candidate");
    expect(evidence?.source?.submittedByTenantId).toBe(tenantAId);
  });
});
