// ============================================================
// intelligence/intelligence-service.ts
// ------------------------------------------------------------
// Delivery 04 — Evidence-grounded intelligence analysis.
//
// Requests AI-assisted analysis using authorized records from the
// current tenant. The LLM is asked to:
//   - Analyze the problem context (alert, variance, decisions, evidence)
//   - Produce a structured output with honesty tags per block
//   - Cite source references for factual evidence
//   - Disclose uncertainty + missing information
//   - NEVER make policy decisions or approve strategies
//
// Authorization: requires strategy:read (analyst+admin+reviewer).
// The analyst remains the decision-maker; the LLM only advises.
//
// Data flow:
//   1. With authenticated tenant context, gather authorized records:
//      - Alert (if alertId provided)
//      - Variance record linked to the alert
//      - Decisions linked to the strategy version (if provided)
//      - Evidence (supporting + counter) linked via the alert/variance
//      - Observations + periods for context
//   2. Build a SANITIZED context (no PII, no API keys, no cross-tenant data)
//   3. Call LLM provider (real or stub, depending on LLM_PROVIDER)
//   4. Parse + validate the LLM's structured JSON output
//   5. Return IntelligenceAnalysisResult with honesty labels
//   6. Audit log entry (intelligence.analysis.requested)
//
// Error handling:
//   - Provider failures (timeout, rate limit, network) → LLMProviderError
//     returned to caller with the focus + contextUsed counts so the
//     analyst knows what context was prepared even if the LLM failed.
//   - Output validation failures → if the LLM's output doesn't parse
//     as JSON or doesn't match the schema, return the raw text as
//     a single "model_inference" block + a "missing_information" block
//     noting the validation failure.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";
import type { Session } from "next-auth";
import { getLLMProviderAsync, LLMProviderError } from "@/lib/llm";
import type { LLMProvider } from "@/lib/llm";
import {
  INTELLIGENCE_SYSTEM_PROMPT,
  type AnalysisRequest,
  type ContentBlock,
  type IntelligenceAnalysisResult,
} from "./contracts";

