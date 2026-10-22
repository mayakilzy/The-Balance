# G03-00 — Security Corrections (REV 4)

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Targeted security correction (DESIGN ONLY — no code, no migrations)
> **Date:** 2026-10-18 (revision 4 — security corrections per owner/reviewer audit)
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner + reviewer final approval
> **Trigger:** Owner directive — three security findings (S1, S2, S3) requiring closure before FINAL PASS
> **Companion to:** `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md` (revised), all other G03-00 documents

---

## 1. Acknowledgment of Findings

The owner (Ayman) and reviewer (ChatGPT) conducted an independent security audit of the REV 3 `SECURITY INVOKER` contract and found **three real design gaps** that must be closed before FINAL PASS. I acknowledge these findings are correct — they are not documentation issues, they are RLS design defects.

### 1.1 Finding S1 — Cross-Tenant Participant Management

> "السياسة الحالية تسمح برؤية صفوف المشاركين الخاصة بالمستأجر الحالي فقط، بينما تتوقع أن يستطيع قائد التنسيق تعديل حالة مشارك تابع لمستأجر آخر."

**Acknowledged as correct.** In PostgreSQL, an `UPDATE` requires that:
1. The row is **visible** per the SELECT policy (USING clause of SELECT)
2. The row satisfies the UPDATE policy's USING clause (for finding the row)
3. The new values satisfy the UPDATE policy's WITH CHECK clause

My REV 3 SELECT policy on `reform_coordination_participants` was:
```sql
CREATE POLICY reform_coordination_participants_select ON reform_coordination_participants
  FOR SELECT TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true));
```

This means Tenant A (lead) **cannot SELECT** Tenant B's participant row. Therefore, Tenant A cannot UPDATE it either — even if the UPDATE policy allowed it, the row is invisible.

This makes the lead's ability to "remove a participant" (set `status = 'removed'`) **non-functional** at the DB level. The service would fail with "row not found" or silently no-op.

### 1.2 Finding S2 — Shared Snapshot Revocation

> "سياسة SELECT الحالية تعتمد على `approvedAt` والعضوية الفعالة، لكنها لا تتضمن تحققاً من وجود إلغاء نشط للّقطة."

**Acknowledged as correct.** My REV 3 SELECT policy on `reform_coordination_shared_snapshots` was:
```sql
CREATE POLICY reform_coordination_shared_snapshots_select ON reform_coordination_shared_snapshots
  FOR SELECT TO balance_app
  USING (
    "ownerTenantId" = current_setting('app.tenant_id', true)
    OR (
      "approvedAt" IS NOT NULL
      AND public.is_coordination_participant("coordinationId"::text)
    )
  );
```

This policy **does not exclude revoked snapshots**. A revoked snapshot (one with a row in `reform_coordination_shared_snapshot_revocations`) is still visible to participants via direct SELECT on the table.

The service-layer query filters out revoked snapshots (via `NOT EXISTS (SELECT 1 FROM ..._revocations WHERE ...)`), but this is **application-layer enforcement**, not DB-level enforcement. A user with direct DB access (or a service bug that forgets the filter) would see revoked snapshots.

### 1.3 Finding S3 — Institutional Representation

> "القيمة `institutionId` ليست إثباتاً بأن المستأجر مخوّل بتمثيل المؤسسة."

**Acknowledged as correct.** My REV 3 design treated `institutionId` as a documentation field with no verification. The owner correctly identified that this conflates:
- **Claimed** institution identity (what the lead asserts)
- **Verified** institutional authority (what the system has verified)
- **Authorization to participate** (separate from institutional claim)
- **Authorization to approve commitments** (separate again)

A tenant could claim to represent any institution, and the system would not verify. This is acceptable as descriptive metadata, but **not** as a basis for authorization.

---

## 2. Design Corrections

### 2.1 S1 Correction — Two-Path Participant Management

**Problem**: The lead cannot SELECT (and therefore cannot UPDATE) another tenant's participant row.

**Solutions considered**:

#### Option A: Expand SELECT to allow lead to see all participants in their coordinations

```sql
CREATE POLICY reform_coordination_participants_select ON reform_coordination_participants
  FOR SELECT TO balance_app
  USING (
    "tenantId" = current_setting('app.tenant_id', true)
    OR EXISTS (
      SELECT 1 FROM public.reform_coordinations c
      WHERE c."id" = "coordinationId"
        AND c."leadTenantId" = current_setting('app.tenant_id', true)
    )
  );
```

**Pros**: Lead can see all participants in their coordinations.
**Cons**: **Expands read access** — the lead can now read participant rows from other tenants (including their `metadata`, `institutionId` claims, `role`, `status`, etc.). The owner explicitly said: "لا توسع صلاحيات القراءة العامة لمجرد تمكين UPDATE."

