// ============================================================
// rls-isolation.integration.test.ts
// ------------------------------------------------------------
// Integration test for RLS isolation on real PostgreSQL 16.
// Runs in CI against the `pgvector/pgvector:pg16` service container.
// Skips locally when RUN_INTEGRATION_TESTS is not set.
//
// Founder directive (mission 00-02):
//   "اختبر العزل باستخدام اتصالات وأدوار قاعدة البيانات الفعلية،
//    وليس Prisma mocks أو دور مالك الجداول الذي قد يتجاوز RLS."
//   (Test isolation using real DB connections and roles, not Prisma
//    mocks or the table-owner role that may bypass RLS.)
//
// This test connects as `balance_app` (RLS-enforced, NOT the admin role)
// and verifies:
//   1. Cross-tenant READ is blocked (Tenant A cannot see Tenant B's audit_log).
//   2. Cross-tenant WRITE is blocked (Tenant A cannot insert with tenant_id=B).
//   3. Cross-tenant UPDATE is blocked.
//   4. Cross-tenant DELETE is blocked.
//   5. Fail-closed: no tenant context → 0 rows on PRIVATE tables.
//   6. PUBLIC tables are readable by any tenant.
//   7. PUBLIC writes blocked for balance_app.
//   8. Tenants table self-isolation (Tenant A sees only its own row).
//   9. Country ≠ Tenant: both tenants in same country are isolated.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  setTenantContext,
  clearTenantContext,
  getTenantContext,
  withTenant,
  withPublicScope,
} from "@/lib/security/tenant-context";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const DIRECT_URL = process.env.DIRECT_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

// Two clients: one as balance_app (RLS-enforced), one as balance_admin (BYPASSRLS for setup).
let appClient: PrismaClient;
let adminClient: PrismaClient;

// Test tenant IDs (seeded before tests run).
let tenantAId: string;
let tenantBId: string;
let countryId: string;

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;

  // balance_app client — used for ALL RLS tests (this is the point).
  appClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  // balance_admin client — used ONLY for setup/teardown, never for RLS assertions.
  adminClient = new PrismaClient({ datasources: { db: { url: DIRECT_URL } } });

  // Verify connectivity
  await appClient.$queryRaw`SELECT 1`;
  await adminClient.$queryRaw`SELECT 1`;

  // Fetch the seeded Demolandia country + 2 tenants (using admin for setup reads).
  const country = await adminClient.country.findUnique({ where: { iso3: "DML" } });
  if (!country) {
    throw new Error(
      "Demolandia (DML) not seeded. Run `bunx tsx prisma/seed-ontology.ts` before tests."
    );
  }
  countryId = country.id;

  const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) {
    throw new Error("Test tenants not seeded. Run `bunx tsx prisma/seed-ontology.ts`.");
  }
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  // Clean up any leftover audit_log entries from previous runs (admin can see all).
  await adminClient.auditLog.deleteMany({});
});

afterAll(async () => {
  if (adminClient) {
    // Clean up
    await adminClient.auditLog.deleteMany({});
    await adminClient.$disconnect();
  }
  if (appClient) {
    await appClient.$disconnect();
  }
});

