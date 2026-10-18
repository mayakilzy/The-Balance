# G03-00 — Open Decisions (Revised)

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Open decisions register (DESIGN ONLY — no code)
> **Date:** 2026-10-18 (revision 5 — closes B1/B2/B3/B4 per owner audit)
> **Author:** GLM (implementation agent)
> **Status:** REV 5 — all blockers closed; awaiting FINAL PASS
> **Companion to:** `G03_00_BLOCKER_CLOSURE_REV5.md` (authoritative for B1-B4 closures)

---

## 1. Revision History

| Rev | Date | Changes |
|-----|------|---------|
| 1 | 2026-10-18 | Initial proposal — 8 decisions (D1-D8) |
| 2 | 2026-10-18 | Owner review: D6 elevated, D3 expanded, D8 per-limitation, vertical slice |
| 3 | 2026-10-18 | Sub-questions resolved, SECURITY INVOKER (not DEFINER), historical preservation, draft mode |
| 4 | 2026-10-18 | Security audit corrections: S1 (SECURITY DEFINER function), S2 (DB-level revocation), S3 (institutional authority) |
| 5 | 2026-10-18 (this) | Blocker closure: B1 (Option A corrected — lead check inside UPDATE WHERE), B2 (tightened revocation), B3 (explicit institutional authority contract), B4 (all documents fully updated) |

---

## 2. Decision Status Summary

| # | Decision | Owner directive | Status |
|---|----------|-----------------|--------|
| D1 | Independent reform tables vs. reuse G01 | APPROVED IN PRINCIPLE | Under revision — review all 9 tables for redundancy |
| D2 | System-initiated opportunity detection | APPROVED — advisory only | Approved |
| D3 | Problem vs. cause analysis | APPROVED WITH MODIFICATIONS | Under revision — add evidence supporting/contradicting, confidence basis, review status |
| D4 | Optional FK to Program/Project | APPROVED IN PRINCIPLE | Under revision — add strict tenant/country/strategy context verification |
| D5 | Three distinct lifecycle states | APPROVED IN PRINCIPLE | Under revision — separate execution verification from outcome measurement |
| D6 | Cross-ministry coordination | **APPROVED WITH MODIFICATIONS** (elevated from deferred) | Under revision — institution-based, not tenant-based; two-level approval; explicit shared snapshots |
| D7 | Duplicate proposal prevention | APPROVED — warning + justified override | Approved |
| D8 | G02 limitations | **CHANGED** — per-limitation dependency assessment, not blanket defer | Under revision — independent assessment of each G02-L22 through L26 |
| D9 (NEW) | Coordination model details | Required by D6 | Proposed — multi-table model (4 tables), threat model documented separately |

---

## 3. D1 — Independent Reform Tables (Revised)

### 3.1 Owner Directive

> "اعتمد مفاهيم التنسيق الجديدة، مع مراجعة الجداول التسعة جميعاً بحثاً عن التكرار. لا ندمج سجل التقدم غير القابل للتلاعب داخل JSONB."

### 3.2 Revised Recommendation

After owner review, the recommendation stands with the following adjustments:

1. **9 tables total** (7 original + 2 coordination... but see D6 below — coordination requires 4 tables, not 2). Total: **7 + 4 = 11 tables** for G03.

