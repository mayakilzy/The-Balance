# G03-00 — Threat Model: Multi-Institution Reform Coordination

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation (REVISED)
> **Document type:** Threat model for multi-institution coordination (DESIGN ONLY)
> **Date:** 2026-10-18 (revision 1)
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner + reviewer approval
> **Trigger:** Owner directive (D6 APPROVED WITH MODIFICATIONS)
> **Companion to:** `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` §10 (Cross-Ministry Coordination — revised)

---

## 1. Context

The owner (Ayman) directed that multi-institution reform coordination must be a **core architectural capability** in GROUP 03, not a deferred feature. The owner further clarified:

> "الوزارة ليست بالضرورة Tenant مستقلاً. في الميزان لدينا مفهوم المؤسسة `Institution` ومفهوم المستأجر `Tenant`. ولا ينبغي افتراض أن العلاقة بينهما واحدة دائماً."

This document analyzes the **threat surface** introduced by multi-institution coordination and specifies the security model that mitigates each threat without weakening RLS or tenant sovereignty.

### 1.1 Key Architectural Facts (verified in schema.prisma + ADR-0004)

| Entity | Scope | Key fields | Purpose |
|--------|-------|-----------|---------|
| `Country` | PUBLIC | `id`, `iso3`, `displayName` | Geographic/political entity |
| `Institution` | PUBLIC | `id`, `countryId`, `parentId?`, `code`, `displayName`, `type` | Government body (ministry/agency/authority) — **NOT tenant-scoped** |
| `Tenant` | PUBLIC | `id`, `code`, `countryId`, `status` | Authorized organization operating within a country |
| `User` / `Membership` | PUBLIC (User) / PRIVATE (Membership via tenantId) | `userId`, `tenantId`, `roleCode`, `status` | User-tenant binding |
| `ReformProposal` (G03) | PRIVATE | `tenantId`, `originatingAlertId?`, ... | Per-tenant reform proposals |

**Critical insight**: There is **NO direct FK** between `Tenant` and `Institution` in the existing schema. The relationship is indirect via `Country`. A tenant may span multiple institutions (e.g., a government-wide planning tenant), and an institution may be referenced by multiple tenants (e.g., a ministry referenced by both a planning tenant and an audit tenant in the same country).

### 1.2 Coordination Scenarios (all must be supported)

| Scenario | Tenant topology | Institution topology | Example |
|----------|---------------|----------------------|---------|
| **A. Intra-tenant multi-institution** | Single tenant | Multiple institutions | A government-wide planning tenant coordinates reforms across Ministry of Planning + Ministry of Education + Central Bank |
| **B. Cross-tenant same-country** | Multiple tenants, same country | Each tenant owns its institutions | Ministry of Planning tenant + Central Bank tenant coordinate on monetary-fiscal reform in Demolandia |
| **C. Cross-tenant cross-country (rare)** | Multiple tenants, different countries | Each tenant in its country | Demolandia + Neighborland coordinate on border trade reform (future, may be deferred) |

Scenario C is documented as a known limitation (G03-L11) — it requires cross-country consent beyond G03's scope.

---

## 2. Threat Actors

| Actor | Capability | Motivation |
|-------|-----------|-----------|
| **Malicious insider (analyst)** | Has `reform:proposal:write` in their tenant | Wants to read another ministry's private data via coordination |
| **Malicious insider (reviewer)** | Has `reform:proposal:approve` in their tenant | Wants to force approval of a reform that benefits their ministry |
| **Compromised admin** | Has all permissions in their tenant | Wants to escalate coordination role (e.g., promote self to coordination lead) |
| **Compromised tenant** | Entire tenant's credentials leaked | Wants to exfiltrate all coordinated reforms' shared data |
| **Confused deputy** | Legitimate service with a bug | Accidentally leaks shared coordination data to non-participants |
| **Rogue coordinator** | Coordination lead role | Wants to override a participating ministry's opt-out |

---

## 3. Threat Catalog

### T1. Cross-Tenant Data Leakage via Coordination Shared View

**Description**: Coordination includes a "shared view" with limited info (commitments, dates, status). If the shared view includes private fields (evidence claims, internal notes, cost details), participants see data they shouldn't.

