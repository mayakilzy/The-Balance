// ============================================================
// program-service.ts — Institutional Design & Program Contracts
// ------------------------------------------------------------
// Mission 01-04: Expand strategy alternative programs into full
// institutional contracts with owning institution, legal mandate,
// required capabilities, and KPIs with sourceKind.
//
// expandPrograms(session, { strategyAlternativeId }) → Program[]
//
// Each program contract includes:
//   - Owning institution (validated against PUBLIC institutions table)
//   - Legal mandate reference (or "mandate gap" if none)
//   - Required capabilities
//   - KPIs with target, frequency, sourceKind
//   - Rationale + evidence refs
//   - simulated: true
//
// Institutional integrity:
//   - Institution must exist in the PUBLIC institutions table
//   - Institution must belong to the same country as the strategy
//   - No cross-country or cross-tenant institution leakage
//   - "mandate gap" shown when no legal basis is documented
//   - No fabricated institutions, laws, or mandates
//
// Per ADR-0017. Reuses G00 + 01-00 + 01-03 contracts.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES — Program Contract
// ============================================================

export interface KPI {
  name: string;
  target: string;
  frequency: string; // "quarterly" | "annual" | "monthly"
  sourceKind: KpiSourceKind;
  notes?: string;
}

export type KpiSourceKind =
  | "official_statistics"
  | "administrative_data"
  | "survey"
  | "international_indicator"
  | "unspecified";

export interface RequiredCapability {
  name: string;
  status: "available" | "needs_building" | "unknown";
  notes?: string;
}

export interface ProgramContract {
  programId: string;
  title: string;
  sector: string;
  strategyVersionId: string;
  // Institutional design
  owningInstitutionId: string | null;
  owningInstitutionCode: string | null;
  owningInstitutionName: string | null;
  legalMandateRef: string | null;
  mandateGap: boolean;
  // Capabilities + KPIs
  requiredCapabilities: RequiredCapability[];
  kpis: KPI[];
  // Provenance
  rationale: string;
  evidenceRefs: Array<{
    evidenceId: string;
    claim: string;
    sourceCode: string | null;
  }>;
  counterEvidence: Array<{
    evidenceId: string;
    claim: string;
    sourceCode: string | null;
  }>;
  simulated: boolean;
  status: string; // "draft"
}

export interface ExpandProgramsResult {
  strategyVersionId: string;
  programs: ProgramContract[];
  summary: {
    totalPrograms: number;
    withInstitution: number;
    withMandateGap: number;
    withoutInstitution: number;
  };
}

// ============================================================
// DETERMINISTIC INSTITUTION ASSIGNMENT
// ============================================================
// Map sectors to institutions based on the Country Pack's PUBLIC
// institutions table. This is deterministic — no LLM, no fabrication.
// If no institution matches the sector, owningInstitutionId = null
// and mandateGap = true.

const SECTOR_INSTITUTION_MAP: Record<string, string[]> = {
  // sector → institution types (in priority order)
  agriculture: ["ministry", "agency"],
  finance: ["ministry", "authority"],
  education: ["ministry"],
  health: ["ministry", "authority"],
  monetary: ["authority"],
  external: ["authority", "ministry"],
};

function getPreferredInstitutionTypes(sector: string): string[] {
  return SECTOR_INSTITUTION_MAP[sector] ?? ["ministry", "agency", "authority"];
}

// ============================================================
// DETERMINISTIC KPI GENERATION
// ============================================================
// KPIs are derived from the objective's targetMetric + targetValue.
// No fabricated targets — they come from the objective.
// sourceKind is determined by the sector + metric type.

const METRIC_SOURCE_KIND: Record<string, KpiSourceKind> = {
  agricultural_gdp_growth_rate: "official_statistics",
  inflation_rate: "official_statistics",
  unemployment_rate: "official_statistics",
  primary_school_enrollment_rate: "administrative_data",
  maternal_mortality_ratio: "official_statistics",
  fx_reserves_months_of_imports: "official_statistics",
  monetary_base_growth_rate: "official_statistics",
};

