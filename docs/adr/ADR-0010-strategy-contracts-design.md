# ADR-0010 — Strategy Contracts Design

**Date:** 2026-10-16
**Status:** Accepted
**Mission:** 00-05

## Context

The Balance requires institutional memory: what was decided, why, on what evidence, and who approved it. The founder directed:
- Separation between draft and approved versions
- Immutable approved versions (any change creates a new version)
- Decisions linked to evidence with verification status at decision time
- Temporal audit trail of decisions/approvals/reversals
- RLS + cross-tenant prevention
- Simulated model output NOT presented as approved government recommendation

## Decision

### Five-table model

1. **`strategies`** (PRIVATE) — high-level plan document
   - `status`: draft → submitted → approved → archived
   - Has multiple versions

2. **`strategy_versions`** (PRIVATE) — specific draft or approved version
   - `status`: draft → approved → superseded
   - `versionNumber`: unique per strategy
   - Approved versions are immutable (service enforces — cannot re-approve)
   - When a new version is approved, previous approved version is superseded

3. **`decisions`** (PRIVATE) — what was decided + why + evidence snapshot
   - `supportingEvidence` / `counterEvidence`: JSONB arrays capturing evidence ID, claim, type, verification status, source AT DECISION TIME
   - This is critical: if evidence is later refuted, the decision record shows what was known when decided
   - `status`: proposed → reviewed → approved → implemented → (optionally) reversed

4. **`decision_events`** (PRIVATE, append-only) — temporal audit trail
   - `eventType`: proposed, reviewed, approved, implemented, reversed, notes_added
   - `balance_app` can SELECT + INSERT only (REVOKE UPDATE/DELETE)
   - RLS: no UPDATE/DELETE policy → denied by default

5. **`events`** (PRIVATE, append-only) — generic timeline
   - strategy.created, strategy.version_created, strategy.version_approved, etc.
   - Same append-only enforcement

### Immutable approved versions

- `approveStrategyVersion()` checks if version is already approved → throws
- Once approved, the version's content cannot be changed
- To modify: create a NEW version (v3, v4, etc.) and approve that
- Previous approved version is automatically superseded

### Evidence snapshot at decision time

When a decision is created:
1. Fetch supporting + counter evidence from DB (RLS-enforced)
2. Snapshot: `{ evidenceId, claim, type, verificationStatus, sourceCode }`
3. Store as JSONB in `decisions.supportingEvidence` + `decisions.counterEvidence`
4. The snapshot is IMMUTABLE — it reflects what was known at decision time
5. If evidence is later verified/refuted, the decision record is unchanged

This is the founder's requirement: "الاحتفاظ بمعرفات الأدلة وحالات تحققها وقت اتخاذ القرار"

### Cross-tenant prevention (triggers)

- `enforce_strategy_version_same_tenant()`: strategy_versions.tenantId must match strategy.tenantId
- `enforce_decision_same_tenant()`: decisions.tenantId must match strategy_version.tenantId (if linked)
- `enforce_decision_event_same_tenant()`: decision_events.tenantId must match decision.tenantId

### Permissions

- `strategy:read` — observer, analyst, reviewer, admin
- `strategy:write` — analyst, admin (create strategy, version, decision)
- `strategy:approve` — reviewer, admin (approve version, approve decision)

### Simulated model output disclaimer

- The StubProvider is used for any LLM calls
- Strategy content is written by humans (or future LLM-assisted tools)
- No strategy or decision is ever presented as "AI-generated government recommendation"
- The UI footer states: "All LLM outputs in this build are SIMULATED (stub provider)"

## Alternatives considered

### Event sourcing for all entities
- **Rejected for 00-05**: Adds complexity. The append-only `decision_events` + `events` tables provide the audit trail without full event sourcing.

### Separate table for evidence-decision links
- **Considered**: A `decision_evidence` junction table.
- **Rejected**: The snapshot approach is better — it captures the evidence state AT DECISION TIME. A live link would show current evidence state, not what was known when decided.

### Version diffing
- **Deferred**: Not needed for 00-05. The full content of each version is stored; diffing is a UI concern.

## Verification (00-05)

1. Create strategy + v1 draft → ✓
2. Create v2 draft → ✓
3. Approve v2 → status changes, strategy status updates → ✓
4. Cannot re-approve approved version (immutable) → ✓
5. Create decision with evidence → snapshot captured → ✓
6. Advance decision: proposed → reviewed → approved → ✓
7. Event trail is complete + append-only → ✓
8. Cross-tenant: Tenant B cannot see Tenant A's strategies → ✓
9. Analyst can create but cannot approve (RBAC) → ✓
10. Evidence snapshot preserves verification status at decision time → ✓
