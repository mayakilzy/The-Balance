// ============================================================
// state-observatory/observation-service.ts
// ------------------------------------------------------------
// Per REV-5 FINAL CORRECTED MISSION:
//   - R1: originType (observed|derived|synthetic) SEPARATE FROM verificationStatus
//   - R4: corrections are append-only (supersedesId + isCurrent)
//   - E2: atomic correction transaction (lock → deactivate → create → link → audit)
//   - E3: cross-country geoRefId rejected
//   - F2: correctObservation order enforced
//   - F3: chain integrity trigger enforces anti-branching
//   - writeAuditTx atomic for all operations
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import {
  IngestObservationInputSchema,
  CorrectionInputSchema,
  type IngestObservationInput,
  type CorrectionInput,
  type Observation,
  NotFoundError,
  ConflictError,
} from "./contracts";
import { validateObservationProvenance } from "./provenance-validator";
import { verifyEvidenceCountryScope } from "./evidence-country-validator";

/**
 * Ingest a new observation.
 *
 * Validations:
 *   - originType=observed → sourceId required (Zod)
 *   - originType=derived → derivationMethod required (Zod)
 *   - isSynthetic=true → Demolandia marker in metadata
 *   - strategyVersionId must be approved in same tenant
 *   - geoRefId cross-country check (E3) — geoLevel="institutional" must reference
 *     an Institution whose countryId matches the tenant's countryId
 *   - Atomic via writeAuditTx
 */
export async function ingestObservation(
  session: Session | null,
  input: IngestObservationInput
): Promise<Observation> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:observation:ingest"
  );

  const parsed = IngestObservationInputSchema.parse(input);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Verify indicator belongs to this tenant
      const indicator = await tx.indicatorDefinition.findFirst({
        where: {
          id: parsed.indicatorDefinitionId,
          tenantId,
        },
      });
      if (!indicator) {
        throw new NotFoundError(
          `Indicator ${parsed.indicatorDefinitionId} not found in tenant ${tenantId}`
        );
      }

      // Verify observation period belongs to this tenant
      const period = await tx.observationPeriod.findFirst({
        where: {
          id: parsed.observationPeriodId,
          tenantId,
        },
      });
      if (!period) {
        throw new NotFoundError(
          `Observation period ${parsed.observationPeriodId} not found in tenant ${tenantId}`
        );
      }

      // If strategyVersionId provided, verify it's approved in same tenant
      if (parsed.strategyVersionId) {
        const sv = await tx.strategyVersion.findFirst({
          where: {
            id: parsed.strategyVersionId,
            tenantId,
            status: "approved",
          },
          select: { id: true },
        });
        if (!sv) {
          throw new Error(
            `StrategyVersion ${parsed.strategyVersionId} not found or not approved`
          );
        }
      }

      // E3: cross-country geoRefId check
      if (parsed.geoRefId && parsed.geoLevel === "institutional") {
        await verifyInstitutionInTenantCountry(tx, tenantId, parsed.geoRefId);
      }

      // 02-01: Provenance + country scope validation BEFORE INSERT
      // Load source (if sourceId provided) — Source is PUBLIC G00 table
      let sourceRow: {
        id: string;
        reviewStatus: string;
        independenceGroup: string | null;
        submittedByTenantId: string | null;
      } | null = null;
      if (parsed.sourceId) {
        sourceRow = await tx.source.findUnique({
          where: { id: parsed.sourceId },
          select: {
            id: true,
            reviewStatus: true,
            independenceGroup: true,
            submittedByTenantId: true,
          },
        });
        if (!sourceRow) {
          throw new NotFoundError(
            `Source ${parsed.sourceId} not found`
          );
        }
      }

      // Load evidence (if evidenceId provided) — RLS-enforced (filters cross-tenant)
      let evidenceRow: {
        id: string;
        tenantId: string;
        sourceId: string | null;
        verificationStatus: string;
        type: string;
        metadata: unknown;
      } | null = null;
      if (parsed.evidenceId) {
        evidenceRow = await tx.evidence.findFirst({
          where: { id: parsed.evidenceId, tenantId },
          select: {
            id: true,
            tenantId: true,
            sourceId: true,
            verificationStatus: true,
            type: true,
            metadata: true,
          },
        });
        // If evidenceId provided but evidence not found in tenant — let validator handle
      }

      // Get tenant's countryId for country scope check
      const tenantRow = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { countryId: true },
      });
      if (!tenantRow) {
        throw new NotFoundError(`Tenant ${tenantId} not found`);
      }

      // Run provenance validation (pure function)
      const provenanceResult = validateObservationProvenance(
        {
          originType: parsed.originType,
          verificationStatus: parsed.verificationStatus ?? "unverified",
          sourceId: parsed.sourceId ?? null,
          evidenceId: parsed.evidenceId ?? null,
          derivationMethod: parsed.derivationMethod ?? null,
          isSynthetic: parsed.isSynthetic ?? true,
        },
        {
          source: sourceRow,
          evidence: evidenceRow,
          sessionTenantId: tenantId,
          tenantCountryId: tenantRow.countryId,
        }
      );

      if (!provenanceResult.valid) {
        throw new Error(
          `Provenance validation failed: ${provenanceResult.errors.join("; ")}`
        );
      }

      // Country scope check (if evidenceId provided)
      if (parsed.evidenceId && evidenceRow) {
        const countryResult = verifyEvidenceCountryScope({
          evidenceMetadata: evidenceRow.metadata,
          tenantCountryId: tenantRow.countryId,
        });
        if (!countryResult.valid) {
          throw new Error(
            `Evidence country scope violation: ${countryResult.reason}`
          );
        }
      }

      // Build metadata with isSynthetic marker (E6) + validation warnings
      const metadata: Record<string, unknown> = {
        ...(parsed.qualityNotes ?? {}),
        isSynthetic: parsed.isSynthetic ?? true,
        syntheticCountry: parsed.isSynthetic === false ? null : "DML",
        // 02-01: attach non-blocking provenance warnings
        provenanceWarnings: provenanceResult.warnings,
      };

      // Create the observation
      const observation = await tx.observation.create({
        data: {
          tenantId,
          indicatorDefinitionId: parsed.indicatorDefinitionId,
          observationPeriodId: parsed.observationPeriodId,
          strategyVersionId: parsed.strategyVersionId ?? null,
          observedValue: parsed.observedValue,
          originType: parsed.originType,
          verificationStatus: parsed.verificationStatus ?? "unverified",
          derivationMethod: parsed.derivationMethod ?? null,
          sourceId: parsed.sourceId ?? null,
          evidenceId: parsed.evidenceId ?? null,
          isSynthetic: parsed.isSynthetic ?? true,
          observedAt: parsed.observedAt ?? null,
          qualityNotes: metadata as Prisma.InputJsonValue,
          geoLevel: parsed.geoLevel ?? "national",
          geoRefId: parsed.geoRefId ?? null,
          isCurrent: true,
          createdBy: userId,
        },
      });

      // Atomic audit log
      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "observatory.observation.ingested",
        details: {
          observationId: observation.id,
          indicatorId: parsed.indicatorDefinitionId,
          periodId: parsed.observationPeriodId,
          originType: parsed.originType,
          isSynthetic: parsed.isSynthetic ?? true,
        },
        status: "ok",
      });

      return observation;
    }
  );
}