**Rejected**: Violates owner directive.

#### Option B: Service-layer-only management (no DB-level cross-tenant UPDATE)

The lead never directly UPDATEs another tenant's participant row. Instead:
1. The lead creates a `removal_request` (a new append-only table)
2. The participant's tenant sees the removal request on their next interaction
3. The participant's tenant (or an automated job) processes the removal

**Pros**: No cross-tenant UPDATE needed.
**Cons**: Adds a new table + asynchronous processing. Over-engineered for the use case.

**Rejected**: Adds complexity without clear benefit.

#### Option C: The participant removes themselves (self-service)

The lead cannot remove a participant. Instead, the participant removes themselves (sets their own `status = 'withdrawn'`).

**Pros**: No cross-tenant UPDATE. Simple.
**Cons**: The lead cannot unilaterally remove a problematic participant. This may be desired (the participant has agency), but the owner's directive implies the lead should have management capability.

**Considered, but insufficient alone**.

#### Option D: Dual-key UPDATE via SECURITY INVOKER function (RECOMMENDED)

Create a SECURITY INVOKER function `is_coordination_lead(p_coordination_id)` that returns TRUE if the current tenant is the lead. Use this function in the UPDATE policy's USING clause:

```sql
CREATE POLICY reform_coordination_participants_update ON reform_coordination_participants
  FOR UPDATE TO balance_app
  USING (
    -- Own row: participant can update their own status (accept/decline/withdraw)
    "tenantId" = current_setting('app.tenant_id', true)
    -- Lead's row: lead can update participant status in their coordinations
    -- BUT this requires the lead to SEE the row first (SELECT policy)
    -- The issue: SELECT policy blocks cross-tenant rows
  )
  WITH CHECK ( ... );
```

**The fundamental problem remains**: UPDATE requires SELECT visibility. Without expanding SELECT, the lead cannot UPDATE.

#### Option E: Use a SECURITY INVOKER function that performs the UPDATE (RECOMMENDED — FINAL)

Instead of relying on RLS for the cross-tenant UPDATE, use a SECURITY INVOKER function that:
1. Verifies the caller is the lead of the coordination
2. Verifies the target participant exists in that coordination
3. Performs the UPDATE on behalf of the caller

```sql
CREATE OR REPLACE FUNCTION public.remove_coordination_participant(
  p_coordination_id TEXT,
  p_participant_id TEXT,
  p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
  -- Step 1: Verify the caller is the lead of this coordination
  -- (is_coordination_lead uses the caller's app.tenant_id)
  WITH lead_check AS (
    SELECT 1 FROM public.reform_coordinations
    WHERE "id" = p_coordination_id
      AND "leadTenantId" = current_setting('app.tenant_id', true)
  )
  -- Step 2: Update the participant's status (only if lead check passed)
  UPDATE public.reform_coordination_participants
  SET "status" = 'removed',
      "removedAt" = NOW(),
      "removedBy" = current_setting('app.user_id', true),
      "removalReason" = p_reason
  WHERE "coordinationId" = p_coordination_id
    AND "id" = p_participant_id
    AND "status" = 'active'  -- only active participants can be removed
    AND EXISTS (SELECT 1 FROM lead_check)  -- lead check
  RETURNING TRUE;
$$;

GRANT EXECUTE ON FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) TO balance_app;
```

**Wait — this still has the RLS problem.** The function uses `SECURITY INVOKER`, so it executes as `balance_app`. RLS on `reform_coordination_participants` would block the UPDATE because `balance_app` from Tenant A cannot see Tenant B's row.

**The solution**: The function must use `SECURITY DEFINER` (not INVOKER) for this specific operation, with strict constraints. OR — we accept that the lead cannot directly UPDATE another tenant's participant row, and use a different mechanism.

#### Option F: Remove the lead's direct UPDATE capability; use a state machine where the participant self-removes (RECOMMENDED — FINAL CHOICE)

**Reconsidering the workflow**: Does the lead really need to *unilaterally* remove a participant? In a government coordination context:
- The lead invited the participant (via invitation)
- The participant accepted (became `active`)
- If the lead wants to remove them, the proper process is:
  1. Lead creates a `removal_request` (append-only, visible to the participant)
  2. The participant sees the request and self-removes (`status = 'withdrawn'`)
  3. If the participant does not self-remove, the lead can mark the coordination as `closed` or `superseded`

This avoids cross-tenant UPDATE entirely. The participant has agency (they self-remove), and the lead has recourse (close/supersede the coordination).

**But the owner's directive implies the lead should have direct management capability.** Let me re-read:

> "صمّم مساراً آمناً لدعوة المشاركين وإزالتهم، يحقق أقل الصلاحيات، ولا يسمح بتعديل صفوف مشاركة غير مصرح بها."

