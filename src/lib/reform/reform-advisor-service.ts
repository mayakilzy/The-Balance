// ============================================================
// src/lib/reform/reform-advisor-service.ts
// ------------------------------------------------------------
// G03-04 — LLM-Assisted Reform Advisor (advisory only)
//
// PRE-03 corrections:
//   1. LLM invoked OUTSIDE DB transaction (per OD-2)
//   2. Causal language REJECTED (throw CausalRejectionError per OD-1)
//   3. Context is curated + sanitized via reform-advisor-context.ts
//   4. `simulated` derived from provider.name === "stub" (trustworthy)
//   5. Receipt issued with trusted provider metadata (per OD-5)
//   6. Receipt bound to tenant/user/proposal/purpose (cross-reuse prevention)
//   7. Receipt signed with HKDF-derived purpose-separated key
//
// ADVISORY-ONLY BOUNDARY (enforced by 25 sentinel assertions):
//   - Advisor NEVER calls approve/select/withdraw/submit/verify/feedback/close/update
//   - Advisor NEVER writes to DB (read-only)
//   - Advisor NEVER writes to audit_log
//   - Advisor output has NO confidence/recommended/ranking/selection fields
//   - Advisor output REJECTS causal language (per frozen §7.4)
//   - LLM invoked AFTER tx commits (no connection held)
//   - Context is sanitized (no PII, no raw records)
//   - Receipt is signed server-side; client cannot forge provenance
// ============================================================
import type { Session } from "next-auth";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { getLLMProvider } from "@/lib/llm";
import type { LLMMessage } from "@/lib/llm";
import {
  NotFoundError,
  CausalRejectionError,
  detectAdvisorCausalLanguage,
} from "./contracts";
import type {
  AdvisorDraftResult,
  DraftProblemStatementInput,
  DraftAlternativesInput,
  DraftAnticipatedOutcomesInput,
} from "./contracts";
import {
  buildSanitizedContext,
  ADVISORY_SYSTEM_PROMPT,
  type AdvisorRawContext,
} from "./reform-advisor-context";
import { issueReceipt } from "./advisor-receipt";
import type { AdvisorReceiptPurpose } from "./contracts";

function buildResult(
  content: string,
  providerName: string,
  modelName: string,
  extraWarnings: string[] = []
): Pick<AdvisorDraftResult, "draft" | "simulated" | "provider" | "model" | "warnings"> {
  return {
    draft: content,
    simulated: providerName === "stub",
    provider: providerName,
    model: modelName,
    warnings: [
      "This is a draft. Review and edit before saving.",
      ...(providerName === "stub"
        ? ["This is a SIMULATED draft from the StubProvider."]
        : []),
      ...extraWarnings,
    ],
  };
}

/**
 * Validate advisor output for causal language.
 * Per frozen G03-00 §7.4: REJECT (throw), not warn.
 * If causal patterns are detected, throw CausalRejectionError.
 */
function validateAdvisorOutput(content: string): void {
  const causalPatterns = detectAdvisorCausalLanguage(content);
  if (causalPatterns.length > 0) {
    // REJECT — do not return the draft
    throw new CausalRejectionError(causalPatterns);
  }
}

