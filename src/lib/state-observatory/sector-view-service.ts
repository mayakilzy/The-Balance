// ============================================================
// state-observatory/sector-view-service.ts
// ------------------------------------------------------------
// Read-only service — sector observatory view.
//
// CORRECTION 3: Truthful sector summaries.
//   - No fabricated FULL/PARTIAL/LOW from counts.
//   - aggregateObservability = "not_computed" with clear reason.
//   - simulatedData = null when not inspected (NOT false).
//   - Deduplicate indicators by ID (D8).
//
// D9: Institution is PUBLIC; programs/indicators are tenant-scoped.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Session } from "next-auth";

export interface SectorView {
  sector: string;
  institutions: Array<{
    id: string;
    code: string;
    displayName: string;
    type: string;
    programCount: number;
    indicatorCount: number;
  }>;
  totalPrograms: number;
  totalIndicators: number; // D8: deduplicated by indicatorId
  totalInstitutions: number;
  // CORRECTION 3: not fabricated from counts
  aggregateObservability: {
    status: "not_computed";
    reason: string; // points to real aggregate-independence analysis
  };
  honesty: {
    noCausalClaims: true;
    // CORRECTION 3: null = not inspected, NOT false
    simulatedData: boolean | null;
    observabilityNotFabricated: true;
  };
}

export async function getSectorView(
  session: Session | null,
  params: { sector: string; strategyVersionId: string; observationPeriodId: string }
): Promise<SectorView> {
  await requirePermissionWithCurrentRole(session, "observatory:observation:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // CORRECTION 2: validate strategyVersion
    const sv = await tx.strategyVersion.findFirst({
      where: { id: params.strategyVersionId, tenantId, status: "approved" },
      select: { id: true },
    });
    if (!sv) {
      throw new Error(`StrategyVersion ${params.strategyVersionId} not approved in tenant`);
    }

    // FIX 1: verify ObservationPeriod belongs to tenant
    const period = await tx.observationPeriod.findFirst({
      where: { id: params.observationPeriodId, tenantId },
      select: { id: true },
    });
    if (!period) {
      throw new Error(`ObservationPeriod ${params.observationPeriodId} not found in tenant`);
    }

    // Fetch programs in this sector (D9: tenant + strategyVersion scoped)
    const programs = await tx.program.findMany({
      where: {
        tenantId,
        sector: params.sector,
        strategyVersionId: params.strategyVersionId,
      },
      select: { id: true, owningInstitutionId: true },
    });

    // Collect institution IDs (non-null only)
    const institutionIds = new Set<string>();
    for (const prog of programs) {
      if (prog.owningInstitutionId) {
        institutionIds.add(prog.owningInstitutionId);
      }
    }

    // Fetch institutions (PUBLIC G00 table)
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { countryId: true },
    });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

    const institutions = institutionIds.size > 0
      ? await tx.institution.findMany({
          where: { id: { in: Array.from(institutionIds) } },
          select: { id: true, code: true, displayName: true, type: true, countryId: true },
        })
      : [];

    // FIX 1: verify each institution belongs to tenant's country.
    // Do NOT silently omit cross-country institutions — report them explicitly.
    const validInstitutions = institutions.filter((inst) => inst.countryId === tenant.countryId);
    const invalidInstitutionIds = institutions
      .filter((inst) => inst.countryId !== tenant.countryId)
      .map((inst) => inst.id);
    if (invalidInstitutionIds.length > 0) {
      // Report the integrity issue explicitly — do not present an apparently complete result
      throw new Error(
        `Data integrity violation: ${invalidInstitutionIds.length} institution(s) ` +
        `referenced by programs in sector "${params.sector}" belong to a different country ` +
        `than tenant ${tenantId}. Invalid institution IDs: ${invalidInstitutionIds.join(", ")}`
      );
    }

    // For each valid institution, count programs + indicators
    const institutionViews: SectorView["institutions"] = [];
    const allIndicatorIds = new Set<string>(); // D8: deduplicate
    let anySimulated = false;
    let simulatedInspected = false;

    for (const inst of validInstitutions) {
      const instPrograms = programs.filter(
        (p) => p.owningInstitutionId === inst.id
      );
      const instProgramIds = instPrograms.map((p) => p.id);

      // FIX 1: indicators must match strategyVersionId in addition to tenant + program
      const indicators = instProgramIds.length > 0
        ? await tx.indicatorDefinition.findMany({
            where: { tenantId, programId: { in: instProgramIds }, strategyVersionId: params.strategyVersionId },
            select: { id: true },
          })
        : [];

      for (const ind of indicators) {
        allIndicatorIds.add(ind.id); // D8: deduplicate
      }

      institutionViews.push({
        id: inst.id,
        code: inst.code,
        displayName: inst.displayName,
        type: inst.type,
        programCount: instPrograms.length,
        indicatorCount: indicators.length,
      });
    }

    // CORRECTION 3: check simulatedData by inspecting observations
    if (allIndicatorIds.size > 0) {
      const obsCount = await tx.observation.count({
        where: {
          tenantId,
          indicatorDefinitionId: { in: Array.from(allIndicatorIds) },
          observationPeriodId: params.observationPeriodId,
          isCurrent: true,
          isSynthetic: true,
        },
      });
      if (obsCount > 0) {
        anySimulated = true;
        simulatedInspected = true;
      } else {
        // Check if any non-synthetic observations exist
        const realObsCount = await tx.observation.count({
          where: {
            tenantId,
            indicatorDefinitionId: { in: Array.from(allIndicatorIds) },
            observationPeriodId: params.observationPeriodId,
            isCurrent: true,
          },
        });
        simulatedInspected = realObsCount > 0;
      }
    }

    // Audit
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "observatory.sector_view.generated",
      details: {
        sector: params.sector,
        strategyVersionId: params.strategyVersionId,
        programCount: programs.length,
        institutionCount: validInstitutions.length,
      },
      status: "ok",
    });

    return {
      sector: params.sector,
      institutions: institutionViews,
      totalPrograms: programs.length,
      totalIndicators: allIndicatorIds.size, // D8: deduplicated
      totalInstitutions: validInstitutions.length,
      aggregateObservability: {
        status: "not_computed" as const,
        reason:
          "per-indicator aggregate independence analysis not performed in sector view — " +
          "use getInstitutionalView or analyzeAggregateIndependence for detailed observability assessment",
      },
      honesty: {
        noCausalClaims: true as const,
        // CORRECTION 3: null when not inspected, NOT false
        simulatedData: simulatedInspected ? anySimulated : null,
        observabilityNotFabricated: true as const,
      },
    };
  });
}