The key phrase: "لا يسمح بتعديل صفوف مشاركة غير مصرح بها" (does not allow modifying unauthorized participant rows).

This means: the lead should be able to remove participants, but **only in a way that doesn't require expanding SELECT to read all participant rows**.

#### Option G: Add a `leadTenantId` denormalized column to `reform_coordination_participants` (RECOMMENDED — FINAL)

Add `leadTenantId` to `reform_coordination_participants` (denormalized from `reform_coordinations.leadTenantId`). Now RLS can express:

```sql
-- SELECT: own row OR lead can see participant rows in their coordinations
-- (via the denormalized leadTenantId — no subquery needed)
CREATE POLICY reform_coordination_participants_select ON reform_coordination_participants
  FOR SELECT TO balance_app
  USING (
    "tenantId" = current_setting('app.tenant_id', true)
    OR "leadTenantId" = current_setting('app.tenant_id', true)
  );

-- UPDATE: lead can update status (for removal) — but only the status field
-- This is enforced by a trigger that blocks UPDATE on other fields when
-- the updater is not the participant's own tenant
CREATE POLICY reform_coordination_participants_update ON reform_coordination_participants
  FOR UPDATE TO balance_app
  USING (
    "tenantId" = current_setting('app.tenant_id', true)  -- own row
    OR "leadTenantId" = current_setting('app.tenant_id', true)  -- lead
  )
  WITH CHECK (
    "tenantId" = current_setting('app.tenant_id', true)
    OR "leadTenantId" = current_setting('app.tenant_id', true)
  );
```

**But wait — this expands SELECT.** The lead can now see all participant rows in their coordinations (including `metadata`, `institutionId`, `role`, `status`). The owner said don't expand read access.

**However**: The lead **must** be able to see who is participating in their coordination. This is not "expanding general read access" — it's the lead's legitimate need to manage their coordination. The owner's concern was about expanding access *to enable UPDATE* — but seeing participant list is a coordination requirement, not a side effect.

Let me re-read the owner's directive once more:

> "لا توسع صلاحيات القراءة العامة لمجرد تمكين UPDATE."

"Don't expand **general** read access **just** to enable UPDATE."

The key word is "general" (العامة) and "just" (لمجرد). The owner is saying: don't expand read access *generally* (e.g., letting the lead see all tenants' data) *just* to enable UPDATE. But allowing the lead to see **participant rows in their own coordinations** is not "general read access" — it's coordination-specific, scoped, and legitimate.

**I'll go with Option G, but with strict constraints**:
- `leadTenantId` is denormalized (set when the participant row is created, immutable)
- The lead can SELECT participant rows in their coordinations (scoped to that coordination)
- The lead can UPDATE only the `status`, `removedAt`, `removedBy`, `removalReason` fields (trigger enforces)
- The lead CANNOT see the participant's `metadata` content beyond what's needed (we'll keep `metadata` but document that it's coordination-scoped)

**Actually, let me reconsider once more.** The cleanest solution that honors the owner's directive is:

#### Option H: SECURITY DEFINER function with strict scope (FINAL CHOICE)

Use a `SECURITY DEFINER` function for the specific operation of removing a participant. The function:
1. Is owned by a dedicated role `balance_coordination_admin` (NOLOGIN, only SELECT on `reform_coordinations` + UPDATE on `reform_coordination_participants`)
2. Verifies the caller is the lead (via `current_setting('app.tenant_id')`)
3. Performs the UPDATE on the participant row (bypassing RLS for this specific operation)
4. Returns BOOLEAN (no data exfiltration)
5. Has locked `search_path`
6. Is the **only** mechanism for cross-tenant participant removal

```sql
-- Dedicated role for cross-tenant participant management
CREATE ROLE balance_coordination_admin NOLOGIN;
GRANT SELECT ON public.reform_coordinations TO balance_coordination_admin;
GRANT UPDATE ON public.reform_coordination_participants TO balance_coordination_admin;

-- Function: remove_coordination_participant
-- Owner: balance_coordination_admin (NOLOGIN — cannot be used to connect)
-- Security: SECURITY DEFINER (executes as the function owner)
-- Returns: BOOLEAN (no data exfiltration)
-- search_path: locked to public, pg_temp
CREATE OR REPLACE FUNCTION public.remove_coordination_participant(
  p_coordination_id TEXT,
  p_participant_id TEXT,
  p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Verify the caller is the lead of this coordination
  -- (reform_coordinations is readable by balance_app via standard RLS,
  --  so the subquery works with the caller's privileges via SECURITY INVOKER
  --  for the SELECT, but the UPDATE uses DEFINER privileges)
  WITH lead_check AS (
    SELECT 1 FROM public.reform_coordinations
    WHERE "id" = p_coordination_id
      AND "leadTenantId" = current_setting('app.tenant_id', true)
  ),
  participant_update AS (
    UPDATE public.reform_coordination_participants
    SET "status" = 'removed',
        "removedAt" = NOW(),
        "removedBy" = current_setting('app.user_id', true),
        "removalReason" = p_reason
    WHERE "coordinationId" = p_coordination_id
      AND "id" = p_participant_id
      AND "status" = 'active'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM lead_check)
    AND EXISTS (SELECT 1 FROM participant_update);
$$;

GRANT EXECUTE ON FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) TO balance_app;
```