function getSourceKindForMetric(metric: string): KpiSourceKind {
  return METRIC_SOURCE_KIND[metric] ?? "unspecified";
}

function generateKPIs(
  sector: string,
  objectiveTargetMetric: string | null,
  objectiveTargetValue: string | null,
  objectiveHorizon: number | null
): KPI[] {
  if (!objectiveTargetMetric || !objectiveTargetValue) {
    return [];
  }

  const sourceKind = getSourceKindForMetric(objectiveTargetMetric);
  return [
    {
      name: objectiveTargetMetric,
      target: objectiveTargetValue,
      frequency: "annual",
      sourceKind,
      notes: sourceKind === "unspecified"
        ? "Measurement source not yet identified — this KPI cannot be verified until a reliable source is designated."
        : undefined,
    },
  ];
}

// ============================================================
// DETERMINISTIC CAPABILITY GENERATION
// ============================================================
// Capabilities are derived from the sector — no fabrication.

const SECTOR_CAPABILITIES: Record<string, string[]> = {
  agriculture: ["agricultural research", "extension services", "irrigation management"],
  finance: ["fiscal policy analysis", "tax administration", "budget execution"],
  education: ["curriculum development", "teacher training", "school construction"],
  health: ["epidemiological surveillance", "health workforce management", "supply chain"],
  monetary: ["monetary policy", "banking supervision", "reserve management"],
  external: ["trade policy", "diplomatic coordination", "FX management"],
};

function generateCapabilities(sector: string): RequiredCapability[] {
  const caps = SECTOR_CAPABILITIES[sector] ?? [];
  return caps.map((name) => ({
    name,
    status: "unknown" as const,
    notes: "Capability availability not assessed — requires institutional diagnostic.",
  }));
}

// ============================================================
// LEGAL MANDATE DETERMINATION
// ============================================================
// The Demolandia seed does not include explicit legal mandates for
// institutions. We do NOT fabricate legal references. Instead:
//   - If the institution has a known type (ministry/authority), we note
//     that the legal mandate is "implied by institution type" but NOT verified.
//   - mandateGap = true (we cannot PROVE the legal mandate exists)
//   - legalMandateRef = null (no fabricated reference)

function determineLegalMandate(
  institutionType: string | null
): { legalMandateRef: string | null; mandateGap: boolean } {
  // We don't fabricate legal references. The mandate gap is always true
  // unless a legal reference is explicitly documented (which Demolandia
  // doesn't have yet).
  return {
    legalMandateRef: null,
    mandateGap: true,
  };
}

// ============================================================
// EXPAND PROGRAMS (public API)
// ============================================================

