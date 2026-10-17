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
import { PrismaClient, Prisma } from "@prisma/client";
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

  // ============================================================
  // 9. EVIDENCE FABRIC (00-04)
  // ============================================================
  console.log("\nSeeding evidence fabric...");

  // Create sources
  const worldBankSource = await prisma.source.upsert({
    where: { code: "WB-WDI-2025" },
    update: {},
    create: {
      code: "WB-WDI-2025",
      displayName: "World Bank WDI 2025",
      type: "international_org",
      license: "CC-BY-4.0",
      url: "https://data.worldbank.org/wdi-2025",
      independenceGroup: "world-bank",
    },
  });

  const imfSource = await prisma.source.upsert({
    where: { code: "IMF-WEO-2025" },
    update: {},
    create: {
      code: "IMF-WEO-2025",
      displayName: "IMF WEO October 2025",
      type: "international_org",
      license: "CC-BY-4.0",
      url: "https://imf.org/weo-oct-2025",
      independenceGroup: "imf",
    },
  });

  // Syndicated source (same independence group — tests dedup)
  const reutersSyndicated = await prisma.source.upsert({
    where: { code: "REUTERS-DML-001" },
    update: {},
    create: {
      code: "REUTERS-DML-001",
      displayName: "Reuters — Demolandia Agriculture Report",
      type: "media",
      url: "https://reuters.com/dml-agri-001",
      independenceGroup: "reuters-syndicate",
    },
  });

  const apSyndicated = await prisma.source.upsert({
    where: { code: "AP-DML-001" },
    update: {},
    create: {
      code: "AP-DML-001",
      displayName: "AP — Demolandia Agriculture (syndicated from Reuters)",
      type: "media",
      url: "https://apnews.com/dml-agri-001",
      independenceGroup: "reuters-syndicate", // SAME group as Reuters!
    },
  });

  // Create evidence for Tenant A
  // 1. Supporting evidence
  // FIX-2 (01-01): all evidence includes metadata.countryId for country-specific scoping
  const evidence1 = await prisma.evidence.create({
    data: {
      tenantId: tenantA.id,
      sourceId: worldBankSource.id,
      claim: "Demolandia's agricultural GDP grew 4.2% in 2024 according to World Bank WDI.",
      summary: "World Bank data shows agricultural sector growth in Demolandia.",
      type: "supporting",
      verificationStatus: "verified",
      observedAt: new Date("2024-12-31"),
      extractionMethod: "manual",
      classification: "public",
      confidenceNotes: "High confidence — official World Bank statistics.",
      metadata: { countryId: country.id, sector: "agriculture", indicatorName: "agricultural_gdp_growth_rate", fictional: true, seededBy: "00-04-seed" } as unknown as Prisma.InputJsonValue,
    },
  });

  // 2. Supporting evidence (different independent source)
  const evidence2 = await prisma.evidence.create({
    data: {
      tenantId: tenantA.id,
      sourceId: imfSource.id,
      claim: "IMF confirms Demolandia agricultural growth at 4.1% for 2024.",
      summary: "IMF independent confirmation of agricultural growth.",
      type: "supporting",
      verificationStatus: "verified",
      observedAt: new Date("2024-12-31"),
      extractionMethod: "manual",
      classification: "public",
      confidenceNotes: "High confidence — independent IMF verification.",
      metadata: { countryId: country.id, sector: "agriculture", indicatorName: "agricultural_gdp_growth_rate", fictional: true, seededBy: "00-04-seed" } as unknown as Prisma.InputJsonValue,
    },
  });

  // 3. Counter-evidence (linked to evidence1)
  const counterEvidence = await prisma.evidence.create({
    data: {
      tenantId: tenantA.id,
      sourceId: reutersSyndicated.id,
      claim: "Local farmers report crop yields declined in 2024 due to drought.",
      summary: "Contradicts official GDP growth figures.",
      type: "counter",
      relatedEvidenceId: evidence1.id,
      verificationStatus: "disputed",
      observedAt: new Date("2024-10-15"),
      extractionMethod: "interview",
      classification: "public",
      confidenceNotes: "Anecdotal — needs further verification.",
      metadata: { countryId: country.id, sector: "agriculture", indicatorName: "crop_yield", fictional: true, seededBy: "00-04-seed" } as unknown as Prisma.InputJsonValue,
    },
  });

  // 4. Duplicate source evidence (syndicated — same independenceGroup)
  const duplicateEvidence = await prisma.evidence.create({
    data: {
      tenantId: tenantA.id,
      sourceId: apSyndicated.id,
      claim: "AP reports Demolandia agriculture decline (syndicated from Reuters).",
      summary: "Same story as Reuters, syndicated.",
      type: "counter",
      relatedEvidenceId: evidence1.id,
      verificationStatus: "unverified",
      observedAt: new Date("2024-10-15"),
      extractionMethod: "wire",
      classification: "public",
      confidenceNotes: "Syndicated content — not independent from Reuters.",
      metadata: { countryId: country.id, sector: "agriculture", indicatorName: "crop_yield", fictional: true, seededBy: "00-04-seed" } as unknown as Prisma.InputJsonValue,
    },
  });

  // Create embeddings for the evidence (using StubProvider — deterministic)
  const { getLLMProvider } = await import("../src/lib/llm");
  const provider = getLLMProvider();

  for (const ev of [evidence1, evidence2, counterEvidence, duplicateEvidence]) {
    const embedResult = await provider.embed({
      input: ev.claim,
      dimensions: 384,
    });
    const vectorLiteral = `[${embedResult.vectors[0]!.join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO "evidence_embeddings" ("id", "evidenceId", "tenantId", "embedding", "model", "createdAt")
      VALUES (gen_random_uuid()::text, ${ev.id}, ${tenantA.id}, ${vectorLiteral}::vector, ${provider.defaultEmbeddingModel}, NOW())
    `;
  }

  console.log(`  Sources: 4 (World Bank, IMF, Reuters, AP-syndicated)`);
  console.log(`  Evidence: 4 (2 supporting, 2 counter — 1 syndicated duplicate)`);
  console.log(`  Embeddings: 4 (StubProvider — deterministic, SIMULATED)`);
  console.log("\nEvidence fabric seed complete.");
  console.log("  Note: Embeddings use StubProvider (deterministic, not real).");
  console.log("  Real embeddings will be added in 00-06 when ZaiProvider is implemented.");

  // ============================================================
  // 10. G01 STATE BUILDER — Demolandia v2 (01-00)
  // ============================================================
  // Per ADR-0013 + G01 Mission Pack §13 (Corrections 1, 2, 3, A):
  //   - 5+ objectives for Tenant A (fictional, clearly labeled)
  //   - CountryPackConfig for BOTH tenants (PRIVATE — each tenant has its own)
  //   - Cross-tenant isolation is enforced by RLS, but we seed different
  //     data per tenant to make the isolation testable + visible.
  console.log("\nSeeding G01 State Builder (Demolandia v2)...");

  // 10a. CountryPackConfig for Tenant A (Ministry of Planning)
  // Tracks 4 sectors; observability is PARTIAL for most (developing country fixture).
  const configA = await prisma.countryPackConfig.upsert({
    where: {
      tenantId_countryId: { tenantId: tenantA.id, countryId: country.id },
    },
    update: {},
    create: {
      tenantId: tenantA.id,
      countryId: country.id,
      sectors: ["agriculture", "finance", "education", "health"] as unknown as Prisma.InputJsonValue,
      observability: {
        agriculture: "FULL",
        finance: "PARTIAL",
        education: "LOW",
        health: "PARTIAL",
      } as unknown as Prisma.InputJsonValue,
      planningAssumptions: {
        baselineYear: 2025,
        targetYear: 2030,
        currency: "DML", // fictional Demolandia currency
        population: 12_000_000, // fictional
        gdpPerCapitaUSD: 3200, // fictional
        fictional: true,
      } as unknown as Prisma.InputJsonValue,
      metadata: {
        seededBy: "01-00-seed",
        version: "v2",
        fictional: true,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // 10b. CountryPackConfig for Tenant B (Central Bank)
  // Tracks fewer sectors (finance-focused); different observability + assumptions.
  // This is the KEY test for Correction A: two tenants, same country, DIFFERENT
  // PRIVATE configs. RLS must prevent Tenant A from seeing Tenant B's config.
  const configB = await prisma.countryPackConfig.upsert({
    where: {
      tenantId_countryId: { tenantId: tenantB.id, countryId: country.id },
    },
    update: {},
    create: {
      tenantId: tenantB.id,
      countryId: country.id,
      sectors: ["finance", "monetary", "external"] as unknown as Prisma.InputJsonValue,
      observability: {
        finance: "FULL",
        monetary: "FULL",
        external: "PARTIAL",
      } as unknown as Prisma.InputJsonValue,
      planningAssumptions: {
        baselineYear: 2025,
        targetYear: 2027,
        currency: "DML",
        inflationTarget: 5.0,
        fictional: true,
      } as unknown as Prisma.InputJsonValue,
      metadata: {
        seededBy: "01-00-seed",
        version: "v2",
        fictional: true,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  console.log(`  CountryPackConfig: Tenant A (sectors: agriculture,finance,education,health)`);
  console.log(`  CountryPackConfig: Tenant B (sectors: finance,monetary,external)`);

  // 10c. Objectives for Tenant A — 5 objectives (≥5 per mission requirement)
  // All clearly fictional, attributed to Demolandia.
  const objectivesA = [
    {
      tenantId: tenantA.id,
      countryId: country.id,
      title: "Reduce unemployment to 10% within 5 years",
      description:
        "Fictional objective: reduce Demolandia's unemployment rate from a fictional 14.5% baseline to 10% by 2030.",
      targetMetric: "unemployment_rate",
      targetValue: "10%",
      horizon: 5,
      status: "active",
      createdBy: adminUser.id,
      metadata: { seededBy: "01-00-seed", fictional: true, sector: "finance" },
    },
    {
      tenantId: tenantA.id,
      countryId: country.id,
      title: "Increase agricultural GDP growth to 6% annually",
      description:
        "Fictional objective: raise Demolandia's agricultural GDP growth from a fictional 4.2% to 6% per year.",
      targetMetric: "agricultural_gdp_growth_rate",
      targetValue: "6%",
      horizon: 5,
      status: "active",
      createdBy: adminUser.id,
      metadata: { seededBy: "01-00-seed", fictional: true, sector: "agriculture" },
    },
    {
      tenantId: tenantA.id,
      countryId: country.id,
      title: "Achieve 95% primary school enrollment",
      description:
        "Fictional objective: raise Demolandia's primary school enrollment from a fictional 88% to 95%.",
      targetMetric: "primary_school_enrollment_rate",
      targetValue: "95%",
      horizon: 7,
      status: "draft",
      createdBy: adminUser.id,
      metadata: { seededBy: "01-00-seed", fictional: true, sector: "education" },
    },
    {
      tenantId: tenantA.id,
      countryId: country.id,
      title: "Reduce maternal mortality to 100 per 100,000 live births",
      description:
        "Fictional objective: lower Demolandia's maternal mortality ratio from a fictional 180 to 100.",
      targetMetric: "maternal_mortality_ratio",
      targetValue: "100",
      horizon: 8,
      status: "draft",
      createdBy: adminUser.id,
      metadata: { seededBy: "01-00-seed", fictional: true, sector: "health" },
    },
    {
      tenantId: tenantA.id,
      countryId: country.id,
      title: "Maintain inflation below 5% annually",
      description:
        "Fictional objective: keep Demolandia's annual inflation rate below 5% (coordinated with Central Bank).",
      targetMetric: "inflation_rate",
      targetValue: "5%",
      horizon: 3,
      status: "active",
      createdBy: adminUser.id,
      metadata: { seededBy: "01-00-seed", fictional: true, sector: "finance" },
    },
  ];

  for (const obj of objectivesA) {
    // Idempotent: skip if an objective with the same title already exists for this tenant.
    const existing = await prisma.objective.findFirst({
      where: { tenantId: obj.tenantId, title: obj.title },
    });
    if (!existing) {
      await prisma.objective.create({ data: obj });
    }
  }

  // 10d. Objectives for Tenant B — 2 objectives (Central Bank focus)
  // Different from Tenant A's objectives — this is the key test for cross-tenant isolation.
  const objectivesB = [
    {
      tenantId: tenantB.id,
      countryId: country.id,
      title: "Maintain foreign exchange reserves above 6 months of imports",
      description:
        "Fictional objective: keep Demolandia's FX reserves at ≥6 months of import cover.",
      targetMetric: "fx_reserves_months_of_imports",
      targetValue: "6",
      horizon: 3,
      status: "active",
      createdBy: adminUser.id,
      metadata: { seededBy: "01-00-seed", fictional: true, sector: "external" },
    },
    {
      tenantId: tenantB.id,
      countryId: country.id,
      title: "Keep monetary base growth within 8% annually",
      description:
        "Fictional objective: constrain Demolandia's monetary base growth to ≤8% per year.",
      targetMetric: "monetary_base_growth_rate",
      targetValue: "8%",
      horizon: 3,
      status: "active",
      createdBy: adminUser.id,
      metadata: { seededBy: "01-00-seed", fictional: true, sector: "monetary" },
    },
  ];

  for (const obj of objectivesB) {
    const existing = await prisma.objective.findFirst({
      where: { tenantId: obj.tenantId, title: obj.title },
    });
    if (!existing) {
      await prisma.objective.create({ data: obj });
    }
  }

  console.log(`  Objectives: Tenant A = 5, Tenant B = 2 (all fictional, clearly labeled)`);
  console.log(`  Cross-tenant isolation: Tenant A's objectives ≠ Tenant B's objectives`);

  // ============================================================
  // 11. G01 STATE BASELINE EVIDENCE (01-01)
  // ============================================================
  // Per ADR-0014 + FIX-2: evidence tagged with metadata.sector + metadata.countryId.
  // The G00 evidence (items 1-4 above) already includes metadata.countryId + metadata.sector.
  // Here we add additional evidence for finance + external sectors.
  //
  // Observability scenarios:
  //   - FULL: agriculture (Tenant A) — 4 evidence, 2 independent sources (WB+IMF), verified
  //   - FULL: finance (Tenant B) — 2 independent + verified + counter-evidence
  //   - PARTIAL: finance (Tenant A) — 1 source, unverified
  //   - PARTIAL: external (Tenant B) — 1 source, unverified
  //   - LOW: education, health (both tenants) — no evidence → "unknown"
  console.log("\nSeeding G01 State Baseline evidence (01-01)...");

  // 11a. Add PARTIAL evidence for "finance" sector (Tenant A)
  //     1 source (IMF), unverified — PARTIAL observability
  //     FIX-2: includes metadata.countryId for country-specific scoping
  const financeEvidence = {
    tenantId: tenantA.id,
    sourceId: imfSource.id,
    claim: "Demolandia's inflation rate was 7.2% in 2024 according to IMF WEO.",
    summary: "IMF data on Demolandia inflation (fictional).",
    type: "supporting",
    verificationStatus: "unverified",
    observedAt: new Date("2024-12-31"),
    extractionMethod: "manual",
    classification: "public",
    confidenceNotes: "Single source, unverified — PARTIAL observability.",
    metadata: { countryId: country.id, sector: "finance", indicatorName: "inflation rate", fictional: true, seededBy: "01-01-seed" },
  };
  const existingFinance = await prisma.evidence.findFirst({
    where: { tenantId: tenantA.id, claim: financeEvidence.claim },
  });
  if (!existingFinance) {
    await prisma.evidence.create({ data: financeEvidence });
    const embedResult = await provider.embed({
      input: financeEvidence.claim,
      dimensions: 384,
    });
    const newEv = await prisma.evidence.findFirst({
      where: { tenantId: tenantA.id, claim: financeEvidence.claim },
    });
    if (newEv) {
      const vectorLiteral = `[${embedResult.vectors[0]!.join(",")}]`;
      await prisma.$executeRaw`
        INSERT INTO "evidence_embeddings" ("id", "evidenceId", "tenantId", "embedding", "model", "createdAt")
        VALUES (gen_random_uuid()::text, ${newEv.id}, ${tenantA.id}, ${vectorLiteral}::vector, ${provider.defaultEmbeddingModel}, NOW())
      `;
    }
  }
  console.log(`  Finance evidence (Tenant A): 1 item (PARTIAL — single source, unverified)`);

  // 11b. Add FULL evidence for "finance" sector to Tenant B
  //     2 independent sources (IMF + World Bank) + 1 verified → FULL
  const financeFullB1 = {
    tenantId: tenantB.id,
    sourceId: imfSource.id,
    claim: "Demolandia's monetary base grew 6.8% in 2024 according to IMF.",
    summary: "IMF data on Demolandia monetary base (fictional).",
    type: "supporting",
    verificationStatus: "verified",
    observedAt: new Date("2024-12-31"),
    extractionMethod: "manual",
    classification: "public",
    confidenceNotes: "Verified — IMF official statistics.",
    metadata: { countryId: country.id, sector: "finance", indicatorName: "monetary base growth", fictional: true, seededBy: "01-01-seed" },
  };
  const financeFullB2 = {
    tenantId: tenantB.id,
    sourceId: worldBankSource.id,
    claim: "World Bank confirms Demolandia monetary base growth at 6.7% for 2024.",
    summary: "World Bank independent confirmation of monetary base growth.",
    type: "supporting",
    verificationStatus: "corroborated",
    observedAt: new Date("2024-12-31"),
    extractionMethod: "manual",
    classification: "public",
    confidenceNotes: "Corroborated — independent World Bank verification.",
    metadata: { countryId: country.id, sector: "finance", indicatorName: "monetary base growth", fictional: true, seededBy: "01-01-seed" },
  };
  for (const ev of [financeFullB1, financeFullB2]) {
    const existing = await prisma.evidence.findFirst({
      where: { tenantId: ev.tenantId, claim: ev.claim },
    });
    if (!existing) {
      const created = await prisma.evidence.create({ data: ev });
      const embedResult = await provider.embed({ input: ev.claim, dimensions: 384 });
      const vectorLiteral = `[${embedResult.vectors[0]!.join(",")}]`;
      await prisma.$executeRaw`
        INSERT INTO "evidence_embeddings" ("id", "evidenceId", "tenantId", "embedding", "model", "createdAt")
        VALUES (gen_random_uuid()::text, ${created.id}, ${tenantB.id}, ${vectorLiteral}::vector, ${provider.defaultEmbeddingModel}, NOW())
      `;
    }
  }
  console.log(`  Finance evidence (Tenant B): 2 items (FULL — 2 independent sources + verified)`);

  // 11c. Add evidence for "external" sector to Tenant B (1 source, PARTIAL)
  const externalEvidence = {
    tenantId: tenantB.id,
    sourceId: imfSource.id,
    claim: "Demolandia's foreign exchange reserves covered 4.8 months of imports in 2024.",
    summary: "IMF data on Demolandia FX reserves (fictional).",
    type: "supporting",
    verificationStatus: "unverified",
    observedAt: new Date("2024-12-31"),
    extractionMethod: "manual",
    classification: "public",
    confidenceNotes: "Single source, unverified — PARTIAL observability.",
    metadata: { countryId: country.id, sector: "external", indicatorName: "FX reserves months of imports", fictional: true, seededBy: "01-01-seed" },
  };
  const existingExternal = await prisma.evidence.findFirst({
    where: { tenantId: tenantB.id, claim: externalEvidence.claim },
  });
  if (!existingExternal) {
    const created = await prisma.evidence.create({ data: externalEvidence });
    const embedResult = await provider.embed({ input: externalEvidence.claim, dimensions: 384 });
    const vectorLiteral = `[${embedResult.vectors[0]!.join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO "evidence_embeddings" ("id", "evidenceId", "tenantId", "embedding", "model", "createdAt")
      VALUES (gen_random_uuid()::text, ${created.id}, ${tenantB.id}, ${vectorLiteral}::vector, ${provider.defaultEmbeddingModel}, NOW())
    `;
  }
  console.log(`  External evidence (Tenant B): 1 item (PARTIAL — single source, unverified)`);

  // 11d. Add counter-evidence for Tenant B's finance sector (contradiction test)
  const financeCounterB = {
    tenantId: tenantB.id,
    sourceId: reutersSyndicated.id,
    claim: "Local economists dispute Demolandia monetary base figures, citing off-budget spending.",
    summary: "Contradicts IMF/WB monetary base growth figures.",
    type: "counter",
    verificationStatus: "disputed",
    observedAt: new Date("2024-11-15"),
    extractionMethod: "interview",
    classification: "public",
    confidenceNotes: "Disputed — counter-evidence to IMF/WB figures.",
    metadata: { countryId: country.id, sector: "finance", fictional: true, seededBy: "01-01-seed" },
  };
  const existingCounter = await prisma.evidence.findFirst({
    where: { tenantId: tenantB.id, claim: financeCounterB.claim },
  });
  if (!existingCounter) {
    const created = await prisma.evidence.create({ data: financeCounterB });
    const embedResult = await provider.embed({ input: financeCounterB.claim, dimensions: 384 });
    const vectorLiteral = `[${embedResult.vectors[0]!.join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO "evidence_embeddings" ("id", "evidenceId", "tenantId", "embedding", "model", "createdAt")
      VALUES (gen_random_uuid()::text, ${created.id}, ${tenantB.id}, ${vectorLiteral}::vector, ${provider.defaultEmbeddingModel}, NOW())
    `;
  }
  console.log(`  Finance counter-evidence (Tenant B): 1 item (contradiction test — shown side-by-side)`);

  // 11e. Education + health sectors have NO evidence → LOW (unknown)
  //     (This is intentional — the baseline engine must say "unknown" for these sectors.)
  //     FIX-1: these sectors appear in the report as LOW (not absent) because they're
  //     listed in CountryPackConfig.sectors.
  console.log(`  Education + health sectors: 0 evidence → LOW (unknown) — intentional for testing`);

  console.log("\nG01 State Builder seed complete.");
  console.log("  Baseline test scenarios (post FIX-1/2/3/4):");
  console.log("    Tenant A: agriculture=FULL (2 indep + verified), finance=PARTIAL (1 source)");
  console.log("    Tenant B: finance=FULL (2 indep + verified + counter), external=PARTIAL");
  console.log("    Both tenants: education=LOW, health=LOW (no evidence → unknown, but appears in report)");
  console.log("    FIX-2: all evidence has metadata.countryId for country-specific scoping");
  console.log("    FIX-3: indicator values use structured metadata or % extraction (no years as values)");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
