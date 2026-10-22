// ============================================================
// src/lib/continuity/handover-dossier-service.ts
// ------------------------------------------------------------
// Delivery 03 — Government handover dossier generation + retrieval.
//
// Aggregates from existing tables (NO raw Prisma in route handlers —
// keeps the trust boundary intact):
//   - Strategy + StrategyVersion (active approved versions)
//   - Decision (lifecycle: approved/implemented/reversed)
//   - ReformAction (outstanding obligations = actions not completed)
//   - AuditLog (recent highlights for traceability)
//
// Persists to HandoverDossier (new table, migration 0033) — content
// is IMMUTABLE post-publication (DB-level trigger blocks mutation).
//
// RLS-enforced: caller only sees dossiers in their current tenant.
//
// Permissions:
//   - generate: requires strategy:approve (reviewer/admin — must be
//     authorized to certify the dossier's contents)
//   - list/get: requires strategy:read (any authorized user can
//     retrieve — e.g., an incoming administration's authorized analyst)
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import { NotFoundError } from "@/lib/reform/contracts";
import type { Session } from "next-auth";
import type { HandoverDossierContent } from "./contracts";

/**
 * Generate a handover dossier. Persists a snapshot to handover_dossiers.
 *
 * Aggregation rules (per owner directive):
 *   - include active approved strategy versions (latest per strategy)
 *   - include all decisions (with status, decidedBy, evidence counts)
 *   - include outstanding obligations (reform actions not completed)
 *   - include audit highlights (recent continuity-relevant actions)
 *
 * Honesty label: "descriptive" — explicitly says we are NOT making
 * causal claims. The dossier is a SNAPSHOT, not a recommendation.
 */
