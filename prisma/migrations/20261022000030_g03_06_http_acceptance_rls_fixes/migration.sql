-- ============================================================
-- The Balance — Migration 0030: G03-06 HTTP Acceptance RLS Fixes
-- ------------------------------------------------------------
-- Three genuine defects were uncovered by G03-06 FINAL HTTP ACCEPTANCE
-- tests against a running Next.js + PostgreSQL 17 instance. These are
-- minimal, forward-only, additive corrections that preserve all frozen
-- G03-05 / G03-06 security contracts (OD-1 to OD-Q1).
--
-- Defect 1 (participants INSERT): The INSERT WITH CHECK policy
--   `reform_coord_participants_insert_app` required the new row's
--   `tenantId` to equal `current_setting('app.tenant_id')`. This
--   blocked two legitimate G03-06 flows:
--     (a) Lead (Tenant A) adding Tenant B as a participant — the new
--         row's tenantId is Tenant B, not the caller's Tenant A.
--     (b) Invited tenant (Tenant B) accepting an invitation — Tenant B
--         is not the lead, so the EXISTS(lead=caller) clause fails.
--   Fix: Allow INSERT when the caller is the LEAD of the coordination
--        (regardless of the new row's tenantId), OR when there is a
--        pending invitation for the caller's tenant in this coordination.
--
-- Defect 2 (invitations UPDATE): The UPDATE policy
--   `reform_coord_invitations_update_app` required `invitedTenantId =
--   current_setting('app.tenant_id')`. This blocked the LEAD from
--   revoking an invitation (the revoke-invitation operation is part
--   of the 16 active G03-06 routes per OD-7).
--   Fix: Allow UPDATE when the caller is the LEAD of the coordination
--        (for revocation) OR when the caller is the invited tenant
--        (for accept/decline — existing behavior preserved).
--
-- Defect 3 (shared_snapshots approve): The G03-01 trigger
--   `enforce_shared_snapshot_immutable_after_approval()` (migration 25)
--   forbids `balance_app` from modifying approvedBy/approvedAt/status.
--   The G03-06 `approveSharedSnapshot` service ran the UPDATE as
--   `balance_app`, which the trigger correctly blocked.
--   Fix: Add a SECURITY DEFINER function owned by
--        `balance_coordination_admin` (NOLOGIN, exempt from the
--        balance_app-only trigger). The function verifies the caller
--        is the lead of the coordination (via app.tenant_id GUC) and
--        performs the approval. balance_app is granted EXECUTE.
--        This mirrors the existing G03-06 pattern used for
--        `check_coordination_activation()` (migration 27).
--
-- No frozen contracts modified. No destructive changes. No new tables.
-- All changes are additive: ALTER POLICY + CREATE FUNCTION + GRANT.
-- ============================================================

-- ============================================================
-- FIX 1: participants INSERT policy — allow lead + invited-tenant paths
-- ============================================================
DROP POLICY IF EXISTS reform_coord_participants_insert_app ON reform_coordination_participants;

CREATE POLICY reform_coord_participants_insert_app ON reform_coordination_participants
    FOR INSERT TO balance_app
    WITH CHECK (
        -- Path A: Caller is the LEAD of the coordination → can add any tenant
        EXISTS (
            SELECT 1 FROM reform_coordinations c
            WHERE c.id = reform_coordination_participants."coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
        OR
        -- Path B: Caller is the invited tenant (accepting a pending invitation)
        (
            reform_coordination_participants."tenantId" = current_setting('app.tenant_id', true)
            AND EXISTS (
                SELECT 1 FROM reform_coordination_invitations i
                WHERE i."coordinationId" = reform_coordination_participants."coordinationId"
                  AND i."invitedTenantId" = reform_coordination_participants."tenantId"
                  AND i.status = 'pending'
            )
        )
    );

-- ============================================================
-- FIX 2: invitations UPDATE policy — allow lead (revoke) + invited (accept/decline)
-- ============================================================
DROP POLICY IF EXISTS reform_coord_invitations_update_app ON reform_coordination_invitations;

CREATE POLICY reform_coord_invitations_update_app ON reform_coordination_invitations
    FOR UPDATE TO balance_app
    USING (
        -- Invited tenant can update (accept / decline)
        "invitedTenantId" = current_setting('app.tenant_id', true)
        OR
        -- Lead of the coordination can update (revoke)
        EXISTS (
            SELECT 1 FROM reform_coordinations c
            WHERE c.id = reform_coordination_invitations."coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    )
    WITH CHECK (
        "invitedTenantId" = current_setting('app.tenant_id', true)
        OR
        EXISTS (
            SELECT 1 FROM reform_coordinations c
            WHERE c.id = reform_coordination_invitations."coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    );

-- ============================================================
-- FIX 3: SECURITY DEFINER function for shared-snapshot approval
-- ------------------------------------------------------------
-- balance_coordination_admin is the same NOLOGIN role that owns
-- check_coordination_activation (migration 27). Granting UPDATE on
-- shared_snapshots to it does not weaken RLS for balance_app —
-- balance_app still cannot UPDATE directly (the trigger blocks it).
-- The function itself is the ONLY path.
-- ============================================================

-- Grant UPDATE on shared_snapshots + INSERT on audit_log to balance_coordination_admin
-- (audit_log INSERT was already granted in migration 27 — re-grant is idempotent)
GRANT UPDATE ON "reform_coordination_shared_snapshots" TO balance_coordination_admin;

-- Allow balance_coordination_admin to bypass the G03-01 immutable-after-approval
-- trigger by adding a permissive UPDATE policy (mirrors reform_coordinations_cadmin_update
-- from migration 27).
CREATE POLICY reform_coord_snapshots_cadmin_update ON reform_coordination_shared_snapshots
    FOR UPDATE TO balance_coordination_admin USING (true) WITH CHECK (true);

-- ============================================================
-- SECURITY DEFINER: approve_coordination_shared_snapshot
-- ------------------------------------------------------------
-- Verifies the caller's app.tenant_id matches the lead of the
-- coordination, then transitions the snapshot to 'approved' and
-- records the audit entry. balance_app is granted EXECUTE —
-- but the function performs its own lead check, so a non-lead
-- caller gets a controlled exception instead of a data leak.
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_coordination_shared_snapshot(
    p_snapshot_id TEXT,
    p_approver_id TEXT,
    p_tenant_id TEXT,
    p_approval_notes TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_coordination_id TEXT;
    v_lead_tenant_id TEXT;
    v_current_status TEXT;
BEGIN
    -- Caller-provided p_tenant_id MUST match the session GUC (anti-spoofing)
    IF p_tenant_id IS NULL OR p_tenant_id <> current_setting('app.tenant_id', true) THEN
        RAISE EXCEPTION 'approve_coordination_shared_snapshot: tenant_id mismatch (GUC vs param)';
    END IF;

    -- Load snapshot + coordination lead
    SELECT s."coordinationId", s.status, c."leadTenantId"
      INTO v_coordination_id, v_current_status, v_lead_tenant_id
    FROM reform_coordination_shared_snapshots s
    JOIN reform_coordinations c ON c.id = s."coordinationId"
    WHERE s.id = p_snapshot_id;

    IF v_coordination_id IS NULL THEN
        RAISE EXCEPTION 'approve_coordination_shared_snapshot: snapshot not found';
    END IF;

    -- Verify caller is the lead
    IF v_lead_tenant_id <> p_tenant_id THEN
        RAISE EXCEPTION 'approve_coordination_shared_snapshot: caller is not the lead of coordination %', v_coordination_id;
    END IF;

    -- Verify snapshot is in 'draft' status (idempotency check)
    IF v_current_status <> 'draft' THEN
        RAISE EXCEPTION 'approve_coordination_shared_snapshot: snapshot % is not in draft status (current=%)', p_snapshot_id, v_current_status;
    END IF;

    -- Perform the approval (current_user=balance_coordination_admin bypasses trigger)
    UPDATE reform_coordination_shared_snapshots
      SET status = 'approved',
          "approvedAt" = NOW(),
          "approvedBy" = p_approver_id
      WHERE id = p_snapshot_id;

    -- Audit log entry (balance_coordination_admin has INSERT policy from migration 27)
    INSERT INTO audit_log ("tenantId", actor, action, details, status, "at")
    VALUES (p_tenant_id, p_approver_id, 'reform.coordination.snapshot_approved',
            jsonb_build_object('coordinationId', v_coordination_id, 'snapshotId', p_snapshot_id, 'notes', p_approval_notes),
            'ok', NOW());

    RETURN TRUE;
END;
$$;

-- Owner = balance_coordination_admin (NOLOGIN — callers MUST use SECURITY DEFINER)
ALTER FUNCTION public.approve_coordination_shared_snapshot(TEXT, TEXT, TEXT, TEXT)
    OWNER TO balance_coordination_admin;

-- Grant EXECUTE to balance_app (the role the application uses)
GRANT EXECUTE ON FUNCTION public.approve_coordination_shared_snapshot(TEXT, TEXT, TEXT, TEXT) TO balance_app;