/**
 * F2 ATOMIC CORRECTION TRANSACTION — exact order:
 *   1. withAuthenticatedTenant (begin tx)
 *   2. SELECT ... FOR UPDATE on the current observation (is_current=TRUE)
 *      — if not found: NotFoundError
 *      — if superseded_by_id IS NOT NULL: ConflictError('already superseded')
 *   3. UPDATE observations SET is_current = FALSE WHERE id = $observationId
 *      — releases the unique slot in observations_one_current_idx
 *   4. INSERT new observation (supersedes_id = $observationId, is_current = TRUE)
 *      — trigger F3 enforces: target.superseded_by_id IS NULL (no branching) → passes
 *      — partial unique index allows new row (old is_current is now FALSE)
 *   5. UPDATE observations SET superseded_by_id = $newId WHERE id = $observationId
 *      — completes the bidirectional link
 *   6. writeAuditTx
 *   7. COMMIT (or ROLLBACK on any error)
 *
 * The SELECT FOR UPDATE ensures concurrent corrections serialize:
 *   Tx2 blocks on FOR UPDATE until Tx1 commits, then sees
 *   superseded_by_id IS NOT NULL → ConflictError.
 */
export async function correctObservation(
  session: Session | null,
  observationId: string,
  correction: CorrectionInput
): Promise<Observation> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:observation:ingest"
  );

  const parsed = CorrectionInputSchema.parse(correction);

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // F2 step 2: SELECT FOR UPDATE on the current observation
      // Use $queryRaw for FOR UPDATE (Prisma doesn't have a native API)
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          indicatorDefinitionId: string;
          observationPeriodId: string;
          geoLevel: string;
          geoRefId: string | null;
          isCurrent: boolean;
          supersededById: string | null;
          originType: string;
          sourceId: string | null;
          derivationMethod: string | null;
          strategyVersionId: string | null;
        }>
      >`
        SELECT "id", "tenantId", "indicatorDefinitionId", "observationPeriodId",
               "geoLevel", "geoRefId", "isCurrent", "supersededById",
               "originType", "sourceId", "derivationMethod", "strategyVersionId"
        FROM "observations"
        WHERE "id" = ${observationId}
          AND "tenantId" = ${tenantId}
          AND "isCurrent" = TRUE
        FOR UPDATE
      `;

      if (rows.length === 0) {
        throw new NotFoundError(
          `Current observation ${observationId} not found in tenant ${tenantId}`
        );
      }

      const current = rows[0]!;
      // F2: if already superseded, conflict
      if (current.supersededById !== null) {
        throw new ConflictError(
          `Observation ${observationId} already superseded (cannot correct a non-current observation)`
        );
      }

      // F2 step 3: deactivate old current observation
      // (releases the unique slot in observations_one_current_idx)
      await tx.observation.update({
        where: { id: observationId },
        data: { isCurrent: false },
      });

      // F2 step 4: insert new observation (the corrected version)
      // Trigger F3 will verify target.superseded_by_id IS NULL (passes here)
      // Partial unique index allows new row because old is_current is now false
      const newOriginType = parsed.originType ?? current.originType;
      const newSourceId = parsed.sourceId ?? current.sourceId;
      const newDerivationMethod =
        parsed.derivationMethod ?? current.derivationMethod;

      const newObservation = await tx.observation.create({
        data: {
          tenantId,
          indicatorDefinitionId: current.indicatorDefinitionId,
          observationPeriodId: current.observationPeriodId,
          strategyVersionId: current.strategyVersionId,
          observedValue: parsed.newValue,
          originType: newOriginType,
          verificationStatus: "unverified", // corrections reset verification
          derivationMethod: newDerivationMethod,
          sourceId: newSourceId,
          isSynthetic: true, // corrections in 02-00 stay synthetic (Demolandia)
          geoLevel: current.geoLevel,
          geoRefId: current.geoRefId,
          supersedesId: observationId,
          correctionReason: parsed.reason,
          correctedById: userId,
          correctedAt: new Date(),
          isCurrent: true,
          createdBy: userId,
        },
      });

      // F2 step 5: complete the bidirectional link
      // (set superseded_by_id on the old observation)
      await tx.observation.update({
        where: { id: observationId },
        data: { supersededById: newObservation.id },
      });

      // F2 step 6: atomic audit log
      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "observatory.observation.corrected",
        details: {
          oldObservationId: observationId,
          newObservationId: newObservation.id,
          reason: parsed.reason,
          newValue: parsed.newValue,
        },
        status: "ok",
      });

      // F2 step 7: commit (withAuthenticatedTenant handles this)
      return newObservation;
    }
  );
}