describeIntegration("RLS isolation — balance_app role (real PostgreSQL)", () => {
  // ============================================================
  // 1. CROSS-TENANT READ IS BLOCKED
  // ============================================================
  it("Tenant A cannot see Tenant B's audit_log rows", async () => {
    // Setup: admin inserts one row for each tenant
    await adminClient.auditLog.create({
      data: { tenantId: tenantAId, actor: "test-a", action: "test.action.a" },
    });
    await adminClient.auditLog.create({
      data: { tenantId: tenantBId, actor: "test-b", action: "test.action.b" },
    });

    // Tenant A reads audit_log → should see ONLY its own row
    const result = await withTenant(tenantAId, async (tx) => {
      return await tx.auditLog.findMany();
    });

    expect(result.length).toBe(1);
    expect(result[0]?.tenantId).toBe(tenantAId);
    expect(result[0]?.actor).toBe("test-a");
    // Critical: Tenant B's row is invisible
    expect(result.find((r) => r.tenantId === tenantBId)).toBeUndefined();
  });

  // ============================================================
  // 2. CROSS-TENANT WRITE IS BLOCKED (WITH CHECK)
  // ============================================================
  it("Tenant A cannot INSERT audit_log with tenant_id=B", async () => {
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.auditLog.create({
          data: { tenantId: tenantBId, actor: "attacker", action: "forged.tenant_id" },
        });
      })
    ).rejects.toThrow(); // RLS WITH CHECK violation
  });

  // ============================================================
  // 3. CROSS-TENANT UPDATE IS BLOCKED
  // ============================================================
  it("Tenant A cannot UPDATE Tenant B's audit_log row", async () => {
    // Tenant B's row exists (from test 1). Tenant A attempts to modify it.
    const result = await withTenant(tenantAId, async (tx) => {
      return await tx.auditLog.updateMany({
        where: { tenantId: tenantBId },
        data: { actor: "hijacked" },
      });
    });
    // updateMany returns count of affected rows. RLS filters BEFORE update,
    // so Tenant A sees 0 rows matching tenant_id=B → 0 updated.
    expect(result.count).toBe(0);
  });

  // ============================================================
  // 4. CROSS-TENANT DELETE IS BLOCKED
  // ============================================================
  it("Tenant A cannot DELETE Tenant B's audit_log row", async () => {
    const result = await withTenant(tenantAId, async (tx) => {
      return await tx.auditLog.deleteMany({
        where: { tenantId: tenantBId },
      });
    });
    expect(result.count).toBe(0); // RLS filtered out Tenant B's rows
  });

  // ============================================================
  // 5. FAIL-CLOSED: no tenant context → 0 rows on PRIVATE tables
  // ============================================================
  it("Without tenant context, audit_log returns 0 rows (fail-closed)", async () => {
    const result = await withPublicScope(async (tx) => {
      return await tx.auditLog.findMany();
    });
    expect(result.length).toBe(0);
  });

  // ============================================================
  // 6. PUBLIC TABLES ARE READABLE BY ANY TENANT
  // ============================================================
  it("PUBLIC tables (countries, public_knowledge) are readable regardless of tenant context", async () => {
    // With tenant context set
    const countriesWithTenant = await withTenant(tenantAId, async (tx) => {
      return await tx.country.findMany();
    });
    expect(countriesWithTenant.length).toBeGreaterThanOrEqual(1);
    expect(countriesWithTenant.find((c) => c.iso3 === "DML")).toBeDefined();

    // Without tenant context (public scope)
    const countriesNoTenant = await withPublicScope(async (tx) => {
      return await tx.country.findMany();
    });
    expect(countriesNoTenant.length).toBeGreaterThanOrEqual(1);

    // Public knowledge is readable in both modes
    const pkWithTenant = await withTenant(tenantAId, async (tx) => {
      return await tx.publicKnowledge.findMany();
    });
    const pkNoTenant = await withPublicScope(async (tx) => {
      return await tx.publicKnowledge.findMany();
    });
    expect(pkWithTenant.length).toBe(pkNoTenant.length);
    expect(pkWithTenant.length).toBeGreaterThanOrEqual(1);
  });

  // ============================================================
  // 7. PUBLIC WRITES BLOCKED FOR balance_app
  // ============================================================
  it("balance_app cannot INSERT/UPDATE/DELETE PUBLIC tables (only admin can)", async () => {
    // Attempt to insert a new country as balance_app → should fail
    await expect(
      withPublicScope(async (tx) => {
        await tx.country.create({
          data: { iso3: "XXX", displayName: "Should Fail" },
        });
      })
    ).rejects.toThrow();

    // Attempt to insert public_knowledge as balance_app → should fail
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.publicKnowledge.create({
          data: { title: "Should Fail", content: "test" },
        });
      })
    ).rejects.toThrow();
  });

  // ============================================================
  // 8. TENANTS TABLE SELF-ISOLATION
  // ============================================================
  it("Tenant A sees only its OWN row in tenants table", async () => {
    const result = await withTenant(tenantAId, async (tx) => {
      return await tx.tenant.findMany();
    });
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe(tenantAId);
    expect(result[0]?.code).toBe("DML-MOP-TENANT");
    // Tenant B is invisible
    expect(result.find((t) => t.id === tenantBId)).toBeUndefined();
  });

  // ============================================================
  // 9. COUNTRY ≠ TENANT: both tenants in same country are isolated
  // ============================================================
  it("Two tenants in the SAME country are isolated from each other", async () => {
    // Both tenants reference the same countryId
    const tenantA = await adminClient.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
    const tenantB = await adminClient.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
    expect(tenantA?.countryId).toBe(tenantB?.countryId);
    expect(tenantA?.countryId).toBe(countryId);

    // But Tenant A cannot see Tenant B's audit_log, even though they share a country
    await adminClient.auditLog.create({
      data: { tenantId: tenantBId, actor: "tenant-b-only", action: "private.action" },
    });

    const tenantAView = await withTenant(tenantAId, async (tx) => {
      return await tx.auditLog.findMany({ where: { actor: "tenant-b-only" } });
    });
    expect(tenantAView.length).toBe(0); // Country sharing ≠ data sharing

    // But both can read the SAME country row (PUBLIC)
    const countryViewA = await withTenant(tenantAId, async (tx) => {
      return await tx.country.findUnique({ where: { id: countryId } });
    });
    const countryViewB = await withTenant(tenantBId, async (tx) => {
      return await tx.country.findUnique({ where: { id: countryId } });
    });
    expect(countryViewA?.id).toBe(countryId);
    expect(countryViewB?.id).toBe(countryId);
  });

  // ============================================================
  // 10. set_config bind-parameter SQL injection prevention (re-verified with RLS)
  // ============================================================
  it("Malicious tenantId in set_config does not bypass RLS", async () => {
    // Attempt to set tenant_id to a SQL injection string
    const malicious = "'; DROP TABLE tenants; --";
    // withTenant calls setTenantContext which validates + uses set_config bind param
    const result = await withTenant(malicious, async (tx) => {
      // RLS policy: tenant_id = current_setting('app.tenant_id') = malicious string
      // No row has that tenant_id, so 0 rows returned.
      return await tx.auditLog.findMany();
    });
    expect(result.length).toBe(0);

    // Verify tenants table still exists (DROP did not execute)
    const tables = await adminClient.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE tablename = 'tenants'
    `;
    expect(tables.length).toBe(1);
  });

  // ============================================================
  // 11. AUDIT LOG APPEND-ONLY — UPDATE blocked even for own rows
  // ------------------------------------------------------------
  // Founder directive (00-02 corrective closure):
  //   "منع UPDATE و DELETE بواسطة الدور التشغيلي على مستوى قاعدة البيانات نفسها"
  //   (Block UPDATE and DELETE by the operational role at the DB level itself)
  // ============================================================
  it("Tenant A cannot UPDATE its own audit_log row (append-only)", async () => {
    // Insert a row as Tenant A (INSERT is allowed)
    await withTenant(tenantAId, async (tx) => {
      await tx.auditLog.create({
        data: { tenantId: tenantAId, actor: "to-update", action: "test.update.target" },
      });
    });

    // Attempt to UPDATE that row — should fail (REVOKE + no UPDATE policy)
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.auditLog.updateMany({
          where: { actor: "to-update" },
          data: { actor: "tampered" },
        });
      })
    ).rejects.toThrow();
  });

  // ============================================================
  // 12. AUDIT LOG APPEND-ONLY — DELETE blocked even for own rows
  // ============================================================
  it("Tenant A cannot DELETE its own audit_log row (append-only)", async () => {
    await withTenant(tenantAId, async (tx) => {
      await tx.auditLog.create({
        data: { tenantId: tenantAId, actor: "to-delete", action: "test.delete.target" },
      });
    });

    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx.auditLog.deleteMany({
          where: { actor: "to-delete" },
        });
      })
    ).rejects.toThrow();
  });

  // ============================================================
  // 13. STATE HIERARCHY — parent must be in the SAME country
  // ------------------------------------------------------------
  // Founder directive (00-02 corrective closure):
  //   "يجب منع ربط عنصر إداري أو مؤسسة بأب ينتمي إلى دولة أخرى"
  //   (Must prevent linking an admin unit or institution to a parent
  //    belonging to another country)
  // ============================================================
  it("StateHierarchy cannot have parent in a different country", async () => {
    // Create a second country (Testlandia) for the cross-border test
    const testlandia = await adminClient.country.upsert({
      where: { iso3: "ZZT" },
      update: {},
      create: { iso3: "ZZT", iso2: "ZT", displayName: "Testlandia (cross-border test)" },
    });

    // Province in Testlandia
    const testlandiaProvince = await adminClient.stateHierarchy.upsert({
      where: { countryId_code: { countryId: testlandia.id, code: "ZZT-P" } },
      update: {},
      create: {
        countryId: testlandia.id,
        code: "ZZT-P",
        displayName: "Testlandia Province",
        level: "province",
      },
    });

    // Attempt: child in Demolandia (DML) with parent in Testlandia (ZZT)
    // → trigger should reject
    await expect(
      adminClient.stateHierarchy.create({
        data: {
          countryId: countryId, // Demolandia
          parentId: testlandiaProvince.id, // Testlandia — DIFFERENT country
          code: "DML-CROSS-BAD",
          displayName: "Cross-border child (should fail)",
          level: "district",
        },
      })
    ).rejects.toThrow(/same country/i);

    // Cleanup
    await adminClient.stateHierarchy.deleteMany({ where: { code: "ZZT-P" } });
    await adminClient.country.deleteMany({ where: { iso3: "ZZT" } });
  });

  // ============================================================
  // 14. INSTITUTION — parent must be in the SAME country
  // ============================================================
  it("Institution cannot have parent in a different country", async () => {
    const testlandia = await adminClient.country.upsert({
      where: { iso3: "ZZT" },
      update: {},
      create: { iso3: "ZZT", iso2: "ZT", displayName: "Testlandia (cross-border test)" },
    });

    const testlandiaMinistry = await adminClient.institution.upsert({
      where: { countryId_code: { countryId: testlandia.id, code: "ZZT-MOF" } },
      update: {},
      create: {
        countryId: testlandia.id,
        code: "ZZT-MOF",
        displayName: "Testlandia Ministry of Finance",
        type: "ministry",
      },
    });

    // Attempt: child in Demolandia with parent in Testlandia → trigger rejects
    await expect(
      adminClient.institution.create({
        data: {
          countryId: countryId, // Demolandia
          parentId: testlandiaMinistry.id, // Testlandia — DIFFERENT country
          code: "DML-CROSS-INST",
          displayName: "Cross-border institution (should fail)",
          type: "directorate",
        },
      })
    ).rejects.toThrow(/same country/i);

    // Cleanup
    await adminClient.institution.deleteMany({ where: { code: "ZZT-MOF" } });
    await adminClient.country.deleteMany({ where: { iso3: "ZZT" } });
  });

  // ============================================================
  // 15. AUDIT LOG — admin can still UPDATE/DELETE (maintenance path)
  // ------------------------------------------------------------
  // Documents the maintenance path: balance_admin (BYPASSRLS) can
  // modify audit_log for legitimate ops (e.g., GDPR erasure).
  // This is audited at the application layer separately.
  // ============================================================
  it("balance_admin can UPDATE/DELETE audit_log (documented maintenance path)", async () => {
    // Admin inserts a row directly
    const row = await adminClient.auditLog.create({
      data: { tenantId: tenantAId, actor: "admin-test", action: "test.admin.maintainable" },
    });

    // Admin can UPDATE it
    await adminClient.auditLog.update({
      where: { id: row.id },
      data: { actor: "admin-corrected" },
    });

    // Admin can DELETE it
    await adminClient.auditLog.delete({
      where: { id: row.id },
    });

    // Verify deletion
    const exists = await adminClient.auditLog.findUnique({ where: { id: row.id } });
    expect(exists).toBeNull();
  });
});
