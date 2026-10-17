// ============================================================
// country-pack-service.ts — Country Pack composition
// ------------------------------------------------------------
// Mission 01-00: G01 Bootstrap + Country Pack Extension
//
// getCountryPack composes PUBLIC reference data (from G00 tables)
// with PRIVATE tenant planning data (from G01 tables) into a single
// response. The separation is critical (Correction A):
//
//   PUBLIC reference (readable by all tenants):
//     - country (geography, ISO codes)
//     - institutions (ministries, agencies, authorities)
//     - adminUnits (state_hierarchy: nation → province → district)
//     - legalMandates (role_references catalog — legal basis)
//
//   PRIVATE planning (tenant-scoped, NEVER visible to other tenants):
//     - countryPackConfig (this tenant's config for this country)
//     - objectives (this tenant's goals for this country)
//
// Two tenants operating on the same country see the SAME public
// reference data but DIFFERENT private planning data. RLS enforces
// this at the DB level; this service composes the two scopes.
//
// Permission: tenant:read (all roles). Reading PUBLIC reference +
// own tenant's PRIVATE planning is a basic capability.
//
// Per ADR-0013. Reuses G00's withAuthenticatedTenant.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES
// ============================================================

export interface CountryReference {
  // PUBLIC — from G00 countries table
  id: string;
  iso3: string;
  iso2: string | null;
  displayName: string;
  status: string;
}

export interface InstitutionReference {
  // PUBLIC — from G00 institutions table
  id: string;
  code: string;
  displayName: string;
  type: string; // ministry | agency | authority | directorate | council
  parentId: string | null;
}

export interface AdminUnitReference {
  // PUBLIC — from G00 state_hierarchy table
  id: string;
  code: string;
  displayName: string;
  level: string; // nation | province | district | municipality | neighborhood
  parentId: string | null;
}

export interface LegalMandateReference {
  // PUBLIC — from G00 role_references table (used as legal basis catalog)
  // NOTE: role_references is currently used for RBAC roles (admin, analyst, etc.).
  // For G01, legal mandates are stored as institution metadata or in the
  // public_knowledge table. This interface is a placeholder for mission 01-04
  // (Institutional Design) to populate. For 01-00, we return an empty array.
  id: string;
  code: string;
  displayName: string;
  description: string;
}

export interface CountryPackConfigData {
  // PRIVATE — from G01 country_pack_configs table (this tenant only)
  id: string;
  sectors: string[]; // e.g., ["agriculture","finance","health"]
  observability: Record<string, string>; // e.g., { "agriculture": "FULL" }
  planningAssumptions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ObjectiveSummary {
  // PRIVATE — from G01 objectives table (this tenant only)
  id: string;
  title: string;
  description: string | null;
  targetMetric: string;
  targetValue: string;
  horizon: number;
  status: string;
  createdBy: string;
  createdAt: Date;
}

export interface CountryPack {
  // The composite response: PUBLIC reference + PRIVATE planning
  // PUBLIC reference (same for all tenants operating on this country)
  country: CountryReference;
  institutions: InstitutionReference[];
  adminUnits: AdminUnitReference[];
  legalMandates: LegalMandateReference[]; // placeholder for 01-04

  // PRIVATE planning (this tenant's view of the country)
  countryPackConfig: CountryPackConfigData | null;
  objectives: ObjectiveSummary[];