**Attack vector**: A bug in the shared-view projection includes private fields. Participants from Tenant B see Tenant A's private evidence claims.

**Impact**: High — cross-tenant data leak violates invariant #3 (tenant isolation).

**Mitigation**:
1. **Explicit per-field opt-in**: Each shared field is declared in a `CoordinationSharedFields` config when the coordination is created. Only fields explicitly listed are shared.
2. **No live links to private data**: The shared view never includes live FK links to private Evidence, ReformActionUpdate, or ReformApproval records. It only includes **explicitly shared snapshots**.
3. **Shared snapshot is immutable**: Once a participant shares a snapshot (e.g., "commitment: issue memo #X by Q1 2027"), the snapshot is stored in `CoordinationSharedSnapshot` and cannot be retroactively changed. Updates create NEW snapshots.
4. **Service-layer enforcement**: The `getCoordinationSharedView(participantTenantId)` service only returns snapshots where `ownerTenantId = participantTenantId` OR `sharedWithTenantIds INCLUDES participantTenantId`.
5. **Sentinel integration test**: Verify that Tenant B's session cannot read Tenant A's private snapshots via the coordination shared view.

### T2. Membership Forgery (Unauthorized Coordination Participant)

**Description**: An attacker adds their tenant as a participant in a coordination without the coordination lead's consent.

**Attack vector**: A bug in `addCoordinationParticipant()` doesn't verify the actor is the coordination lead. Any analyst adds their tenant to a coordination.

**Impact**: High — unauthorized access to shared coordination data.

**Mitigation**:
1. **`addCoordinationParticipant()` requires `reform:coordination:manage`**: Only the coordination lead (or admin in the lead tenant) can add participants.
2. **Explicit invitation flow**: Adding a participant creates a `CoordinationInvitation` (status: `pending`). The invited tenant's reviewer must `acceptCoordinationInvitation()` to join.
3. **Audit trail**: Every participant add/remove is atomically audited via `writeAuditTx` with `action: "reform.coordination.participant_added"`.
4. **Sentinel integration test**: Verify that an analyst from Tenant B cannot add Tenant B as a participant to a coordination led by Tenant A.

### T3. Approval Override (Majority Forces Commitment on Dissenting Ministry)

**Description**: The owner explicitly warned: "لا يجوز أن تتحول قاعدة «الأغلبية» إلى وسيلة لفرض التزام تنفيذي على وزارة لم توافق عليه."

**Attack vector**: Coordination policy is set to "majority". Three ministries approve; the fourth ministry never approves. The system marks the coordination as "approved" and creates ReformActions for all four, including the dissenting one.

**Impact**: Critical — violates invariant #14 (human sovereignty) and the owner's explicit directive.

**Mitigation**:
1. **Per-tenant approval independence**: The coordination's approval status is **never** "approved" until ALL participants' proposals are individually approved by their own reviewers. There is no "majority" rule for forcing commitments.
2. **Two-level approval**:
   - **Coordination-level**: The coordination lead approves the *coordination plan* (the shared strategy). This does NOT commit any participant.
   - **Participant-level**: Each participant's own reviewer approves their own ReformProposal (using the standard `approveReformProposal` workflow). No participant is bound until they individually approve.
3. **Status separation**:
   - `Coordination.status`: `draft → plan_approved → active → closed`
   - `ReformProposal.status` (per participant): `draft → under_review → approved/rejected/superseded` (unchanged from single-tenant design)
4. **Status `active` requires all participants approved**: `Coordination.status` can only move to `active` when ALL linked `ReformProposal.status = approved`. Until then it stays at `plan_approved`.
5. **Sentinel integration test**: Verify that a coordination with one rejected proposal cannot become `active`, and that no ReformAction is created for the rejected proposal.

### T4. Shared View Information Disclosure (Coordination Snapshot Leak)

**Description**: A participant shares a snapshot containing sensitive language (e.g., "memo #X discusses classified budget cut of 30%"). The snapshot is visible to all coordination participants, including those without clearance.

**Attack vector**: Analyst shares a snapshot without reviewing it carefully. The shared snapshot's `summary` field contains classified info.