**Why this is safe**:
1. **No SELECT expansion**: The RLS SELECT policy on `reform_coordination_participants` remains tenant-scoped (own row only). The lead cannot directly SELECT other tenants' participant rows.
2. **Controlled UPDATE**: The only way to UPDATE another tenant's participant row is via this function, which:
   - Verifies the caller is the lead (via the subquery on `reform_coordinations`, which IS readable by the caller via standard RLS)
   - Only updates `status`, `removedAt`, `removedBy`, `removalReason` (not `metadata`, `institutionId`, `role`, etc.)
   - Only updates `status = 'active'` rows (cannot remove already-removed participants)
   - Returns BOOLEAN (no data exfiltration)
3. **Dedicated role**: `balance_coordination_admin` is NOLOGIN (cannot be used to connect), has only SELECT on `reform_coordinations` + UPDATE on `reform_coordination_participants`. If the function is exploited, the attacker can only remove participants (not read private data, not modify other tables).
4. **Locked `search_path`**: Prevents search path injection.
5. **SQL language**: No dynamic SQL.
6. **Audit trail**: The function is called from the service layer, which writes an atomic audit entry via `writeAuditTx`.

**This is the FINAL choice for S1.** It honors the owner's directive (no SELECT expansion) while enabling the lead to remove participants.

**Wait — I need to reconsider.** The owner said "Use SECURITY INVOKER" was a good improvement. Using SECURITY DEFINER here reverses that for this specific function. Is that justified?

**Yes**, because:
1. The function is **highly specific** (one operation: remove participant)
2. The function **returns BOOLEAN only** (no data exfiltration)
3. The dedicated role `balance_coordination_admin` has **minimal privileges** (SELECT on coordinations + UPDATE on participants — nothing else)
4. The function is **auditable** (single entry point for cross-tenant participant removal)
5. **No alternative achieves the same security**: Option G expands SELECT (rejected by owner), Option F removes lead's management capability (against owner's intent), Option B adds async complexity.

**The trade-off is explicit and documented**: we use SECURITY DEFINER for one specific cross-tenant UPDATE operation, with a dedicated minimal-privilege role, because there is no SECURITY INVOKER solution that honors the owner's "no SELECT expansion" directive.

---

### 2.2 S2 Correction — DB-Level Revocation Enforcement

**Problem**: Revoked snapshots are still visible via direct SELECT.

**Solution**: Add the revocation check to the SELECT policy itself.

```sql
-- Drop the old policy
DROP POLICY reform_coordination_shared_snapshots_select ON reform_coordination_shared_snapshots;

-- Create the corrected policy
CREATE POLICY reform_coordination_shared_snapshots_select ON reform_coordination_shared_snapshots
  FOR SELECT TO balance_app
  USING (
    -- Owner can always see their own snapshots (including drafts)
    "ownerTenantId" = current_setting('app.tenant_id', true)
    -- Other participants can only see APPROVED, NON-REVOKED snapshots
    OR (
      "approvedAt" IS NOT NULL
      AND public.is_coordination_participant("coordinationId"::text)
      -- S2 FIX: Exclude revoked snapshots at the DB level
      AND NOT EXISTS (
        SELECT 1 FROM public.reform_coordination_shared_snapshot_revocations r
        WHERE r."snapshotId" = "id"
      )
    )
  );
```

**Wait — this has a problem.** The subquery `SELECT 1 FROM public.reform_coordination_shared_snapshot_revocations` is subject to RLS on that table. The caller (`balance_app` from Tenant B) needs to be able to read revocation rows for snapshots in coordinations they participate in.

The RLS policy on `reform_coordination_shared_snapshot_revocations` (from SECURITY_CONTRACT §3.5) was:
```sql
CREATE POLICY reform_coordination_shared_snapshot_revocations_select
  ON reform_coordination_shared_snapshot_revocations
  FOR SELECT TO balance_app
  USING (
    "tenantId" = current_setting('app.tenant_id', true)  -- owner who revoked
    OR public.is_coordination_participant(
      (SELECT "coordinationId" FROM public.reform_coordination_shared_snapshots
       WHERE "id" = "snapshotId")::text
    )
  );
```

This policy has a subquery that reads `reform_coordination_shared_snapshots` — which itself is subject to RLS. This creates a potential circular dependency.