// ------------------------------------------------------------
// Helper: safely parse the LLM's JSON output
// ------------------------------------------------------------
function parseLLMOutput(raw: string): {
  summary: string;
  blocks: ContentBlock[];
} | null {
  // The LLM may wrap JSON in markdown fences (```json ... ```).
  // Strip them before parsing.
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.blocks)
    ) {
      // Validate each block has a kind + text
      const validKinds = new Set([
        "factual_evidence",
        "calculation",
        "model_inference",
        "missing_information",
        "uncertainty",
      ]);
      const blocks: ContentBlock[] = parsed.blocks
        .filter(
          (b: unknown): b is ContentBlock =>
            typeof b === "object" &&
            b !== null &&
            typeof (b as ContentBlock).kind === "string" &&
            validKinds.has((b as ContentBlock).kind) &&
            typeof (b as ContentBlock).text === "string"
        )
        .map((b: ContentBlock) => ({
          kind: b.kind,
          text: b.text,
          ...(b.sourceRefs ? { sourceRefs: b.sourceRefs } : {}),
          ...(b.calculationInputs
            ? { calculationInputs: b.calculationInputs }
            : {}),
        }));
      return { summary: parsed.summary, blocks };
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Helper: build sanitized context (no PII, no API keys)
// ------------------------------------------------------------
interface SanitizedContext {
  text: string;
  counts: {
    evidenceCount: number;
    decisionCount: number;
    alertCount: number;
    observationCount: number;
    varianceCount: number;
  };
}

interface AlertContext {
  id: string;
  title: string;
  description: string;
  severity: string;
  lifecycleStage: string;
  varianceRecordId: string | null;
  strategyVersionId: string | null;
}

interface VarianceContext {
  id: string;
  varianceAbsolute: string;
  varianceDirection: string;
  comparisonValid: boolean;
}

interface EvidenceContext {
  id: string;
  claim: string;
  verificationStatus: string;
  type: string; // "supporting" | "counter" | "neutral"
}

interface DecisionContext {
  id: string;
  title: string;
  status: string;
  rationale: string;
}

interface ObservationContext {
  id: string;
  observedValue: string;
  originType: string;
  verificationStatus: string;
}

function buildSanitizedContext(input: {
  alert?: AlertContext | null;
  variance?: VarianceContext | null;
  decisions: DecisionContext[];
  evidence: EvidenceContext[];
  observations: ObservationContext[];
  question?: string;
}): SanitizedContext {
  const parts: string[] = [];

  if (input.alert) {
    parts.push(
      `ALERT: ${input.alert.title}\n` +
        `  Description: ${input.alert.description}\n` +
        `  Severity: ${input.alert.severity}\n` +
        `  Lifecycle: ${input.alert.lifecycleStage}\n`
    );
  }
  if (input.variance) {
    parts.push(
      `VARIANCE: absolute=${input.variance.varianceAbsolute}, ` +
        `direction=${input.variance.varianceDirection}, ` +
        `comparison_valid=${input.variance.comparisonValid}\n`
    );
  }
  if (input.decisions.length > 0) {
    parts.push("DECISIONS (institutional memory):\n");
    for (const d of input.decisions) {
      parts.push(
        `  - [${d.id}] ${d.title} (status: ${d.status})\n` +
          `    Rationale: ${d.rationale.slice(0, 500)}\n`
      );
    }
  }
  if (input.evidence.length > 0) {
    parts.push("EVIDENCE (authorized records):\n");
    for (const e of input.evidence) {
      parts.push(
        `  - [${e.id}] "${e.claim.slice(0, 300)}"\n` +
          `    verification: ${e.verificationStatus}, ` +
          `stance: ${e.type}\n`
      );
    }
  }
  if (input.observations.length > 0) {
    parts.push("OBSERVATIONS (G02 measurements):\n");
    for (const o of input.observations) {
      parts.push(
        `  - [${o.id}] value=${o.observedValue}, ` +
          `origin=${o.originType}, verification=${o.verificationStatus}\n`
      );
    }
  }
  if (input.question) {
    parts.push(`\nANALYST QUESTION: ${input.question}\n`);
  }

  return {
    text: parts.join("\n"),
    counts: {
      evidenceCount: input.evidence.length,
      decisionCount: input.decisions.length,
      alertCount: input.alert ? 1 : 0,
      observationCount: input.observations.length,
      varianceCount: input.variance ? 1 : 0,
    },
  };
}

// ------------------------------------------------------------
// Main service: analyze a problem using authorized records + LLM
// ------------------------------------------------------------
export async function analyzeProblem(
  session: Session | null,
  request: AnalysisRequest
): Promise<IntelligenceAnalysisResult> {
  await requirePermissionWithCurrentRole(session, "strategy:read");

  // Step 1: Gather authorized records from current tenant
  const { rawContext } = await withAuthenticatedTenant(
    session,
    async ({ tx, tenantId, userId }) => {
      // Validate targets belong to this tenant
      let alert: AlertContext | null = null;
      let variance: VarianceContext | null = null;
      let decisions: DecisionContext[] = [];
      let evidence: EvidenceContext[] = [];
      let observations: ObservationContext[] = [];

      if (request.alertId) {
        const a = await tx.alert.findFirst({
          where: { id: request.alertId, tenantId },
          select: {
            id: true,
            title: true,
            description: true,
            severity: true,
            lifecycleStage: true,
            varianceRecordId: true,
            strategyVersionId: true,
          },
        });
        if (!a) {
          throw new Error(
            `Alert ${request.alertId} not found in tenant scope — cannot analyze cross-tenant alert`
          );
        }
        alert = a;
        // Fetch the variance record linked to this alert
        if (a.varianceRecordId) {
          const v = await tx.varianceRecord.findFirst({
            where: { id: a.varianceRecordId, tenantId },
            select: {
              id: true,
              varianceAbsolute: true,
              varianceDirection: true,
              comparisonValid: true,
            },
          });
          if (v) {
            // Prisma returns Decimal for varianceAbsolute — convert to string for JSON
            variance = {
              id: v.id,
              varianceAbsolute: String(v.varianceAbsolute ?? "null"),
              varianceDirection: v.varianceDirection,
              comparisonValid: v.comparisonValid,
            };
          }
        }
      }

      if (request.strategyVersionId) {
        const sv = await tx.strategyVersion.findFirst({
          where: { id: request.strategyVersionId, tenantId },
          select: { id: true, strategyId: true },
        });
        if (!sv) {
          throw new Error(
            `StrategyVersion ${request.strategyVersionId} not found in tenant scope`
          );
        }
        // Fetch decisions linked to this strategy version
        decisions = await tx.decision.findMany({
          where: { strategyVersionId: request.strategyVersionId, tenantId },
          orderBy: { decidedAt: "desc" },
          take: 20,
          select: {
            id: true,
            title: true,
            status: true,
            rationale: true,
          },
        });
      }

      if (request.decisionId) {
        const d = await tx.decision.findFirst({
          where: { id: request.decisionId, tenantId },
          select: {
            id: true,
            title: true,
            status: true,
            rationale: true,
            strategyVersionId: true,
          },
        });
        if (!d) {
          throw new Error(
            `Decision ${request.decisionId} not found in tenant scope`
          );
        }
        decisions = [d]; // focus on the single decision
      }

      // Fetch evidence: from the alert's variance + observations
      if (alert?.varianceRecordId) {
        const obsWithEvidence = await tx.observation.findMany({
          where: { tenantId, varianceRecords: { some: { id: alert.varianceRecordId } } },
          take: 10,
          select: {
            id: true,
            observedValue: true,
            originType: true,
            verificationStatus: true,
            evidenceId: true,
          },
        });
        observations = obsWithEvidence.map((o) => ({
          id: o.id,
          observedValue: String(o.observedValue ?? "null"),
          originType: o.originType,
          verificationStatus: o.verificationStatus,
        }));

        // Fetch linked evidence — Evidence model has `type` field
        // (values: "supporting" | "counter" | "neutral"), not supportsOrContradicts
        const evidenceIds = obsWithEvidence
          .map((o) => o.evidenceId)
          .filter((id): id is string => id !== null);
        if (evidenceIds.length > 0) {
          const evRows = await tx.evidence.findMany({
            where: { id: { in: evidenceIds }, tenantId },
            take: 20,
            select: {
              id: true,
              claim: true,
              verificationStatus: true,
              type: true,
            },
          });
          evidence = evRows;
        }
      }

      const rawContext = buildSanitizedContext({
        alert,
        variance,
        decisions,
        evidence,
        observations,
        question: request.question,
      });

      // Audit the request BEFORE the LLM call (so we have a record
      // even if the LLM times out). writeAuditTx returns void —
      // the audit entry is identified by (tenantId, actor, action, at)
      // rather than a returned id.
      await writeAuditTx(tx, {
        tenantId,
        actor: userId,
        action: "intelligence.analysis.requested",
        details: {
          focus: {
            alertId: request.alertId,
            strategyVersionId: request.strategyVersionId,
            decisionId: request.decisionId,
            question: request.question?.slice(0, 200),
          },
          contextUsed: rawContext.counts,
          provider: process.env.LLM_PROVIDER ?? "stub",
        },
        status: "ok",
      });

      return { rawContext };
    }
  );

  // Step 2: Initialize the LLM provider (async for zai SDK)
  const provider: LLMProvider = await getLLMProviderAsync();

  // Step 3: Call the LLM with the sanitized context
  const start = Date.now();
  let llmContent: string;
  let llmModel: string;
  let llmUsage: IntelligenceAnalysisResult["usage"];
  let providerError: LLMProviderError | null = null;

  try {
    const result = await provider.complete({
      messages: [
        { role: "system", content: INTELLIGENCE_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Analyze the following problem using ONLY the evidence provided in the context. ` +
            `Return your analysis as a JSON object per the system prompt format.\n\n` +
            `=== CONTEXT (authorized institutional records) ===\n${rawContext.text}\n=== END CONTEXT ===\n\n` +
            `Produce your JSON analysis now.`,
        },
      ],
      maxTokens: 1500,
      temperature: 0.3, // low temperature for more deterministic analysis
      traceId: `intel-${request.alertId ?? request.strategyVersionId ?? request.decisionId}-${Date.now()}`,
    });
    llmContent = result.content;
    llmModel = result.model;
    llmUsage = result.usage;
  } catch (err) {
    if (err instanceof LLMProviderError) {
      providerError = err;
      llmContent = "";
      llmModel = providerError.provider;
      llmUsage = undefined;
    } else {
      throw err;
    }
  }

  const elapsedMs = Date.now() - start;

  // Step 4: Parse + validate the LLM's output
  const parsed = parseLLMOutput(llmContent);
  const isStub = provider.name === "stub";

  // Step 5: Build the result with honesty labels
  const result: IntelligenceAnalysisResult = {
    focus: {
      alertId: request.alertId,
      strategyVersionId: request.strategyVersionId,
      decisionId: request.decisionId,
      question: request.question,
    },
    provider: provider.name,
    model: llmModel,
    simulated: isStub,
    blocks: parsed?.blocks ?? [
      {
        kind: "model_inference",
        text: llmContent || "(no output from provider)",
      },
      ...(providerError
        ? [
            {
              kind: "missing_information" as const,
              text: `LLM provider failed (code=${providerError.code}): ${providerError.message}. The analyst must retry or use the contextual records directly.`,
            },
          ]
        : []),
      ...(parsed === null && !providerError
        ? [
            {
              kind: "missing_information" as const,
              text: "LLM output did not conform to the expected JSON schema. The raw text is in the model_inference block above. The analyst should review the raw output and re-request if needed.",
            },
          ]
        : []),
    ],
    summary: parsed?.summary ?? "(LLM output not parseable)",
    contextUsed: rawContext.counts,
    elapsedMs,
    usage: llmUsage,
    disclaimer:
      "This is an AI-assisted analysis. The LLM advises; the human decides. " +
      "No strategy approval, policy execution, or state change is performed by this analysis. " +
      "Treat model_inference blocks as hypotheses — verify against authorized records before acting.",
    auditId: undefined, // will be filled by caller
  };

  return result;
}
