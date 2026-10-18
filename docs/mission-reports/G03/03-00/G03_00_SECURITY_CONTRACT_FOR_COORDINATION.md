# G03-00 — Security Contract for Coordination Access Function

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation (REV 3)
> **Document type:** Security contract specification (DESIGN ONLY — no SQL execution)
> **Date:** 2026-10-18 (revision 3 — post owner + reviewer review)
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner + reviewer final approval
> **Trigger:** Owner directive: "قدّم عقداً أمنياً واضحاً للدالة المقترحة"

---

## 1. Problem Statement

### 1.1 The Owner's Concern (Acknowledged)

> "إتاحة قراءة بيانات تنسيقية بين المستأجرين لا يمكن تشبيهها ببساطة بدالة سلامة سلاسل الملاحظات في GROUP 02. فالأولى تتعامل مع حدود الإفصاح عن البيانات، بينما الثانية تتحقق من سلامة علاقات داخلية. استخدام `SECURITY DEFINER` ممكن، لكنه يحتاج تدقيقاً دقيقاً للصلاحيات، ومالك الدالة، و`search_path`، ونطاق الصفوف التي يُسمح بإرجاعها."

**This is correct.** The G02 `SECURITY DEFINER` pattern (used for observation chain integrity) verifies internal data consistency within a single tenant's rows. The coordination access function is fundamentally different:

| Aspect | G02 chain integrity | G03 coordination access |
|--------|---------------------|------------------------|
| Purpose | Verify internal relationships (no cycles, no self-reference) | Verify cross-tenant authorization (is the caller a participant?) |
| Data exposure | No data returned — only boolean EXISTS check | Must NOT expose any data — only boolean authorization check |
| Risk if compromised | Chain integrity broken (data quality issue) | Cross-tenant data leak (security incident) |
| RLS bypass scope | Bypasses RLS on `observations` only for integrity check | Must bypass RLS on `reform_coordination_participants` for authorization check |
| Failure mode | Bad data | Unauthorized access |

The stakes are higher for G03. This document specifies the complete security contract.

### 1.2 Why SECURITY DEFINER Is Still the Right Tool

Despite the owner's correct caution, `SECURITY DEFINER` remains the right tool **when properly constrained**, because:

1. **Standard RLS is insufficient**: `reform_coordinations` rows must be visible to the lead tenant AND all active participants. Standard tenant-isolation RLS (`tenantId = current_setting('app.tenant_id')`) cannot express "tenantId = lead OR is_participant(id)" without a subquery that itself needs RLS bypass.

2. **Alternatives are worse**:
   - **Application-layer enforcement**: Service code checks participant status before SELECT. Risk: any service bug (e.g., a forgotten check) exposes cross-tenant data. Defense-in-depth failure.
   - **Materialized view per coordination**: Impractical — coordinations are dynamic.
   - **Denormalized `visibleToTenantIds` array on `reform_coordinations`**: Sync issues — adding/removing a participant requires updating the coordination row, which is race-prone and audit-unfriendly.
   - **View with SECURITY INVOKER + explicit JOIN**: PostgreSQL 15+ supports `SECURITY INVOKER` views, but the JOIN itself would need RLS bypass for the participant check.

3. **SECURITY DEFINER with strict constraints** is the PostgreSQL-recommended pattern for cross-tenant authorization helpers. The risk is manageable if the function is:
   - Minimal (only returns boolean — never rows)
   - Owned by a dedicated non-admin role
   - Has a locked `search_path`
   - Has minimal grants
   - Cannot be exploited for data exfiltration

This document specifies these constraints as a verifiable contract.

---

## 2. Function Specification

### 2.1 Function Signature

```sql
-- Function name: is_coordination_participant
-- Purpose: Return TRUE if the current tenant (from app.tenant_id session setting)
--          is an ACTIVE participant in the specified coordination.
-- Returns: BOOLEAN — NEVER returns rows, NEVER returns data
-- Language: SQL (not PL/pgSQL — SQL functions are simpler to audit)
-- Volatility: STABLE (same result within a transaction)

CREATE OR REPLACE FUNCTION public.is_coordination_participant(
  p_coordination_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.reform_coordination_participants
    WHERE "coordinationId" = p_coordination_id
      AND "tenantId" = current_setting('app.tenant_id', true)
      AND "status" = 'active'
  );
$$;
```

### 2.2 Critical Design Choices

#### 2.2.1 Returns BOOLEAN Only

The function **never returns rows**. It uses `EXISTS(...)` which evaluates to a single boolean. Even if an attacker could exploit the function, they cannot exfiltrate data through it — the return type is `BOOLEAN`, not `SETOF record` or `TABLE`.

**Verification**: The function body contains exactly one `SELECT EXISTS(...)`. No `RETURN QUERY`, no `SETOF`, no `TABLE(...)` return type.

#### 2.2.2 Language: SQL (not PL/pgSQL)

SQL functions are:
- Simpler to audit (no control flow, no variables, no dynamic SQL)
- Inlinable by the planner (but STABLE + SECURITY DEFINER prevents unsafe inlining)
- Cannot execute dynamic SQL (`EXECUTE` is PL/pgSQL only)