export async function generateHandoverDossier(
  session: Session | null,
  input: {
    title: string;
    scope: {
      asOfDate?: string;
      strategyVersionIds?: string[];
      decisionIds?: string[];
      proposalIds?: string[];
      includeActiveStrategies?: boolean;
      includeOutstandingObligations?: boolean;
      includeAuditHighlights?: boolean;
    };
  }
): Promise<{
  dossierId: string;
  generatedAt: Date;
  content: HandoverDossierContent;
}> {
  await requirePermissionWithCurrentRole(session, "strategy:approve");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // ============================================================
      // 1. STRATEGIES (active approved latest versions per strategy)
      // ============================================================
      const includeActive =
        input.scope.includeActiveStrategies !== false;
      let strategies: Array<{
        strategyId: string;
        title: string;
        latestVersion: {
          id: string;
          versionNumber: number;
          status: string;
          approvedAt: Date | null;
        };
        decisionCount: number;
        programCount: number;
      }> = [];

      if (includeActive) {
        // Find all strategies in this tenant
        const allStrategies = await tx.strategy.findMany({
          where: { tenantId },
          select: {
            id: true,
            title: true,
            versions: {
              orderBy: { versionNumber: "desc" },
              take: 1,
              select: {
                id: true,
                versionNumber: true,
                status: true,
                approvedAt: true,
              },
            },
          },
        });

        for (const s of allStrategies) {
          const latest = s.versions[0];
          if (!latest) continue;
          // Filter by scope.strategyVersionIds if provided
          if (
            input.scope.strategyVersionIds &&
            input.scope.strategyVersionIds.length > 0 &&
            !input.scope.strategyVersionIds.includes(latest.id)
          ) {
            continue;
          }
          // Only include versions that are approved or superseded (active in the
          // sense of having been adopted at some point — drafts are excluded)
          if (latest.status === "draft") continue;

          const decisionCount = await tx.decision.count({
            where: { tenantId, strategyVersionId: latest.id },
          });
          const programCount = await tx.program.count({
            where: { tenantId, strategyVersionId: latest.id },
          });

          strategies.push({
            strategyId: s.id,
            title: s.title,
            latestVersion: latest,
            decisionCount,
            programCount,
          });
        }
      }

      // ============================================================
      // 2. DECISIONS
      // ============================================================
      const decisionFilter: Record<string, unknown> = { tenantId };
      if (
        input.scope.decisionIds &&
        input.scope.decisionIds.length > 0
      ) {
        decisionFilter.id = { in: input.scope.decisionIds };
      }
      const decisions = await tx.decision.findMany({
        where: decisionFilter,
        orderBy: { decidedAt: "desc" },
        take: 200,
        select: {
          id: true,
          title: true,
          status: true,
          decidedBy: true,
          decidedAt: true,
          rationale: true,
          supportingEvidence: true,
          counterEvidence: true,
        },
      });
      const decisionSummaries = decisions.map((d) => {
        const sup = Array.isArray(d.supportingEvidence)
          ? (d.supportingEvidence as unknown as unknown[])
          : [];
        const cnt = Array.isArray(d.counterEvidence)
          ? (d.counterEvidence as unknown as unknown[])
          : [];
        return {
          id: d.id,
          title: d.title,
          status: d.status,
          decidedBy: d.decidedBy,
          decidedAt: d.decidedAt,
          rationaleExcerpt:
            d.rationale.length > 200
              ? d.rationale.substring(0, 197) + "..."
              : d.rationale,
          evidenceCount: { supporting: sup.length, counter: cnt.length },
        };
      });

      // ============================================================
      // 3. OUTSTANDING OBLIGATIONS (reform actions not completed)
      // ============================================================
      const includeObligations =
        input.scope.includeOutstandingObligations !== false;
      let obligations: Array<{
        id: string;
        kind: "reform_action";
        title: string;
        status: string;
        progressPercentage: number;
        dueDate: Date | null;
        proposalId: string;
      }> = [];

      if (includeObligations) {
        const actions = await tx.reformAction.findMany({
          where: {
            tenantId,
            // Outstanding = anything that's not completed or cancelled
            status: { notIn: ["completed", "cancelled"] },
          },
          orderBy: { dueDate: "asc" },
          take: 200,
          select: {
            id: true,
            title: true,
            status: true,
            progressPercentage: true,
            dueDate: true,
            proposalId: true,
          },
        });
        obligations = actions.map((a) => ({
          id: a.id,
          kind: "reform_action",
          title: a.title,
          status: a.status,
          progressPercentage: a.progressPercentage,
          dueDate: a.dueDate,
          proposalId: a.proposalId,
        }));
      }

      // ============================================================
      // 4. AUDIT HIGHLIGHTS (recent continuity-relevant actions)
      // ============================================================
      const includeAudit = input.scope.includeAuditHighlights !== false;
      let auditHighlights: Array<{
        at: Date;
        action: string;
        actor: string;
        status: string;
      }> = [];

      if (includeAudit) {
        const auditActions = [
          "strategy.version.approved",
          "decision.created",
          "decision.advanced",
          "reform.proposal.approved",
          "reform.proposal.superseded",
          "reform.action.completed",
          "reform.action.cancelled",
          "observatory.alert.closed",
        ];
        const audit = await tx.auditLog.findMany({
          where: {
            tenantId,
            action: { in: auditActions },
          },
          orderBy: { at: "desc" },
          take: 100,
          select: { at: true, action: true, actor: true, status: true },
        });
        auditHighlights = audit.map((a) => ({
          at: a.at,
          action: a.action,
          actor: a.actor,
          status: a.status,
        }));
      }

      // ============================================================
      // 5. BUILD CONTENT
      // ============================================================
      const generatedAt = new Date();
      const content: HandoverDossierContent = {
        generatedAt,
        asOfDate: input.scope.asOfDate ?? null,
        strategies,
        decisions: decisionSummaries,
        obligations,
        auditHighlights,
        counts: {
          strategies: strategies.length,
          decisions: decisionSummaries.length,
          obligations: obligations.length,
          auditEntries: auditHighlights.length,
        },
        honesty: {
          scope: "descriptive",
          notes:
            "This dossier is a SNAPSHOT of institutional state as of the " +
            "generatedAt timestamp. It is descriptive — no causal claims " +
            "about policy outcomes are made. Outstanding obligations are " +
            "reform actions not yet completed or cancelled; their feasibility " +
            "must be assessed independently by the incoming administration.",
        },
      };

      // ============================================================
      // 6. PERSIST TO handover_dossiers
      // ============================================================
      const dossier = await tx.handoverDossier.create({
        data: {
          tenantId,
          title: input.title,
          scope: input.scope as object,
          content: content as object,
          generatedBy: userId,
          generatedAt,
          status: "published",
        },
        select: { id: true },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "handover.dossier.generated",
        details: {
          dossierId: dossier.id,
          title: input.title,
          counts: content.counts,
        },
        status: "ok",
      });

      return { dossierId: dossier.id, generatedAt, content };
    }
  );
}