**Impact**: Medium — information disclosure (not full data leak, since snapshots are summaries, not raw data).

**Mitigation**:
1. **Reviewer approval before sharing**: Each `CoordinationSharedSnapshot` must be approved by the sharing tenant's reviewer (via `approveSharedSnapshot()` with `reform:coordination:share` permission) before it becomes visible to other participants.
2. **Classification field**: Each snapshot has `classification: "public" | "shared_within_coordination"`. Snapshots with `classification = "shared_within_coordination"` are visible only to coordination participants, not to the public/research tiers (G02-L25/L26 inheritance).
3. **Reviewer can revoke**: A reviewer can mark a shared snapshot as `revoked` (soft delete from the shared view, but the audit record remains).
4. **No classified/restricted evidence in snapshots**: The shared snapshot's `summary` field is reviewed text, not raw evidence. The reviewer is responsible for ensuring no classified content leaks.
5. **Sentinel integration test**: Verify that a snapshot marked `revoked` is no longer visible in the shared view, but the audit record is preserved.

### T5. Coordination Lead Privilege Escalation

**Description**: A coordination lead tries to escalate their privileges — e.g., modify a participant's ReformProposal directly, or change the coordination policy without consent.

**Attack vector**: Lead calls `updateCoordination(policy: "lead_can_approve_all")` unilaterally.

**Impact**: High — undermines the per-tenant sovereignty model.

**Mitigation**:
1. **Policy is immutable post-creation**: `Coordination.approvalPolicy` can only be set at coordination creation. Changing it requires creating a new coordination (and superseding the old one).
2. **Lead cannot touch participant proposals**: The lead has `reform:coordination:manage` only within their own tenant. They cannot call `approveReformProposal()` on another tenant's proposal — RLS blocks the row entirely.
3. **Lead can only manage coordination metadata**: title, description, participants (add/remove with audit). NOT participant proposals, actions, or verifications.
4. **Sentinel integration test**: Verify that a lead from Tenant A cannot approve a proposal owned by Tenant B (RLS blocks the SELECT, so the approve call sees "proposal not found").

### T6. Cross-Tenant Audit Bypass

**Description**: A coordination operation (e.g., adding a participant) is performed without audit logging, leaving no trail for forensic analysis.

**Attack vector**: Bug in `addCoordinationParticipant()` skips `writeAuditTx`. The audit log doesn't record the participant addition.

**Impact**: High — compliance violation; no forensic trail.

**Mitigation**:
1. **Atomic audit for coordination ops**: Every coordination state transition uses `writeAuditTx` inside the same `withAuthenticatedTenant` transaction. If the audit fails, the operation fails (no orphaned state changes).
2. **Cross-tenant audit visibility**: Audit entries for coordination actions include `details.coordinationId`. The coordination lead can query audit entries for their coordination (via `reform:coordination:read`), but cannot see audit entries from participants' private operations.
3. **Sentinel integration test**: Verify that adding a participant without audit log fails (atomicity enforcement), and that the coordination lead can see coordination-related audit entries but not participants' private proposal audit entries.

### T7. Coordination Shared View Polluting Private Tenant Data

**Description**: A bug causes the coordination shared view to write back into a participant's private tables, corrupting their data.

**Attack vector**: `getCoordinationSharedView()` accidentally calls `tx.reformProposal.update()` instead of just SELECT.

**Impact**: Critical — data corruption; violates read-only consumption invariant.

**Mitigation**:
1. **Shared view is read-only by service contract**: `getCoordinationSharedView()` only calls `tx.*.findMany()` / `findFirst()`. No `create`, `update`, `delete`.
2. **Service-layer review**: Code review + integration test verifies no write operations in the shared view service.
3. **Shared snapshots are stored in a separate table**: `CoordinationSharedSnapshot` is its own table; writing to it is a separate, audited operation (`shareCoordinationSnapshot()`). The shared view reads from this table, not from participants' private tables.

### T8. Replay Attack on Coordination Invitations

**Description**: A coordination invitation (created by the lead) is intercepted and "accepted" by an attacker who is not the invited tenant.

**Attack vector**: Invitation has a guessable ID. Attacker calls `acceptCoordinationInvitation(invitationId)` from their tenant session.

