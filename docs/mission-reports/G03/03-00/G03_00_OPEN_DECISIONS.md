# G03-00 — Open Decisions

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Open decisions register (DESIGN ONLY — no code)
> **Date:** 2026-10-18
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner approval
> **Companion to:** `G03_00_ARCHITECTURE_PROPOSAL.md` §15

---

## 1. Overview

This document lists the **open decisions** that require explicit owner approval before GROUP 03 implementation can begin. Each decision includes:

1. **The question** — what needs to be decided
2. **My recommendation** — what I (GLM, the implementation agent) recommend, with rationale
3. **Alternatives considered** — what other options exist, with trade-offs
4. **Impact of each option** — what changes if this option is chosen
5. **Urgency** — when the decision is needed (before 03-01, before 03-02, etc.)

### 1.1 Decision Status Legend

| Status | Meaning |
|--------|---------|
| **PROPOSED** | GLM's recommendation — awaiting owner review |
| **APPROVED** | Owner has approved the decision |
| **REJECTED** | Owner has rejected the recommendation — alternatives must be explored |
| **DEFERRED** | Decision postponed to a later mission |
| **SUPERSEDED** | A later decision overrides this one |

### 1.2 Decision Count

8 open decisions (D1 through D8) require owner approval before 03-01 can begin.

---

## 2. Decision D1 — Independent Reform Tables vs. Reuse G01 Program/Project

### 2.1 The Question

Should GROUP 03 introduce **independent tables** for reform proposals, alternatives, actions, and updates? Or should it **reuse the existing G01 Program/Project tables** by extending them with reform-specific fields?

### 2.2 Recommendation: Independent Tables

**I recommend independent tables** (`reform_proposals`, `reform_alternatives`, `reform_actions`, etc.) for the following reasons:

1. **Honors invariant #10** (`src/lib/state-builder/` diff = 0): Reusing G01 tables would require modifying them, violating the read-only constraint on G01 code.