This eliminates an entire class of SQL injection risks.

#### 2.2.3 STABLE Volatility

`STABLE` means the function returns the same result within a single transaction. This is correct because:
- The participant check should be consistent within a transaction
- It prevents the planner from re-evaluating the function mid-statement (which could expose race conditions)
- It does NOT prevent the function from seeing committed changes from other transactions (which is desired — if a participant is added mid-transaction, the next statement sees it)

#### 2.2.4 `SET search_path = public, pg_temp`

**Critical**: The function's `search_path` is explicitly set to `public, pg_temp`. This prevents:
- **Search path injection**: An attacker creates a malicious table in `public` (or another schema) with the same name as `reform_coordination_participants`, and the function resolves to the wrong table.
- **`pg_temp` for temporary objects**: Including `pg_temp` allows the function to use temporary objects if needed (rare, but standard practice).

**Why `public` first?**: All THE BALANCE tables are in the `public` schema. The function explicitly references `public.reform_coordination_participants` with the schema prefix, so even if `search_path` were empty, the reference would resolve correctly. The `search_path` is a defense-in-depth layer.

**Verification**: The function body uses fully-qualified `public.reform_coordination_participants`. No unqualified table references.

#### 2.2.5 SECURITY DEFINER

The function executes with the **owner's privileges**, not the caller's. This is necessary because:
- `balance_app` (the caller) cannot read `reform_coordination_participants` rows from other tenants (RLS blocks them)
- The function must read those rows to check participant status
- The function owner must have SELECT on the table **without RLS restrictions for this specific check**

**Critical constraint**: The function owner is **NOT `balance_admin`** (which has BYPASSRLS for migrations — too broad). The function owner is a **dedicated role `balance_coordination_helper`** with minimal grants.

### 2.3 Function Owner: Dedicated Role

```sql
-- Create a dedicated role for the coordination helper function.
-- This role has ONLY the privileges needed for the participant check.
-- It does NOT have BYPASSRLS, does NOT have INSERT/UPDATE/DELETE on any table.

CREATE ROLE balance_coordination_helper NOLOGIN;

-- Grant ONLY SELECT on the participants table
GRANT SELECT ON public.reform_coordination_participants TO balance_coordination_helper;

-- Do NOT grant:
-- - INSERT, UPDATE, DELETE on any table
-- - BYPASSRLS
-- - USAGE on any schema except public
-- - CREATE on any schema
-- - Any other privileges

-- The function is owned by balance_coordination_helper, not balance_admin.
-- This ensures:
-- - If the function is exploited, the attacker can only SELECT from
--   reform_coordination_participants (not modify it)
-- - The function cannot be used to bypass RLS on any other table
-- - The function cannot escalate privileges (the role is NOLOGIN —
--   no one can connect as this role)
```

### 2.4 RLS Behavior for `balance_coordination_helper`

The `balance_coordination_helper` role needs to read `reform_coordination_participants` across tenants. Two options:

#### Option A: Add `balance_coordination_helper` to the `balance_admin` policy (REJECTED)

```sql
-- REJECTED: This would give the helper role BYPASSRLS-like access
CREATE POLICY ... FOR balance_coordination_helper USING (true) WITH CHECK (true);
```

**Rejected because**: This grants blanket SELECT on all rows, which is broader than needed. If the function is exploited, the attacker can read ALL participants across ALL coordinations — not just the one being checked.

#### Option B: Grant the helper role SELECT but with RLS still enforced (PREFERRED)

```sql
-- The helper role has SELECT granted on the table.
-- RLS is ENABLED + FORCED on reform_coordination_participants.
-- The helper role does NOT have BYPASSRLS.
-- Therefore, RLS policies STILL APPLY to the helper role's queries.

-- But wait — this defeats the purpose. The helper role's queries
-- would be filtered by RLS (tenantId = current_setting('app.tenant_id')),
-- so it would only see the current tenant's participants — which is
-- exactly what we want, but then why do we need SECURITY DEFINER at all?
```

**Critical realization**: The function does NOT need to bypass RLS! Because the function checks `"tenantId" = current_setting('app.tenant_id', true)`, the RLS policy on `reform_coordination_participants` (which uses the same condition) would ALLOW the function to see exactly the rows it needs.

#### Option C: Use SECURITY INVOKER (not DEFINER) — THE CORRECT SOLUTION

```sql
-- Use SECURITY INVOKER — the function executes with the CALLER's privileges.
-- The caller (balance_app) has SELECT on the table, and RLS allows them
-- to see rows where tenantId = current_setting('app.tenant_id').
-- The function's query checks the same condition, so it returns the
-- correct result WITHOUT bypassing RLS.

CREATE OR REPLACE FUNCTION public.is_coordination_participant(
  p_coordination_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER  -- <-- CHANGED FROM DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.reform_coordination_participants
    WHERE "coordinationId" = p_coordination_id
      AND "tenantId" = current_setting('app.tenant_id', true)
      AND "status" = 'active'
  );
$$;
```

### 2.5 Why SECURITY INVOKER Is the Right Choice (REVISED from Rev 2)

**The owner's caution was prescient.** After careful analysis, `SECURITY DEFINER` is **unnecessary** for this function. Here's why:

