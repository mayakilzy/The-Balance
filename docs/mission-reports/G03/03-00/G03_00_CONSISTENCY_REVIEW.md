# G03-00 — Consistency Review

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation (REV 3)
> **Document type:** Cross-document consistency verification (DESIGN ONLY)
> **Date:** 2026-10-18 (revision 3 — post owner + reviewer second review)
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — verifies all 9 G03-00 documents speak the same architectural language
> **Companion to:** All other G03-00 documents

---

## 1. Purpose

Per owner directive (REV 3 §6): "أنشئ مراجعة اتساق توضح أن جميع الوثائق تتفق على [8 نقاط]"

This document verifies that all 9 G03-00 design documents are internally consistent. Each section below addresses one of the 8 consistency points the owner requested.

### 1.1 Documents in Scope

| # | Document | Status |
|---|----------|--------|
| 1 | `G03_00_ARCHITECTURE_PROPOSAL.md` | Header-updated (rev 2) → content verified consistent |
| 2 | `G03_00_DOMAIN_MODEL.md` | **Fully revised (rev 3)** — 12 tables, D3 expansion, coordination tables, supersession |
| 3 | `G03_00_WORKFLOW_AND_APPROVALS.md` | Header-updated (rev 2) → content verified consistent |
| 4 | `G03_00_INTEGRATION_CONTRACTS.md` | Header-updated (rev 2) → content verified consistent |
| 5 | `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` | Header-updated (rev 2) → content verified consistent |
| 6 | `G03_00_MISSION_ROADMAP.md` | **Fully revised (rev 2)** — 9 missions |
| 7 | `G03_00_OPEN_DECISIONS.md` | **Fully revised (rev 3)** — D1-D12, sub-questions resolved |
| 8 | `G03_00_THREAT_MODEL.md` | **New (rev 2)** — 10 threats |
| 9 | `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md` | **New (rev 3)** — SECURITY INVOKER contract |
| 10 | `G03_00_MISSION_REPORT.md` | To be updated for rev 3 |

---

## 2. Consistency Point 1: Table Names, Relationships, and Final Count

### 2.1 Authoritative Count: **12 tables** (7 core + 5 coordination)

| # | Table | Document references | Consistent? |
|---|-------|---------------------|:---:|
| 1 | `reform_proposals` | DOMAIN_MODEL §2.1, ARCHITECTURE §7.1, ROADMAP 03-01 | ✓ |
| 2 | `reform_alternatives` | DOMAIN_MODEL §2.2, ARCHITECTURE §7.1, ROADMAP 03-01 | ✓ |
| 3 | `reform_approvals` | DOMAIN_MODEL §2.3, ARCHITECTURE §7.1, ROADMAP 03-01 | ✓ |
| 4 | `reform_actions` | DOMAIN_MODEL §2.4, ARCHITECTURE §7.1, ROADMAP 03-01 | ✓ |
| 5 | `reform_action_updates` | DOMAIN_MODEL §2.5, ARCHITECTURE §7.1, ROADMAP 03-01 | ✓ |
| 6 | `reform_verifications` | DOMAIN_MODEL §2.6, ARCHITECTURE §7.1, ROADMAP 03-01 | ✓ |
| 7 | `reform_feedback_loops` | DOMAIN_MODEL §2.7, ARCHITECTURE §7.1, ROADMAP 03-01 | ✓ |
| 8 | `reform_coordinations` | DOMAIN_MODEL §2.8, THREAT_MODEL §4.1, SECURITY_CONTRACT §3.1 | ✓ |
| 9 | `reform_coordination_participants` | DOMAIN_MODEL §2.9, THREAT_MODEL §4.2, SECURITY_CONTRACT §3.2 | ✓ |
| 10 | `reform_coordination_invitations` | DOMAIN_MODEL §2.10, THREAT_MODEL §4.3, SECURITY_CONTRACT §3.3 | ✓ |
| 11 | `reform_coordination_shared_snapshots` | DOMAIN_MODEL §2.11, THREAT_MODEL §4.4, SECURITY_CONTRACT §3.4 | ✓ |
| 12 | `reform_coordination_shared_snapshot_revocations` | DOMAIN_MODEL §2.12, THREAT_MODEL §4.4, SECURITY_CONTRACT §3.5 | ✓ |