/**
 * List observations. By default, only current (is_current=true) rows are returned.
 * Pass includeHistory=true to also see superseded rows.
 */
export async function listObservations(
  session: Session | null,
  filter: {
    indicatorDefinitionId?: string;
    observationPeriodId?: string;
    includeHistory?: boolean;
  }
): Promise<Observation[]> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:observation:read"
  );

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const where: {
      tenantId: string;
      indicatorDefinitionId?: string;
      observationPeriodId?: string;
      isCurrent?: boolean;
    } = { tenantId };
    if (filter.indicatorDefinitionId) {
      where.indicatorDefinitionId = filter.indicatorDefinitionId;
    }
    if (filter.observationPeriodId) {
      where.observationPeriodId = filter.observationPeriodId;
    }
    if (!filter.includeHistory) {
      where.isCurrent = true;
    }
    const observations = await tx.observation.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    return observations;
  });
}

/**
 * Get the current observation for a given (indicator, period, geo) tuple.
 * Returns null if no current observation exists.
 */
export async function getCurrentObservation(
  session: Session | null,
  params: {
    indicatorId: string;
    periodId: string;
    geoLevel?: string;
    geoRefId?: string;
  }
): Promise<Observation | null> {
  await requirePermissionWithCurrentRole(
    session,
    "observatory:observation:read"
  );

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const where: {
      tenantId: string;
      indicatorDefinitionId: string;
      observationPeriodId: string;
      isCurrent: boolean;
      geoLevel?: string;
      geoRefId?: string;
    } = {
      tenantId,
      indicatorDefinitionId: params.indicatorId,
      observationPeriodId: params.periodId,
      isCurrent: true,
    };
    if (params.geoLevel) where.geoLevel = params.geoLevel;
    if (params.geoRefId) where.geoRefId = params.geoRefId;

    const obs = await tx.observation.findFirst({ where });
    return obs ?? null;
  });
}

// ------------------------------------------------------------
// E3: cross-country geoRefId verification
// ------------------------------------------------------------

async function verifyInstitutionInTenantCountry(
  tx: Prisma.TransactionClient,
  tenantId: string,
  institutionId: string
): Promise<void> {
  // Get tenant's countryId
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { countryId: true },
  });
  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  // Look up the institution (PUBLIC table — accessible without tenant scope)
  const institution = await tx.institution.findUnique({
    where: { id: institutionId },
    select: { countryId: true },
  });

  if (!institution) {
    throw new Error(`Institution ${institutionId} not found`);
  }

  if (institution.countryId !== tenant.countryId) {
    throw new Error(
      `E3 violation: Institution ${institutionId} belongs to country ${institution.countryId}, ` +
        `but tenant ${tenantId} belongs to country ${tenant.countryId}. ` +
        `Cross-country geoRefId references are forbidden.`
    );
  }
}
