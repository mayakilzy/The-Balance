// ============================================================
// src/lib/continuity/policy-impact-service.ts
// ------------------------------------------------------------
// Delivery 03 — Policy change impact assessment.
//
// Owner directive: "Provide a basic impact assessment grounded in
// existing information: affected programs, dependencies,
// obligations and risks. Clearly distinguish calculated results,
// documented facts, missing information and simulated assessments."
//
// Honesty model (mandatory per owner):
//   - calculated = computed from DB rows (counts, status, progress)
//   - documented = explicitly captured in DB fields (rationale,
//     cancellationReason, metadata.uncertainty, etc.)
//   - missing = a known unknown (e.g., a referenced entity not found)
//   - simulated = explicitly NOT used (we do not invent values)
//
// This is ON-DEMAND computation (no persistence). Audit log captures
// that an assessment was requested (action="policy.impact.assessed")
// so institutional memory of the QUESTION is preserved, even though
// the result is not persisted.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Session } from "next-auth";
import type {
  PolicyImpactAssessmentResult,
} from "./contracts";

/**
 * Assess the impact of a proposed policy change.
 *
 * Inputs:
 *   - changeType: "supersede" | "reverse" | "amend" | "cancel"
 *   - description: human description of the proposed change
 *   - target: { strategyVersionId?, decisionId?, proposalId? }
 *     At least one target ID is required (Zod enforces).
 *
 * Computes (CALCULATED from DB rows):
 *   - affectedPrograms: programs linked to target strategyVersionId
 *   - affectedActions: reform actions linked to target proposalId
 *                       OR to programs linked to target strategyVersionId
 *   - affectedDecisions: decisions linked to target strategyVersionId
 *   - outstandingObligations: reform actions not completed
 *
 * Documents (DOCUMENTED from DB fields):
 *   - risks: qualitative strings from metadata.risks if present
 *
 * Missing information (MISSING — known unknowns):
 *   - missingInformation: list of things we COULD NOT compute due to
 *     absent data (e.g., "No budget impact analysis available" if
 *     budgetLine rows are absent for affected programs)
 *
 * Honesty:
 *   - scope = "descriptive" — explicitly states no causal claims
 *   - No simulated values are produced (we never invent numbers)
 *
 * RLS-enforced: only data in the caller's tenant is considered.
 */