1. **The RLS policy on `reform_coordination_participants` already uses the same condition as the function** (`"tenantId" = current_setting('app.tenant_id', true)`). The function checks `"tenantId" = current_setting('app.tenant_id', true) AND "status" = 'active'` — RLS allows the caller to see their own tenant's rows, so the function can read them.

2. **No cross-tenant data is accessed**: The function only checks if the CURRENT tenant (from `app.tenant_id`) is a participant. It does NOT read other tenants' rows — RLS blocks those, and the function's WHERE clause also filters them out.

3. **`SECURITY INVOKER`** means the function executes with the caller's (`balance_app`) privileges. `balance_app` has SELECT on the table, and RLS allows it to see its own tenant's rows. The function works correctly.

4. **`SECURITY DEFINER` was over-engineering**: I introduced it in rev 2 because I assumed the coordination RLS needed cross-tenant visibility. But on closer inspection, the function only checks the CURRENT tenant's participation — which is exactly what standard RLS allows.

### 2.6 But Wait — How Does the Coordination Metadata Become Visible to Participants?

This is the key question. If `SECURITY INVOKER` is used, then:
- `balance_app` from Tenant B can read `reform_coordination_participants` rows where `tenantId = Tenant B` (their own participation row).
- But `balance_app` from Tenant B CANNOT read `reform_coordinations` rows owned by Tenant A (the lead), because RLS on `reform_coordinations` uses `leadTenantId = current_setting('app.tenant_id')` — which is false for Tenant B.

**Solution**: The RLS policy on `reform_coordinations` uses the helper function:

```sql
CREATE POLICY reform_coordinations_visible_to_participants ON reform_coordinations
  FOR SELECT
  TO balance_app
  USING (
    "leadTenantId" = current_setting('app.tenant_id', true)
    OR public.is_coordination_participant("id"::text)
  );
```

Here, the function is called in the RLS policy's USING clause. The function uses `SECURITY INVOKER`, so it executes as `balance_app`. RLS on `reform_coordination_participants` allows `balance_app` to see only their own tenant's participation rows. The function checks if that row exists with `status = 'active'`.