/**
 * List handover dossiers in the caller's tenant (most recent first).
 *
 * RLS-enforced: caller only sees dossiers in their current tenant.
 * Returns metadata (no content) — use getHandoverDossier for full content.
 */
export async function listHandoverDossiers(
  session: Session | null,
  filter?: { status?: string; limit?: number }
): Promise<
  Array<{
    id: string;
    title: string;
    status: string;
    generatedBy: string;
    generatedAt: Date;
    retrievalCount: number;
    retrievedBy: string | null;
    retrievedAt: Date | null;
  }>
> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId }) => {
      const where: Record<string, unknown> = { tenantId };
      if (filter?.status) where.status = filter.status;
      const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);

      return tx.handoverDossier.findMany({
        where,
        orderBy: { generatedAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          status: true,
          generatedBy: true,
          generatedAt: true,
          retrievalCount: true,
          retrievedBy: true,
          retrievedAt: true,
        },
      });
    }
  );
}

/**
 * Retrieve a single handover dossier by id.
 *
 * RLS-enforced: NotFoundError (→ 404) if not in the caller's tenant
 * (does NOT leak cross-tenant existence).
 *
 * Updates the retrieval-tracking columns (retrievedBy, retrievedAt,
 * retrievalCount) atomically — content remains immutable (DB trigger
 * blocks any content mutation on published dossiers).
 */
export async function getHandoverDossier(
  session: Session | null,
  dossierId: string
): Promise<{
  id: string;
  title: string;
  scope: unknown;
  content: HandoverDossierContent;
  generatedBy: string;
  generatedAt: Date;
  status: string;
  retrievalCount: number;
  retrievedBy: string | null;
  retrievedAt: Date | null;
}> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      const existing = await tx.handoverDossier.findFirst({
        where: { id: dossierId, tenantId },
      });
      if (!existing) {
        throw new NotFoundError(`Handover dossier ${dossierId} not found`);
      }

      // Update retrieval tracking (content is IMMUTABLE — DB trigger blocks any
      // content mutation. Only retrieval-tracking columns are allowed.)
      const updated = await tx.handoverDossier.update({
        where: { id: dossierId },
        data: {
          retrievedBy: userId,
          retrievedAt: new Date(),
          retrievalCount: { increment: 1 },
        },
      });

      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "handover.dossier.retrieved",
        details: { dossierId, newRetrievalCount: updated.retrievalCount },
        status: "ok",
      });

      return {
        id: updated.id,
        title: updated.title,
        scope: updated.scope,
        content: updated.content as unknown as HandoverDossierContent,
        generatedBy: updated.generatedBy,
        generatedAt: updated.generatedAt,
        status: updated.status,
        retrievalCount: updated.retrievalCount,
        retrievedBy: updated.retrievedBy,
        retrievedAt: updated.retrievedAt,
      };
    }
  );
}
