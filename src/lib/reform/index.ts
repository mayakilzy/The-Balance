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