2. **Semantic separation**: A `Program` is a strategic planning artifact (from G01's Strategy Composer). A `ReformAction` is an implementation tracking artifact (from G03). They have different lifecycles, different ownership, and different audit requirements. Conflating them creates conceptual confusion.

3. **Lifecycle mismatch**: Programs have `status: draft | proposed | active | completed | retired`. Reform actions have `status: planned | in_progress | completed | blocked | cancelled`. Different states, different transitions.

4. **Clean rollback**: If G03 needs to be removed (hypothetically), dropping the 7 new tables is cleaner than rolling back extensions to G01 tables.

5. **Pattern consistency**: G02 introduced 5 independent tables (IndicatorDefinition, ObservationPeriod, Observation, VarianceRecord, Alert) rather than extending G01. G03 should follow the same pattern.

### 2.3 Alternatives Considered

#### Alternative A: Extend G01 Program/Project tables

- **Mechanism**: Add nullable columns like `reformProposalId`, `reformStatus`, `reformProgressPercentage` to the `programs` and `projects` tables.
- **Pros**: Fewer tables (no new `reform_*` tables); single source of truth for "what's being done".
- **Cons**:
  - Violates invariant #10 (`state-builder/` diff must = 0)
  - Conflates two semantically distinct concepts (strategic plan vs. implementation tracking)
  - Lifecycle state machines don't align
  - Harder to audit (reform-specific audit actions mixed with strategy audit actions)
  - Breaks G01's existing tests
- **Rejected**: Violates invariant + semantic confusion.

#### Alternative B: Reuse G00 Decision + DecisionEvent tables

- **Mechanism**: Use the existing `decisions` table for reform approvals (since `Decision` already has `supportingEvidence`/`counterEvidence` JSONB snapshots).
- **Pros**: Less schema duplication; leverages existing lifecycle (`proposed → reviewed → approved → implemented → reversed`).
- **Cons**:
  - `Decision` is tied to `StrategyVersion` (nullable FK), not to `ReformProposal`. The semantics are different.
  - `DecisionEvent` doesn't have F6 verification (reform verification needs `verifiedAction` + `evidenceSource`).
  - The reform loop has more phases than the decision lifecycle (alternatives, actions, action updates, feedback loops).
  - Mixing decisions and reform approvals in the same table creates audit confusion.
- **Rejected**: Semantically distinct; doesn't fit the reform lifecycle.

### 2.4 Impact of Independent Tables

- **Schema**: +7 new tables (migration 03-01)
- **Code**: +11 service modules in `src/lib/reform/`
- **Tests**: ~190 new tests
- **Maintenance**: Slightly more code to maintain, but cleaner separation of concerns

### 2.5 Urgency

**Before 03-01** (schema bootstrap). This decision shapes the entire schema.

---

## 3. Decision D2 — System-Initiated "Opportunity Detection"

### 3.1 The Question

Should the system **proactively suggest reform opportunities** (e.g., "Alert X has been open for 30 days — consider drafting a reform proposal")? Or should reform initiation be **strictly human** (analyst decides what to reform, system only responds to explicit requests)?

### 3.2 Recommendation: Advisory Opportunity Detection (No Auto-Create)

**I recommend advisory-only opportunity detection**:

1. The system may compute a list of "reform opportunities" (alerts that are open for >N days, variances that exceed threshold M, etc.)
2. This list is presented to analysts as **suggestions**, not as created proposals
3. The analyst must explicitly click "Draft Proposal from this Opportunity" to create a proposal — the system never creates proposals automatically
4. The opportunity list is descriptive (no causal claims, no ranking)

### 3.3 Rationale

1. **Honors invariant #14** (human remains sovereign): No automatic reform creation. The system suggests; the human decides.

2. **Reduces analyst cognitive load**: Without opportunity detection, analysts must manually scan all alerts + variances to find candidates for reform. With it, the system surfaces the most pressing candidates.

3. **Advisory only**: The opportunity list is not a "to-do list" — it's a "consider these" list. The analyst may ignore all suggestions.

4. **Pattern consistency**: G02's `assessEarlyWarning` is already advisory + descriptive. G03's opportunity detection follows the same pattern.

### 3.4 Alternatives Considered

#### Alternative A: No system suggestions (strict human-initiated)

- **Mechanism**: Analysts must manually navigate to alerts/variances and decide to draft proposals. No "opportunity list" is computed.
- **Pros**: Maximum human sovereignty; no risk of system bias.
- **Cons**: Analysts may miss pressing issues; cognitive load is high.
- **Rejected**: Limits value; advisory suggestions don't violate sovereignty.

#### Alternative B: Auto-create draft proposals from opportunities

- **Mechanism**: When an alert is open for >N days, the system automatically creates a `ReformProposal` with `status: draft` and pre-fills the problem statement.
- **Pros**: Faster turnaround; no manual initiation.
- **Cons**:
  - Violates invariant #14 (human remains sovereign — even draft creation is a human act)
  - Creates clutter (many auto-generated drafts that analysts never review)
  - May produce causal claims if the LLM is used for auto-drafting
- **Rejected**: Violates sovereignty; creates clutter.

### 3.5 Implementation Note

Opportunity detection is NOT part of 03-00 through 03-06. It's a **future mission** (03-07 or later) that builds on the core reform pipeline. The current design (03-00) only specifies that the *architecture* supports it — the actual detection service is deferred.

### 3.6 Urgency

**Low** — opportunity detection is a future mission. The decision here is only about whether the *architecture* permits it. (Yes, it does — `ReformProposal.originatingAlertId` is nullable, so proposals can be created from alerts OR from human initiative.)

---

## 4. Decision D3 — Distinguishing Problem Detection vs. Cause Analysis

### 4.1 The Question

How should GROUP 03 distinguish between:
- **Problem detection** — "what is the observed variance?" (descriptive, factual)
- **Cause analysis** — "why does this variance exist?" (hypothetical, inferential)

### 4.2 Recommendation: Separate Fields with Confidence Levels

**I recommend separate fields** on `ReformProposal`:

1. `problemStatement` (String, required) — describes the observed variance/problem. Descriptive only, no causal claims. Example: "Quarterly inflation exceeded the planned milestone by 2.3 percentage points for two consecutive periods."

2. `hypothesizedCauses` (JSONB array, optional) — list of hypothesized causes, each with:
   - `cause` (String) — the hypothesized cause
   - `confidenceLevel` (Enum: `low` | `medium` | `high`) — analyst's confidence in this hypothesis
   - `supportingEvidenceIds` (String[]) — evidence supporting this hypothesis

### 4.3 Rationale

1. **Epistemic honesty**: Problem detection is factual (the variance exists). Cause analysis is hypothetical (we *think* X caused Y, but we're not sure). Conflating them creates false certainty.

2. **Honors invariant #1** (`attributionLevel = "descriptive"`): By separating `problemStatement` (descriptive) from `hypothesizedCauses` (explicitly hypothetical), we make it clear that causes are *assumptions*, not facts.

3. **Supports later verification**: When the reform is verified (F6 pattern), the verifier can check whether the hypothesized causes were validated — without conflating them with the original problem.

4. **Pattern consistency**: G02's `VarianceRecord` separates `varianceAbsolute` (factual) from `attributionLevel: "descriptive"` (epistemic stance). G03 follows the same separation.

### 4.4 Alternatives Considered

#### Alternative A: Single `problemDescription` field

- **Mechanism**: One field that covers both problem + causes.
- **Pros**: Simpler schema.
- **Cons**:
  - Conflates observation with hypothesis
  - No structured way to capture confidence levels
  - Harder to verify causes later
- **Rejected**: Epistemically dishonest; loses structured confidence data.

#### Alternative B: Separate `Problem` and `Cause` entities (normalized)

- **Mechanism**: A `ReformProblem` table and a `ReformCause` table, with `ReformCause.problemId` FK.
- **Pros**: Fully normalized; causes can be shared across problems.
- **Cons**:
  - Overkill for the current use case
  - Adds 2 more tables (we'd have 9 instead of 7)
  - Causes are rarely shared across problems (each problem has its own context)
- **Rejected**: YAGNI; JSONB array is sufficient.

### 4.5 Urgency

**Before 03-01** (schema bootstrap). This shapes the `ReformProposal` table structure.

---

## 5. Decision D4 — Relationship Between ReformAction and G01 Program/Project

### 5.1 The Question

Should `ReformAction` have a **required** foreign key to G01 `Program` or `Project`? Or should the link be **optional** (nullable)?

### 5.2 Recommendation: Optional Nullable FK

**I recommend optional nullable FK**:
- `ReformAction.programId` (nullable) — optional link to G01 Program
- `ReformAction.projectId` (nullable) — optional link to G01 Project

### 5.3 Rationale

1. **Not all reforms fit existing programs**: A reform may be triggered by an alert that doesn't align with any existing G01 program. Forcing a link would require creating a "fake" program just to satisfy the FK — bad data hygiene.

2. **Some reforms are standalone**: A targeted reform (e.g., "issue a memo clarifying regulation X") may not need a full program/project structure. It's a single action, not a multi-project initiative.

3. **When a reform DOES fit a program, the link is valuable**: The analyst can see "this reform action is part of program Y, which is part of strategy Z." This provides strategic context.

4. **Pattern consistency**: G02's `IndicatorDefinition` has optional FKs to `Objective`, `Program`, and `StrategyVersion` (all nullable). G03 follows the same pattern.

### 5.4 Alternatives Considered

#### Alternative A: Required FK to Program

- **Mechanism**: `ReformAction.programId` is NOT NULL.
- **Pros**: Every reform is tied to a strategic program — stronger traceability.
- **Cons**:
  - Forces creation of "fake" programs for standalone reforms
  - Some legitimate reforms don't fit any program
  - Breaks the "human initiative" path (an analyst may want to create a reform without first creating a program)
- **Rejected**: Too rigid; doesn't match real-world reform patterns.

#### Alternative B: Required FK to either Program OR Project (XOR)

- **Mechanism**: `ReformAction.programId` OR `ReformAction.projectId` must be set (but not both).
- **Pros**: Forces strategic alignment; ensures every reform is tied to planning.
- **Cons**:
  - XOR constraints are awkward in PostgreSQL (requires a CHECK constraint)
  - Still forces a link when none exists
  - Breaks standalone reforms
- **Rejected**: Same issue as Alternative A, plus implementation complexity.

### 5.5 Urgency

**Before 03-01** (schema bootstrap). This shapes the `ReformAction` table structure.

---

## 6. Decision D5 — Definition of "Approved", "Implemented", "Verified"

### 6.1 The Question

When is a reform "approved"? When is it "implemented"? When is its impact "verified"? Should these be:
- **Three distinct states** with clear boundaries?
- **A single linear progression** (approved → implemented → verified)?
- **Conflated** (e.g., "approved" = "implemented")?

### 6.2 Recommendation: Three Distinct States

**I recommend three distinct states**, each with its own entity + lifecycle:

1. **Approved** — A human reviewer has signed off on the reform proposal (via `ReformApproval` record). The reform is *authorized* but not yet *executed*.

2. **Implemented** — The reform action has been carried out (via `ReformAction.status = "completed"`). The reform is *executed* but its impact is not yet *verified*.

3. **Verified** — A human reviewer has verified that the specific action was executed (via `ReformVerification.verificationStatus = "verified"`, F6 pattern). The reform is *verified as executed* but its *impact on indicators* is not yet *measured*.

4. **Measured** (optional, via `ReformFeedbackLoop`) — A new observation has been taken post-reform, and a descriptive comparison is made. The impact is *described* but **never causally attributed** to the reform.

### 6.3 Rationale

1. **Audit granularity**: Each state transition is a separate audit event. Conflating them loses the audit trail.

2. **F6 compliance**: Verification (state 3) requires `verifiedAction` + `evidenceSource` — describing the *specific action verified*, not a policy outcome. This is only possible if verification is a separate state from implementation.

3. **Causal attribution prohibition**: The feedback loop (state 4) is *descriptive only*. By separating "verified as executed" (state 3) from "impact measured" (state 4), we make it clear that execution verification does NOT imply causal attribution.

4. **Pattern consistency**: G02's Alert separates `lifecycleStage` (detected → notified → reviewed → decision_documented → closed) from `executionStatus` (not_applicable → pending → verified → disputed). G03 follows the same separation principle.

### 6.4 Alternatives Considered

#### Alternative A: Single linear progression

- **Mechanism**: `ReformProposal.status` goes `draft → approved → implemented → verified` (single field).
- **Pros**: Simpler schema.
- **Cons**:
  - Loses the distinction between "authorized" and "executed"
  - Cannot represent "approved but not yet started" vs. "in progress"
  - F6 verification would be conflated with implementation
- **Rejected**: Loses audit granularity; conflates distinct concepts.

#### Alternative B: Conflate "approved" with "implemented"

- **Mechanism**: Approval automatically sets the action to "in_progress".
- **Pros**: Faster workflow.
- **Cons**:
  - Removes the "authorized but not started" state
  - Makes it impossible to track "approved reforms that haven't been started yet"
- **Rejected**: Loses important state information.

### 6.5 Urgency

**Before 03-01** (schema bootstrap). This shapes the entire lifecycle structure.

---

## 7. Decision D6 — Cross-Ministry (Cross-Tenant) Reforms

### 7.1 The Question

How should GROUP 03 handle reforms that span multiple ministries (e.g., a monetary-fiscal coordination reform between the Central Bank and the Ministry of Planning)?

### 7.2 Recommendation: Defer to Future Mission (Single-Tenant Only in G03)

**I recommend that G03 ships single-tenant only**, with cross-tenant coordination deferred to a future mission.

### 7.3 Rationale

1. **Complexity**: Cross-tenant coordination requires:
   - A `ReformCoordination` table linking proposals across tenants
   - A multi-tenant approval workflow (all ministries must approve)
   - Shared visibility with explicit per-tenant consent
   - New permissions (`reform:coordination:*`)
   - New audit actions for coordination events
   
   This is a significant feature that would expand G03's scope by ~30%.

2. **Current data model**: G00/G01/G02 are strictly tenant-isolated. Adding cross-tenant coordination to G03 would require rethinking the RLS model for the new coordination tables — a non-trivial architectural extension.

3. **Workaround exists**: Each ministry can create its own proposal for the same problem (referencing the same originating Alert). This is "soft coordination" — no shared state, but the audit trail shows both ministries are working on the same problem.

4. **G02 pattern**: G02 shipped without cross-tenant variance aggregation (each tenant computes its own variance). G03 follows the same pattern — ship single-tenant first, defer cross-tenant to a future mission.

### 7.4 Alternatives Considered

#### Alternative A: Implement cross-tenant coordination in G03

- **Mechanism**: Add `ReformCoordination` table + multi-tenant approval workflow.
- **Pros**: Full cross-ministry reform support out of the box.
- **Cons**:
  - Significant scope expansion (~30% more work)
  - New RLS pattern (cross-tenant visibility with consent)
  - New permissions + audit actions
  - Delays G03 closure by 1-2 missions
- **Rejected**: Scope creep; G03 should ship focused.

#### Alternative B: Use a "shared tenant" pattern

- **Mechanism**: Create a "joint reform tenant" that both ministries are members of. The joint tenant owns the reform proposal; both ministries see it via their membership.
- **Pros**: Reuses existing tenant + membership model.
- **Cons**:
  - Requires creating joint tenants for every cross-ministry reform (administrative overhead)
  - Doesn't scale to N-ministry reforms
  - Confuses ownership (who owns the joint tenant?)
- **Rejected**: Hacky; doesn't scale.

### 7.5 Documented as Limitation

This will be documented as **G03-L01: Cross-Tenant Reform Coordination** in the G03 Known Limitations register (produced at G03 closure).

### 7.6 Urgency

**Low** — deferring doesn't block 03-01. The architecture (single-tenant) is already specified.

---

## 8. Decision D7 — Duplicate Proposal Prevention

### 8.1 The Question

Should GROUP 03 **prevent** analysts from creating duplicate reform proposals for the same alert? Or should it **allow** duplicates (with a soft warning)?

### 8.2 Recommendation: Soft Check with Override

**I recommend a soft check**:
- When creating a proposal with `originatingAlertId` set, the service checks if there's already an active (non-rejected, non-superseded) proposal for that alert.
- If found, the service returns a **warning** in the response: "Warning: An active proposal (ID: X) already exists for this alert. Are you sure you want to create another?"
- The analyst can override the warning by setting `input.allowDuplicate = true` in the request.
- No hard block — the analyst may have a legitimate reason to create a second proposal (e.g., different approach, different alternative set).

### 8.3 Rationale

1. **Avoids false positives**: Two proposals for the same alert may be legitimate (e.g., one proposes a monetary response, another proposes a fiscal response — both are valid).

2. **Respects analyst judgment**: The analyst is closest to the problem. A hard block would force them to delete the existing proposal (losing history) or create a fake "different" alert.

3. **Pattern consistency**: G01's `composeStrategies` allows multiple alternatives for the same objective without deduplication. G03 follows the same pattern.

4. **Audit trail preserved**: Even if duplicates are created, each is a separate audited entity. The reviewer can see both during review.

### 8.4 Alternatives Considered

#### Alternative A: Hard block (unique constraint on `(tenantId, originatingAlertId)`)

- **Mechanism**: DB-level unique constraint preventing two proposals for the same alert.
- **Pros**: Strict prevention of duplicates.
- **Cons**:
  - Blocks legitimate use cases (multiple approaches to same problem)
  - Forces analysts to "delete and recreate" (losing history)
  - Doesn't account for rejected/superseded proposals
- **Rejected**: Too rigid; blocks legitimate use cases.

#### Alternative B: Hard block only on active proposals (partial unique index)

- **Mechanism**: Partial unique index on `(tenantId, originatingAlertId) WHERE status IN ('draft', 'under_review', 'approved')`.
- **Pros**: Allows re-proposal after rejection/supersession.
- **Cons**:
  - Still blocks legitimate parallel proposals (e.g., monetary + fiscal response to same alert)
  - Forces sequential workflow when parallel might be better
- **Rejected**: Still too rigid.

### 8.5 Implementation Note

The soft check is implemented in the service layer (not the DB). It returns a warning in the response payload, not an error. The API route can choose to surface the warning to the UI or log it.

### 8.6 Urgency

**Before 03-02** (proposal service). The check is in the service layer, not the schema.

---

## 9. Decision D8 — Which G02 Limitations to Address in G03

### 9.1 The Question

GROUP 02 left several limitations deferred (G02-L22, L23, L24) or documented (G02-L25, L26). Which of these should GROUP 03 **address** (fix), and which should it **leave deferred**?

### 9.2 Recommendation: Defer All to Future Missions

**I recommend that G03 does NOT address any G02 limitations**. All limitations remain in their current state:

| Limitation | Current status | G03 action |
|-----------|---------------|------------|
| G02-L22 (Institutional Early Warning Not Computed) | DEFERRED | Remains deferred |
| G02-L23 (No Hierarchical Institution Aggregation) | DEFERRED | Remains deferred |
| G02-L24 (Sector View Observability Not Computed) | DEFERRED | Remains deferred |
| G02-L25 (Publication Approval Gap) | DOCUMENTED | Remains documented (G03 has no publication workflow) |
| G02-L26 (Government Projection Limited to Public Evidence) | DOCUMENTED | Remains documented (G3 inherits conservative clearance) |

### 9.3 Rationale

1. **Scope discipline**: G03 is already a large group (7 missions, ~190 tests). Adding G02 limitation fixes would expand scope by 2-3 more missions.

2. **G03 doesn't need them to function**:
   - G02-L22 (institutional early warning): G03 can work with national-scope early warnings. If institutional-scope is needed, the analyst can manually check the institutional view.
   - G02-L23 (hierarchical institution aggregation): G03's `ReformAction.owningInstitutionId` is a single institution. Hierarchical rollup is not needed for the reform loop.
   - G02-L24 (sector observability): G03's `ReformProposal` references `Program.sector` (from G01). Sector observability is not needed for the reform loop.
   - G02-L25 (publication): G03 has no publication workflow. This is consistent with the fail-closed design.
   - G02-L26 (government clearance): G03 inherits the conservative clearance. No weakening.

3. **Future hardening mission**: A dedicated "G02 Hardening" mission (post-G03, or as part of G04/G05) can address these limitations with focused effort.

4. **Pattern consistency**: G02 didn't fix G01's limitations (StubProvider, no real data, etc.). G03 follows the same discipline — don't fix predecessor's limitations unless they block the current group's functionality.

### 9.4 Alternatives Considered

#### Alternative A: Address G02-L22 (Institutional Early Warning) in G03

- **Mechanism**: Extend G02's `assessEarlyWarning` to support institutional scope. Add `getInstitutionalEarlyWarning()` to G02 (modifying `state-observatory/`).
- **Pros**: G03 can use institutional-scope early warnings as reform signals.
- **Cons**:
  - Violates invariant #11 (`state-observatory/` diff = 0 unless explicitly approved)
  - Expands G03 scope by 1 mission
  - G03 can function without it (national scope is sufficient for the reform loop)
- **Rejected**: Violates invariant; not needed for G03 functionality.

#### Alternative B: Address G02-L25 (Publication Approval) in G03

- **Mechanism**: Add a `publication_status` field to `ReformProposal` + a publication approval workflow.
- **Pros**: Allows published reforms to be visible to the public/research tiers.
- **Cons**:
  - Significant scope expansion (publication workflow is non-trivial)
  - Requires designing a publication approval model (who approves? what's the criteria?)
  - G03 reforms are tenant-private by default — publication is a separate concern
- **Rejected**: Scope creep; publication is a separate mission.

### 9.5 Documented as G03 Limitations

At G03 closure, the following limitations will be documented:
- G03-L01: Cross-Tenant Reform Coordination (see D6)
- G03-L02: No Browser UI for Reform (deferred — mirrors G02-L03)
- G03-L03: Publication Workflow Not Implemented (inherits G02-L25)
- G03-L04: Government Projection Limited to Public Evidence (inherits G02-L26)
- G03-L05: LLM Advisor Uses StubProvider
- G03-L06: No Real Country Data (inherits G02-L04)
- G03-L07: G02-L22/L23/L24 Still Deferred
- G03-L08: Advisor Causal Language Rejection Is Pattern-Based (regex, not NLP)
- G03-L09: No Sub-Year Granularity for Reform Timeline (inherits G02-L01)
- G03-L10: No External Integrations (Email/SMS/Webhooks) (inherits G02-L05)

### 9.6 Urgency

**Low** — deferring doesn't block 03-01. The architecture (no G02 fixes) is already specified.

---

## 10. Decision Summary

| # | Decision | Recommendation | Urgency | Status |
|---|----------|----------------|---------|--------|
| D1 | Independent reform tables vs. reuse G01 | **Independent tables** | Before 03-01 | PROPOSED |
| D2 | System-initiated opportunity detection | **Advisory only** (no auto-create) | Low (future mission) | PROPOSED |
| D3 | Problem detection vs. cause analysis | **Separate fields** (`problemStatement` + `hypothesizedCauses[]`) | Before 03-01 | PROPOSED |
| D4 | ReformAction → Program/Project link | **Optional nullable FK** | Before 03-01 | PROPOSED |
| D5 | Definition of approved/implemented/verified | **Three distinct states** | Before 03-01 | PROPOSED |
| D6 | Cross-ministry reforms | **Defer to future mission** (single-tenant in G03) | Low | PROPOSED |
| D7 | Duplicate proposal prevention | **Soft check with override** | Before 03-02 | PROPOSED |
| D8 | Which G02 limitations to address | **Defer all** (no G02 fixes in G03) | Low | PROPOSED |

---

## 11. Decisions That Require Owner Approval Before 03-01

The following decisions **must** be approved before mission 03-01 (schema bootstrap) can begin:

- **D1** — Independent tables (shapes the schema)
- **D3** — Separate fields for problem vs. causes (shapes `ReformProposal` table)
- **D4** — Optional FK to Program/Project (shapes `ReformAction` table)
- **D5** — Three distinct states (shapes the entire lifecycle)

The following decisions can be approved later (before their respective missions):

- **D7** — Before 03-02 (service layer, not schema)
- **D2, D6, D8** — Low urgency (architecture already supports deferral)

---

## 12. Owner Approval Process

For each decision, the owner should respond with one of:

1. **APPROVED** — accept the recommendation as-is
2. **APPROVED with modification** — accept the recommendation with specific changes (please describe)
3. **REJECTED** — reject the recommendation; explore alternatives
4. **DEFERRED** — postpone the decision to a later mission (architecture supports deferral for D2, D6, D7, D8)

### 12.1 Example Approval Format

```
D1: APPROVED
D2: APPROVED
D3: APPROVED with modification — add `evidenceContradictsIds` field to `hypothesizedCauses[]` for tracking contradicting evidence
D4: APPROVED
D5: APPROVED
D6: DEFERRED (future mission)
D7: APPROVED
D8: APPROVED
```

### 12.2 What Happens After Approval

Once all required decisions (D1, D3, D4, D5) are approved:

1. I (GLM) update the design documents to reflect any modifications
2. The architecture becomes **frozen** — no further changes without owner approval
3. Mission 03-01 (schema bootstrap) can begin

If any required decision is REJECTED, I will propose alternatives and re-submit for approval before proceeding.

---

## 13. GLM's Technical Opinion (As Requested by Owner)

Per the owner's directive: *"لا تتردد في طرح رأيك أو مقترحك بنهاية تنفيذ اي مهمة"* — here is my honest technical opinion on the open decisions:

### 13.1 Strongly Recommended (High Confidence)

- **D1 (Independent tables)**: This is the only correct choice. Reusing G01 tables would violate invariants and create semantic confusion.
- **D5 (Three distinct states)**: This is essential for audit granularity and F6 compliance. Conflating states would weaken the entire reform loop.
- **D8 (Defer all G02 limitations)**: G03 is already large. Adding G02 fixes would cause scope creep and delay delivery.

### 13.2 Recommended (Medium Confidence)

- **D3 (Separate fields)**: This is the epistemically honest choice, but I can see arguments for a simpler single-field approach if the owner prioritizes simplicity over precision.
- **D4 (Optional FK)**: This matches real-world reform patterns. A required FK would be too rigid.

### 13.3 Defensible Either Way (Low Confidence)

- **D2 (Opportunity detection)**: I lean toward advisory-only, but I can see arguments for strict human-initiated if the owner prioritizes maximum sovereignty.
- **D6 (Cross-tenant coordination)**: Deferring is the pragmatic choice, but if the owner has a strong use case for cross-ministry reforms, addressing it in G03 is defensible (with scope expansion).
- **D7 (Duplicate prevention)**: Soft check is my preference, but a hard block (partial unique index) is also defensible if the owner wants strict deduplication.

### 13.4 My Biggest Concern

**D6 (Cross-ministry coordination)** is the decision I'm least certain about. In a real government context, many reforms ARE cross-ministry (monetary-fiscal coordination, security-economic balance, etc.). Shipping G03 single-tenant-only may limit real-world usefulness.

However, I also believe that shipping a focused single-tenant G03 is better than delaying it to add cross-tenant coordination. The workaround (each ministry creates its own proposal referencing the same alert) is functional, even if not ideal.

**My recommendation to the owner**: Approve D6 as DEFERRED for now. If, during G03 implementation, you find that cross-ministry reforms are critical, we can revisit and add a 03-07 mission for cross-tenant coordination.

---

## 14. Conclusion

The 8 open decisions listed here shape the entire GROUP 03 architecture. My recommendations are designed to:

1. **Honor all 14 inherited invariants** — no violations
2. **Follow proven G01/G02 patterns** — consistency over novelty
3. **Ship a focused, valuable G03** — no scope creep
4. **Preserve human sovereignty** — no automatic decisions
5. **Maintain epistemic honesty** — descriptive, never causal
6. **Defer cross-cutting concerns** — cross-tenant, publication, G02 fixes

I await the owner's approval (or modification/rejection) of each decision. Once D1, D3, D4, D5 are approved, the architecture is frozen and mission 03-01 can begin.

---

*End of G03-00 Open Decisions. This completes the 7-document design package for Mission 03-00.*
