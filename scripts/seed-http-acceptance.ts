// ============================================================
// seed-http-acceptance.ts — Add test users for G03-06 HTTP Acceptance
// ------------------------------------------------------------
// Adds:
//   - adminb@demolandia.test  (admin role in Tenant B — DML-CB-TENANT)
//   - reviewera@demolandia.test (reviewer role in Tenant A — DML-MOP-TENANT)
//   - observera@demolandia.test (observer role in Tenant A)
//
// All emails are LOWERCASE — findUserByEmail() lowercases input before
// querying the DB (see auth-bootstrap.ts). Storing mixed-case emails
// would cause signin to fail with 401.
//
// Idempotent: upserts by email.
// Connects as balance_admin (DIRECT_URL) — bypass RLS for fixture setup.
// ============================================================
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL ?? "postgresql://balance_admin:balance_admin_dev_only@localhost:5433/balance?schema=public" },
  },
});

async function main() {
  console.log("Seeding HTTP acceptance test users...");

  const tenantA = await prisma.tenant.findUnique({ where: { code: "DML-MOP-TENANT" } });
  const tenantB = await prisma.tenant.findUnique({ where: { code: "DML-CB-TENANT" } });
  if (!tenantA || !tenantB) {
    throw new Error("Required tenants not found — run seed-ontology.ts first");
  }

  const adminBHash = await hashPassword("test_adminB_password_g0306");
  const reviewerAHash = await hashPassword("test_reviewer_password_g0306");
  const observerAHash = await hashPassword("test_observer_password_g0306");

  // adminb — admin in Tenant B (lowercase email)
  const adminB = await prisma.user.upsert({
    where: { email: "adminb@demolandia.test" },
    update: {},
    create: {
      email: "adminb@demolandia.test",
      name: "Test Admin B",
      passwordHash: adminBHash,
      status: "active",
    },
  });
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: adminB.id, tenantId: tenantB.id } },
    update: { roleCode: "admin", status: "active" },
    create: {
      userId: adminB.id,
      tenantId: tenantB.id,
      roleCode: "admin",
      status: "active",
    },
  });

  // reviewera — reviewer in Tenant A (has coordination:approve + share, but NOT manage)
  const reviewerA = await prisma.user.upsert({
    where: { email: "reviewera@demolandia.test" },
    update: {},
    create: {
      email: "reviewera@demolandia.test",
      name: "Test Reviewer A",
      passwordHash: reviewerAHash,
      status: "active",
    },
  });
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: reviewerA.id, tenantId: tenantA.id } },
    update: { roleCode: "reviewer", status: "active" },
    create: {
      userId: reviewerA.id,
      tenantId: tenantA.id,
      roleCode: "reviewer",
      status: "active",
    },
  });

  // observera — observer in Tenant A (only coordination:read)
  const observerA = await prisma.user.upsert({
    where: { email: "observera@demolandia.test" },
    update: {},
    create: {
      email: "observera@demolandia.test",
      name: "Test Observer A",
      passwordHash: observerAHash,
      status: "active",
    },
  });
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: observerA.id, tenantId: tenantA.id } },
    update: { roleCode: "observer", status: "active" },
    create: {
      userId: observerA.id,
      tenantId: tenantA.id,
      roleCode: "observer",
      status: "active",
    },
  });

  console.log(`  Created/updated 3 users:`);
  console.log(`    adminb@demolandia.test  → admin in Tenant B (${tenantB.id})`);
  console.log(`    reviewera@demolandia.test → reviewer in Tenant A (${tenantA.id})`);
  console.log(`    observera@demolandia.test → observer in Tenant A (${tenantA.id})`);
  console.log("\nTest credentials (FIXTURES, not secrets):");
  console.log("  adminb@demolandia.test / test_adminB_password_g0306");
  console.log("  reviewera@demolandia.test / test_reviewer_password_g0306");
  console.log("  observera@demolandia.test / test_observer_password_g0306");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("Seed failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
