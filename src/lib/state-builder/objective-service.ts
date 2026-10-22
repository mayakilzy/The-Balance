// ============================================================
// objective-service.ts — Objective CRUD (tenant-scoped)
// ------------------------------------------------------------
// Mission 01-00: G01 Bootstrap + Country Pack Extension
//
// Objectives are human-defined goals for a country (e.g.,
// "reduce unemployment to 10% in 5 years"). They are PRIVATE
// (tenant-scoped) — a tenant's objectives are NEVER visible to
// other tenants (Correction A).
//
// Permissions (per §6 of the approved mission pack):
//   - createObjective: strategy:write (analyst + admin)
//   - listObjectives:  strategy:read  (all roles)
//
// Per ADR-0013. Reuses G00's withAuthenticatedTenant +
// requirePermissionWithCurrentRole (current DB role, not stale JWT).
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES
// ============================================================

export interface CreateObjectiveInput {
  countryId: string;
  title: string;
  description?: string;
  targetMetric: string;
  targetValue: string;
  horizon: number;
  status?: "draft" | "active" | "achieved" | "abandoned";
  metadata?: Record<string, unknown>;
}

export interface ObjectiveSummary {
  id: string;
  tenantId: string;
  countryId: string;
  title: string;
  description: string | null;
  targetMetric: string;
  targetValue: string;
  horizon: number;
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListObjectivesInput {
  countryId?: string;
  status?: string;
  limit?: number;
}

// ============================================================
// CREATE OBJECTIVE
// ============================================================

export async function createObjective(
  session: Session,
  input: CreateObjectiveInput
): Promise<{ objectiveId: string }> {
  // Permission check FIRST (uses CURRENT DB role, not stale JWT).
  // Per §6 of the approved mission pack: composer reuses strategy:write.
  // createObjective is a write operation → strategy:write.
  await requirePermissionWithCurrentRole(session, "strategy:write");

  // Validate input
  if (!input.countryId || input.countryId.length === 0) {
    throw new Error("countryId is required");
  }
  if (!input.title || input.title.trim().length === 0) {
    throw new Error("title is required");
  }
  if (!input.targetMetric || input.targetMetric.trim().length === 0) {
    throw new Error("targetMetric is required");
  }
  if (!input.targetValue || input.targetValue.trim().length === 0) {
    throw new Error("targetValue is required");
  }
  if (!Number.isInteger(input.horizon) || input.horizon < 1 || input.horizon > 100) {
    throw new Error("horizon must be an integer between 1 and 100 years");
  }

  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Verify the country exists (PUBLIC table — readable by all tenants).
    const country = await tx.country.findUnique({
      where: { id: input.countryId },
      select: { id: true, displayName: true },
    });
    if (!country) {
      throw new Error(`Country not found: ${input.countryId}`);
    }

    // Create the objective — RLS WITH CHECK enforces tenantId = current tenant.
    const objective = await tx.objective.create({
      data: {
        tenantId,
        countryId: input.countryId,
        title: input.title.trim(),
        description: input.description?.trim() ?? null,
        targetMetric: input.targetMetric.trim(),
        targetValue: input.targetValue.trim(),
        horizon: input.horizon,
        status: input.status ?? "draft",
        createdBy: userId,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    // Record a domain event (G00 events table — append-only timeline).
    // NOTE: This is a DOMAIN EVENT (timeline), NOT an audit_log entry.
    // Audit log entries are reserved for privileged/security-relevant actions
    // (like strategy approval in mission 01-10). Objective creation is a
    // regular write — the events table is the appropriate record.
    await tx.event.create({
      data: {
        tenantId,
        eventType: "objective.created",
        actor: userId,
        entityType: "objective",
        entityId: objective.id,
        metadata: {
          title: input.title,
          countryId: input.countryId,
          targetMetric: input.targetMetric,
          targetValue: input.targetValue,
          horizon: input.horizon,
        } as Prisma.InputJsonValue,
      },
    });

    return { objectiveId: objective.id };
  });
}

// ============================================================
// LIST OBJECTIVES (tenant-scoped)
// ============================================================

export async function listObjectives(
  session: Session,
  input: ListObjectivesInput = {}
): Promise<ObjectiveSummary[]> {
  // Read permission — all roles can list objectives.
  await requirePermissionWithCurrentRole(session, "strategy:read");

  // Cap limit to prevent unbounded queries.
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // RLS ensures only this tenant's objectives are visible.
    const where: Prisma.ObjectiveWhereInput = { tenantId };
    if (input.countryId) {
      where.countryId = input.countryId;
    }
    if (input.status) {
      where.status = input.status;
    }

    const objectives = await tx.objective.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return objectives.map((o) => ({
      id: o.id,
      tenantId: o.tenantId,
      countryId: o.countryId,
      title: o.title,
      description: o.description,
      targetMetric: o.targetMetric,
      targetValue: o.targetValue,
      horizon: o.horizon,
      status: o.status,
      createdBy: o.createdBy,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));
  });
}

// ============================================================
// GET OBJECTIVE BY ID (tenant-scoped)
// ============================================================

export async function getObjective(
  session: Session,
  objectiveId: string
): Promise<ObjectiveSummary | null> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // RLS ensures cross-tenant access returns null.
    const objective = await tx.objective.findFirst({
      where: { id: objectiveId, tenantId },
    });
    if (!objective) return null;

    return {
      id: objective.id,
      tenantId: objective.tenantId,
      countryId: objective.countryId,
      title: objective.title,
      description: objective.description,
      targetMetric: objective.targetMetric,
      targetValue: objective.targetValue,
      horizon: objective.horizon,
      status: objective.status,
      createdBy: objective.createdBy,
      createdAt: objective.createdAt,
      updatedAt: objective.updatedAt,
    };
  });
}
