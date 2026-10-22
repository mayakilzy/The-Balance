// ============================================================
// src/lib/continuity/contracts.ts — Zod schemas + shared types
// ------------------------------------------------------------
// Delivery 03 — Strategic Continuity & Government Handover.
//
// Reuses existing models: Decision, DecisionEvent, StrategyVersion,
// ReformProposal/ReformApproval/ReformAction, AuditLog. Adds:
//   - HandoverDossier (new table — migration 0033)
//   - PolicyImpactAssessment (on-demand computation, no persistence)
//
// All inputs validated by Zod before reaching the service layer.
// ============================================================
import { z } from "zod";

// ------------------------------------------------------------
// Decision lifecycle (reuses strategy-service.createDecision/advanceDecision)
// ------------------------------------------------------------
export const CreateDecisionBodySchema = z.object({
  strategyVersionId: z.string().min(1).optional(),
  title: z.string().min(5).max(200),
  rationale: z.string().min(10),
  supportingEvidenceIds: z.array(z.string().min(1)).optional(),
  counterEvidenceIds: z.array(z.string().min(1)).optional(),
});
export type CreateDecisionBody = z.infer<typeof CreateDecisionBodySchema>;

export const AdvanceDecisionBodySchema = z.object({
  // reviewed | approved | implemented | reversed
  newStatus: z.enum(["reviewed", "approved", "implemented", "reversed"]),
  notes: z.string().optional(),
});
export type AdvanceDecisionBody = z.infer<typeof AdvanceDecisionBodySchema>;

// ------------------------------------------------------------
// Handover dossier
// ------------------------------------------------------------
export const HandoverDossierScopeSchema = z.object({
  asOfDate: z.string().datetime().optional(),
  strategyVersionIds: z.array(z.string().min(1)).optional(),
  decisionIds: z.array(z.string().min(1)).optional(),
  proposalIds: z.array(z.string().min(1)).optional(),
  includeActiveStrategies: z.boolean().optional(),
  includeOutstandingObligations: z.boolean().optional(),
  includeAuditHighlights: z.boolean().optional(),
});

export const GenerateHandoverDossierBodySchema = z.object({
  title: z.string().min(5).max(300),
  scope: HandoverDossierScopeSchema,
});
export type GenerateHandoverDossierBody = z.infer<typeof GenerateHandoverDossierBodySchema>;

// ------------------------------------------------------------
// Policy change impact assessment
// ------------------------------------------------------------
export const PolicyChangeTargetSchema = z.object({
  strategyVersionId: z.string().min(1).optional(),
  decisionId: z.string().min(1).optional(),
  proposalId: z.string().min(1).optional(),
}).refine(
  (val) => val.strategyVersionId || val.decisionId || val.proposalId,
  { message: "At least one of strategyVersionId / decisionId / proposalId is required" }
);

export const PolicyChangeBodySchema = z.object({
  changeType: z.enum(["supersede", "reverse", "amend", "cancel"]),
  description: z.string().min(10),
  target: PolicyChangeTargetSchema,
});
export type PolicyChangeBody = z.infer<typeof PolicyChangeBodySchema>;

// ------------------------------------------------------------
// Output types
// ------------------------------------------------------------
export interface StrategyVersionHistoryEntry {
  id: string;
  versionNumber: number;
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  approvalNotes: string | null;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  isLatest: boolean;
}

export interface HistoricalTraceEntry {
  at: Date;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  status: string;
  source: "audit_log" | "decision_event" | "reform_proposal" | "reform_action";
  refId: string;
}

export interface DossierStrategySummary {
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
}

export interface DossierDecisionSummary {
  id: string;
  title: string;
  status: string;
  decidedBy: string;
  decidedAt: Date;
  rationaleExcerpt: string;
  evidenceCount: { supporting: number; counter: number };
}

export interface DossierObligationSummary {
  id: string;
  kind: "reform_action";
  title: string;
  status: string;
  progressPercentage: number;
  dueDate: Date | null;
  proposalId: string;
}

export interface DossierAuditHighlight {
  at: Date;
  action: string;
  actor: string;
  status: string;
}

export interface HandoverDossierContent {
  generatedAt: Date;
  asOfDate: string | null;
  strategies: DossierStrategySummary[];
  decisions: DossierDecisionSummary[];
  obligations: DossierObligationSummary[];
  auditHighlights: DossierAuditHighlight[];
  counts: {
    strategies: number;
    decisions: number;
    obligations: number;
    auditEntries: number;
  };
  honesty: {
    scope: "descriptive";
    notes: string;
  };
}

export interface PolicyImpactAssessmentResult {
  changeType: string;
  description: string;
  target: {
    strategyVersionId?: string;
    decisionId?: string;
    proposalId?: string;
  };
  affectedPrograms: Array<{
    id: string;
    title: string;
    sector: string;
    status: string;
  }>;
  affectedActions: Array<{
    id: string;
    title: string;
    status: string;
    progressPercentage: number;
  }>;
  affectedDecisions: Array<{
    id: string;
    title: string;
    status: string;
  }>;
  outstandingObligations: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
  }>;
  risks: string[];
  missingInformation: string[];
  honesty: {
    scope: "descriptive";
    notes: string;
  };
}