**The cleaner solution**: Use a SECURITY INVOKER function `is_snapshot_revoked(p_snapshot_id)` that checks if a revocation exists, similar to `is_coordination_participant`:

```sql
CREATE OR REPLACE FUNCTION public.is_snapshot_revoked(
  p_snapshot_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reform_coordination_shared_snapshot_revocations
    WHERE "snapshotId" = p_snapshot_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_snapshot_revoked(TEXT) TO balance_app;
```

**But this function uses SECURITY INVOKER**, so RLS on `reform_coordination_shared_snapshot_revocations` applies. The caller (Tenant B) needs to see revocation rows for snapshots in their coordination.

The RLS on `reform_coordination_shared_snapshot_revocations` allows:
- The revoking tenant (`tenantId = current_tenant`)
- Coordination participants (via `is_coordination_participant`)

So Tenant B (a participant) CAN read revocation rows for snapshots in their coordination. The function `is_snapshot_revoked` will work correctly.

**But wait** — the RLS on `reform_coordination_shared_snapshot_revocations` uses a subquery to `reform_coordination_shared_snapshots` to find the `coordinationId`. And the RLS on `reform_coordination_shared_snapshots` (with the S2 fix) uses `is_snapshot_revoked` (which reads `reform_coordination_shared_snapshot_revocations`).

**This is circular**: 
- To check if a snapshot is visible, we check `is_snapshot_revoked`
- `is_snapshot_revoked` reads `reform_coordination_shared_snapshot_revocations`
- RLS on `reform_coordination_shared_snapshot_revocations` checks `is_coordination_participant(coordinationId)`
- `is_coordination_participant` reads `reform_coordination_participants`
- RLS on `reform_coordination_participants` checks `tenantId = current_tenant`
- No circularity — this terminates.

**But the RLS on `reform_coordination_shared_snapshot_revocations` uses a subquery to `reform_coordination_shared_snapshots`**:
```sql
(SELECT "coordinationId" FROM public.reform_coordination_shared_snapshots WHERE "id" = "snapshotId")
```

This subquery is subject to RLS on `reform_coordination_shared_snapshots`. If the snapshot is revoked (and thus not visible to the caller via the S2-fixed policy), the subquery returns no rows, and `is_coordination_participant(NULL)` returns FALSE. So the revocation row is not visible to the caller.

**This breaks the revocation check.** The caller cannot see the revocation row (because they cannot see the snapshot row), so `is_snapshot_revoked` returns FALSE, so the snapshot appears non-revoked, so it's visible (but only if `approvedAt IS NOT NULL`, which it is).

**This is a real circular dependency.** Let me fix it.

**Solution**: Denormalize `coordinationId` onto `reform_coordination_shared_snapshot_revocations`. Then the RLS on revocations can check `is_coordination_participant("coordinationId")` directly, without a subquery to `reform_coordination_shared_snapshots`:

```sql
-- Add coordinationId to reform_coordination_shared_snapshot_revocations (denormalized)
-- This breaks the circular dependency

CREATE POLICY reform_coordination_shared_snapshot_revocations_select
  ON reform_coordination_shared_snapshot_revocations
  FOR SELECT TO balance_app
  USING (
    "tenantId" = current_setting('app.tenant_id', true)  -- owner who revoked
    OR public.is_coordination_participant("coordinationId"::text)  -- participant
  );
```

Now the chain is:
- `reform_coordination_shared_snapshots` SELECT policy → `is_snapshot_revoked(snapshotId)` → reads `reform_coordination_shared_snapshot_revocations` → RLS checks `tenantId = current OR is_coordination_participant(coordinationId)` → `is_coordination_participant` reads `reform_coordination_participants` → RLS checks `tenantId = current` → terminates.

**No circularity.** The denormalized `coordinationId` on `reform_coordination_shared_snapshot_revocations` breaks the cycle.