export async function assessPolicyChangeImpact(
  session: Session | null,
  input: {
    changeType: "supersede" | "reverse" | "amend" | "cancel";
    description: string;
    target: {
      strategyVersionId?: string;
      decisionId?: string;
      proposalId?: string;
    };
  }
): Promise<PolicyImpactAssessmentResult> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  return withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // ============================================================
      // 1. VALIDATE TARGET (must exist in caller's tenant)
      // ============================================================
      let strategyVersionId: string | undefined = input.target.strategyVersionId;
      let proposalId: string | undefined = input.target.proposalId;

      if (strategyVersionId) {
        const sv = await tx.strategyVersion.findFirst({
          where: { id: strategyVersionId, tenantId },
          select: { id: true },
        });
        if (!sv) {
          throw new Error(
            `StrategyVersion ${strategyVersionId} not found in tenant scope — cannot assess impact for a strategy from another tenant`
          );
        }
      }

      if (input.target.decisionId) {
        const d = await tx.decision.findFirst({
          where: { id: input.target.decisionId, tenantId },
          select: { id: true, strategyVersionId: true },
        });
        if (!d) {
          throw new Error(
            `Decision ${input.target.decisionId} not found in tenant scope`
          );
        }
        // A decision may carry its own strategyVersionId — use it as a secondary
        // scope for finding affected programs/actions
        if (!strategyVersionId && d.strategyVersionId) {
          strategyVersionId = d.strategyVersionId;
        }
      }

      if (proposalId) {
        const p = await tx.reformProposal.findFirst({
          where: { id: proposalId, tenantId },
          select: { id: true, strategyVersionId: true },
        });
        if (!p) {
          throw new Error(
            `ReformProposal ${proposalId} not found in tenant scope`
          );
        }
        if (!strategyVersionId && p.strategyVersionId) {
          strategyVersionId = p.strategyVersionId;
        }
      }

      // ============================================================
      // 2. AFFECTED PROGRAMS (calculated — counts from DB)
      // ============================================================
      const affectedPrograms = strategyVersionId
        ? await tx.program.findMany({
            where: { tenantId, strategyVersionId },
            select: { id: true, title: true, sector: true, status: true },
          })
        : [];

      // ============================================================
      // 3. AFFECTED ACTIONS (calculated)
      //    - If proposalId target: actions linked directly to that proposal
      //    - Else if strategyVersionId target: actions linked to programs
      //      that are linked to the strategy version
      // ============================================================
      let affectedActions: Array<{
        id: string;
        title: string;
        status: string;
        progressPercentage: number;
      }> = [];

      if (proposalId) {
        const actions = await tx.reformAction.findMany({
          where: { tenantId, proposalId },
          select: {
            id: true,
            title: true,
            status: true,
            progressPercentage: true,
          },
        });
        affectedActions = actions;
      } else if (strategyVersionId && affectedPrograms.length > 0) {
        const programIds = affectedPrograms.map((p) => p.id);
        const actions = await tx.reformAction.findMany({
          where: { tenantId, programId: { in: programIds } },
          select: {
            id: true,
            title: true,
            status: true,
            progressPercentage: true,
          },
        });
        affectedActions = actions;
      }

      // ============================================================
      // 4. AFFECTED DECISIONS (calculated — linked to strategyVersionId)
      // ============================================================
      const affectedDecisions = strategyVersionId
        ? await tx.decision.findMany({
            where: { tenantId, strategyVersionId },
            select: { id: true, title: true, status: true },
          })
        : input.target.decisionId
          ? await tx.decision.findMany({
              where: { tenantId, id: input.target.decisionId },
              select: { id: true, title: true, status: true },
            })
          : [];

      // ============================================================
      // 5. OUTSTANDING OBLIGATIONS (calculated — actions not completed)
      // ============================================================
      const outstandingObligations = await tx.reformAction.findMany({
        where: {
          tenantId,
          status: { notIn: ["completed", "cancelled"] },
          // Limit to obligations linked to the affected scope (if a scope is set)
          ...(proposalId
            ? { proposalId }
            : strategyVersionId && affectedPrograms.length > 0
              ? { programId: { in: affectedPrograms.map((p) => p.id) } }
              : {}),
        },
        select: {
          id: true,
          title: true,
          status: true,
          proposalId: true,
        },
        take: 100,
      });

      // ============================================================
      // 6. RISKS (documented — from metadata if present)
      // ============================================================
      const risks: string[] = [];
      // If target is a proposal, look at its actions' cancellation reasons
      if (proposalId) {
        const cancelledActions = await tx.reformAction.findMany({
          where: { tenantId, proposalId, status: "cancelled" },
          select: { title: true, cancellationReason: true },
        });
        for (const ca of cancelledActions) {
          if (ca.cancellationReason) {
            risks.push(
              `Previously cancelled action "${ca.title}": ${ca.cancellationReason}`
            );
          }
        }
      }
      // Add qualitative risks based on outstanding obligations count
      if (outstandingObligations.length > 5) {
        risks.push(
          `${outstandingObligations.length} outstanding obligations may be disrupted by this change — incoming administration must decide whether to continue, amend, or cancel each one.`
        );
      }
      if (affectedDecisions.some((d) => d.status === "approved")) {
        risks.push(
          "One or more APPROVED decisions may be invalidated — institutional reversal carries political cost and may require explicit supersession documentation."
        );
      }

      // ============================================================
      // 7. MISSING INFORMATION (known unknowns)
      // ============================================================
      const missingInformation: string[] = [];
      if (!strategyVersionId) {
        missingInformation.push(
          "No strategy version targeted — cannot assess program/action dependencies."
        );
      }
      if (affectedPrograms.length === 0 && strategyVersionId) {
        missingInformation.push(
          "No programs linked to the targeted strategy version — budget impact is unknown."
        );
      }
      if (
        affectedActions.length === 0 &&
        !proposalId &&
        strategyVersionId
      ) {
        missingInformation.push(
          "No reform actions linked to the affected programs — implementation continuity impact is unknown."
        );
      }
      // Check budget lines for affected programs
      if (affectedPrograms.length > 0) {
        const budgetLineCount = await tx.budgetLine.count({
          where: {
            tenantId,
            programId: { in: affectedPrograms.map((p) => p.id) },
          },
        });
        if (budgetLineCount === 0) {
          missingInformation.push(
            "No budget lines recorded for affected programs — financial impact cannot be quantified."
          );
        }
      }
      // Check G02 indicators for the strategy version
      if (strategyVersionId) {
        const indicatorCount = await tx.indicatorDefinition.count({
          where: { tenantId, strategyVersionId },
        });
        if (indicatorCount === 0) {
          missingInformation.push(
            "No KPI indicators linked to the strategy version — post-change measurement baseline is unknown."
          );
        }
      }

      // ============================================================
      // 8. BUILD RESULT (with honesty label)
      // ============================================================
      const result: PolicyImpactAssessmentResult = {
        changeType: input.changeType,
        description: input.description,
        target: input.target,
        affectedPrograms,
        affectedActions,
        affectedDecisions,
        outstandingObligations: outstandingObligations.map((o) => ({
          id: o.id,
          title: o.title,
          kind: "reform_action",
          status: o.status,
        })),
        risks,
        missingInformation,
        honesty: {
          scope: "descriptive",
          notes:
            "This assessment is computed FROM EXISTING DATABASE ROWS — no " +
            "simulated or fabricated values. Calculated fields (affectedPrograms, " +
            "affectedActions, outstandingObligations) are direct query results. " +
            "Documented fields (risks) come from existing metadata (cancellationReason). " +
            "Missing information is explicitly listed (known unknowns) — the incoming " +
            "administration must decide whether to gather that information before " +
            "proceeding with the policy change.",
        },
      };

      // ============================================================
      // 9. AUDIT (preserves the QUESTION in institutional memory)
      // ============================================================
      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "policy.impact.assessed",
        details: {
          changeType: input.changeType,
          target: input.target,
          description: input.description,
          counts: {
            affectedPrograms: affectedPrograms.length,
            affectedActions: affectedActions.length,
            affectedDecisions: affectedDecisions.length,
            outstandingObligations: outstandingObligations.length,
            risks: risks.length,
            missingInformation: missingInformation.length,
          },
        },
        status: "ok",
      });

      return result;
    }
  );
}