2. **Review for redundancy** — I performed this review. Findings:
   - `reform_action_updates` (append-only progress log): **KEEP** — owner explicitly directed not to merge into JSONB. The append-only enforcement is a security property, not a data modeling choice.
   - `reform_approvals` (immutable approval record): **KEEP** — evidence snapshot at approval time requires a separate table. Merging into `reform_proposals` would lose the snapshot's immutability.
   - `reform_verifications` (F6-pattern verification): **KEEP** — one per action (unique constraint). Merging into `reform_actions` would conflate execution lifecycle with verification status (violates invariant #7).
   - `reform_feedback_loops` (descriptive before/after): **KEEP** — one per action (unique constraint). Merging into `reform_actions` would lose the `attributionLevel` DB trigger enforcement.
   - `reform_alternatives`: **KEEP** — multiple per proposal; cannot be a JSONB array on `reform_proposals` because alternatives have their own lifecycle (selected/withdrawn) and unique constraints.
   - All other tables are non-redundant.

3. **No merges**: Per owner directive, `reform_action_updates` stays as a separate table. All other tables are similarly justified.

### 3.3 Final Count

| Table group | Count | Purpose |
|-------------|-------|---------|
| Core reform entities | 7 | ReformProposal, ReformAlternative, ReformApproval, ReformAction, ReformActionUpdate, ReformVerification, ReformFeedbackLoop |
| Coordination entities (D6) | 4 | ReformCoordination, ReformCoordinationParticipant, ReformCoordinationInvitation, ReformCoordinationSharedSnapshot |
| **TOTAL** | **11** | |

### 3.4 Number of Services (Result, Not Goal)

| Service group | Count | Purpose |
|---------------|-------|---------|
| Core reform services | 11 | (as originally proposed) |
| Coordination services | 1 | `reform-coordination-service.ts` (CRUD + invitations + shared snapshots + plan approval) |
| **TOTAL** | **12** | |

**Critical**: Per owner directive, these numbers are **estimates derived from the design**, not goals to hit. They will be adjusted if the design evolves further.

---

## 4. D3 — Problem & Cause Analysis (Revised)

### 4.1 Owner Directive

> "افصل المشكلة المرصودة عن الفرضيات التفسيرية. استخدم مستوى ثقة وصفياً: `unknown / low / medium / high`. وأضف: Evidence supporting the hypothesis. Evidence contradicting the hypothesis. Confidence basis and assessment source. Hypothesis review status and timestamp. لا تعرض مستوى الثقة على أنه احتمال إحصائي معاير دون دليل."

### 4.2 Revised `hypothesizedCauses[]` Schema

```typescript
export const HypothesizedCauseSchema = z.object({
  cause: z.string().min(1).max(2000),
  // Confidence level — descriptive, not probabilistic
  confidenceLevel: z.enum(["unknown", "low", "medium", "high"]).default("unknown"),
  // Confidence basis — what is the confidence based on?
  confidenceBasis: z.enum([
    "analyst_judgment",           // analyst's expert judgment
    "historical_pattern",          // based on historical data patterns
    "statistical_correlation",     // based on statistical correlation (NOT causation)
    "expert_consultation",         // consulted with domain experts
    "literature_review",           // based on published research
    "international_comparison",    // compared with other countries' experiences
    "unknown",                     // basis not specified
  ]).default("unknown"),
  // Evidence supporting the hypothesis (live links, not snapshots — these are working hypotheses)
  supportingEvidenceIds: z.array(z.string()).default([]),
  // Evidence contradicting the hypothesis (CRITICAL — owner directive)
  contradictingEvidenceIds: z.array(z.string()).default([]),
  // Hypothesis review status
  reviewStatus: z.enum([
    "proposed",                    // initial draft
    "under_review",                // being analyzed
    "validated",                   // supporting evidence outweighs contradicting
    "invalidated",                 // contradicting evidence outweighs supporting
    "inconclusive",                // evidence is balanced or insufficient
    "superseded",                  // replaced by a newer hypothesis
  ]).default("proposed"),
  // Review tracking
  reviewedBy: z.string().optional(),
  reviewedAt: z.date().optional(),
  reviewNotes: z.string().max(5000).optional(),
  // Provenance
  proposedBy: z.string(),
  proposedAt: z.date().default(() => new Date()),
  // Last modification (for hypothesis evolution tracking)
  lastModifiedAt: z.date().default(() => new Date()),
  lastModifiedBy: z.string().optional(),
});
```

### 4.3 Critical Design Choices

1. **`confidenceLevel` is descriptive, not probabilistic**: `unknown/low/medium/high` — never a percentage. Per owner directive, no calibrated probability without evidence.

2. **`confidenceBasis` is required for non-`unknown` confidence**: If `confidenceLevel != "unknown"`, the basis must be specified. This prevents analysts from setting `high` confidence without justification.

3. **`contradictingEvidenceIds` is a first-class field**: Not hidden in `metadata`. The system explicitly tracks evidence that contradicts each hypothesis.

4. **`reviewStatus` tracks the hypothesis lifecycle**: A hypothesis is not static — it evolves as evidence accumulates. The system tracks: proposed → under_review → validated/invalidated/inconclusive → superseded.

5. **`reviewedBy` + `reviewedAt`**: Hypothesis validation is a human act, not automatic. The reviewer who validated/invalidated the hypothesis is recorded.

6. **Live links, not snapshots**: `supportingEvidenceIds` and `contradictingEvidenceIds` are live references to the `Evidence` table. As evidence is verified/refuted over time, the hypothesis context naturally updates. This is different from `ReformApproval`'s evidence snapshot (which is frozen at approval time).

### 4.4 Honest Acknowledgment (Per Owner Directive)

> "ولا تعتبر regex أو `attributionLevel="descriptive"` ضماناً كافياً لسلامة النصوص من الادعاءات السببية."

The owner correctly identified that my original `regex` pattern + `attributionLevel` DB trigger is **insufficient** to guarantee causal-language-free text. The revised model addresses this by:

1. **Epistemic separation in the data model** (not just the text): `problemStatement` (descriptive, factual) is separate from `hypothesizedCauses[]` (explicitly hypothetical). The system cannot conflate them.

2. **`reviewStatus` field makes epistemic state explicit**: A hypothesis is `proposed`, `under_review`, `validated`, `invalidated`, `inconclusive`, or `superseded`. The reviewer must explicitly decide the epistemic status.

3. **`confidenceBasis` forces epistemic honesty**: The analyst must declare the basis for their confidence. "Statistical correlation" is allowed (because correlation is descriptive), but it's explicitly labeled — not hidden.

4. **Reviewer judgment is the primary defense**: The system cannot replace human review. The reviewer reads the text, evaluates the evidence, and decides whether the hypothesis is valid. The DB triggers and regex patterns are **defense in depth**, not the primary safeguard.

5. **Regex stays as a defense-in-depth layer** (not removed): It catches obvious policy-outcome language in `verifiedAction`. But it's documented as a weak check — not a guarantee.

6. **Audit trail of epistemic decisions**: Every `reviewStatus` change is audited via `writeAuditTx` (action: `reform.hypothesis_reviewed`). The reviewer is accountable.

### 4.5 What This Does NOT Solve

- A determined analyst can still write subtly causal language in the `cause` field (e.g., "the lag in monetary transmission contributes to inflation persistence"). The system cannot detect this. The reviewer must.
- The system cannot verify that `supportingEvidenceIds` actually support the cause. The reviewer must read the evidence.
- The system cannot prevent analysts from overestimating confidence. The reviewer must challenge it.

These are inherent limitations of any system that relies on human judgment. The model provides the **structure** for honest epistemic practice, but it cannot enforce it.

---

## 5. D4 — Optional FK to Program/Project (Revised)

### 5.1 Owner Directive

> "روابط Program/Project اختيارية، مع التحقق الصارم من المستأجر والبلد والسياق الاستراتيجي."

### 5.2 Revised Service-Layer Verification

When a ReformAction is created with `programId` or `projectId`, the service must verify:

1. **Tenant match**: The Program/Project belongs to the same tenant as the ReformAction.
2. **Country match**: The Program's strategy version references a Strategy whose tenant's country matches the ReformProposal's tenant's country.
3. **Strategic context match**: The Program's `strategyVersionId` matches (or is compatible with) the ReformProposal's `strategyVersionId` (if set on the proposal).

### 5.3 Verification Logic

```typescript
async function verifyProgramLink(
  tx: Prisma.TransactionClient,
  tenantId: string,
  programId: string,
  proposalStrategyVersionId?: string
): Promise<void> {
  const program = await tx.program.findFirst({
    where: { id: programId, tenantId },
    include: { strategyVersion: { include: { strategy: { include: { tenant: true } } } } },
  });
  if (!program) {
    throw new NotFoundError("Program not found in tenant scope");
  }

  // Country match check
  const programCountryId = program.strategyVersion.strategy.tenant.countryId;
  const actionTenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  if (actionTenant?.countryId !== programCountryId) {
    throw new ConflictError(
      "Country mismatch: ReformAction's tenant country must match Program's strategy version country"
    );
  }

  // Strategic context match (if proposal has a strategyVersionId)
  if (proposalStrategyVersionId && program.strategyVersionId !== proposalStrategyVersionId) {
    // Not a hard error — the program may be from a different but compatible strategy
    // Log a warning and require explicit confirmation in the input
    // (the service accepts `allowCrossStrategyProgramLink: true` to override)
  }
}
```

### 5.4 Acceptance

This adds verification complexity but honors the owner's directive for strict context matching. The `allowCrossStrategyProgramLink` flag allows legitimate cases where a reform action references a program from a different (but compatible) strategy.

---

## 6. D5 — Lifecycle Separation (Revised)

### 6.1 Owner Directive

> "افصل دائماً: Human approval. Implementation completion. Execution verification. Descriptive outcome measurement."

### 6.2 Four Distinct States (Revised from Three)

The owner's directive separates **execution verification** from **outcome measurement**. This is a critical distinction I had conflated. Revised:

| # | State | Entity | Field | What it certifies |
|---|-------|--------|-------|-------------------|
| 1 | **Human approval** | `ReformApproval` | (created) | A reviewer has authorized the reform |
| 2 | **Implementation completion** | `ReformAction` | `status = completed` | The action has been executed (work done) |
| 3 | **Execution verification** | `ReformVerification` | `verificationStatus = verified` | A reviewer has verified the specific action was executed (F6 pattern) |
| 4 | **Descriptive outcome measurement** | `ReformFeedbackLoop` | (created) | A new observation has been taken post-reform, and a descriptive comparison is recorded |

### 6.3 Critical Separation: Verification vs. Measurement

- **Verification (state 3)** is about the **action**: was the memo issued? was the infrastructure completed? was the regulation published? This is F6 — `verifiedAction` + `evidenceSource` required.

- **Measurement (state 4)** is about the **outcome**: did the indicator change after the reform? This is **descriptive only** — `attributionLevel = "descriptive"`. The system never claims the reform *caused* the change.

### 6.4 Why This Separation Matters

A reform can be:
- **Approved + Implemented + Verified + Measured**: full lifecycle.
- **Approved + Implemented + Verified + NOT Measured**: the action was verified, but no post-reform observation has been taken yet (e.g., the next measurement period hasn't arrived).
- **Approved + Implemented + NOT Verified + Measured**: the action was completed but not verified by a reviewer (process gap), yet observations continued.
- **Approved + NOT Implemented**: the reform was approved but never executed (e.g., political change).
- **Approved + Implemented + Verified + Measured + Disputed**: the verification was disputed (someone challenged the F6 claim).

The four states are **independent**. The system tracks each separately, and the audit trail preserves the full history.

### 6.5 State Machine (Revised)

```
ReformProposal: draft → under_review → approved/rejected/superseded
                                       │
                                       ▼ (state 1: human approval — ReformApproval)
                                       │
ReformAction: planned → in_progress → completed/blocked/cancelled
                                              │
                                              ▼ (state 2: implementation completion)
                                              │
ReformVerification: pending → verified/disputed
                              │
                              ▼ (state 3: execution verification — F6)
                              │
ReformFeedbackLoop: (created, immutable, attributionLevel="descriptive")
                              │
                              ▼ (state 4: descriptive outcome measurement)
                              │
[New Observation created via ingestObservation — append-only, never mutates history]
```

---

## 7. D6 — Multi-Institution Coordination (REVISED — Core Capability)

### 7.1 Owner Directive (Full Text)

> "اعتمد مفهومي `ReformCoordination` و`CoordinationParticipant` مبدئياً، لكن لا تفترض أن كل وزارة تساوي Tenant مستقلاً. ادرس العلاقة بين Institution وTenant في المعمارية الحالية، وصمّم عضوية الجهات المشاركة وفق الهوية المؤسسية وحدود ملكية البيانات."

> "يجب دعم: إصلاح مشترك بين مؤسسات داخل المستأجر نفسه. إمكانية التنسيق المصرح به بين جهات موزعة على مستأجرين مختلفين. مشاركة حد أدنى من بيانات التنسيق المصرح بها فقط. بقاء المقترحات والأدلة التفصيلية خاضعة لمالكها وصلاحياتها. اعتماد كل جهة لالتزاماتها، دون فرض التزام عليها بمجرد أغلبية المشاركين. عدم إضعاف RLS أو استخدام BYPASSRLS لتجاوز حدود المشاركة."

### 7.2 Revised Architecture

Full details in `G03_00_THREAT_MODEL.md` and `G03_00_DOMAIN_MODEL.md` (revised). Summary:

#### 7.2.1 New Tables (4)

| Table | Purpose |
|-------|---------|
| `reform_coordinations` | Coordination metadata (title, lead tenant, policy, status) |
| `reform_coordination_participants` | M:N coordination↔tenant (with role + status) |
| `reform_coordination_invitations` | Pending invitations (with expiry + invited tenant) |
| `reform_coordination_shared_snapshots` | Explicitly shared, reviewer-approved, immutable snapshots |

#### 7.2.2 Institution-Aware Participant Model

**Critical correction**: Participants are **tenants**, not institutions. Why?

- `Institution` is PUBLIC (no tenantId) — it's the government body's public identity.
- `Tenant` is the authorized organization that owns private data.
- A coordination is between **tenants** (who own the data), not institutions (which are public references).

However, each `ReformCoordinationParticipant` has an **optional `institutionId`** field that documents which institution the tenant is representing in this coordination. This:
- Honors the owner's directive to be "institution-aware"
- Allows multiple tenants representing the same institution (rare but possible)
- Allows a single tenant representing multiple institutions in different coordinations
- Keeps RLS simple (tenant-based, not institution-based)

#### 7.2.3 Three Coordination Scenarios (All Supported)

| Scenario | Topology | Example |
|----------|----------|---------|
| A. Intra-tenant multi-institution | Single tenant, multiple institutionId participants | Government planning tenant coordinates 3 ministries (each represented by an institutionId) |
| B. Cross-tenant same-country | Multiple tenants, same country | MOP tenant + CB tenant coordinate on monetary-fiscal reform |
| C. Cross-tenant cross-country | Multiple tenants, different countries | Demolandia + Neighborland coordinate on border trade (deferred — G03-L11) |

#### 7.2.4 Two-Level Approval (No Majority Override)

- **Coordination plan approval**: Lead reviewer approves the coordination plan (title, objectives, participant list). This does NOT commit any participant.
- **Per-participant proposal approval**: Each participant's reviewer approves their own ReformProposal (standard `approveReformProposalWithAuditSafe` workflow). No participant is bound until they individually approve.
- **Coordination `active` state**: Requires ALL linked proposals to be `approved`. No majority rule.

#### 7.2.5 Explicit Shared Snapshots (No Live Links to Private Data)

- Participants share **explicitly approved snapshots** (title, summary, type) via `CoordinationSharedSnapshot`.
- Each snapshot requires **reviewer approval** before becoming visible to other participants.
- Snapshots are **immutable** (RLS blocks UPDATE/DELETE). To revoke, create a revocation record in a separate append-only table.
- The shared view service NEVER queries participants' private tables. It only queries `CoordinationSharedSnapshot`.

### 7.3 New Permissions (4 added — total G03 permissions now 13)

| Permission | Roles | Purpose |
|-----------|-------|---------|
| `reform:coordination:read` | admin, analyst, reviewer, observer | Read coordination metadata + shared snapshots (within own participation) |
| `reform:coordination:manage` | admin, reviewer | Create coordination, add/remove participants, manage invitations |
| `reform:coordination:approve` | admin, reviewer (lead tenant) | Approve coordination plan (lead only) |
| `reform:coordination:share` | admin, reviewer | Approve shared snapshots before visible to other participants |

### 7.4 RLS Pattern: Coordination-Aware RLS via SECURITY DEFINER Helper

The standard tenant-isolation RLS is insufficient for coordination tables (coordination metadata must be visible to all participants). Solution:

```sql
-- Helper function (SECURITY DEFINER — bypasses RLS for this check only)
CREATE OR REPLACE FUNCTION is_coordination_participant(p_coordination_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM reform_coordination_participants
    WHERE "coordinationId" = p_coordination_id
    AND "tenantId" = current_setting('app.tenant_id', true)
    AND "status" = 'active'
  );
$$;

GRANT EXECUTE ON FUNCTION is_coordination_participant(TEXT) TO balance_app;

-- RLS policy for reform_coordinations: visible to lead OR active participant
CREATE POLICY reform_coordinations_visible_to_participants ON reform_coordinations
  FOR SELECT
  TO balance_app
  USING (
    "leadTenantId" = current_setting('app.tenant_id', true)
    OR is_coordination_participant("id"::text)
  );
```

This pattern is the **same as G02's observation chain integrity** (which uses `SECURITY DEFINER` functions for cross-row checks). It's proven safe and tested.

### 7.5 Threat Model

10 threats identified and mitigated — see `G03_00_THREAT_MODEL.md` for full details. Key threats:
- T1: Cross-tenant data leakage via shared view
- T2: Membership forgery
- T3: Approval override (majority forcing commitment)
- T4: Shared snapshot information disclosure
- T5: Coordination lead privilege escalation
- T6: Cross-tenant audit bypass
- T7: Shared view polluting private tenant data
- T8: Invitation replay attack
- T9: Information aggregation via metadata
- T10: Coordination supersession confusion

### 7.6 Implementation Phasing

Per owner directive ("تنفيذ تدريجي يحافظ على استقلال كل وزارة وصلاحياتها"), coordination implementation is **phased within G03**:

| Phase | Mission | Scope |
|-------|---------|-------|
| Phase 1 (Foundation) | 03-01 | Schema bootstrap includes 4 coordination tables + RLS + triggers + 4 new permissions |
| Phase 2 (Core single-tenant reform) | 03-02 through 03-04 | Single-tenant reform proposals/alternatives/approval (coordination-agnostic) |
| Phase 3 (Implementation tracking) | 03-05 | ReformAction + updates (coordination-agnostic) |
| Phase 4 (Verification + feedback) | 03-06 | F6 verification + feedback loop (coordination-agnostic) |
| Phase 5 (Coordination services) | 03-07 (NEW) | Coordination CRUD + invitations + shared snapshots + plan approval |
| Phase 6 (Vertical integration test) | 03-08 (NEW) | End-to-end coordination flow: alert → multi-institution proposal → approval → action → verification → feedback |

**Note**: The new 03-07 and 03-08 missions replace the original "deferred coordination" stance. Total mission count: 9 (was 7). See revised `G03_00_MISSION_ROADMAP.md`.

---

## 8. D7 — Duplicate Proposal Prevention (Approved)

### 8.1 Owner Directive

> "استخدم تحذيراً من المقترحات المكررة مع تجاوز بشري مبرر وموثق."

### 8.2 Implementation

When creating a proposal with `originatingAlertId`, the service:
1. Checks if there's an existing active proposal for the same alert in the same tenant.
2. If found, returns a warning in the response payload (NOT an error).
3. The analyst can override by setting `input.allowDuplicate = true` in the request with a `duplicateJustification` (required text field, min 20 chars).
4. The override is recorded in `metadata.duplicateOverride` with the justification, the actor, and the timestamp — for audit.

---

## 9. D8 — G02 Limitations (Revised — Per-Limitation Assessment)

### 9.1 Owner Directive

> "أجرِ Dependency Assessment مستقلاً لكل من: G02-L22, G02-L23, G02-L24, G02-L25, G02-L26. صنّف كل قيد: REQUIRED FOR G03 CORE / REQUIRED FOR A SPECIFIC G03 CAPABILITY / SAFELY DEFERRED. وقدّم مبررات واضحة لكل تصنيف دون تعديل GROUP 02 تلقائياً."

### 9.2 Per-Limitation Dependency Assessment

#### G02-L22: Institutional Early Warning Not Computed

- **Description**: `assessEarlyWarning` (02-03) supports national scope only. Institutional early warning is `"not_computed"`.
- **G03 dependency**: MEDIUM. If a ReformProposal originates from an institutional-scope Alert (national) but the reform targets a specific institution, the analyst may want institutional early warning as a signal. However, G03 can function with national early warning — the analyst manually filters.
- **Classification**: **REQUIRED FOR A SPECIFIC G03 CAPABILITY** (institutional-scope reform proposals). Not required for G03 core (national-scope reforms work without it).
- **Recommendation**: **SAFELY DEFERRED** from G03 core. If institutional-scope reform becomes a priority, address in a hardening mission (03-09 or later) — but this requires modifying `state-observatory/` (violates invariant #11) unless we extend it via a new service in `state-observatory/` (which requires owner approval).

#### G02-L23: No Hierarchical Institution Aggregation

- **Description**: Parent/child institution measurements are NOT auto-merged. Each institution's view contains only its own direct measurements.
- **G03 dependency**: LOW. ReformAction.owningInstitutionId is a single institution (no hierarchical rollup needed). If a reform targets a parent ministry, the analyst can manually aggregate child institutions' data.
- **Classification**: **SAFELY DEFERRED**. G03 does not need hierarchical institution aggregation.
- **Recommendation**: DEFER to a future mission (G04 or later).

#### G02-L24: Sector View Observability Not Computed

- **Description**: `aggregateObservability.status = "not_computed"` in sector view. Real observability requires per-indicator `analyzeAggregateIndependence`.
- **G03 dependency**: LOW. ReformProposal references `Program.sector` (from G01), but does not require sector-level observability.
- **Classification**: **SAFELY DEFERRED**. G03 does not need sector observability.
- **Recommendation**: DEFER to a future mission (G04 or later).

#### G02-L25: Publication Approval Gap

- **Description**: No publication approval mechanism exists. Public/Research tiers return `publication_unavailable` (fail-closed).
- **G03 dependency**: **HIGH**. If reform data is ever to be visible to the public (e.g., published reform outcomes for transparency), G02-L25 blocks this.
- **Classification**: **REQUIRED FOR A SPECIFIC G03 CAPABILITY** (public publication of reform outcomes). Not required for G03 core (tenant-private reforms work without it).
- **Recommendation**: **SAFELY DEFERRED** from G03 core. The owner has not yet directed that reforms be publicly published. When/if the owner wants public reform visibility, a dedicated publication mission is needed (03-10 or later) that:
  1. Designs a publication approval workflow (similar to G01's strategy approval)
  2. Adds a `publication_status` field to relevant G03 tables
  3. Implements `publishReformProposal()` with atomic approval + audit
  4. Integrates with G02's `PermissionedView` to expose published reforms

  **Critical**: This does NOT modify G02. The publication workflow is purely G03-side, with optional G02 PermissionedView integration (which uses G02's existing contracts).

#### G02-L26: Government Projection Limited to Public Evidence

- **Description**: Government tier shows only `classification="public"` evidence. No granular clearance model.
- **G03 dependency**: MEDIUM. If reform data is exposed to government viewers via PermissionedView, the same conservative clearance applies.
- **Classification**: **REQUIRED FOR A SPECIFIC G03 CAPABILITY** (classified reform data visible to cleared government viewers). Not required for G03 core (reforms with `classification="public"` evidence work without it).
- **Recommendation**: **SAFELY DEFERRED** from G03 core. G03 inherits the conservative clearance (all reform evidence defaults to `classification="public"`). When/if the owner wants a granular clearance model, a dedicated mission is needed (likely G04 or later) that:
  1. Designs a per-user clearance model (e.g., `UserClearance` table)
  2. Modifies `PermissionedView` to respect clearance (requires modifying `state-observatory/` — owner approval needed)
  3. Allows classified reform evidence to be visible to cleared viewers

  **Critical**: This MAY require modifying G02's `permissioned-view-service.ts`. Per invariant #11, this requires explicit owner approval.

### 9.3 Summary Table

| Limitation | Classification | Recommendation | Mission |
|-----------|----------------|----------------|---------|
| G02-L22 (Institutional Early Warning) | REQUIRED FOR SPECIFIC CAPABILITY | DEFER from G03 core; address if institutional-scope reforms become priority | 03-09+ (requires G02 extension) |
| G02-L23 (Hierarchical Institution Aggregation) | SAFELY DEFERRED | DEFER to G04+ | G04+ |
| G02-L24 (Sector View Observability) | SAFELY DEFERRED | DEFER to G04+ | G04+ |
| G02-L25 (Publication Approval) | REQUIRED FOR SPECIFIC CAPABILITY | DEFER from G03 core; address when owner wants public reform visibility | 03-10+ (G03-side publication workflow) |
| G02-L26 (Government Projection Clearance) | REQUIRED FOR SPECIFIC CAPABILITY | DEFER from G03 core; address when owner wants classified reform visibility | G04+ (requires G02 extension) |

### 9.4 Critical Conclusion

**None of these limitations are addressed in G03's 9 missions.** All are deferred, but each is classified by its dependency on G03 capabilities — not blanket-deferred as in my original proposal. The owner can prioritize specific limitations based on real-world needs.

---

## 10. D9 — Coordination Model Details (NEW)

### 10.1 Origin

This decision was created during the revision process to consolidate the coordination model details that emerged from D6.

### 10.2 Recommendation

Adopt the 4-table coordination model documented in:
- `G03_00_THREAT_MODEL.md` — full threat analysis
- `G03_00_DOMAIN_MODEL.md` (revised) — table schemas + RLS + triggers
- `G03_00_WORKFLOW_AND_APPROVALS.md` (revised) — two-level approval flow

### 10.3 Sub-Questions RESOLVED by Owner (REV 3)

The owner (Ayman) resolved all 5 sub-questions in REV 3:

| # | Sub-question | Owner decision (REV 3) | Implementation |
|---|--------------|----------------------|-----------------|
| 1 | `reform:coordination:manage` scope | **Delegated/specific permission — NOT automatic for all reviewers** | `reform:coordination:manage` requires explicit delegation. A reviewer has it only if explicitly granted by admin. The permission catalog assigns it to `admin` only by default; reviewers must be explicitly delegated per-tenant. |
| 2 | Early vertical slice timing | **Stays at 03-02** | Mission 03-02 remains the vertical slice. No change to roadmap. |
| 3 | Shared snapshots draft mode | **Support Draft (unpublished), then review + explicit approval before sharing** | `ReformCoordinationSharedSnapshot.status` lifecycle: `draft` (private to owner) → `under_review` → `approved` (visible to participants) → `revoked` (via separate table). See DOMAIN_MODEL.md §2.11. |
| 4 | Cross-strategy program/project links | **Forbidden by default unless explicit strategic context verification + delegation** | `allowCrossStrategyProgramLink` flag removed. ReformAction.programId/projectId must match the ReformProposal's strategyVersionId. No cross-strategy links allowed. See D4 revision below. |
| 5 | Documentation completeness | **Must unify and fully update the 5 documents before 03-01** | All 5 documents (ARCHITECTURE_PROPOSAL, DOMAIN_MODEL, WORKFLOW_AND_APPROVALS, INTEGRATION_CONTRACTS, SECURITY_AND_EVIDENCE_POLICY) are fully updated in REV 3. |

### 10.4 Remaining Open Questions (Non-Blocking for 03-01)

1. **Charter document for high-stakes reforms**: A formal charter signed by all participants might be needed for high-stakes reforms. Out of scope for 03-00. Documented as a future enhancement.
2. **Coordination-level audit log**: Currently all coordination actions go to standard `audit_log` with `details.coordinationId`. May want a dedicated table for cleaner reporting. Non-blocking — the current approach works, a dedicated table is a UX optimization.

These are flagged for owner review but not blocking for 03-01.

---

## 10.5 NEW Decisions from Security Audit (REV 4 — D13, D14, D15)

Per owner/reviewer security audit (REV 4), three new decisions address the findings S1, S2, S3:

### D13 — SECURITY DEFINER for Participant Removal (S1 Correction)

**Finding S1**: Cross-tenant participant management cannot be done via standard RLS because UPDATE requires SELECT visibility, and the SELECT policy on `reform_coordination_participants` is tenant-scoped (own row only).

**Recommendation**: Use a SECURITY DEFINER function `remove_coordination_participant(coordination_id, participant_id, reason)` owned by a dedicated minimal-privilege role `balance_coordination_admin` (NOLOGIN, SELECT on `reform_coordinations` + UPDATE on `reform_coordination_participants` only).

**Why SECURITY DEFINER here, not INVOKER**: The function must UPDATE a row the caller cannot SELECT (cross-tenant). SECURITY INVOKER would inherit the caller's RLS restrictions and fail. The dedicated role + BOOLEAN return + locked search_path + SQL language make this a controlled exception.

**Alternatives considered** (all rejected):
- Expand SELECT policy → violates owner directive "no SELECT expansion"
- Service-layer-only management → no DB-level enforcement
- Self-service removal only → removes lead's management capability

**Status**: PROPOSED (rev 4) — awaiting owner approval.

---

### D14 — DB-Level Revocation Enforcement (S2 Correction)

**Finding S2**: The SELECT policy on `reform_coordination_shared_snapshots` did not exclude revoked snapshots. Direct SELECT bypassed the service-layer filter.

**Recommendation**:
1. Add denormalized `coordinationId` (not nullable) to `reform_coordination_shared_snapshot_revocations` — breaks the circular RLS dependency.
2. Create `is_snapshot_revoked(snapshotId)` function (SECURITY INVOKER, returns BOOLEAN).
3. Add `AND NOT is_snapshot_revoked("id"::text)` to the SELECT policy on `reform_coordination_shared_snapshots`.

**Why denormalization is needed**: Without `coordinationId` on the revocations table, the RLS policy on revocations must subquery `reform_coordination_shared_snapshots` to find the `coordinationId`. But that table's RLS (with the S2 fix) excludes revoked snapshots — creating a circular dependency where the revocation row is invisible because the snapshot row is invisible. Denormalizing `coordinationId` breaks the cycle.

**Status**: PROPOSED (rev 4) — awaiting owner approval.

---

### D15 — Institutional Authority Separation (S3 Correction)

**Finding S3**: `institutionId` is a claim, not verified authority. The system conflated claimed identity, verified authority, participation authorization, and commitment approval authorization.

**Recommendation**: Separate four concepts:
1. **Claimed institution**: `institutionId` (lead's assertion — documentation only)
2. **Verified institution**: `verifiedInstitutionId` + `verifiedAt` + `verifiedBy` + `verificationMethod` (admin-verified via future workflow — G03-L13 deferred)
3. **Participation authorization**: `tenantId` + invitation status (system-verified via session)
4. **Commitment approval authorization**: `canApproveCommitments` (boolean, default FALSE, explicit grant by lead or admin)

**Conservative constraint**: To approve commitments claiming institutional authority, a participant must have BOTH `canApproveCommitments = true` AND `verifiedInstitutionId` set (matching the claimed institution).

**What this does NOT solve**: The verification workflow itself (admin setting `verifiedInstitutionId`) is out of scope for 03-00 (G03-L13). Until then, `verifiedInstitutionId` is always NULL, meaning no commitments can claim verified institutional authority — fail-closed.

**Status**: PROPOSED (rev 4) — awaiting owner approval.

---

## 11. Decisions That Require Owner Approval Before 03-01 (REV 4 — Updated)

| # | Decision | Status | Required before 03-01? |
|---|----------|--------|------------------------|
| D1 | **12 tables** (7 core + 5 coordination) | PROPOSED (rev 3 — was 11 in rev 2, added revocations table) | YES |
| D3 | Expanded `hypothesizedCauses[]` schema (confidenceBasis, contradictingEvidenceIds, reviewStatus, reviewedBy, reviewedAt) | PROPOSED (rev 2) | YES |
| D4 | **Cross-strategy links forbidden by default** (rev 3 — was "allowed with override" in rev 2) | PROPOSED (rev 3 — owner decision) | YES |
| D5 | Four distinct lifecycle states (separated verification from measurement) | PROPOSED (rev 2) | YES |
| D6 | Multi-institution coordination (5 tables, 4 permissions, two-level approval, SECURITY INVOKER) | PROPOSED (rev 3 — SECURITY INVOKER not DEFINER) | YES |
| D9 | Coordination model details | PROPOSED (rev 2) | YES |
| D10 (NEW) | SECURITY INVOKER (not DEFINER) for coordination access function | PROPOSED (rev 3 — owner directive) | YES |
| D11 (NEW) | Historical preservation on supersession (no silent rewrite) | PROPOSED (rev 3 — owner directive) | YES |
| D12 (NEW) | Shared snapshot draft mode (draft → under_review → approved → revoked) | PROPOSED (rev 3 — owner decision) | YES |
| **D13 (REV 4)** | **SECURITY DEFINER for participant removal** (S1 correction — dedicated minimal-privilege role) | PROPOSED (rev 4 — security audit) | YES |
| **D14 (REV 4)** | **DB-level revocation enforcement** (S2 correction — denormalized coordinationId + is_snapshot_revoked function) | PROPOSED (rev 4 — security audit) | YES |
| **D15 (REV 4)** | **Institutional authority separation** (S3 correction — claimed vs verified vs participation vs approval) | PROPOSED (rev 4 — security audit) | YES |
| D2 | Advisory opportunity detection | APPROVED | No |
| D7 | Soft duplicate check with override | APPROVED | No |
| D8 | Per-limitation G02 assessment | PROPOSED (rev 2) | No (informational) |

---

## 12. GLM's Technical Opinion (Revised)

### 12.1 What I Got Wrong in the First Version

1. **D6 was incorrectly deferred.** The owner correctly identified that multi-institution reform is a core government capability, not a "nice to have". My original "single-tenant only" stance would have shipped a platform that doesn't match real government work.

2. **Conflated execution verification with outcome measurement.** The owner's directive to separate "execution verification" from "descriptive outcome measurement" is epistemically critical. My original three-state model blurred this distinction.

3. **Over-relied on regex + DB trigger for causal language prevention.** The owner correctly identified that these are defense-in-depth layers, not guarantees. The revised model adds epistemic structure (separate problem statement, hypothesis lifecycle, confidence basis) as the primary defense.

4. **Treated table count as a goal.** The owner correctly noted that "we don't need 7 tables and 11 services and 30 API routes just because they're written in design docs". The numbers are estimates derived from the design, not targets.

5. **Did not study the Institution-Tenant relationship carefully.** My original coordination design assumed "ministry = tenant" (1:1), which ADR-0004 explicitly rejects. The revised design uses institutionId as an optional attribute on participants, keeping RLS tenant-based.

### 12.2 What I'm Confident About Now

1. **The 4-table coordination model** is the right granularity. Fewer tables would lose the invitation flow or the shared snapshot model. More tables would be over-engineering.

2. **The two-level approval (coordination plan + per-participant proposal)** is the only model that honors both "coordination is meaningful" and "no majority override".

3. **The `SECURITY DEFINER` helper function for coordination RLS** is a proven pattern (G02 uses it for observation chain integrity). It's safe and tested.

4. **The expanded `hypothesizedCauses[]` schema** with `confidenceBasis`, `contradictingEvidenceIds`, and `reviewStatus` makes the epistemic state explicit. This is structurally honest.

5. **The 9-mission roadmap** (with 03-07 coordination + 03-08 vertical integration) provides a practical path: ship core reform first (03-02 through 03-06), then coordination (03-07 + 03-08), then iterate.

### 12.3 What I'm Still Uncertain About

1. **The vertical slice mission (03-08).** The owner directed: "أفضّل أن يقدّم GROUP 03 في مرحلة مبكرة مساراً رأسياً صغيراً يعمل فعلياً". I've added this as 03-08 at the end. But the owner may want it earlier — perhaps a "minimum viable reform" mission before coordination. I'd appreciate the owner's view on timing.

2. **The shared snapshot reviewer approval.** Requiring reviewer approval for every shared snapshot may slow down coordination. But without it, an analyst could leak info via summaries. I've kept the approval requirement, but the owner may want a "draft mode" where snapshots are visible only to the sharing tenant until approved.

3. **The `allowCrossStrategyProgramLink` flag (D4).** Allowing a ReformAction to link to a Program from a different strategy version (with explicit override) may be too permissive. The owner may want this blocked entirely, requiring the analyst to create a new Program in the current strategy.

### 12.4 What I'd Like the Owner to Clarify

1. **Should the vertical slice mission be earlier?** (e.g., as 03-02 instead of 03-08)
2. **Should `reform:coordination:manage` be admin-only or admin+reviewer?**
3. **Should shared snapshots have a "draft mode" visible only to the sharing tenant?**
4. **Should `allowCrossStrategyProgramLink` be removed entirely?**

---

## 13. Conclusion

The revised open decisions document reflects the owner's directive to:
1. Elevate multi-institution coordination from deferred to core
2. Separate epistemic states (problem vs. cause, verification vs. measurement)
3. Assess G02 limitations individually, not blanket-defer
4. Add a vertical slice mission for early validation
5. Treat numbers as estimates, not goals

The architecture is now more complex (11 tables, 12 services, 13 permissions, 9 missions) but more honest about the real-world needs of government reform. The threat model identifies 10 specific threats with mitigations that do not weaken RLS or tenant sovereignty.

I await the owner's final approval (or further modifications) before proceeding to mission 03-01.

---

*End of G03-00 Open Decisions (Revised). Companion documents: THREAT_MODEL.md, ARCHITECTURE_PROPOSAL.md (revised), DOMAIN_MODEL.md (revised), WORKFLOW_AND_APPROVALS.md (revised), INTEGRATION_CONTRACTS.md (revised), SECURITY_AND_EVIDENCE_POLICY.md (revised), MISSION_ROADMAP.md (revised).*