export async function expandPrograms(
  session: Session,
  input: { strategyAlternativeId: string }
): Promise<ExpandProgramsResult> {
  // Permission: strategy:write (analyst + admin) — same as composer
  await requirePermissionWithCurrentRole(session, "strategy:write");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // 1. Fetch the strategy version (must be in tenant scope — RLS enforced)
    const strategyVersion = await tx.strategyVersion.findFirst({
      where: { id: input.strategyAlternativeId, tenantId },
      include: {
        strategy: true,
      },
    });

    if (!strategyVersion) {
      throw new Error(
        `Strategy version ${input.strategyAlternativeId} not found in tenant scope. ` +
        `Cannot expand programs for a strategy that doesn't belong to this tenant.`
      );
    }

    // 2. Parse the alternative data from the version metadata
    const metadata = strategyVersion.metadata as unknown as Record<string, unknown>;
    const alternativeData = metadata as unknown as {
      programs?: Array<{
        title: string;
        sector: string;
        rationale: string;
        evidenceRefs: Array<{ evidenceId: string; claim: string; sourceCode: string | null }>;
        simulated: boolean;
      }>;
      objectives?: Array<{ objectiveId: string; objectiveTitle: string; approach: string }>;
      counterEvidence?: Array<{ evidenceId: string; claim: string; sourceCode: string | null }>;
      inputSnapshot?: { countryId: string };
    };

    if (!alternativeData.programs || alternativeData.programs.length === 0) {
      throw new Error(
        `Strategy version ${input.strategyAlternativeId} has no programs to expand. ` +
        `Ensure the strategy was composed correctly.`
      );
    }

    // 3. Get the country ID from the input snapshot
    const countryId = alternativeData.inputSnapshot?.countryId;
    if (!countryId) {
      throw new Error(
        `Strategy version ${input.strategyAlternativeId} has no countryId in inputSnapshot. ` +
        `Cannot validate institutions without knowing the country.`
      );
    }

    // 4. Fetch PUBLIC institutions for this country
    const institutions = await tx.institution.findMany({
      where: { countryId },
    });

    // 5. Fetch objectives (for KPI generation)
    const objectiveIds = (alternativeData.objectives ?? []).map((o) => o.objectiveId);
    const objectives = objectiveIds.length > 0
      ? await tx.objective.findMany({
          where: { tenantId, id: { in: objectiveIds } },
        })
      : [];

    // 6. For each program in the alternative, expand into a full contract
    const programContracts: ProgramContract[] = [];

    for (const progData of alternativeData.programs) {
      // 6a. Find matching institution for this sector
      const preferredTypes = getPreferredInstitutionTypes(progData.sector);
      let matchedInstitution: typeof institutions[0] | null = null;

      for (const prefType of preferredTypes) {
        matchedInstitution = institutions.find((i) => i.type === prefType) ?? null;
        if (matchedInstitution) break;
      }

      // 6b. Determine legal mandate
      const { legalMandateRef, mandateGap } = determineLegalMandate(
        matchedInstitution?.type ?? null
      );

      // 6c. Find the objective for this sector (for KPI generation)
      const matchingObjective = objectives.find((o) => {
        const meta = (o.metadata ?? {}) as unknown as Record<string, unknown>;
        return typeof meta.sector === "string" && meta.sector === progData.sector;
      });

      // 6d. Generate KPIs from the objective
      const kpis = generateKPIs(
        progData.sector,
        matchingObjective?.targetMetric ?? null,
        matchingObjective?.targetValue ?? null,
        matchingObjective?.horizon ?? null
      );

      // 6e. Generate required capabilities
      const requiredCapabilities = generateCapabilities(progData.sector);

      // 6f. Check if a Program record already exists (idempotent resume)
      const existingProgram = await tx.program.findFirst({
        where: {
          tenantId,
          strategyVersionId: strategyVersion.id,
          title: progData.title,
        },
      });

      let programId: string;

      if (existingProgram) {
        // Reuse existing program — update its metadata
        await tx.program.update({
          where: { id: existingProgram.id },
          data: {
            owningInstitutionId: matchedInstitution?.id ?? null,
            legalMandateRef,
            rationale: progData.rationale,
            metadata: {
              simulated: true,
              sector: progData.sector,
              kpis,
              requiredCapabilities,
              mandateGap,
              evidenceRefs: progData.evidenceRefs,
              counterEvidence: alternativeData.counterEvidence ?? [],
              expandedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        programId = existingProgram.id;
      } else {
        // Create new Program record
        const newProgram = await tx.program.create({
          data: {
            tenantId,
            strategyVersionId: strategyVersion.id,
            title: progData.title,
            sector: progData.sector,
            owningInstitutionId: matchedInstitution?.id ?? null,
            legalMandateRef,
            rationale: progData.rationale,
            status: "draft", // NEVER auto-approved
            metadata: {
              simulated: true,
              sector: progData.sector,
              kpis,
              requiredCapabilities,
              mandateGap,
              evidenceRefs: progData.evidenceRefs,
              counterEvidence: alternativeData.counterEvidence ?? [],
              expandedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        programId = newProgram.id;
      }

      // 6g. Build the contract object
      programContracts.push({
        programId,
        title: progData.title,
        sector: progData.sector,
        strategyVersionId: strategyVersion.id,
        owningInstitutionId: matchedInstitution?.id ?? null,
        owningInstitutionCode: matchedInstitution?.code ?? null,
        owningInstitutionName: matchedInstitution?.displayName ?? null,
        legalMandateRef,
        mandateGap,
        requiredCapabilities,
        kpis,
        rationale: progData.rationale,
        evidenceRefs: progData.evidenceRefs,
        counterEvidence: alternativeData.counterEvidence ?? [],
        simulated: true,
        status: "draft",
      });
    }

    // 7. Build summary
    const summary = {
      totalPrograms: programContracts.length,
      withInstitution: programContracts.filter((p) => p.owningInstitutionId !== null).length,
      withMandateGap: programContracts.filter((p) => p.mandateGap).length,
      withoutInstitution: programContracts.filter((p) => p.owningInstitutionId === null).length,
    };

    return {
      strategyVersionId: strategyVersion.id,
      programs: programContracts,
      summary,
    };
  });
}

// ============================================================
// GET PROGRAMS FOR A STRATEGY VERSION
// ============================================================

export async function getPrograms(
  session: Session,
  strategyVersionId: string
): Promise<ProgramContract[]> {
  await requirePermissionWithCurrentRole(session, "program:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const programs = await tx.program.findMany({
      where: { tenantId, strategyVersionId },
      orderBy: { title: "asc" },
    });

    // Fetch institutions for enrichment
    const institutionIds = [...new Set(programs.map((p) => p.owningInstitutionId).filter(Boolean))] as string[];
    const institutions = institutionIds.length > 0
      ? await tx.institution.findMany({ where: { id: { in: institutionIds } } })
      : [];
    const institutionMap = new Map(institutions.map((i) => [i.id, i]));

    return programs.map((p) => {
      const meta = (p.metadata ?? {}) as unknown as Record<string, unknown>;
      const inst = p.owningInstitutionId ? institutionMap.get(p.owningInstitutionId) : null;
      return {
        programId: p.id,
        title: p.title,
        sector: p.sector,
        strategyVersionId: p.strategyVersionId,
        owningInstitutionId: p.owningInstitutionId,
        owningInstitutionCode: inst?.code ?? null,
        owningInstitutionName: inst?.displayName ?? null,
        legalMandateRef: p.legalMandateRef,
        mandateGap: (meta.mandateGap as boolean) ?? true,
        requiredCapabilities: (meta.requiredCapabilities as RequiredCapability[]) ?? [],
        kpis: (meta.kpis as KPI[]) ?? [],
        rationale: p.rationale ?? "",
        evidenceRefs: (meta.evidenceRefs as ProgramContract["evidenceRefs"]) ?? [],
        counterEvidence: (meta.counterEvidence as ProgramContract["counterEvidence"]) ?? [],
        simulated: (meta.simulated as boolean) ?? true,
        status: p.status,
      };
    });
  });
}

// ============================================================
// VALIDATE INSTITUTION (helper for cross-country prevention)
// ============================================================

export async function validateInstitutionForCountry(
  session: Session,
  institutionId: string,
  countryId: string
): Promise<{ valid: boolean; reason?: string }> {
  return withAuthenticatedTenant(session, async ({ tx }) => {
    const institution = await tx.institution.findUnique({
      where: { id: institutionId },
    });

    if (!institution) {
      return { valid: false, reason: `Institution ${institutionId} not found.` };
    }

    if (institution.countryId !== countryId) {
      return {
        valid: false,
        reason: `Institution ${institutionId} belongs to country ${institution.countryId}, not ${countryId}. Cross-country institution rejected.`,
      };
    }

    return { valid: true };
  });
}