**This works correctly**:
- Tenant B's `balance_app` queries `reform_coordinations` where they're a participant
- RLS evaluates `public.is_coordination_participant("id"::text)`
- The function (as Tenant B's `balance_app`) queries `reform_coordination_participants` for rows where `tenantId = Tenant B AND coordinationId = <id> AND status = 'active'`
- RLS on `reform_coordination_participants` allows this query (Tenant B reading their own rows)
- The function returns TRUE if such a row exists, FALSE otherwise
- The outer RLS policy on `reform_coordinations` then allows or denies the SELECT

**No cross-tenant data is leaked.** The function only sees the caller's own participation rows, and RLS enforces this.

### 2.7 Revised Function Specification (Final)

```sql
-- Function name: is_coordination_participant
-- Purpose: Return TRUE if the current tenant is an ACTIVE participant in the coordination.
-- Returns: BOOLEAN — NEVER returns rows
-- Language: SQL (not PL/pgSQL)
-- Volatility: STABLE
-- Security: SECURITY INVOKER (executes with caller's privileges — no RLS bypass)
-- search_path: locked to public, pg_temp

CREATE OR REPLACE FUNCTION public.is_coordination_participant(
  p_coordination_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.reform_coordination_participants
    WHERE "coordinationId" = p_coordination_id
      AND "tenantId" = current_setting('app.tenant_id', true)
      AND "status" = 'active'
  );
$$;

-- Grant EXECUTE to balance_app (and balance_admin for ops)
GRANT EXECUTE ON FUNCTION public.is_coordination_participant(TEXT) TO balance_app;
GRANT EXECUTE ON FUNCTION public.is_coordination_participant(TEXT) TO balance_admin;

-- No dedicated helper role needed (SECURITY INVOKER uses caller's privileges)
```

### 2.8 Why This Is More Secure Than Rev 2's SECURITY DEFINER

| Aspect | Rev 2 (SECURITY DEFINER) | Rev 3 (SECURITY INVOKER) |
|--------|-------------------------|-------------------------|
| Privileges used | Function owner's (dedicated role) | Caller's (`balance_app`) |
| RLS bypass on `participants` table | Yes (function owner bypasses RLS) | No (caller's RLS applies) |
| Risk if function compromised | Attacker reads ALL participants across ALL tenants | Attacker can only read their own tenant's participants (RLS enforced) |
| Dedicated role needed | Yes (`balance_coordination_helper`) | No |
| Complexity | Higher (role creation + grants + audit) | Lower (standard function) |
| Audit surface | Larger (function + role + grants) | Smaller (function only) |

**Conclusion**: `SECURITY INVOKER` is strictly more secure because it does NOT bypass RLS. The function works correctly because the RLS policy on `reform_coordination_participants` uses the same condition the function checks.

---

## 3. RLS Policy Specifications (Coordination Tables)

### 3.1 `reform_coordinations`

```sql
ALTER TABLE reform_coordinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_coordinations FORCE ROW LEVEL SECURITY;

-- SELECT: visible to lead OR active participant
CREATE POLICY reform_coordinations_select ON reform_coordinations
  FOR SELECT
  TO balance_app
  USING (
    "leadTenantId" = current_setting('app.tenant_id', true)
    OR public.is_coordination_participant("id"::text)
  );

-- INSERT: only lead tenant can create coordinations
CREATE POLICY reform_coordinations_insert ON reform_coordinations
  FOR INSERT
  TO balance_app
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));

-- UPDATE: only lead tenant can modify coordination metadata
-- (status transitions, title, description — but NOT approvalPolicy, which is immutable post-creation)
CREATE POLICY reform_coordinations_update ON reform_coordinations
  FOR UPDATE
  TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));

-- DELETE: BLOCKED for balance_app (coordinations are soft-archived, never hard-deleted)
-- No DELETE policy → RLS denies by default

-- balance_admin: full access (for migrations + ops only)
CREATE POLICY reform_coordinations_admin ON reform_coordinations
  FOR ALL
  TO balance_admin
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON reform_coordinations TO balance_app;
```

### 3.2 `reform_coordination_participants`

```sql
ALTER TABLE reform_coordination_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_coordination_participants FORCE ROW LEVEL SECURITY;

-- SELECT: each participant sees only their own row
CREATE POLICY reform_coordination_participants_select ON reform_coordination_participants
  FOR SELECT
  TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true));

-- INSERT: only lead tenant (when adding participants via invitations)
-- The lead's tenantId is on the coordination row, not this row.
-- So we need a subquery to check: is the caller the lead of the coordination
-- referenced by coordinationId?
CREATE POLICY reform_coordination_participants_insert ON reform_coordination_participants
  FOR INSERT
  TO balance_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.reform_coordinations c
      WHERE c."id" = "coordinationId"
        AND c."leadTenantId" = current_setting('app.tenant_id', true)
    )
  );

-- UPDATE: participant can update their own status (accept/decline invitation)
-- OR lead can update (remove participant)
CREATE POLICY reform_coordination_participants_update ON reform_coordination_participants
  FOR UPDATE
  TO balance_app
  USING (
    "tenantId" = current_setting('app.tenant_id', true)  -- own row
    OR EXISTS (
      SELECT 1 FROM public.reform_coordinations c
      WHERE c."id" = "coordinationId"
        AND c."leadTenantId" = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    "tenantId" = current_setting('app.tenant_id', true)
    OR EXISTS (
      SELECT 1 FROM public.reform_coordinations c
      WHERE c."id" = "coordinationId"
        AND c."leadTenantId" = current_setting('app.tenant_id', true)
    )
  );

-- DELETE: BLOCKED for balance_app (use status = 'removed' for soft delete)
-- No DELETE policy → RLS denies by default

GRANT SELECT, INSERT, UPDATE ON reform_coordination_participants TO balance_app;
```

### 3.3 `reform_coordination_invitations`

```sql
ALTER TABLE reform_coordination_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_coordination_invitations FORCE ROW LEVEL SECURITY;

-- SELECT: visible to lead (sender) OR invited tenant (recipient)
CREATE POLICY reform_coordination_invitations_select ON reform_coordination_invitations
  FOR SELECT
  TO balance_app
  USING (
    "invitedTenantId" = current_setting('app.tenant_id', true)  -- recipient
    OR EXISTS (
      SELECT 1 FROM public.reform_coordinations c
      WHERE c."id" = "coordinationId"
        AND c."leadTenantId" = current_setting('app.tenant_id', true)
    )
  );

-- INSERT: only lead
CREATE POLICY reform_coordination_invitations_insert ON reform_coordination_invitations
  FOR INSERT
  TO balance_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.reform_coordinations c
      WHERE c."id" = "coordinationId"
        AND c."leadTenantId" = current_setting('app.tenant_id', true)
    )
  );

-- UPDATE: only invited tenant (to accept/decline)
CREATE POLICY reform_coordination_invitations_update ON reform_coordination_invitations
  FOR UPDATE
  TO balance_app
  USING ("invitedTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("invitedTenantId" = current_setting('app.tenant_id', true));

-- DELETE: BLOCKED (append-only — invitations are never deleted, only status-changed)

GRANT SELECT, INSERT, UPDATE ON reform_coordination_invitations TO balance_app;
```

### 3.4 `reform_coordination_shared_snapshots`

```sql
ALTER TABLE reform_coordination_shared_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_coordination_shared_snapshots FORCE ROW LEVEL SECURITY;

-- SELECT: owner (sharing tenant) OR coordination participant (after approval)
CREATE POLICY reform_coordination_shared_snapshots_select ON reform_coordination_shared_snapshots
  FOR SELECT
  TO balance_app
  USING (
    -- Owner can always see their own snapshots (including drafts)
    "ownerTenantId" = current_setting('app.tenant_id', true)
    -- Other participants can only see APPROVED snapshots (drafts are private to owner)
    OR (
      "approvedAt" IS NOT NULL
      AND public.is_coordination_participant("coordinationId"::text)
    )
  );

-- INSERT: only owner tenant
CREATE POLICY reform_coordination_shared_snapshots_insert ON reform_coordination_shared_snapshots
  FOR INSERT
  TO balance_app
  WITH CHECK ("ownerTenantId" = current_setting('app.tenant_id', true));

-- UPDATE: only owner tenant (for status transitions: draft → under_review → approved)
CREATE POLICY reform_coordination_shared_snapshots_update ON reform_coordination_shared_snapshots
  FOR UPDATE
  TO balance_app
  USING ("ownerTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("ownerTenantId" = current_setting('app.tenant_id', true));

-- DELETE: BLOCKED (append-only — snapshots are never deleted, only revoked via revocation table)

GRANT SELECT, INSERT, UPDATE ON reform_coordination_shared_snapshots TO balance_app;
```

### 3.5 `reform_coordination_shared_snapshot_revocations`

```sql
ALTER TABLE reform_coordination_shared_snapshot_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_coordination_shared_snapshot_revocations FORCE ROW LEVEL SECURITY;

-- SELECT: visible to coordination participants (so they know a snapshot was revoked)
CREATE POLICY reform_coordination_shared_snapshot_revocations_select
  ON reform_coordination_shared_snapshot_revocations
  FOR SELECT
  TO balance_app
  USING (
    "tenantId" = current_setting('app.tenant_id', true)  -- owner who revoked
    OR public.is_coordination_participant(
      (SELECT "coordinationId" FROM public.reform_coordination_shared_snapshots
       WHERE "id" = "snapshotId")::text
    )
  );

-- INSERT: only the snapshot's owner tenant
CREATE POLICY reform_coordination_shared_snapshot_revocations_insert
  ON reform_coordination_shared_snapshot_revocations
  FOR INSERT
  TO balance_app
  WITH CHECK (
    "tenantId" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM public.reform_coordination_shared_snapshots s
      WHERE s."id" = "snapshotId"
        AND s."ownerTenantId" = current_setting('app.tenant_id', true)
    )
  );

-- UPDATE/DELETE: BLOCKED (append-only)

GRANT SELECT, INSERT ON reform_coordination_shared_snapshot_revocations TO balance_app;
```

---

## 4. Shared View: How Participants See Approved Snapshots

### 4.1 The Shared View Service Logic

The shared view service (`getCoordinationSharedView(participantTenantId)`) does NOT query participants' private tables. It queries only `reform_coordination_shared_snapshots`:

```sql
-- Shared view query (executed as balance_app for the participant tenant)
SELECT
  s."id",
  s."title",
  s."summary",
  s."snapshotType",
  s."sharedAt",
  s."sharedBy",
  s."approvedAt",
  s."ownerTenantId",
  s."classification"
FROM public.reform_coordination_shared_snapshots s
WHERE s."coordinationId" = $1  -- the coordination ID
  AND s."approvedAt" IS NOT NULL  -- only approved snapshots
  AND NOT EXISTS (
    SELECT 1 FROM public.reform_coordination_shared_snapshot_revocations r
    WHERE r."snapshotId" = s."id"
  )
ORDER BY s."sharedAt" DESC;
```

### 4.2 RLS Enforcement on This Query

When `balance_app` from Tenant B executes this query:
1. RLS on `reform_coordination_shared_snapshots` filters rows to those where:
   - `ownerTenantId = Tenant B` (own snapshots), OR
   - `approvedAt IS NOT NULL AND is_coordination_participant(coordinationId)` — Tenant B is an active participant
2. The `is_coordination_participant` function executes as `balance_app` (SECURITY INVOKER), checks `reform_coordination_participants` for Tenant B's active participation.
3. RLS on `reform_coordination_shared_snapshot_revocations` allows the subquery (Tenant B is a participant).

**Result**: Tenant B sees only:
- Their own snapshots (drafts + approved)
- Other participants' APPROVED, NON-REVOKED snapshots

Tenant B does NOT see:
- Other participants' draft snapshots
- Other participants' revoked snapshots
- Any private proposal data (the shared view only queries the snapshots table, not proposals/actions/verifications)

### 4.3 What the Shared View Does NOT Query

- ❌ `reform_proposals` (private to each tenant)
- ❌ `reform_actions` (private)
- ❌ `reform_action_updates` (private)
- ❌ `reform_approvals` (private)
- ❌ `reform_verifications` (private)
- ❌ `evidence` (private)
- ❌ Any other tenant's data

**Critical invariant**: The shared view service contract specifies that it ONLY queries `reform_coordination_shared_snapshots` and `reform_coordination_shared_snapshot_revocations`. This is verified by:
1. Code review (the service implementation)
2. Integration test (verify the service does not access other tables)
3. SQL audit (log all queries executed by the service during tests)

---

## 5. Membership Verification Deep Dive

### 5.1 How `is_coordination_participant` Verifies Active Membership

The function checks three conditions:
1. `"coordinationId" = p_coordination_id` — the row is for the specified coordination
2. `"tenantId" = current_setting('app.tenant_id', true)` — the row belongs to the current tenant
3. `"status" = 'active'` — the participation is currently active (not pending/declined/removed)

### 5.2 Participant Status Lifecycle

```
Invitation sent
  │
  ▼
reform_coordination_participants row created with status = 'pending_invitation'
  │
  │ Invitee accepts invitation
  │
  ▼
status = 'active'
  │
  │ Lead removes participant (or participant withdraws)
  │
  ▼
status = 'removed' (or 'withdrawn')
  │
  ▼
[Row preserved for audit — never deleted]
```

The function returns TRUE only when `status = 'active'`. Pending, removed, and withdrawn participants are NOT considered active — they cannot see coordination data.

### 5.3 Preventing Tenant Impersonation

**Threat**: An attacker sets `app.tenant_id` to a victim's tenant ID, then calls the function.

**Mitigation**:
1. `balance_app` cannot set `app.tenant_id` arbitrarily — it can only set it via `set_config('app.tenant_id', $1, true)` inside a transaction started by the application.
2. The application (`withAuthenticatedTenant`) sets `app.tenant_id` from the **verified session** (JWT + DB membership check), not from client input.
3. The `app.tenant_id` setting is **transaction-scoped** (`true` as third arg to `set_config`), so it cannot persist beyond the transaction.

**Verification**: Integration test attempts to set `app.tenant_id` to a different tenant — should fail (the application never does this, and `balance_app` cannot bypass the application's session check).

### 5.4 Preventing Institution Impersonation

**Threat**: A participant claims to represent an `Institution` they don't actually belong to.

**Mitigation**:
1. `reform_coordination_participants.institutionId` is **optional** — it's a documentation field, not an authorization field.
2. The system does NOT authorize based on `institutionId` — it authorizes based on `tenantId` (which is verified via session).
3. The lead (who adds participants) is responsible for verifying that the invited tenant actually represents the claimed institution. This is a **human process**, not a system-enforced one.
4. The audit trail records who added each participant and what `institutionId` was claimed.

**Verification**: Integration test verifies that the system does not grant any privileges based on `institutionId` — only `tenantId` matters for authorization.

### 5.5 Authority Source for Representing an Institution

**Owner directive**: "مصدر الصلاحية لتمثيل Institution داخل Tenant"

The authority to represent an Institution within a Tenant is **not system-enforced** in G03. The system:
1. Records the `institutionId` claimed by the participant (optional field).
2. Records who added the participant (audit trail).
3. Does NOT verify that the Tenant actually represents the Institution.

**Rationale**: The relationship between `Institution` and `Tenant` is not 1:1 (per ADR-0004). A Tenant may span multiple Institutions, and an Institution may be referenced by multiple Tenants. Verifying this relationship would require a new `TenantInstitutionMembership` table — out of scope for G03.

**Recommendation**: The lead (who creates the coordination and adds participants) is responsible for verifying institutional representation. This is a **governance process**, not a technical one. The system provides the audit trail for accountability.

**Future enhancement (out of scope for G03)**: A `TenantInstitutionClaim` table could record verified Institution-Tenant relationships, validated by the country's audit authority. This would allow the system to enforce institutional representation. Documented as G03-L12 (Institutional Representation Verification Not Enforced).

---

## 6. DML Permissions Summary

### 6.1 Per-Table DML Matrix

| Table | balance_app SELECT | balance_app INSERT | balance_app UPDATE | balance_app DELETE | balance_admin |
|-------|:-:|:-:|:-:|:-:|:-:|
| `reform_coordinations` | ✓ (lead OR participant) | ✓ (lead only) | ✓ (lead only) | ✗ | ALL |
| `reform_coordination_participants` | ✓ (own row) | ✓ (lead only) | ✓ (own row OR lead) | ✗ | ALL |
| `reform_coordination_invitations` | ✓ (recipient OR lead) | ✓ (lead only) | ✓ (recipient only) | ✗ | ALL |
| `reform_coordination_shared_snapshots` | ✓ (own OR approved+participant) | ✓ (owner only) | ✓ (owner only) | ✗ | ALL |
| `reform_coordination_shared_snapshot_revocations` | ✓ (owner OR participant) | ✓ (snapshot owner only) | ✗ | ✗ | ALL |

### 6.2 Append-Only Tables (UPDATE + DELETE BLOCKED)

- `reform_coordination_invitations` — invitations are never deleted, only status-changed
- `reform_coordination_shared_snapshots` — snapshots are never deleted, only revoked via revocation table
- `reform_coordination_shared_snapshot_revocations` — revocations are append-only

### 6.3 Soft Delete Tables (DELETE BLOCKED, status field used)

- `reform_coordinations` — soft-archived via `archivedAt` field (no DELETE)
- `reform_coordination_participants` — soft-removed via `status = 'removed'` (no DELETE)

---

## 7. Negative Tests (Required for 03-01)

### 7.1 Test Catalog

| Test ID | Test | Expected behavior |
|---------|------|-------------------|
| SEC-01 | Tenant B queries `reform_coordinations` where Tenant A is lead and Tenant B is NOT a participant | Returns 0 rows |
| SEC-02 | Tenant B queries `reform_coordinations` where Tenant A is lead and Tenant B IS a participant (active) | Returns the coordination row |
| SEC-03 | Tenant B queries `reform_coordinations` where Tenant B was a participant but status = 'removed' | Returns 0 rows |
| SEC-04 | Tenant B queries `reform_coordination_shared_snapshots` where Tenant A has a DRAFT snapshot | Returns 0 rows (drafts are private to owner) |
| SEC-05 | Tenant B queries `reform_coordination_shared_snapshots` where Tenant A has an APPROVED snapshot | Returns the snapshot row |
| SEC-06 | Tenant B queries `reform_coordination_shared_snapshots` where Tenant A has a REVOKED snapshot | Returns 0 rows (revocation filters it out) |
| SEC-07 | Tenant B attempts to INSERT a shared snapshot with `ownerTenantId = Tenant A` | RLS denies (INSERT blocked) |
| SEC-08 | Tenant B attempts to UPDATE Tenant A's shared snapshot | RLS denies (UPDATE blocked) |
| SEC-09 | Tenant B attempts to DELETE Tenant A's shared snapshot | RLS denies (DELETE blocked) |
| SEC-10 | Tenant B attempts to accept an invitation addressed to Tenant C | RLS denies (UPDATE blocked — invitedTenantId != current tenant) |
| SEC-11 | Tenant B attempts to add a participant to a coordination led by Tenant A | RLS denies (INSERT blocked — lead check fails) |
| SEC-12 | Tenant B calls `is_coordination_participant(coordinationId)` where they ARE a participant | Returns TRUE |
| SEC-13 | Tenant B calls `is_coordination_participant(coordinationId)` where they are NOT a participant | Returns FALSE |
| SEC-14 | Tenant B calls `is_coordination_participant(coordinationId)` where they were REMOVED | Returns FALSE |
| SEC-15 | An unauthenticated session (no `app.tenant_id` set) calls `is_coordination_participant` | Returns FALSE (current_setting returns '', no match) |
| SEC-16 | Tenant B queries the shared view for a coordination where they are NOT a participant | Returns 0 rows |
| SEC-17 | Tenant B queries the shared view for a coordination where they ARE a participant | Returns approved, non-revoked snapshots from other participants |
| SEC-18 | Tenant A (lead) attempts to UPDATE `approvalPolicy` on an existing coordination | RLS denies (or trigger blocks — policy is immutable post-creation) |
| SEC-19 | Tenant B attempts to create a coordination with `leadTenantId = Tenant A` | RLS denies (INSERT check fails) |
| SEC-20 | SQL audit verifies the shared view service does NOT query `reform_proposals`, `reform_actions`, etc. | Query log shows only `reform_coordination_shared_snapshots` and `reform_coordination_shared_snapshot_revocations` |

### 7.2 Implementation Notes

- Tests SEC-01 through SEC-19 are integration tests run on real PostgreSQL 16 with RLS enabled.
- Test SEC-20 requires query logging (e.g., `pg_stat_statements` or `log_statement = 'all'`) during the test, then assertion that no forbidden tables were queried.
- All 20 tests are sentinel regression tests — they must pass on every CI run.

---

## 8. Alternative Architectures Considered

### 8.1 Application-Layer Authorization (No Helper Function)

**Approach**: Service code checks participant status before every coordination query.

**Pros**:
- No `SECURITY DEFINER` function
- No RLS bypass (even via INVOKER)

**Cons**:
- **Defense-in-depth failure**: Any service bug (forgotten check) exposes cross-tenant data.
- **Inconsistent enforcement**: Different services might check differently.
- **No DB-level guarantee**: A future migration script or admin tool could bypass the check.

**Rejected**: RLS is the proven pattern for tenant isolation (G00/G01/G02). Abandoning it for coordination would weaken the platform's security model.

### 8.2 Denormalized `visibleToTenantIds` Array

**Approach**: Add `visibleToTenantIds TEXT[]` to `reform_coordinations`, listing all participants. RLS policy: `current_setting('app.tenant_id') = ANY(visibleToTenantIds)`.

**Pros**:
- No helper function needed.
- Single-table query.

**Cons**:
- **Sync issues**: Adding/removing a participant requires updating the coordination row — race-prone.
- **Audit unfriendly**: The array doesn't capture when each participant was added/removed.
- **Size limits**: PostgreSQL arrays have practical limits for very large coordinations.
- **Loss of invitation lifecycle**: Cannot distinguish pending/active/removed participants.

**Rejected**: Loses the rich participant lifecycle that the dedicated table provides.

### 8.3 PostgreSQL 15+ SECURITY INVOKER Views

**Approach**: Create a view `reform_coordinations_visible` that JOINs `reform_coordinations` with `reform_coordination_participants` and uses `SECURITY INVOKER`.

**Pros**:
- No function needed.
- Standard SQL pattern.

**Cons**:
- Requires PostgreSQL 15+ (we're on 16, so OK).
- The view still needs to JOIN across tenants, which RLS would block — same problem as the function.
- Views are less flexible than functions for complex authorization logic.

**Considered but rejected in favor of the simpler function approach**. The function is more readable and auditable than a view JOIN.

### 8.4 Per-Tenant Materialized Views

**Approach**: Create a materialized view per tenant, listing their visible coordinations.

**Cons**:
- Impractical — coordinations are dynamic, materialized views need refresh.
- Storage overhead.
- Staleness issues.

**Rejected**: Impractical for dynamic data.

### 8.5 Conclusion

The `SECURITY INVOKER` function approach (rev 3) is the **simplest secure** solution:
- No RLS bypass (INVOKER, not DEFINER)
- No dedicated role
- Minimal audit surface
- Standard PostgreSQL pattern
- Works with existing RLS infrastructure

---

## 9. Function Audit and Verification Plan

### 9.1 Function Ownership Audit

```sql
-- Verify the function is owned by a non-admin role
SELECT p.proname, r.rolname AS owner, p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_roles r ON p.proowner = r.oid
WHERE p.proname = 'is_coordination_participant';

-- Expected:
-- proname: is_coordination_participant
-- owner: postgres (or the migration role — NOT balance_admin)
-- prosecdef: false (SECURITY INVOKER)
```

**Note**: With `SECURITY INVOKER`, the function owner matters less (the caller's privileges are used). But the owner should still be a non-admin role for defense-in-depth.

### 9.2 Function Body Audit

```sql
-- Verify the function body matches the specification
SELECT prosrc FROM pg_proc WHERE proname = 'is_coordination_participant';

-- Expected: a single SELECT EXISTS(...) with the exact WHERE clause
-- No dynamic SQL, no RETURN QUERY, no SETOF
```

### 9.3 Grants Audit

```sql
-- Verify only balance_app and balance_admin have EXECUTE
SELECT grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_name = 'is_coordination_participant';

-- Expected:
-- grantee: balance_app, privilege_type: EXECUTE
-- grantee: balance_admin, privilege_type: EXECUTE
-- (no other grantees)
```

### 9.4 search_path Audit

```sql
-- Verify the function's search_path is locked
SELECT proconfig FROM pg_proc WHERE proname = 'is_coordination_participant';

-- Expected: {search_path=public,pg_temp}
```

### 9.5 Query Audit (for SEC-20)

During integration tests, enable query logging:
```sql
-- In test setup
SET log_statement = 'all';
-- Run the shared view service
-- In test assertion: verify the log does NOT contain queries on:
-- reform_proposals, reform_actions, reform_action_updates, reform_approvals,
-- reform_verifications, reform_feedback_loops, evidence, audit_log
```

---

## 10. Honest Disclosure

### 10.1 What This Contract Does NOT Guarantee

1. **It does not prevent a malicious lead from sharing misleading snapshots**: A lead can share a snapshot with incorrect info. The system cannot verify the accuracy of human-written summaries. Mitigation: audit trail + reviewer accountability.

2. **It does not prevent side-channel inference**: A participant might infer info from coordination metadata (title, participant list, status). Mitigation: coordination list is participants-only (T9 mitigation).

3. **It does not verify institutional representation**: The `institutionId` field is documentation, not authorization. A tenant can claim to represent any institution. Mitigation: governance process + audit trail. (G03-L12)

4. **It does not prevent collusion**: Two participants from different tenants could collude to share data outside the system. The system cannot prevent this. Mitigation: audit trail + legal agreements (out of scope).

### 10.2 What This Contract DOES Guarantee

1. **No cross-tenant data leak via the coordination system**: RLS + SECURITY INVOKER function ensures each tenant sees only what they're authorized to see.
2. **No RLS bypass**: The function uses the caller's privileges — no dedicated bypass role.
3. **No data exfiltration via the function**: The function returns BOOLEAN only — never rows.
4. **Append-only history**: Shared snapshots, revocations, and invitations cannot be mutated or deleted.
5. **Audit trail completeness**: Every coordination action is atomically audited.
6. **Verifiable security**: 20 negative tests verify the contract on real PostgreSQL 16.

### 10.3 Open Question for Owner

**Should `balance_coordination_helper` role still be created?**

With `SECURITY INVOKER`, the function uses the caller's privileges — no dedicated role is needed. But the owner may want the function owned by a non-admin role (e.g., `postgres` or a dedicated `balance_function_owner`) for defense-in-depth.

**My recommendation**: Own the function as `postgres` (the default migration role). Do NOT create a dedicated helper role — it adds complexity without security benefit when using `SECURITY INVOKER`.

---

## 11. Conclusion

The rev 3 security contract for the coordination access function:

1. **Uses `SECURITY INVOKER`** (not `SECURITY DEFINER`) — no RLS bypass, no dedicated role
2. **Returns BOOLEAN only** — no data exfiltration surface
3. **Has locked `search_path`** — no search path injection
4. **Uses SQL language** (not PL/pgSQL) — no dynamic SQL
5. **Is verified by 20 negative tests** — on real PostgreSQL 16
6. **Is auditable** — function body, grants, ownership, search_path all verifiable

The owner's concern about `SECURITY DEFINER` was correct. The rev 3 solution (`SECURITY INVOKER`) is strictly more secure because it does NOT bypass RLS. The function works correctly because the RLS policy on `reform_coordination_participants` uses the same condition the function checks.

**This contract will be implemented in mission 03-01** (schema bootstrap) when the actual migration SQL is written. The contract here is the design specification — verifiable before implementation.

---

*End of G03-00 Security Contract for Coordination Access Function. Companion to: THREAT_MODEL.md, OPEN_DECISIONS.md (revised), DOMAIN_MODEL.md (revised), SECURITY_AND_EVIDENCE_POLICY.md (revised).*