// ============================================================
// 1. Draft problem statement
// ============================================================
export async function draftProblemStatement(
  session: Session | null,
  input: DraftProblemStatementInput
): Promise<AdvisorDraftResult> {
  await requirePermissionWithCurrentRole(session, "reform:proposal:write");

  // Step 1: Read permitted context inside SHORT-LIVED DB transaction
  const { rawContext, tenantId, userId } = await withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      const alert = await tx.alert.findFirst({
        where: { id: input.alertId, tenantId },
        select: {
          title: true,
          description: true,
          severity: true,
          lifecycleStage: true,
          varianceRecordId: true,
        },
      });
      if (!alert) {
        throw new NotFoundError(
          `Alert ${input.alertId} not found in tenant ${tenantId}`
        );
      }

      let variance: AdvisorRawContext["variance"] = null;
      if (input.includeVariance && alert.varianceRecordId) {
        const v = await tx.varianceRecord.findFirst({
          where: { id: alert.varianceRecordId, tenantId },
          select: {
            varianceAbsolute: true,
            varianceDirection: true,
            notes: true,
          },
        });
        if (v) {
          variance = {
            delta:
              v.varianceAbsolute !== null ? Number(v.varianceAbsolute) : 0,
            direction: v.varianceDirection,
            description: v.notes ?? "",
          };
        }
      }

      return {
        rawContext: { alert, variance } as AdvisorRawContext,
        tenantId,
        userId,
      };
    }
  ); // <-- DB transaction COMMITS here, connection released

  // Step 2: Construct sanitized LLM context (outside DB tx)
  const llmContext = buildSanitizedContext(rawContext);

  // Step 3: Invoke LLM provider (OUTSIDE DB tx — no connection held)
  const provider = getLLMProvider();
  const result = await provider.complete({
    messages: [
      { role: "system", content: ADVISORY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Draft a problem statement for the following alert:\n${llmContext}`,
      },
    ],
    traceId: `advisor-problem-${Date.now()}`,
  });

  // Step 4: Validate output (causal REJECTION per OD-1)
  validateAdvisorOutput(result.content);

  // Step 5: Issue receipt (trusted provenance — per OD-5)
  const receipt = issueReceipt({
    tenantId,
    userId,
    proposalId: input.alertId, // bind to alert (problem statement is alert-scoped)
    purpose: "draft_problem_statement" as AdvisorReceiptPurpose,
    draftContent: result.content,
    providerName: provider.name,
    modelName: result.model,
  });

  // Step 6: Return advisory draft with receipt
  return {
    ...buildResult(result.content, provider.name, result.model),
    receipt,
  };
}

// ============================================================
// 2. Draft multiple alternatives
// ============================================================
export async function draftReformAlternatives(
  session: Session | null,
  input: DraftAlternativesInput
): Promise<AdvisorDraftResult[]> {
  await requirePermissionWithCurrentRole(session, "reform:alternative:write");

  // Step 1: Read proposal context (short tx)
  const { rawContext, tenantId, userId } = await withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      const proposal = await tx.reformProposal.findFirst({
        where: { id: input.proposalId, tenantId },
        select: {
          title: true,
          problemStatement: true,
          hypothesizedCauses: true,
        },
      });
      if (!proposal) {
        throw new NotFoundError(`Proposal ${input.proposalId} not found`);
      }
      return {
        rawContext: {
          proposal: {
            title: proposal.title,
            problemStatement: proposal.problemStatement,
            hypothesizedCauses: (proposal.hypothesizedCauses as string[]) ?? [],
          },
        } as AdvisorRawContext,
        tenantId,
        userId,
      };
    }
  ); // tx commits

  // Step 2: Sanitize
  const llmContext = buildSanitizedContext(rawContext);

  // Step 3: Invoke LLM for each requested alternative (outside tx)
  const provider = getLLMProvider();
  const results: AdvisorDraftResult[] = [];

  for (let i = 0; i < input.count; i++) {
    const result = await provider.complete({
      messages: [
        { role: "system", content: ADVISORY_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Draft alternative #${i + 1} for the following proposal:\n${llmContext}`,
        },
      ],
      traceId: `advisor-alt-${input.proposalId}-${i}`,
    });

    // Step 4: Validate each (causal REJECTION)
    validateAdvisorOutput(result.content);

    // Step 5: Issue receipt for each draft
    const receipt = issueReceipt({
      tenantId,
      userId,
      proposalId: input.proposalId,
      purpose: "draft_alternatives" as AdvisorReceiptPurpose,
      draftContent: result.content,
      providerName: provider.name,
      modelName: result.model,
    });

    results.push({
      ...buildResult(result.content, provider.name, result.model),
      receipt,
    });
  }

  return results;
}

