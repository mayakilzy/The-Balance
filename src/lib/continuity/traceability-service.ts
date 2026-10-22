// ============================================================
// src/lib/continuity/traceability-service.ts
// ------------------------------------------------------------
// Delivery 03 — Historical traceability + strategy version history.
//
// Reuses: StrategyVersion (already has draft|approved|superseded
// status chain), Decision + DecisionEvent, AuditLog.
//
// Both functions are RLS-enforced via withAuthenticatedTenant +
// requirePermissionWithCurrentRole('strategy:read').
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import type { Session } from "next-auth";
import type { StrategyVersionHistoryEntry, HistoricalTraceEntry } from "./contracts";

/**
 * Get the full version history of a strategy, ordered by versionNumber DESC.
 * Includes status (draft|approved|superseded), approval metadata, and a
 * flag indicating the latest version.
 *
 * RLS-enforced: caller only ever sees versions in their current tenant.
 */
export async function getStrategyVersionHistory(
  session: Session | null,
  strategyId: string
): Promise<StrategyVersionHistoryEntry[]> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId }) => {
      // Verify the strategy belongs to the caller's tenant (no cross-tenant leak)
      const strategy = await tx.strategy.findFirst({
        where: { id: strategyId, tenantId },
        select: { id: true },
      });
      if (!strategy) {
        throw new Error(
          `Strategy ${strategyId} not found in tenant scope — ` +
            "cannot retrieve history for a strategy from another tenant"
        );
      }

      const versions = await tx.strategyVersion.findMany({
        where: { strategyId, tenantId },
        orderBy: { versionNumber: "desc" },
        select: {
          id: true,
          versionNumber: true,
          status: true,
          approvedBy: true,
          approvedAt: true,
          approvalNotes: true,
          metadata: true,
          createdBy: true,
          createdAt: true,
        },
      });

      const latestVersionNumber = versions[0]?.versionNumber ?? 0;
      return versions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        status: v.status,
        approvedBy: v.approvedBy,
        approvedAt: v.approvedAt,
        approvalNotes: v.approvalNotes,
        metadata: v.metadata as unknown as Record<string, unknown>,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        isLatest: v.versionNumber === latestVersionNumber,
      }));
    }
  );
}

/**
 * Get the full historical trace for a strategy or decision.
 *
 * Aggregates from:
 *   - audit_log (every action with prefix 'state-builder.' | 'reform.' | 'observatory.' | 'auth.')
 *   - decision_events (lifecycle events for a decision)
 *   - reform_proposals (status transitions + supersession)
 *   - reform_actions (status transitions + cancellation)
 *
 * Sorted by `at` ASC (chronological).
 *
 * RLS-enforced: only entries in the caller's tenant are returned.
 */