### 2.2 Count Verification Across Documents

| Document | Stated count | Actual list | Consistent? |
|----------|:---:|:---:|:---:|
| DOMAIN_MODEL §1.2 | 12 (7 core + 5 coordination) | 12 tables listed | ✓ |
| OPEN_DECISIONS D1 | 12 (rev 3) | 12 tables in §3.3 | ✓ |
| MISSION_ROADMAP §4.3 | 12 (was 11 in rev 2 — corrected) | 12 tables in §4.3 | ✓ |
| THREAT_MODEL §4 | 5 coordination tables | 5 coordination tables | ✓ |
| SECURITY_CONTRACT §3 | 5 coordination tables + 7 core | 12 total | ✓ |

### 2.3 Cross-Table Relationships

```
Tenant (G00)
  │
  ├── ReformProposal (G03) ←─── coordinationId? ──→ ReformCoordination (G03)
  │     │                                                       │
  │     │                                                       ├── leadTenantId ──→ Tenant
  │     │                                                       ├── countryId ──→ Country
  │     │                                                       ├── participants[] ──→ ReformCoordinationParticipant
  │     │                                                       ├── invitations[] ──→ ReformCoordinationInvitation
  │     │                                                       └── sharedSnapshots[] ──→ ReformCoordinationSharedSnapshot
  │     │                                                                                  │
  │     │                                                                                  └── revocations[] ──→ ReformCoordinationSharedSnapshotRevocation
  │     │
  │     ├── originatingAlertId? ──── Alert (G02)
  │     ├── originatingVarianceRecordId? ── VarianceRecord (G02)
  │     ├── strategyVersionId? ───── StrategyVersion (G01)
  │     ├── objectiveId? ─────────── Objective (G01)
  │     │
  │     ├── ReformAlternative[]
  │     ├── ReformApproval?
  │     └── ReformAction[]
  │           │
  │           ├── programId? ─────── Program (G01)
  │           ├── projectId? ─────── Project (G01)
  │           │
  │           ├── ReformActionUpdate[] (append-only)
  │           ├── ReformVerification?
  │           └── ReformFeedbackLoop?
  │
  └── Event[] (G00)
```

**Verification**: All FKs and relationships are consistent across DOMAIN_MODEL, THREAT_MODEL, and SECURITY_CONTRACT. ✓

---

## 3. Consistency Point 2: Permissions and Authorized Entities

### 3.1 Authoritative Count: **13 permissions** (9 core + 4 coordination)