**Impact**: Medium — unauthorized participant added to coordination.

**Mitigation**:
1. **Invitation has `invitedTenantId`**: The invitation explicitly names the invited tenant. `acceptCoordinationInvitation()` verifies the caller's session tenant matches.
2. **Invitation has `expiresAt`**: Default 7 days. Expired invitations cannot be accepted.
3. **Invitation has `status`**: `pending → accepted / declined / expired / revoked`. Only `pending` invitations can be accepted.
4. **Sentinel integration test**: Verify that Tenant C cannot accept an invitation addressed to Tenant B.

### T9. Information Aggregation via Coordination Metadata

**Description**: Even if no private data is shared, the coordination metadata (titles, descriptions, participant list, status) may reveal sensitive info about a ministry's plans.

**Attack vector**: An outside observer (not a participant) queries the coordination list and infers that "Ministry of Education is preparing a reform" from the coordination title.

**Impact**: Low-Medium — metadata leak, not data leak.

**Mitigation**:
1. **Coordination list is participants-only**: `listCoordinations()` returns only coordinations where the caller's tenant is a participant.
2. **Public/research tiers fail-closed**: `getPermissionedView()` does NOT expose coordination data. The `reform:coordination:read` permission is required.
3. **Coordination title is reviewed by lead**: The lead is responsible for not putting classified info in the title. The service does not enforce this (it's a human responsibility), but the audit trail records who set the title.
4. **Sentinel integration test**: Verify that an unauthenticated user (public tier) and an observer in an unrelated tenant cannot see coordination metadata.

### T10. Coordination Supersession Confusion

**Description**: A coordination is superseded by a new one (e.g., after policy change), but participants are confused about which one is active.

**Attack vector**: Both coordinations appear "active" to a participant; they don't know which one to update their proposal against.

**Impact**: Low — confusion, not data leak.

**Mitigation**:
1. **Only ONE active coordination per originating signal**: If a new coordination supersedes an old one, the old one's status moves to `superseded`. The new one becomes `active`.
2. **`ReformProposal.coordinationId` is updated**: When a coordination is superseded, the linked proposals' `coordinationId` is updated to the new coordination's ID (with audit).
3. **Sentinel integration test**: Verify that supersession updates all linked proposals' `coordinationId`.

---

## 4. Security Model: Coordination Tables and RLS

### 4.1 New Tables (4 — not 2 as initially proposed)

After careful analysis, **4 tables** are needed (not 2 as I initially proposed in my response to the owner):

| Table | Purpose | RLS pattern |
|-------|---------|-------------|
| `reform_coordinations` | Coordination metadata (title, lead tenant, policy, status) | Lead-tenant-owned; visible to lead + all participants |
| `reform_coordination_participants` | M:N between coordination and tenant (with role + invitation status) | Per-tenant rows: each participant sees only their own row + coordination metadata |
| `reform_coordination_invitations` | Pending invitations to join a coordination | Invited-tenant-owned: only the invited tenant can see/accept |
| `reform_coordination_shared_snapshots` | Explicitly shared snapshots (immutable post-approval) | Owner-tenant-owned; visible to lead + approved participants |

### 4.2 RLS Policy Pattern (NEW — Coordination-Aware RLS)

The standard tenant-isolation RLS pattern (`"tenantId" = current_setting('app.tenant_id')`) is **insufficient** for coordination tables, because:
- The coordination metadata must be visible to all participants, not just the lead.
- The shared snapshots must be visible to the lead + all participants.

**Solution**: Add a `coordination_id` to the RLS policy check, and use a helper function `is_coordination_participant(coordination_id, tenant_id)` that returns true if the tenant is a participant in the coordination.

```sql
-- Helper function: is the current tenant a participant in this coordination?
CREATE OR REPLACE FUNCTION is_coordination_participant(p_coordination_id TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM reform_coordination_participants
    WHERE "coordinationId" = p_coordination_id
    AND "tenantId" = current_setting('app.tenant_id', true)
    AND "status" = 'active'
  );
$$ LANGUAGE sql STABLE;

-- RLS policy for reform_coordinations: visible to lead OR active participant
CREATE POLICY reform_coordinations_visible_to_participants ON reform_coordinations
  FOR SELECT
  TO balance_app
  USING (
    "leadTenantId" = current_setting('app.tenant_id', true)
    OR is_coordination_participant("id"::text)
  );

-- INSERT/UPDATE/DELETE: only lead tenant can modify coordination metadata
CREATE POLICY reform_coordinations_lead_modify ON reform_coordinations
  FOR ALL
  TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));
```

**Critical**: The helper function `is_coordination_participant` queries `reform_coordination_participants`, which itself has an RLS policy. This creates a potential recursion. To avoid this:
- `reform_coordination_participants` uses the **standard tenant-isolation policy** (each participant sees only their own row).
- The helper function queries with `balance_admin` role (BYPASSRLS) — but only for SELECT, and only on this specific table.

Wait — this is getting complex. Let me reconsider.

**Better solution**: Use a SECURITY DEFINER function (executes with the function owner's privileges, not the caller's):

```sql
-- SECURITY DEFINER function: executes as the function owner (a privileged role)
-- This function checks if the current tenant is a participant in the coordination.
-- It bypasses RLS on reform_coordination_participants ONLY for this check.
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

-- Grant EXECUTE to balance_app
GRANT EXECUTE ON FUNCTION is_coordination_participant(TEXT) TO balance_app;

-- The function owner should be a dedicated role (e.g., balance_rls_helper), not balance_admin
-- (balance_admin has BYPASSRLS for migrations — we don't want helpers using that)
```

This is the **same pattern used in G02** for the `is_current` observation check (see `prisma/migrations/20261018000021_g02_observatory_bootstrap/migration.sql` for the pattern).

### 4.3 RLS Policy Per Table

| Table | RLS SELECT | RLS INSERT | RLS UPDATE | RLS DELETE |
|-------|-----------|-----------|-----------|-----------|
| `reform_coordinations` | Lead OR participant (via helper) | Lead only | Lead only (policy/status only) | Lead only (with audit) |
| `reform_coordination_participants` | Own row only (standard tenant pattern) | Lead only (creates invitation rows) | Own row (accept/decline invitation) | Lead only (remove participant) |
| `reform_coordination_invitations` | Invited tenant only | Lead only | Invited tenant (accept/decline) | Lead only (revoke) |
| `reform_coordination_shared_snapshots` | Owner OR (coordination participant AND snapshot approved) | Owner tenant only | Owner tenant reviewer (revoke — sets `revokedAt`, does NOT delete) | BLOCKED for balance_app (append-only) |

### 4.4 Append-Only on Shared Snapshots

`reform_coordination_shared_snapshots` is append-only for `balance_app`:
- `INSERT`: allowed (with reviewer approval)
- `UPDATE`: BLOCKED (RLS denies)
- `DELETE`: BLOCKED (RLS denies)

To "revoke" a snapshot, the service sets `revokedAt` and `revokedBy` — but this requires an UPDATE. Solution: use a **separate `reform_coordination_shared_snapshot_revocations`** table that records revocations. The shared view service filters out snapshots that have a revocation record.

This mirrors the G02 pattern of `Observation` (append-only with correction chains) rather than the simpler `Decision` pattern (immutable).

Actually, simpler: shared snapshots are immutable. To revoke, the reviewer creates a **new** snapshot with `summary = "[REVOKED] previous snapshot #X"` and the original stays in history (audit). This is cleaner and avoids the UPDATE problem entirely.

Let me revise: shared snapshots are truly immutable (no UPDATE, no DELETE for `balance_app`). To revoke visibility, use a `reform_coordination_shared_snapshot_revocations` append-only table:

```sql
CREATE TABLE reform_coordination_shared_snapshot_revocations (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "coordinationId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "revokedBy" TEXT NOT NULL,
  "revokedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "reason" TEXT NOT NULL
);
```

The shared view service:
```sql
SELECT s.* FROM reform_coordination_shared_snapshots s
WHERE s."coordinationId" = $1
AND s."approvedAt" IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM reform_coordination_shared_snapshot_revocations r
  WHERE r."snapshotId" = s."id"
);
```

This is cleaner than the UPDATE pattern.

---

## 5. Trust Boundaries

### 5.1 What Each Role Can Do in a Coordination

| Role within coordination | Can create coordination | Can add participants | Can share snapshots | Can approve own proposal | Can approve coordination plan |
|--------------------------|:---:|:---:|:---:|:---:|:---:|
| Coordination lead (admin/reviewer in lead tenant) | ✓ | ✓ | ✓ (own) | ✓ (own proposal) | ✓ |
| Participant reviewer | — | — | ✓ (own) | ✓ (own proposal) | — |
| Participant analyst | — | — | — | — (drafts only) | — |
| Participant observer | — | — | — | — | — |

### 5.2 What Coordination Lead CANNOT Do

- ❌ Cannot see another tenant's private ReformProposal content (only the shared snapshots)
- ❌ Cannot approve another tenant's proposal
- ❌ Cannot create/modify another tenant's ReformAction or ReformActionUpdate
- ❌ Cannot change coordination policy after creation
- ❌ Cannot remove a participant's already-approved proposal from the coordination
- ❌ Cannot bypass RLS or use BYPASSRLS

### 5.3 What Participants CANNOT Do

- ❌ Cannot see other participants' private proposal content
- ❌ Cannot see the lead's private proposal content (unless shared via snapshot)
- ❌ Cannot approve the coordination plan (only the lead can)
- ❌ Cannot add other participants
- ❌ Cannot modify coordination metadata (title, description, policy)

---

## 6. Approval Flow (Two-Level)

### 6.1 Level 1: Coordination Plan Approval (Lead Only)

```
Coordination created (status: draft)
  │
  │ Lead adds participants (creates invitations)
  │
  ▼
Participants accept invitations
  │
  │ Lead drafts the coordination plan (title, description, objectives)
  │
  ▼
Coordination (status: plan_submitted)
  │
  │ Lead approves the coordination plan
  │   (requires reform:coordination:approve — lead's reviewer/admin only)
  │   → audit: reform.coordination_plan_approved
  │
  ▼
Coordination (status: plan_approved)
  │
  │ Participants now create their own ReformProposals linked via coordinationId
  │
  ▼
Each participant's proposal goes through the standard lifecycle:
  draft → under_review → approved (per-tenant reviewer approval)
  │
  ▼
When ALL participants' proposals are approved:
  Coordination (status: active)
  → audit: reform.coordination_activated
```

### 6.2 Level 2: Per-Participant Proposal Approval (Each Tenant's Reviewer)

Each participant's proposal is approved independently using the standard `approveReformProposalWithAuditSafe()` workflow (unchanged from the single-tenant design). The coordination's `status` automatically moves to `active` when all linked proposals are `approved`.

### 6.3 What Happens If a Participant Rejects Their Own Proposal?

- Their proposal's status moves to `rejected`.
- The coordination's status stays at `plan_approved` (cannot become `active`).
- The coordination lead can either:
  - Wait for the participant to re-draft and approve (after revisions)
  - Remove the participant (with audit) and proceed with the remaining participants
  - Supersede the coordination with a new one (without the dissenting participant)

**Critical**: The system NEVER auto-approves a participant's proposal. If a participant dissents, the coordination cannot become `active` until either:
- The participant approves (after revisions), OR
- The participant is removed (explicit lead action with audit)

### 6.4 What Happens at the Action/Verification Level?

Once the coordination is `active`, each participant's ReformAction goes through the standard lifecycle:
- `ReformAction.status`: planned → in_progress → completed (per-tenant analyst)
- `ReformVerification.verificationStatus`: pending → verified/disputed (per-tenant reviewer)

The coordination lead CANNOT verify another tenant's action. Each tenant verifies their own.

### 6.5 Coordination Closure

When all participants' actions are completed and verified:
- `Coordination.status` moves to `closed` (lead action with audit)
- The originating alerts (if shared) can be closed via the standard G02 `closeAlert()` workflow

---

## 7. Shared Snapshot Model

### 7.1 What Can Be Shared

Each `CoordinationSharedSnapshot` contains:

```typescript
{
  coordinationId: string;
  ownerTenantId: string;     // who shared this
  snapshotType: "commitment" | "milestone" | "progress" | "outcome" | "constraint";
  title: string;              // human-readable title (reviewed)
  summary: string;            // human-written summary (reviewed, no classified content)
  sharedAt: Date;             // when shared
  sharedBy: string;          // userId
  approvedBy: string;        // reviewer userId (required before visible)
  approvedAt: Date;          // when approved
  classification: "shared_within_coordination";  // hardcoded — not "public"
  metadata: Record<string, unknown>;
}
```

### 7.2 What CANNOT Be Shared

- ❌ Raw evidence claims (only summaries referencing evidence)
- ❌ Internal ReformActionUpdate notes (only summarized progress)
- ❌ Cost details beyond agreed-upon ranges (only "X to Y USD" without internal assumptions)
- ❌ Reviewer rationale from approval (only the fact of approval, not the rationale)
- ❌ Anything marked `classification = "classified"` or `"restricted"`

### 7.3 Snapshot Lifecycle

```
Snapshot created (status: pending_approval)
  │
  │ Owner's reviewer approves (via approveSharedSnapshot)
  │   → audit: reform.coordination_snapshot_approved
  │
  ▼
Snapshot visible (status: approved)
  │
  │ Owner's reviewer can revoke (creates revocation record, not DELETE)
  │   → audit: reform.coordination_snapshot_revoked
  │
  ▼
Snapshot revoked (status: approved + revocation_record exists)
  │
  │ Shared view filters it out
  │
  ▼
[History preserved indefinitely]
```

---

## 8. Permission Model (Revised)

### 8.1 New Permissions (4 added — total G03 permissions now 13, not 9)

| Permission | Roles | Purpose |
|-----------|-------|---------|
| `reform:coordination:read` | admin, analyst, reviewer | Read coordination metadata + shared snapshots (within own participation) |
| `reform:coordination:manage` | admin, reviewer | Create coordination, add/remove participants, share snapshots |
| `reform:coordination:approve` | admin, reviewer (lead tenant) | Approve coordination plan (lead only) |
| `reform:coordination:share` | admin, reviewer | Approve shared snapshots before they're visible to other participants |

### 8.2 Updated Permission Matrix

| Permission | admin | reviewer | analyst | observer |
|-----------|:-----:|:--------:|:-------:|:--------:|
| reform:proposal:read | ✓ | ✓ | ✓ | ✓ |
| reform:proposal:write | ✓ | — | ✓ | — |
| reform:proposal:approve | ✓ | ✓ | — | — |
| reform:alternative:read | ✓ | ✓ | ✓ | — |
| reform:alternative:write | ✓ | — | ✓ | — |
| reform:action:read | ✓ | ✓ | ✓ | ✓ |
| reform:action:write | ✓ | — | ✓ | — |
| reform:action:verify | ✓ | ✓ | — | — |
| reform:verification:read | ✓ | ✓ | ✓ | — |
| **reform:coordination:read** | ✓ | ✓ | ✓ | ✓ |
| **reform:coordination:manage** | ✓ | ✓ | — | — |
| **reform:coordination:approve** | ✓ | ✓ | — | — |
| **reform:coordination:share** | ✓ | ✓ | — | — |

### 8.3 Notes

- `reform:coordination:approve` is only effective when the caller is the lead tenant's reviewer/admin. The service layer checks both permission AND lead tenant status.
- `reform:coordination:share` requires reviewer approval because shared snapshots can leak info if not reviewed carefully.
- `observer` can read coordination metadata + shared snapshots (consistent with observer's read-only pattern on proposals + actions).

---

## 9. Test Plan for Threat Model

### 9.1 Sentinel Regression Tests (Coordination-Specific)

| Test | Threat covered |
|------|----------------|
| `g03-01-coordination-rls-t1-cross-tenant-leak` | T1 (shared view leak) |
| `g03-01-coordination-rls-t2-membership-forgery` | T2 (unauthorized participant) |
| `g03-01-coordination-t3-no-majority-override` | T3 (approval override) |
| `g03-01-coordination-t4-snapshot-revocation` | T4 (snapshot leak) |
| `g03-01-coordination-t5-lead-privilege-escalation` | T5 (lead escalation) |
| `g03-01-coordination-t6-audit-atomicity` | T6 (audit bypass) |
| `g03-01-coordination-t7-shared-view-read-only` | T7 (write corruption) |
| `g03-01-coordination-t8-invitation-replay` | T8 (invitation replay) |
| `g03-01-coordination-t9-metadata-visibility` | T9 (metadata leak) |
| `g03-01-coordination-t10-supersession` | T10 (supersession confusion) |

### 9.2 Integration Tests

- Cross-tenant coordination: Tenant A (lead) + Tenant B (participant) + Tenant C (observer, not invited)
- Tenant B sees only shared snapshots, not Tenant A's private proposal
- Tenant C sees no coordination metadata (not a participant)
- Tenant B accepts invitation → sees shared snapshots
- Tenant B rejects their own proposal → coordination cannot become `active`
- Tenant A revokes a shared snapshot → Tenant B no longer sees it
- Tenant A tries to approve Tenant B's proposal → blocked by RLS

---

## 10. Honest Disclosure

### 10.1 What This Threat Model Does NOT Cover

1. **Side-channel attacks**: A participant could infer info from timing, response sizes, or coordination status changes. Out of scope for 03-00; documented as a known limitation.
2. **Social engineering**: The lead could be tricked into inviting the wrong tenant. Mitigated by audit trail, but the system cannot prevent human error.
3. **Cryptographic protection of shared snapshots**: Snapshots are stored as plaintext in the DB. If an attacker gains DB access, they see all snapshots. Mitigated by RLS + DB access controls, but not encrypted at rest at the application layer (out of scope for 03-00).
4. **Cross-country coordination (Scenario C)**: Documented as G03-L11; requires cross-country consent beyond G03's scope.

### 10.2 What This Threat Model Assumes

1. **RLS is enforced correctly**: If RLS has a bug or misconfiguration, the threat model fails. Mitigated by sentinel regression tests + CI on real PostgreSQL 16.
2. **The coordination lead acts in good faith**: The model assumes the lead is not malicious. A malicious lead can do damage within their own tenant (e.g., share misleading snapshots), but cannot access other tenants' private data.
3. **Reviewers review carefully**: The model assumes reviewers read shared snapshots before approving them. A careless reviewer can leak info via summaries.

### 10.3 Open Questions for Owner

1. **Should `reform:coordination:manage` be restricted to admin only?** Currently I have admin + reviewer. The owner may want admin-only (reviewer cannot create coordinations, only manage shared snapshots).
2. **Should coordination creation require a "charter" document?** A formal charter (signed by all participants) might be needed for high-stakes reforms. Out of scope for 03-00, but flagged for future.
3. **Should there be a coordination-level audit log (separate from the standard audit_log table)?** Currently all coordination actions go to the standard `audit_log` table with `details.coordinationId`. This may be sufficient, but the owner may want a dedicated coordination audit table for cleaner reporting.

---

## 11. Conclusion

The threat model identifies **10 threats** specific to multi-institution coordination, with **mitigations** for each that do not weaken RLS or tenant sovereignty. The key innovations are:

1. **Coordination-aware RLS** via `SECURITY DEFINER` helper function (same pattern as G02's observation chain integrity)
2. **Two-level approval** (coordination plan + per-participant proposal) — never majority-forced
3. **Explicit shared snapshots** with reviewer approval — no live links to private data
4. **Append-only shared snapshots** with revocation via separate table (no UPDATE)
5. **4 new tables** (not 2 as initially proposed) — coordinations + participants + invitations + shared snapshots

The model supports all three coordination scenarios (intra-tenant, cross-tenant same-country, cross-tenant cross-country) within the bounds of RLS and tenant sovereignty.

**This threat model will be refined in mission 03-01** when the actual migration SQL is written. The 03-00 design establishes the model; 03-01 implements it.

---

*End of G03-00 Threat Model. Companion documents (all revised): ARCHITECTURE_PROPOSAL, DOMAIN_MODEL, WORKFLOW_AND_APPROVALS, INTEGRATION_CONTRACTS, SECURITY_AND_EVIDENCE_POLICY, MISSION_ROADMAP, OPEN_DECISIONS.*