// ============================================================
// 3. Draft comparison summary
// ============================================================
export async function draftComparisonSummary(
  session: Session | null,
  proposalId: string
): Promise<AdvisorDraftResult> {
  await requirePermissionWithCurrentRole(session, "reform:alternative:read");

  const { rawContext, tenantId, userId } = await withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      const proposal = await tx.reformProposal.findFirst({
        where: { id: proposalId, tenantId },
        select: { title: true, problemStatement: true },
      });
      if (!proposal) {
        throw new NotFoundError(`Proposal ${proposalId} not found`);
      }

      const alternatives = await tx.reformAlternative.findMany({
        where: { proposalId, tenantId },
        select: {
          title: true,
          description: true,
          riskLevel: true,
          feasibilityScore: true,
        },
      });

      return {
        rawContext: {
          proposal: {
            title: proposal.title,
            problemStatement: proposal.problemStatement,
            hypothesizedCauses: [],
          },
          alternatives: alternatives.map((a) => ({
            title: a.title,
            description: a.description,
            riskLevel: a.riskLevel,
            feasibilityScore: a.feasibilityScore,
          })),
        } as AdvisorRawContext,
        tenantId,
        userId,
      };
    }
  ); // tx commits

  const llmContext = buildSanitizedContext(rawContext);

  const provider = getLLMProvider();
  const result = await provider.complete({
    messages: [
      { role: "system", content: ADVISORY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Draft a descriptive comparison summary for the following alternatives:\n${llmContext}`,
      },
    ],
    traceId: `advisor-comp-${proposalId}`,
  });

  validateAdvisorOutput(result.content);

  const receipt = issueReceipt({
    tenantId,
    userId,
    proposalId,
    purpose: "draft_comparison_summary" as AdvisorReceiptPurpose,
    draftContent: result.content,
    providerName: provider.name,
    modelName: result.model,
  });

  return {
    ...buildResult(result.content, provider.name, result.model),
    receipt,
  };
}

// ============================================================
// 4. Draft anticipated outcomes
// ============================================================
export async function draftAnticipatedOutcomes(
  session: Session | null,
  input: DraftAnticipatedOutcomesInput
): Promise<AdvisorDraftResult> {
  await requirePermissionWithCurrentRole(session, "reform:alternative:write");

  const { rawContext, tenantId, userId, proposalId } =
    await withAuthenticatedTenant(
      session,
      async ({ tx, tenantId, userId }) => {
        const alternative = await tx.reformAlternative.findFirst({
          where: { id: input.alternativeId, tenantId },
          select: {
            title: true,
            description: true,
            riskLevel: true,
            feasibilityScore: true,
            proposalId: true,
          },
        });
        if (!alternative) {
          throw new NotFoundError(
            `Alternative ${input.alternativeId} not found`
          );
        }
        return {
          rawContext: {
            alternatives: [
              {
                title: alternative.title,
                description: alternative.description,
                riskLevel: alternative.riskLevel,
                feasibilityScore: alternative.feasibilityScore,
              },
            ],
          } as AdvisorRawContext,
          tenantId,
          userId,
          proposalId: alternative.proposalId,
        };
      }
    ); // tx commits

  const llmContext = buildSanitizedContext(rawContext);

  const provider = getLLMProvider();
  const result = await provider.complete({
    messages: [
      { role: "system", content: ADVISORY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Draft anticipated outcomes (descriptive, qualified, never causal) for the following alternative:\n${llmContext}`,
      },
    ],
    traceId: `advisor-outcomes-${input.alternativeId}`,
  });

  validateAdvisorOutput(result.content);

  const receipt = issueReceipt({
    tenantId,
    userId,
    proposalId, // bind to the alternative's proposal
    purpose: "draft_anticipated_outcomes" as AdvisorReceiptPurpose,
    draftContent: result.content,
    providerName: provider.name,
    modelName: result.model,
  });

  return {
    ...buildResult(result.content, provider.name, result.model),
    receipt,
  };
}