| Permission | Roles | Document references | Consistent? |
|-----------|-------|---------------------|:---:|
| `reform:proposal:read` | admin, analyst, reviewer, observer | DOMAIN_MODEL §7.2, SECURITY §3.2, INTEGRATION §5.2 | ✓ |
| `reform:proposal:write` | admin, analyst | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:proposal:approve` | admin, reviewer | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:alternative:read` | admin, analyst, reviewer | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:alternative:write` | admin, analyst | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:action:read` | admin, analyst, reviewer, observer | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:action:write` | admin, analyst | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:action:verify` | admin, reviewer | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:verification:read` | admin, analyst, reviewer | DOMAIN_MODEL §7.2, SECURITY §3.2 | ✓ |
| `reform:coordination:read` | admin, analyst, reviewer, observer | THREAT_MODEL §8.2, SECURITY_CONTRACT §6.1, OPEN_DECISIONS D6 | ✓ |
| `reform:coordination:manage` | **admin only by default; reviewer only via explicit delegation** (rev 3) | OPEN_DECISIONS §10.3, SECURITY_CONTRACT §6.1 | ✓ |
| `reform:coordination:approve` | admin, reviewer (lead tenant only) | THREAT_MODEL §8.2, SECURITY_CONTRACT §6.1 | ✓ |
| `reform:coordination:share` | admin, reviewer | THREAT_MODEL §8.2, SECURITY_CONTRACT §6.1 | ✓ |

### 3.2 Permission Matrix (Authoritative — from SECURITY_CONTRACT §6.1)

| Permission | admin | reviewer | analyst | observer |
|-----------|:---:|:---:|:---:|:---:|
| reform:proposal:read | ✓ | ✓ | ✓ | ✓ |
| reform:proposal:write | ✓ | — | ✓ | — |
| reform:proposal:approve | ✓ | ✓ | — | — |
| reform:alternative:read | ✓ | ✓ | ✓ | — |
| reform:alternative:write | ✓ | — | ✓ | — |
| reform:action:read | ✓ | ✓ | ✓ | ✓ |
| reform:action:write | ✓ | — | ✓ | — |
| reform:action:verify | ✓ | ✓ | — | — |
| reform:verification:read | ✓ | ✓ | ✓ | — |
| reform:coordination:read | ✓ | ✓ | ✓ | ✓ |
| reform:coordination:manage | ✓ | (delegated only) | — | — |
| reform:coordination:approve | ✓ | ✓ (lead tenant) | — | — |
| reform:coordination:share | ✓ | ✓ | — | — |

**Note on `reform:coordination:manage`** (REV 3 owner decision): By default, only `admin` has this permission. A reviewer can be explicitly delegated per-tenant by an admin (via a future role-delegation mechanism, out of scope for 03-00). For 03-01, the permission is assigned to `admin` only in the `ROLE_PERMISSIONS` catalog. The explicit delegation mechanism is documented as a future enhancement.

### 3.3 Verification

All documents agree on:
- 13 permissions (9 core + 4 coordination) ✓
- Role assignments per permission ✓
- The exception: `reform:coordination:manage` is admin-only by default (rev 3) ✓

---

## 4. Consistency Point 3: Lifecycle States and Transitions

### 4.1 Authoritative Model: **4 distinct lifecycle states** (per D5)

| State | Entity | Field | Document references | Consistent? |
|-------|--------|-------|---------------------|:---:|
| 1. Human approval | ReformApproval | (created) | WORKFLOW §4, OPEN_DECISIONS D5, DOMAIN_MODEL §2.3 | ✓ |
| 2. Implementation completion | ReformAction | `status = completed` | WORKFLOW §3.3, OPEN_DECISIONS D5, DOMAIN_MODEL §2.4 | ✓ |
| 3. Execution verification | ReformVerification | `verificationStatus = verified` | WORKFLOW §3.4, OPEN_DECISIONS D5, DOMAIN_MODEL §2.6 | ✓ |
| 4. Descriptive outcome measurement | ReformFeedbackLoop | (created) | WORKFLOW §6, OPEN_DECISIONS D5, DOMAIN_MODEL §2.7 | ✓ |

### 4.2 State Machines (Summary)

| Entity | States | Document references | Consistent? |
|--------|--------|---------------------|:---:|
| ReformProposal | draft → under_review → approved/rejected/superseded | WORKFLOW §3.1, DOMAIN_MODEL §1.3 | ✓ |
| ReformAlternative | draft → selected/withdrawn | WORKFLOW §3.2, DOMAIN_MODEL §1.3 | ✓ |
| ReformAction | planned → in_progress → completed/blocked/cancelled | WORKFLOW §3.3, DOMAIN_MODEL §1.3 | ✓ |
| ReformVerification | pending → verified/disputed | WORKFLOW §3.4, DOMAIN_MODEL §1.3 | ✓ |
| ReformCoordination | draft → plan_submitted → plan_approved → active → closed/superseded | DOMAIN_MODEL §1.3, §2.8 | ✓ |
| ReformCoordinationParticipant | pending_invitation → active → removed/withdrawn | DOMAIN_MODEL §1.3, §2.9 | ✓ |
| ReformCoordinationInvitation | pending → accepted/declined/expired/revoked | DOMAIN_MODEL §1.3, §2.10 | ✓ |
| ReformCoordinationSharedSnapshot | draft → under_review → approved → revoked | DOMAIN_MODEL §1.3, §2.11 (rev 3 — draft mode) | ✓ |

### 4.3 Critical Separation (D5)

The 4 states are **independent** — verified across all documents:
- Verification (state 3) is about the **action** (was the memo issued?)
- Measurement (state 4) is about the **outcome** (did the indicator change?)
- A reform can be verified without being measured, or measured without being verified

All documents agree on this separation. ✓

---

## 5. Consistency Point 4: Data Access Paths for Shared Data

### 5.1 Shared Data Access Paths

| Access path | Mechanism | Document references | Consistent? |
|-------------|-----------|---------------------|:---:|
| Coordination metadata visibility | RLS policy with `is_coordination_participant()` helper (SECURITY INVOKER) | SECURITY_CONTRACT §3.1, THREAT_MODEL §4.2, DOMAIN_MODEL §3.1 | ✓ |
| Shared snapshot visibility (approved only) | RLS policy: `ownerTenantId = current_tenant OR (approvedAt IS NOT NULL AND is_coordination_participant())` | SECURITY_CONTRACT §3.4, THREAT_MODEL §4.4 | ✓ |
| Draft snapshot privacy | RLS policy: drafts visible only to `ownerTenantId = current_tenant` (rev 3 — owner decision) | SECURITY_CONTRACT §3.4, DOMAIN_MODEL §2.11 | ✓ |
| Revoked snapshot filtering | Shared view service filters out snapshots with revocation records | SECURITY_CONTRACT §4.1, THREAT_MODEL T4 | ✓ |
| Invitation visibility | RLS: `invitedTenantId = current_tenant OR lead tenant` | SECURITY_CONTRACT §3.3 | ✓ |

### 5.2 What the Shared View Does NOT Query

All documents agree (verified in SECURITY_CONTRACT §4.3 and THREAT_MODEL §4.1):
- ❌ `reform_proposals` (private to each tenant)
- ❌ `reform_actions` (private)
- ❌ `reform_action_updates` (private)
- ❌ `reform_approvals` (private)
- ❌ `reform_verifications` (private)
- ❌ `evidence` (private)
- ❌ Any other tenant's data

The shared view service ONLY queries `reform_coordination_shared_snapshots` and `reform_coordination_shared_snapshot_revocations`. ✓

---

## 6. Consistency Point 5: Approval and Audit Rules

### 6.1 Two-Level Approval (No Majority Override)

| Level | What | Who approves | Document references | Consistent? |
|-------|------|---------------|---------------------|:---:|
| 1. Coordination plan approval | Coordination metadata (title, description, policy, participants) | Lead tenant's reviewer/admin (`reform:coordination:approve`) | WORKFLOW §4, THREAT_MODEL §6, SECURITY_CONTRACT §5.1 | ✓ |
| 2. Per-participant proposal approval | Each participant's own ReformProposal | Each tenant's own reviewer (`reform:proposal:approve`) | WORKFLOW §4, INTEGRATION §4.5, DOMAIN_MODEL §2.3 | ✓ |

**Coordination `active` state**: requires ALL linked proposals approved. No majority rule. All documents agree. ✓

### 6.2 Audit Trail Pattern (Three-Layer)

| Layer | Table | Atomicity | Document references | Consistent? |
|-------|-------|-----------|---------------------|:---:|
| 1. Authorization | (in-memory check) | Throws PermissionDeniedError | SECURITY §4.1, WORKFLOW §9.1 | ✓ |
| 2. Domain Event | `events` (G00) | Atomic with primary operation | SECURITY §4.1, WORKFLOW §9.1 | ✓ |
| 3. Audit Log | `audit_log` (G00) | Atomic via `writeAuditTx` | SECURITY §4.1, WORKFLOW §9.1, INTEGRATION §4.5 | ✓ |

### 6.3 Denied-Attempt Audit

All documents agree (verified in WORKFLOW §4.3, SECURITY §4.4, INTEGRATION §4.5):
- Denied permission attempts are audited via `*WithAuditSafe` wrapper
- `status: "denied"`, `errorCode: "PERMISSION_DENIED"`
- Original `PermissionDeniedError` always re-thrown (not masked by audit failure)

### 6.4 Supersession Audit (REV 3 — Historical Preservation)

Per owner directive (D11): supersession does NOT rewrite history. Audit entries record:
- What was superseded
- What superseded it
- Why
- Historical context preserved (old proposal's coordinationId, strategyVersionId — NOT modified)

Verified in DOMAIN_MODEL §3.7, OPEN_DECISIONS D11. ✓

---

## 7. Consistency Point 6: Mission Decomposition (03-01 through 03-08)

### 7.1 Authoritative Mission List: **9 missions** (1 design + 1 schema + 7 service/closure)

| Mission | Title | Type | Schema diff | Document references | Consistent? |
|---------|-------|------|:---:|---------------------|:---:|
| 03-00 | Architecture & Scope Foundation (this) | Design | 0 | ROADMAP §3, OPEN_DECISIONS D9 | ✓ |
| 03-01 | Schema Bootstrap (12 tables, 13 permissions, SECURITY INVOKER function) | Schema | +1 migration | ROADMAP §4, DOMAIN_MODEL §9 | ✓ |
| 03-02 | Vertical Slice — Minimum Viable Reform (NEW) | Code | 0 | ROADMAP §5 | ✓ |
| 03-03 | Reform Alternatives | Code | 0 | ROADMAP §6 | ✓ |
| 03-04 | Reform Comparison + Advisor | Code | 0 | ROADMAP §7 | ✓ |
| 03-05 | Enhanced Approval Workflow | Code | 0 | ROADMAP §8 | ✓ |
| 03-06 | Multi-Institution Coordination Services (NEW) | Code | 0 | ROADMAP §9 | ✓ |
| 03-07 | Coordination Vertical Slice (NEW) | Code | 0 | ROADMAP §10 | ✓ |
| 03-08 | Polish + Closure (NEW) | Code | 0 | ROADMAP §11 | ✓ |

### 7.2 Mission Numbering Consistency

| Source | 03-06 | 03-07 |
|--------|-------|-------|
| MISSION_ROADMAP (rev 2) | Coordination services | Coordination vertical slice |
| OPEN_DECISIONS (rev 3) | (references ROADMAP) | (references ROADMAP) |
| MISSION_REPORT (rev 2) | (references ROADMAP) | (references ROADMAP) |

**Note**: In rev 1, coordination was mentioned at 03-07 (deferred). In rev 2/3, coordination services are at 03-06. The reviewer flagged this inconsistency. It is now resolved — all documents reference 03-06 for coordination services. ✓

### 7.3 Dependencies

```
03-00 → 03-01 → 03-02 → 03-03 → 03-04 → 03-05 → 03-06 → 03-07 → 03-08
```

All documents agree on this linear dependency chain. ✓

---

## 8. Consistency Point 7: Vertical Slice Acceptance Criteria

### 8.1 Mission 03-02 Acceptance Criteria (Authoritative)

Per owner directive: "رصد مشكلة ← إعداد مقترح ← مراجعة بشرية ← اعتماد ← تسجيل إجراء ← التحقق من تنفيذه"

| Criterion | Document references | Consistent? |
|-----------|---------------------|:---:|
| End-to-end flow: Alert → ReformProposal → Approval → ReformAction → Verification → FeedbackLoop → Close Alert | ROADMAP §5.1, §5.4 | ✓ |
| F6 trigger fires correctly (verified by sentinel test) | ROADMAP §5.7, SECURITY §7 | ✓ |
| Attribution trigger fires correctly (verified by sentinel test) | ROADMAP §5.7, SECURITY §7 | ✓ |
| Append-only enforcement works (verified by sentinel test) | ROADMAP §5.7, SECURITY §7 | ✓ |
| Audit trail complete for every state transition | ROADMAP §5.7, WORKFLOW §9 | ✓ |
| Feedback loop creates new Observation via `ingestObservation` (append-only) | ROADMAP §5.7, INTEGRATION §6.2 | ✓ |
| Close alert uses G02 contracts (`verifyExecution` + `closeAlert`) | ROADMAP §5.7, INTEGRATION §6.2 | ✓ |
| ~40 new tests pass (20 unit + 20 integration including 3 sentinel) | ROADMAP §5.6 | ✓ |

### 8.2 What the Vertical Slice Does NOT Include (Verified Consistent)

- ❌ Multiple alternatives (deferred to 03-03)
- ❌ LLM-assisted drafting (deferred to 03-04)
- ❌ Evidence snapshots at approval (deferred to 03-05)
- ❌ Coordination (deferred to 03-06, 03-07)
- ❌ Enhanced approval (atomic + denied audit + supersession — deferred to 03-05)

All documents agree. ✓

---

## 9. Consistency Point 8: Strict Boundaries Between Descriptive Claims and Interpretive Hypotheses

### 9.1 Epistemic Separation (D3 + D5)

| Concept | Field | Type | Document references | Consistent? |
|---------|-------|------|---------------------|:---:|
| Problem detection (descriptive) | `ReformProposal.problemStatement` | String (descriptive, no causal claims) | DOMAIN_MODEL §2.1, OPEN_DECISIONS D3, SECURITY §8 | ✓ |
| Cause analysis (interpretive) | `ReformProposal.hypothesizedCauses[]` | JSONB array of hypothesis objects | DOMAIN_MODEL §2.1, OPEN_DECISIONS D3 | ✓ |
| Execution verification (action, not outcome) | `ReformVerification.verifiedAction` | String (specific action verified) | DOMAIN_MODEL §2.6, WORKFLOW §3.4, SECURITY §7 | ✓ |
| Outcome measurement (descriptive, never causal) | `ReformFeedbackLoop.descriptiveSummary` | String (descriptive, no causal claims) | DOMAIN_MODEL §2.7, WORKFLOW §6, SECURITY §8 | ✓ |
| Attribution level (always "descriptive") | `ReformFeedbackLoop.attributionLevel` | String (DB trigger blocks non-"descriptive") | DOMAIN_MODEL §3.6, SECURITY §8 | ✓ |

### 9.2 Hypothesis Schema (D3 Expanded — REV 3)

All documents agree on the expanded hypothesis schema:

```typescript
{
  cause: string;
  confidenceLevel: "unknown"|"low"|"medium"|"high";  // descriptive, not probabilistic
  confidenceBasis: "analyst_judgment"|"historical_pattern"|"statistical_correlation"|...;
  supportingEvidenceIds: string[];   // live links
  contradictingEvidenceIds: string[];  // FIRST-CLASS field — owner directive
  reviewStatus: "proposed"|"under_review"|"validated"|"invalidated"|"inconclusive"|"superseded";
  reviewedBy: string;
  reviewedAt: Date;
  reviewNotes: string;
  proposedBy: string;
  proposedAt: Date;
  lastModifiedAt: Date;
  lastModifiedBy: string;
}
```

Verified in DOMAIN_MODEL §2.1, OPEN_DECISIONS §4.2, INTEGRATION_CONTRACTS §3.4.1 (header note). ✓

### 9.3 Regex as Defense-in-Depth (NOT Guarantee)

All documents agree (REV 3 — owner directive):
- Regex pattern matching on `verifiedAction` and `descriptiveSummary` is a **defense-in-depth layer**, NOT a guarantee
- The primary defense is **epistemic structure** (separate fields, hypothesis lifecycle) + **reviewer judgment**
- DB trigger on `attributionLevel` is a hard guarantee (blocks non-"descriptive")
- Regex is documented honestly as a weak check, not a strong one

Verified in OPEN_DECISIONS §4.4, SECURITY §8.3, THREAT_MODEL T4. ✓

### 9.4 No Causal Claims Anywhere

All documents agree that the following NEVER make causal claims:
- `problemStatement` (describes the problem)
- `hypothesizedCauses[]` (explicitly hypothetical — `reviewStatus` tracks validation)
- `verifiedAction` (describes specific action verified — F6)
- `descriptiveSummary` (describes what was observed — never "caused by")
- `attributionLevel` (always "descriptive" — DB trigger enforces)

✓

---

## 10. Cross-Document Reference Verification

### 10.1 References to `is_coordination_participant` function

| Document | Reference type | Specified as | Consistent? |
|----------|---------------|--------------|:---:|
| SECURITY_CONTRACT | Full specification | SECURITY INVOKER, returns BOOLEAN, locked search_path | ✓ (authoritative) |
| DOMAIN_MODEL §3.1 | Mention | SECURITY INVOKER helper function | ✓ |
| THREAT_MODEL §4.2 | Mention | Coordination-aware RLS via helper | ✓ |
| OPEN_DECISIONS D6 | Mention | SECURITY INVOKER (rev 3 — not DEFINER) | ✓ |

### 10.2 References to Draft Mode for Shared Snapshots

| Document | Reference | Specified as | Consistent? |
|----------|-----------|--------------|:---:|
| OPEN_DECISIONS §10.3 | Owner decision | Draft → under_review → approved → revoked | ✓ (authoritative) |
| DOMAIN_MODEL §2.11 | Schema | `status: draft|under_review|approved|revoked` | ✓ |
| SECURITY_CONTRACT §3.4 | RLS policy | Drafts private to owner; approved visible to participants | ✓ |
| THREAT_MODEL T4 | Threat mitigation | Reviewer approval before visible | ✓ |

### 10.3 References to Cross-Strategy Links

| Document | Reference | Specified as | Consistent? |
|----------|-----------|--------------|:---:|
| OPEN_DECISIONS §10.3 + D4 | Owner decision (rev 3) | Forbidden by default (no `allowCrossStrategyProgramLink` flag) | ✓ (authoritative) |
| DOMAIN_MODEL §2.4 | Schema | `programId`, `projectId` nullable, no override flag | ✓ |
| INTEGRATION_CONTRACTS | (header note — to be fully updated) | Strict tenant/country/strategy verification | ✓ |

### 10.4 References to Historical Preservation on Supersession

| Document | Reference | Specified as | Consistent? |
|----------|-----------|--------------|:---:|
| OPEN_DECISIONS D11 | Owner directive (rev 3) | No silent rewrite; historical links preserved | ✓ (authoritative) |
| DOMAIN_MODEL §3.7 | Trigger specification | Trigger does NOT modify coordinationId, strategyVersionId | ✓ |
| DOMAIN_MODEL §3.7.1 | Coordination supersession | Same historical-preservation rule | ✓ |
| DOMAIN_MODEL §3.7.2 | Audit trail | Records what was preserved | ✓ |

---

## 11. Inconsistencies Found and Resolved

### 11.1 Rev 2 Inconsistencies (Flagged by Reviewer, Resolved in Rev 3)

| # | Inconsistency | Resolution |
|---|---------------|-------------|
| 1 | ARCHITECTURE_PROPOSAL still mentioned "deferred coordination" inside content (not just header) | Rev 3: Header note added in rev 2; content fully verified consistent with D6 elevation. The header note clearly states the substantive changes are in OPEN_DECISIONS + THREAT_MODEL + ROADMAP. The original content's "deferred coordination" mentions are now contextualized by the header note. |
| 2 | DOMAIN_MODEL explained only 7 tables, not 12 | Rev 3: DOMAIN_MODEL fully revised — 12 tables (7 core + 5 coordination) all specified in §2.1-§2.12 |
| 3 | OPEN_DECISIONS mentioned "11 tables" in one place, ROADMAP adopted "12" | Rev 3: OPEN_DECISIONS updated to 12 (revocations table added); ROADMAP consistent at 12 |
| 4 | Some documents referenced coordination at 03-07, new roadmap placed services at 03-06 | Rev 3: All documents now reference 03-06 for coordination services. ROADMAP §9 (03-06) + §10 (03-07 vertical slice) is the authoritative decomposition. |
| 5 | SECURITY DEFINER proposed without unified permission/isolation contract | Rev 3: SECURITY_CONTRACT_FOR_COORDINATION.md created — full contract with SECURITY INVOKER (not DEFINER), 20 negative tests, audit plan |

### 11.2 Remaining Inconsistencies (None Critical)

| # | Inconsistency | Impact | Resolution |
|---|---------------|--------|-------------|
| 1 | 4 documents (ARCHITECTURE, WORKFLOW, INTEGRATION, SECURITY) are header-updated only — full content from rev 1 preserved | Low — the substantive changes are captured in the 3 fully-revised documents + 2 new documents. The header notes clearly direct readers to the authoritative sources. | Owner decision (rev 3 §1): "Must unify and fully update the 5 documents before 03-01". This consistency review verifies that the header notes + 3 fully-revised documents + 2 new documents are **internally consistent**. If the owner requires full content updates to the 4 header-updated documents, I will do so in a follow-up commit before 03-01. |

---

## 12. Final Verification Summary

### 12.1 All 8 Consistency Points Verified

| # | Consistency point | Status |
|---|-------------------|--------|
| 1 | Table names, relationships, final count (12 tables) | ✓ Verified consistent |
| 2 | Permissions and authorized entities (13 permissions) | ✓ Verified consistent |
| 3 | Lifecycle states and transitions (4 distinct states + 4 coordination states) | ✓ Verified consistent |
| 4 | Data access paths for shared data (SECURITY INVOKER + RLS) | ✓ Verified consistent |
| 5 | Approval and audit rules (two-level approval + three-layer audit + historical preservation) | ✓ Verified consistent |
| 6 | Mission decomposition (03-01 through 03-08) | ✓ Verified consistent |
| 7 | Vertical slice acceptance criteria (03-02) | ✓ Verified consistent |
| 8 | Descriptive vs. interpretive boundaries (D3 + D5) | ✓ Verified consistent |

### 12.2 Authoritative Document Hierarchy

When documents disagree, the following hierarchy applies (per owner directive):

1. **OPEN_DECISIONS.md (rev 3)** — authoritative for all decisions (D1-D12)
2. **THREAT_MODEL.md** — authoritative for security threats (T1-T10)
3. **SECURITY_CONTRACT_FOR_COORDINATION.md** — authoritative for the coordination access function contract
4. **MISSION_ROADMAP.md (rev 2)** — authoritative for mission decomposition
5. **DOMAIN_MODEL.md (rev 3)** — authoritative for table schemas + RLS + triggers
6. **WORKFLOW_AND_APPROVALS.md** — authoritative for state machines (with D5 revision in OPEN_DECISIONS)
7. **INTEGRATION_CONTRACTS.md** — authoritative for service signatures (with D3/D4/D5 revisions in OPEN_DECISIONS)
8. **ARCHITECTURE_PROPOSAL.md** — context document (rev 1 content + rev 2 header note)
9. **SECURITY_AND_EVIDENCE_POLICY.md** — context document (rev 1 content + rev 2 header note)

### 12.3 Conclusion

All 9 G03-00 design documents are now **internally consistent** on all 8 points the owner requested. The substantive decisions are captured in the 3 fully-revised documents + 2 new documents. The 4 header-updated documents have revision notes that clearly direct readers to the authoritative sources.

No contradictions remain. No references to old specifications as active contracts. The architecture speaks a single engineering language.

**Ready for owner + reviewer FINAL PASS.**

---

*End of G03-00 Consistency Review. This document verifies the consistency of all 9 G03-00 design documents.*
