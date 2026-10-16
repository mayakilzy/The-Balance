// ============================================================
// seed-ontology.ts — Seed fictional country + tenants + state + institutions + users
// ------------------------------------------------------------
// Per mission 00-02: "Seed one clearly fictional country fixture".
// We use "Demolandia" (ISO3: DML) — a fictional country.
// Per mission 00-03: seed users + memberships for auth testing.
//
// This script is idempotent: it uses upserts and skips if rows exist.
// Run with: bunx tsx prisma/seed-ontology.ts
//
// IMPORTANT: This connects as balance_admin (via DIRECT_URL) because
// balance_app cannot INSERT into PUBLIC tables (RLS blocks writes).
// ============================================================
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

async function main() {
  console.log("Seeding ontology (Demolandia fictional fixture)...");

  // 1. Country: Demolandia (fictional)
  const country = await prisma.country.upsert({
    where: { iso3: "DML" },
    update: {},
    create: {
      iso3: "DML",
      iso2: "DM",
      displayName: "Demolandia",
      status: "active",
    },
  });
  console.log(`  Country: ${country.displayName} (id=${country.id})`);

  // 2. State hierarchy: Nation → 2 provinces → 1 district each
  const nation = await prisma.stateHierarchy.upsert({
    where: { countryId_code: { countryId: country.id, code: "DML-NAT" } },
    update: {},
    create: {
      countryId: country.id,
      code: "DML-NAT",
      displayName: "Demolandia (Nation)",
      level: "nation",
    },
  });
  console.log(`  StateHierarchy: ${nation.displayName} (level=${nation.level})`);

  const northProvince = await prisma.stateHierarchy.upsert({
    where: { countryId_code: { countryId: country.id, code: "DML-N" } },
    update: {},
    create: {
      countryId: country.id,
      parentId: nation.id,
      code: "DML-N",
      displayName: "Northland Province",
      level: "province",
    },
  });
  const southProvince = await prisma.stateHierarchy.upsert({
    where: { countryId_code: { countryId: country.id, code: "DML-S" } },
    update: {},
    create: {
      countryId: country.id,
      parentId: nation.id,
      code: "DML-S",
      displayName: "Southland Province",
      level: "province",
    },
  });
  console.log(`  StateHierarchy: ${northProvince.displayName}, ${southProvince.displayName}`);

  // 3. Institutions: 1 ministry + 1 agency
  const ministryOfPlanning = await prisma.institution.upsert({
    where: { countryId_code: { countryId: country.id, code: "DML-MOP" } },
    update: {},
    create: {
      countryId: country.id,
      code: "DML-MOP",
      displayName: "Ministry of Planning — Demolandia",
      type: "ministry",
    },
  });
  const centralBank = await prisma.institution.upsert({
    where: { countryId_code: { countryId: country.id, code: "DML-CB" } },
    update: {},
    create: {
      countryId: country.id,
      code: "DML-CB",
      displayName: "Central Bank of Demolandia",
      type: "authority",
    },
  });
  console.log(`  Institutions: ${ministryOfPlanning.displayName}, ${centralBank.displayName}`);

  // 4. Tenants: 2 tenants in the same country (tests Country ≠ Tenant)
  const tenantA = await prisma.tenant.upsert({
    where: { code: "DML-MOP-TENANT" },
    update: {},
    create: {
      code: "DML-MOP-TENANT",
      displayName: "Demolandia Ministry of Planning (Tenant)",
      countryId: country.id,
      status: "active",
    },
  });
  const tenantB = await prisma.tenant.upsert({
    where: { code: "DML-CB-TENANT" },
    update: {},
    create: {
      code: "DML-CB-TENANT",
      displayName: "Demolandia Central Bank (Tenant)",
      countryId: country.id,
      status: "active",
    },
  });
  console.log(`  Tenants: ${tenantA.code}, ${tenantB.code} (both in ${country.iso3})`);

  // 5. Role references (catalog)
  const roles = [
    { code: "admin", displayName: "Administrator", description: "Full tenant access" },
    { code: "analyst", displayName: "Analyst", description: "Read + create evidence/strategy" },
    { code: "reviewer", displayName: "Reviewer", description: "Read + approve/reject" },
    { code: "observer", displayName: "Observer", description: "Read only" },
  ];
  for (const r of roles) {
    await prisma.roleReference.upsert({
      where: { code: r.code },
      update: {},
      create: r,
    });
  }
  console.log(`  RoleReferences: ${roles.length} roles seeded`);

  // 6. Source registry (catalog)
  const sources = [
    { code: "WORLD_BANK", displayName: "World Bank", type: "international_org", license: "CC-BY-4.0", url: "https://www.worldbank.org" },
    { code: "IMF", displayName: "International Monetary Fund", type: "international_org", license: "CC-BY-4.0", url: "https://www.imf.org" },
    { code: "UN_STATS", displayName: "UN Statistics Division", type: "international_org", license: "CC-BY-3.0", url: "https://unstats.un.org" },
  ];
  for (const s of sources) {
    await prisma.sourceRegistry.upsert({
      where: { code: s.code },
      update: {},
      create: s,
    });
  }
  console.log(`  SourceRegistry: ${sources.length} sources seeded`);

  // 7. Public knowledge (international indicators)
  const publicKnowledge = [
    {
      title: "World Development Indicators — 2025",
      content: "Synthetic placeholder for World Bank WDI 2025. Real data will be loaded in mission 00-04 (Evidence).",
      metadata: { type: "indicator_catalog", year: 2025, synthetic: true },
      publishedAt: new Date("2025-06-01"),
      sourceCode: "WORLD_BANK",
    },
    {
      title: "IMF World Economic Outlook — October 2025",
      content: "Synthetic placeholder for IMF WEO Oct 2025. Real data will be loaded in 00-04.",
      metadata: { type: "economic_outlook", year: 2025, synthetic: true },
      publishedAt: new Date("2025-10-01"),
      sourceCode: "IMF",
    },
  ];
  for (const pk of publicKnowledge) {
    const source = await prisma.sourceRegistry.findUnique({ where: { code: pk.sourceCode } });
    await prisma.publicKnowledge.upsert({
      where: { id: (await prisma.publicKnowledge.findFirst({ where: { title: pk.title } }))?.id ?? "_" },
      update: {},
      create: {
        sourceId: source?.id,
        title: pk.title,
        content: pk.content,
        metadata: pk.metadata,
        publishedAt: pk.publishedAt,
      },
    });
  }
  console.log(`  PublicKnowledge: ${publicKnowledge.length} entries seeded`);

  console.log("\nSeed complete. All fixtures are clearly fictional (Demolandia).");
  console.log("Test tenant IDs for RLS tests:");
  console.log(`  Tenant A: ${tenantA.id} (${tenantA.code})`);
  console.log(`  Tenant B: ${tenantB.id} (${tenantB.code})`);

  // ============================================================
  // 8. USERS + MEMBERSHIPS (00-03)
  // ============================================================
  console.log("\nSeeding users + memberships...");

  // Hash test passwords. These are TEST FIXTURES, not secrets.
  // They are documented here for integration tests to use.
  const adminHash = await hashPassword("test_admin_password_00_03");
  const analystHash = await hashPassword("test_analyst_password_00_03");
  const suspendedHash = await hashPassword("test_suspended_password_00_03");
  const revokedHash = await hashPassword("test_revoked_password_00_03");

  // User 1: admin in Tenant A
  const adminUser = await prisma.user.upsert({
    where: { email: "admin@demolandia.test" },
    update: {},
    create: {
      email: "admin@demolandia.test",
      name: "Test Admin",
      passwordHash: adminHash,
      status: "active",
    },
  });

  // User 2: analyst in Tenant A
  const analystUser = await prisma.user.upsert({
    where: { email: "analyst@demolandia.test" },
    update: {},
    create: {
      email: "analyst@demolandia.test",
      name: "Test Analyst",
      passwordHash: analystHash,
      status: "active",
    },
  });

  // User 3: suspended user (cannot authenticate)
  const suspendedUser = await prisma.user.upsert({
    where: { email: "suspended@demolandia.test" },
    update: {},
    create: {
      email: "suspended@demolandia.test",
      name: "Test Suspended",
      passwordHash: suspendedHash,
      status: "suspended",
    },
  });

  // User 4: user with revoked membership (can authenticate but no tenant access)
  const revokedUser = await prisma.user.upsert({
    where: { email: "revoked@demolandia.test" },
    update: {},
    create: {
      email: "revoked@demolandia.test",
      name: "Test Revoked",
      passwordHash: revokedHash,
      status: "active",
    },
  });

  // Memberships
  // Admin → Tenant A as admin
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: adminUser.id, tenantId: tenantA.id } },
    update: {},
    create: {
      userId: adminUser.id,
      tenantId: tenantA.id,
      roleCode: "admin",
      status: "active",
    },
  });

  // Analyst → Tenant A as analyst
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: analystUser.id, tenantId: tenantA.id } },
    update: {},
    create: {
      userId: analystUser.id,
      tenantId: tenantA.id,
      roleCode: "analyst",
      status: "active",
    },
  });

  // Suspended user → Tenant A (membership active, but user suspended)
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: suspendedUser.id, tenantId: tenantA.id } },
    update: {},
    create: {
      userId: suspendedUser.id,
      tenantId: tenantA.id,
      roleCode: "observer",
      status: "active",
    },
  });

  // Revoked user → Tenant A (membership revoked)
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: revokedUser.id, tenantId: tenantA.id } },
    update: { status: "revoked" },
    create: {
      userId: revokedUser.id,
      tenantId: tenantA.id,
      roleCode: "observer",
      status: "revoked",
    },
  });

  console.log(`  Users: ${adminUser.email}, ${analystUser.email}, ${suspendedUser.email}, ${revokedUser.email}`);
  console.log(`  Memberships: 4 (admin, analyst, suspended-user, revoked-membership)`);
  console.log("\nTest credentials (FIXTURES, not secrets):");
  console.log("  admin@demolandia.test / test_admin_password_00_03");
  console.log("  analyst@demolandia.test / test_analyst_password_00_03");
  console.log("  suspended@demolandia.test / test_suspended_password_00_03 (suspended)");
  console.log("  revoked@demolandia.test / test_revoked_password_00_03 (membership revoked)");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