  // Honesty flags
  fictional: boolean; // true if the country is a fictional fixture (e.g., Demolandia)
  sourceNote: string; // explanation of data provenance
}

// ============================================================
// GET COUNTRY PACK
// ============================================================

export async function getCountryPack(
  session: Session,
  input: { countryId: string }
): Promise<CountryPack> {
  // Read permission — all roles can read the country pack.
  await requirePermissionWithCurrentRole(session, "tenant:read");

  if (!input.countryId || input.countryId.length === 0) {
    throw new Error("countryId is required");
  }

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // -------------------------------------------------------
    // 1. PUBLIC REFERENCE DATA (from G00 tables — readable by all tenants)
    // -------------------------------------------------------
    // These queries run inside the tenant-scoped transaction, but the G00
    // PUBLIC tables (countries, institutions, state_hierarchy) have RLS
    // policies that allow balance_app to SELECT unconditionally (USING true).
    // So these return the same rows regardless of which tenant is asking.

    const country = await tx.country.findUnique({
      where: { id: input.countryId },
    });
    if (!country) {
      throw new Error(`Country not found: ${input.countryId}`);
    }

    const institutions = await tx.institution.findMany({
      where: { countryId: input.countryId },
      orderBy: [{ type: "asc" }, { displayName: "asc" }],
    });

    const adminUnits = await tx.stateHierarchy.findMany({
      where: { countryId: input.countryId },
      orderBy: [{ level: "asc" }, { displayName: "asc" }],
    });

    // Legal mandates: placeholder — mission 01-04 will populate this from
    // institution metadata or a dedicated legal catalog. For 01-00, empty.
    const legalMandates: LegalMandateReference[] = [];

    // -------------------------------------------------------
    // 2. PRIVATE PLANNING DATA (from G01 tables — this tenant only)
    // -------------------------------------------------------
    // RLS on country_pack_configs + objectives ensures only THIS tenant's
    // rows are visible. Cross-tenant access returns null/empty.

    const countryPackConfigRow = await tx.countryPackConfig.findUnique({
      where: {
        tenantId_countryId: { tenantId, countryId: input.countryId },
      },
    });

    const objectiveRows = await tx.objective.findMany({
      where: { tenantId, countryId: input.countryId },
      orderBy: { createdAt: "desc" },
    });

    // -------------------------------------------------------
    // 3. COMPOSE THE RESPONSE
    // -------------------------------------------------------
    // Determine if the country is a fictional fixture.
    // Demolandia (DML) is the seeded fictional country. Any country with
    // iso3 = "DML" or displayName containing "Demolandia" is fictional.
    const isFictional =
      country.iso3 === "DML" ||
      country.displayName.toLowerCase().includes("demolandia");

    const sourceNote = isFictional
      ? "Fictional fixture country (Demolandia). All data is synthetic. Not representative of any real country."
      : "Country reference data from G00 PUBLIC tables. Planning data is tenant-scoped.";

    return {
      // PUBLIC reference
      country: {
        id: country.id,
        iso3: country.iso3,
        iso2: country.iso2,
        displayName: country.displayName,
        status: country.status,
      },
      institutions: institutions.map((i) => ({
        id: i.id,
        code: i.code,
        displayName: i.displayName,
        type: i.type,
        parentId: i.parentId,
      })),
      adminUnits: adminUnits.map((u) => ({
        id: u.id,
        code: u.code,
        displayName: u.displayName,
        level: u.level,
        parentId: u.parentId,
      })),
      legalMandates,

      // PRIVATE planning
      countryPackConfig: countryPackConfigRow
        ? {
            id: countryPackConfigRow.id,
            sectors: (countryPackConfigRow.sectors as unknown as string[]) ?? [],
            observability:
              (countryPackConfigRow.observability as unknown as Record<string, string>) ??
              {},
            planningAssumptions:
              (countryPackConfigRow.planningAssumptions as unknown as Record<string, unknown>) ??
              {},
            metadata:
              (countryPackConfigRow.metadata as unknown as Record<string, unknown>) ?? {},
            createdAt: countryPackConfigRow.createdAt,
            updatedAt: countryPackConfigRow.updatedAt,
          }
        : null,
      objectives: objectiveRows.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description,
        targetMetric: o.targetMetric,
        targetValue: o.targetValue,
        horizon: o.horizon,
        status: o.status,
        createdBy: o.createdBy,
        createdAt: o.createdAt,
      })),

      // Honesty flags
      fictional: isFictional,
      sourceNote,
    };
  });
}

// ============================================================
// UPSERT COUNTRY PACK CONFIG (helper for seed + future admin UI)
// ============================================================
// This is NOT exposed via API in mission 01-00. It's a helper used by
// the seed script to create per-tenant CountryPackConfig rows.
// Future missions (01-04+) may expose it via an admin API.

export interface UpsertCountryPackConfigInput {
  tenantId: string;
  countryId: string;
  sectors: string[];
  observability: Record<string, string>;
  planningAssumptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export async function upsertCountryPackConfig(
  input: UpsertCountryPackConfigInput
): Promise<{ configId: string }> {
  // This helper runs WITHOUT a session — it's for the seed script only.
  // The seed connects as balance_admin (BYPASSRLS) via DIRECT_URL.
  // It must NOT be called from API routes without a session wrapper.
  const { db } = await import("@/lib/db");

  const config = await db.countryPackConfig.upsert({
    where: {
      tenantId_countryId: { tenantId: input.tenantId, countryId: input.countryId },
    },
    update: {
      sectors: input.sectors as unknown as Prisma.InputJsonValue,
      observability: input.observability as unknown as Prisma.InputJsonValue,
      planningAssumptions:
        (input.planningAssumptions ?? {}) as unknown as Prisma.InputJsonValue,
      metadata: (input.metadata ?? {}) as unknown as Prisma.InputJsonValue,
    },
    create: {
      tenantId: input.tenantId,
      countryId: input.countryId,
      sectors: input.sectors as unknown as Prisma.InputJsonValue,
      observability: input.observability as unknown as Prisma.InputJsonValue,
      planningAssumptions:
        (input.planningAssumptions ?? {}) as unknown as Prisma.InputJsonValue,
      metadata: (input.metadata ?? {}) as unknown as Prisma.InputJsonValue,
    },
  });

  return { configId: config.id };
}
