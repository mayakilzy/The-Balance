// ============================================================
// src/lib/reform/index.ts — Barrel export for G03-02 + G03-03
// ------------------------------------------------------------
// Exports the approved services + contracts.
// G03-03: Alternative service added (CRUD + selection + withdrawal).
// Comparison, advisor, enhanced approval, coordination, and query
// services are deferred to G03-04+.
// ============================================================

// Contracts (Zod schemas + types + error classes)
export * from "./contracts";

// G03-03-R1 — Lock helper (fail-closed SELECT FOR UPDATE)
export { lockProposalRow, LockUnavailableError } from "./lock-helper";

// Proposal service (G03-02 + G03-03 modifications)
export {
  createReformProposal,
  getReformProposal,
  listReformProposals,
  submitForReview,
  approveReformProposal,
  rejectReformProposal,
} from "./reform-proposal-service";

// Alternative service (G03-03)
export {
  addReformAlternative,
  listReformAlternatives,
  selectAlternative,
  withdrawAlternative,
} from "./reform-alternative-service";

// Action service (G03-02)
export {
  createReformAction,
  getReformAction,
  listReformActions,
  startReformAction,
  completeReformAction,
} from "./reform-action-service";

// Action update service (G03-02 — append-only)
export {
  addReformActionUpdate,
  listReformActionUpdates,
} from "./reform-action-update-service";

// Verification service (G03-02 — F6)
export {
  verifyReformAction,
  getReformVerification,
} from "./reform-verification-service";

// Feedback service (G03-02 — descriptive + G02 integration)
export {
  createReformFeedbackLoop,
  getReformFeedbackLoop,
  closeOriginatingAlert,
} from "./reform-feedback-service";

// ============================================================
// G03-04 — Reform Comparison + Advisor (PRE-03 corrected)
// ============================================================

// Comparison service (deterministic, no LLM)
export { compareReformAlternatives } from "./reform-comparison-service";

// Advisor service (LLM-assisted, advisory only)
export {
  draftProblemStatement,
  draftReformAlternatives,
  draftComparisonSummary,
  draftAnticipatedOutcomes,
} from "./reform-advisor-service";

// Receipt module (trusted provenance — HMAC-SHA256 with HKDF-derived key)
export {
  issueReceipt,
  verifyReceipt,
  computeDraftHash,
  type AdvisorReceiptPayload,
  type VerifiedReceipt,
} from "./advisor-receipt";

// Context builder (curated + sanitized LLM context)
export {
  buildSanitizedContext,
  stripPii,
  enforceSizeLimit,
  ADVISORY_SYSTEM_PROMPT,
  type AdvisorRawContext,
} from "./reform-advisor-context";