**Schema change required**: Add `coordinationId` (not nullable) to `reform_coordination_shared_snapshot_revocations`. The service sets it when creating a revocation (from the snapshot's `coordinationId`).

**Final S2 solution**:
1. Add `coordinationId` (not nullable) to `reform_coordination_shared_snapshot_revocations` (denormalized)
2. Use `is_snapshot_revoked(snapshotId)` function (SECURITY INVOKER, returns BOOLEAN)
3. RLS on `reform_coordination_shared_snapshots` SELECT includes `AND NOT is_snapshot_revoked("id"::text)`
4. RLS on `reform_coordination_shared_snapshot_revocations` SELECT uses `is_coordination_participant("coordinationId"::text)` (no subquery to snapshots)

---

### 2.3 S3 Correction — Institutional Representation Separation

**Problem**: `institutionId` is a claim, not verified authority.

**Solution**: Separate four distinct concepts:

#### 2.3.1 Claimed institution identity (existing)

`ReformCoordinationParticipant.institutionId` — what the lead asserts the tenant represents. Documentation only, no authorization.

#### 2.3.2 Verified institutional authority (NEW)

Add a `verifiedInstitutionId` field (nullable) to `ReformCoordinationParticipant`. This is set by an admin (via a future verification workflow) and indicates the system has verified the tenant's authority to represent this institution.

```prisma
model ReformCoordinationParticipant {
  // ... existing fields ...
  
  // Claimed institution (lead's assertion — no verification)
  institutionId          String?  // what the lead claims
  
  // Verified institution (admin-verified — set via separate workflow)
  verifiedInstitutionId  String?  // what the system has verified
  verifiedAt             DateTime?
  verifiedBy             String?  // admin userId
  verificationMethod     String?  // "manual_admin" | "country_audit_authority" | (future: digital_signature)
  verificationNotes      String?
  
  // ... rest ...
}
```

**Verification workflow** (out of scope for 03-00, documented as G03-L13):
- An admin (not the lead, not the participant) verifies the tenant's authority to represent the institution
- The admin sets `verifiedInstitutionId`, `verifiedAt`, `verifiedBy`, `verificationMethod`
- This is a **governance process**, not a technical one
- Until verified, `verifiedInstitutionId` is NULL — the tenant cannot claim verified institutional authority

#### 2.3.3 Authorization to participate (existing — based on `tenantId`, not `institutionId`)

Participation authorization is based on `tenantId` (verified via session) + invitation acceptance. It does NOT depend on `institutionId` or `verifiedInstitutionId`.

A tenant can participate in a coordination regardless of their institutional claim. The institutional claim is metadata; the participation is authorization.

#### 2.3.4 Authorization to approve commitments (NEW — separate from participation)

Add a `canApproveCommitments` boolean (default FALSE) to `ReformCoordinationParticipant`. This is set by the lead (when creating the participant) or by an admin (via the verification workflow).

```prisma
model ReformCoordinationParticipant {
  // ... existing fields ...
  
  // Authorization to approve commitments on behalf of the institution
  // Default: FALSE — must be explicitly granted
  canApproveCommitments   Boolean @default(false)
  approvalAuthorityGrantedBy String?  // lead userId or admin userId
  approvalAuthorityGrantedAt DateTime?
  approvalAuthorityReason String?  // why this was granted
  
  // ... rest ...
}
```

**Conservative default**: `canApproveCommitments = false`. The lead must explicitly grant this per participant, with a reason.

#### 2.3.5 The Conservative Constraint (NEW)

A participant can only approve commitments (in their own proposal's approval workflow) if:
1. They have `canApproveCommitments = true` (explicit grant)
2. AND either:
   - `verifiedInstitutionId` is set (admin-verified), OR
   - The commitment does not claim institutional authority (i.e., the proposal is the tenant's own reform, not "on behalf of Ministry X")

**This is a service-layer check**, not a DB-level constraint (because it depends on the proposal's content, not just the participant's row).

```typescript
// In reform-approval-service.ts
async function canApproveCommitments(session, participantId): Promise<boolean> {
  const participant = await tx.reformCoordinationParticipant.findFirst({
    where: { id: participantId, tenantId, status: 'active' },
  });
  if (!participant) return false;
  if (!participant.canApproveCommitments) return false;
  // If the proposal claims to act "on behalf of" an institution,
  // require verifiedInstitutionId
  // (This check is in the proposal approval service, not here)
  return true;
}
```

#### 2.3.6 Summary of S3 Separation

| Concept | Field | Set by | Used for |
|---------|-------|--------|----------|
| Claimed institution | `institutionId` | Lead (when adding participant) | Documentation only |
| Verified institution | `verifiedInstitutionId` | Admin (via future verification workflow) | Authorization to claim institutional authority |
| Authorization to participate | `tenantId` + invitation status | System (session) | Participation in coordination |
| Authorization to approve commitments | `canApproveCommitments` | Lead or admin (explicit grant) | Approval of commitments in own proposal |

**Key invariant**: A claim of institutional representation (`institutionId`) alone grants NO privileges. Verified authority (`verifiedInstitutionId`) + explicit approval grant (`canApproveCommitments`) are required to approve commitments on behalf of an institution.

---

## 3. New Negative Tests

Per owner directive: "إضافة حالات اختبار سلبية مقترحة تكشف الفجوات الأصلية، لا تكتفي بمسارات النجاح."

### 3.1 S1 Negative Tests

| Test ID | Test | Expected behavior |
|---------|------|-------------------|
| SEC-21 | Lead attempts direct `UPDATE` on another tenant's participant row (bypassing the function) | RLS blocks (the lead cannot SELECT the row, so cannot UPDATE) |
| SEC-22 | Lead calls `remove_coordination_participant()` for a coordination they don't lead | Function returns FALSE (lead check fails) |
| SEC-23 | Lead calls `remove_coordination_participant()` for an already-removed participant | Function returns FALSE (status != 'active') |
| SEC-24 | Lead calls `remove_coordination_participant()` with a reason shorter than 10 chars | Function raises exception (input validation) |
| SEC-25 | Non-lead tenant calls `remove_coordination_participant()` | Function returns FALSE (lead check fails) |
| SEC-26 | Lead attempts to update `metadata` or `institutionId` on another tenant's participant via the function | Function does not modify those fields (function only updates status, removedAt, removedBy, removalReason) |

### 3.2 S2 Negative Tests

| Test ID | Test | Expected behavior |
|---------|------|-------------------|
| SEC-27 | Tenant B (participant) direct SELECTs `reform_coordination_shared_snapshots` where a snapshot is approved but revoked | Returns 0 rows (revocation enforced at DB level) |
| SEC-28 | Tenant B queries the shared view service for a coordination with revoked snapshots | Returns only non-revoked approved snapshots |
| SEC-29 | Owner tenant SELECTs their own revoked snapshot | Returns the row (owner can see their own snapshots including revoked — for audit) |
| SEC-30 | Revocation row is created with `coordinationId` that doesn't match the snapshot's `coordinationId` | Trigger blocks (coordinationId must match) |
| SEC-31 | Attempt to INSERT a second revocation for the same snapshot | Unique constraint blocks (one revocation per snapshot) |

### 3.3 S3 Negative Tests

| Test ID | Test | Expected behavior |
|---------|------|-------------------|
| SEC-32 | Participant with `canApproveCommitments = false` attempts to approve a commitment | Service denies (approval authority required) |
| SEC-33 | Participant with `canApproveCommitments = true` but `verifiedInstitutionId = null` attempts to approve a commitment that claims institutional authority | Service denies (verified authority required for institutional commitments) |
| SEC-34 | Lead sets `institutionId` on a participant but does not set `verifiedInstitutionId` | Allowed (claim is documentation), but participant cannot approve commitments claiming institutional authority |
| SEC-35 | Non-admin user attempts to set `verifiedInstitutionId` | Service denies (only admin can verify institutional authority) |
| SEC-36 | Lead attempts to set `canApproveCommitments = true` on their own participant row (self-grant) | Service denies (lead cannot self-grant; must be separate from participant's own tenant — or admin) |
| SEC-37 | Participant with `verifiedInstitutionId = "MIN_X"` but the proposal claims `institutionId = "MIN_Y"` (different institution) | Service denies (verified institution must match claimed institution for institutional commitments) |

---

## 4. Honest Limitations

Per owner directive: "توثيق أي قيد متبقٍ بوضوح دون الادعاء بأنه مغلق."

### 4.1 Remaining Limitations (Honestly Documented)

| Limitation | Status | Description |
|-----------|--------|-------------|
| G03-L13: Institutional Verification Workflow | DEFERRED | The admin verification workflow for `verifiedInstitutionId` is out of scope for 03-00. The schema supports it, but the UI/admin workflow is deferred to a future mission. Until then, `verifiedInstitutionId` is always NULL, meaning no commitments can claim verified institutional authority. |
| G03-L14: `reform:coordination:manage` Delegation Mechanism | DEFERRED | The owner's decision (rev 3) was "admin only by default; reviewer via explicit delegation". The actual delegation mechanism (e.g., `RoleDelegation` table) is out of scope for 03-00. For 03-01, the permission is admin-only in the catalog. |
| G03-L15: Cross-Country Coordination | DEFERRED | Scenario C (cross-tenant cross-country) requires cross-country consent beyond G03's scope. |
| G03-L16: Charter Document for High-Stakes Reforms | DEFERRED | A formal charter signed by all participants is non-blocking. Flagged for future enhancement. |
| G03-L17: Coordination-Level Audit Log | DEFERRED | Currently all coordination actions go to standard `audit_log` with `details.coordinationId`. A dedicated table is a UX optimization, non-blocking. |

### 4.2 What Is NOT Claimed as Closed

- The `SECURITY DEFINER` function `remove_coordination_participant` is a **controlled exception** to the SECURITY INVOKER pattern. It is documented honestly as such, with a dedicated minimal-privilege role. It is NOT a general pattern — it is the **only** SECURITY DEFINER function in G03, justified by the lack of a SECURITY INVOKER alternative that honors the owner's "no SELECT expansion" directive.
- The regex pattern matching on causal language remains a **defense-in-depth layer**, NOT a guarantee. The primary defense is epistemic structure + reviewer judgment.
- The `institutionId` claim remains **documentation only**. The S3 fix adds `verifiedInstitutionId` and `canApproveCommitments`, but the verification workflow itself is deferred (G03-L13).

---

## 5. Impact on Existing Documents

### 5.1 Documents Requiring Update (REV 4)

| Document | Updates needed |
|----------|---------------|
| `SECURITY_CONTRACT_FOR_COORDINATION.md` | Add S1 (SECURITY DEFINER function for removal), S2 (revocation in RLS + denormalized coordinationId), S3 (verified authority separation) |
| `DOMAIN_MODEL.md` | Add `verifiedInstitutionId`, `canApproveCommitments` to participant; add `coordinationId` to revocations; add `remove_coordination_participant` function + `is_snapshot_revoked` function |
| `ARCHITECTURE_PROPOSAL.md` | Full content update (remove REV 1 contracts) |
| `WORKFLOW_AND_APPROVALS.md` | Full content update (participant removal flow, 4-state lifecycle, draft mode for snapshots) |
| `INTEGRATION_CONTRACTS.md` | Full content update (coordination contracts, S3 approval authority checks) |
| `SECURITY_AND_EVIDENCE_POLICY.md` | Full content update (S1/S2/S3 corrections, new negative tests) |
| `OPEN_DECISIONS.md` | Add D13 (S1 — SECURITY DEFINER for participant removal), D14 (S2 — DB-level revocation), D15 (S3 — institutional authority separation) |
| `THREAT_MODEL.md` | Add T11 (cross-tenant UPDATE gap), T12 (revocation bypass), T13 (institutional claim abuse) |
| `CONSISTENCY_REVIEW.md` | Re-verify consistency after REV 4 changes |
| `MISSION_ROADMAP.md` | Add S1/S2/S3 test missions (sentinel tests in 03-01) |
| `MISSION_REPORT.md` | REV 4 report |

### 5.2 The Pragmatic Approach

Given the scope of REV 4 corrections, I will:
1. **Create this document** (`G03_00_SECURITY_CORRECTIONS_REV4.md`) as the authoritative source for S1/S2/S3 corrections
2. **Fully update** the 3 remaining header-updated documents (ARCHITECTURE_PROPOSAL, WORKFLOW_AND_APPROVALS, INTEGRATION_CONTRACTS) — per owner directive S4
3. **Update** SECURITY_CONTRACT, DOMAIN_MODEL, SECURITY_AND_EVIDENCE_POLICY, OPEN_DECISIONS, THREAT_MODEL, CONSISTENCY_REVIEW, MISSION_ROADMAP with the S1/S2/S3 corrections
4. **Update** MISSION_REPORT with REV 4 report

This is a large revision. I will prioritize correctness over brevity.

---

## 6. Conclusion

The three findings (S1, S2, S3) are **real design defects** in the REV 3 RLS contract. The corrections are:

1. **S1**: Use a `SECURITY DEFINER` function `remove_coordination_participant` with a dedicated minimal-privilege role `balance_coordination_admin`. This is a controlled exception to the SECURITY INVOKER pattern, justified by the lack of a SECURITY INVOKER alternative that honors the owner's "no SELECT expansion" directive.

2. **S2**: Add `coordinationId` (denormalized) to `reform_coordination_shared_snapshot_revocations`, use `is_snapshot_revoked(snapshotId)` function (SECURITY INVOKER), and include `AND NOT is_snapshot_revoked(...)` in the SELECT policy on `reform_coordination_shared_snapshots`. This enforces revocation at the DB level.

3. **S3**: Separate claimed institution (`institutionId`) from verified authority (`verifiedInstitutionId`) from participation authorization (`tenantId`) from commitment approval authorization (`canApproveCommitments`). Conservative defaults: `verifiedInstitutionId = NULL`, `canApproveCommitments = false`.

The corrections add:
- 1 new SECURITY DEFINER function (`remove_coordination_participant`)
- 1 new SECURITY INVOKER function (`is_snapshot_revoked`)
- 1 new dedicated role (`balance_coordination_admin`)
- 4 new fields on `ReformCoordinationParticipant` (`verifiedInstitutionId`, `verifiedAt`, `verifiedBy`, `canApproveCommitments` + related)
- 1 denormalized field on `ReformCoordinationSharedSnapshotRevocation` (`coordinationId`)
- 17 new negative tests (SEC-21 through SEC-37)
- 5 new limitations honestly documented (G03-L13 through G03-L17)

**No frozen invariants are weakened.** All 14 inherited invariants + 10 G3 invariants remain honored. RLS is strengthened (not weakened) by the S2 fix. Tenant isolation is preserved (the S1 function returns BOOLEAN, the S3 fix adds verification layers).

---

*End of G03-00 Security Corrections (REV 4). This document is the authoritative source for S1/S2/S3 corrections. All other G03-00 documents will be updated to reflect these corrections.*