export async function getHistoricalTrace(
  session: Session | null,
  params: { strategyVersionId?: string; decisionId?: string }
): Promise<{
  focus: { strategyVersionId?: string; decisionId?: string };
  entries: HistoricalTraceEntry[];
}> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId }) => {
      // Validate that the requested focus belongs to the caller's tenant
      if (params.strategyVersionId) {
        const sv = await tx.strategyVersion.findFirst({
          where: { id: params.strategyVersionId, tenantId },
          select: { id: true, strategyId: true },
        });
        if (!sv) {
          throw new Error(
            `StrategyVersion ${params.strategyVersionId} not found in tenant scope`
          );
        }
      }
      if (params.decisionId) {
        const d = await tx.decision.findFirst({
          where: { id: params.decisionId, tenantId },
          select: { id: true },
        });
        if (!d) {
          throw new Error(
            `Decision ${params.decisionId} not found in tenant scope`
          );
        }
      }

      const entries: HistoricalTraceEntry[] = [];

      // 1. Decision events (if a decisionId focus is set)
      if (params.decisionId) {
        const decisionEvents = await tx.decisionEvent.findMany({
          where: { decisionId: params.decisionId, tenantId },
          orderBy: { at: "asc" },
          select: {
            id: true,
            eventType: true,
            actor: true,
            at: true,
            notes: true,
            metadata: true,
          },
        });
        for (const e of decisionEvents) {
          entries.push({
            at: e.at,
            action: `decision.${e.eventType}`,
            actor: e.actor,
            details: {
              notes: e.notes,
              ...(e.metadata as unknown as Record<string, unknown>),
            },
            status: "ok",
            source: "decision_event",
            refId: e.id,
          });
        }
      }

      // 2. Audit log entries that mention the focused IDs in their details JSONB
      //    or any continuity-relevant action verb in the tenant
      const auditActions = [
        "strategy.version.created",
        "strategy.version.approved",
        "decision.created",
        "decision.advanced",
        "reform.proposal.created",
        "reform.proposal.submitted",
        "reform.proposal.approved",
        "reform.proposal.rejected",
        "reform.proposal.superseded",
        "reform.action.created",
        "reform.action.started",
        "reform.action.completed",
        "reform.action.cancelled",
        "reform.verification.recorded",
        "observatory.alert.detected",
        "observatory.alert.reviewed",
        "observatory.alert.closed",
        "handover.dossier.generated",
        "handover.dossier.retrieved",
        "policy.impact.assessed",
      ];

      // Fetch audit_log entries for this tenant + relevant actions
      const auditEntries = await tx.auditLog.findMany({
        where: {
          tenantId,
          action: { in: auditActions },
        },
        orderBy: { at: "asc" },
        select: { id: true, at: true, action: true, actor: true, details: true, status: true },
        take: 500, // cap to avoid unbounded scan
      });

      // Filter: include entries whose details reference our focus IDs (if any)
      for (const a of auditEntries) {
        const details = a.details as unknown as Record<string, unknown>;
        const includeEntry =
          !params.strategyVersionId && !params.decisionId
            ? true // no focus set → include all
            : params.strategyVersionId
              ? JSON.stringify(details).includes(params.strategyVersionId)
              : JSON.stringify(details).includes(params.decisionId!);
        if (includeEntry) {
          entries.push({
            at: a.at,
            action: a.action,
            actor: a.actor,
            details,
            status: a.status,
            source: "audit_log",
            refId: a.id.toString(),
          });
        }
      }

      // 3. Reform proposals (status transitions — if strategyVersionId focus)
      if (params.strategyVersionId) {
        const proposals = await tx.reformProposal.findMany({
          where: { strategyVersionId: params.strategyVersionId, tenantId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            status: true,
            createdAt: true,
            submittedAt: true,
            approvedAt: true,
            rejectedAt: true,
            supersededAt: true,
            archivedAt: true,
            createdBy: true,
            title: true,
          },
        });
        for (const p of proposals) {
          entries.push({
            at: p.createdAt,
            action: "reform.proposal.created",
            actor: p.createdBy,
            details: { proposalId: p.id, title: p.title, status: p.status },
            status: "ok",
            source: "reform_proposal",
            refId: p.id,
          });
          if (p.submittedAt) {
            entries.push({
              at: p.submittedAt,
              action: "reform.proposal.submitted",
              actor: p.createdBy,
              details: { proposalId: p.id },
              status: "ok",
              source: "reform_proposal",
              refId: p.id,
            });
          }
          if (p.approvedAt) {
            entries.push({
              at: p.approvedAt,
              action: "reform.proposal.approved",
              actor: p.createdBy,
              details: { proposalId: p.id },
              status: "ok",
              source: "reform_proposal",
              refId: p.id,
            });
          }
          if (p.supersededAt) {
            entries.push({
              at: p.supersededAt,
              action: "reform.proposal.superseded",
              actor: p.createdBy,
              details: { proposalId: p.id },
              status: "ok",
              source: "reform_proposal",
              refId: p.id,
            });
          }
        }
      }

      // Sort all entries by `at` ASC
      entries.sort((a, b) => a.at.getTime() - b.at.getTime());

      return {
        focus: {
          strategyVersionId: params.strategyVersionId,
          decisionId: params.decisionId,
        },
        entries,
      };
    }
  );
}

/**
 * List decisions, optionally filtered by strategyVersionId / status.
 *
 * RLS-enforced via withAuthenticatedTenant + requirePermissionWithCurrentRole('strategy:read').
 */
export async function listDecisions(
  session: Session | null,
  filter?: {
    strategyVersionId?: string;
    status?: string;
    limit?: number;
  }
): Promise<
  Array<{
    id: string;
    title: string;
    rationale: string;
    status: string;
    decidedBy: string;
    decidedAt: Date;
    strategyVersionId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId }) => {
      const where: Record<string, unknown> = { tenantId };
      if (filter?.strategyVersionId)
        where.strategyVersionId = filter.strategyVersionId;
      if (filter?.status) where.status = filter.status;
      const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);

      return tx.decision.findMany({
        where,
        orderBy: { decidedAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          rationale: true,
          status: true,
          decidedBy: true,
          decidedAt: true,
          strategyVersionId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }
  );
}
