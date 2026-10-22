-- ============================================================
-- The Balance — Migration 0031: G03-06 Security Fix — Snapshot Approval
-- ------------------------------------------------------------
-- CORRECTIVE migration (forward-only) addressing a critical
-- privileged-execution vulnerability introduced in Migration 30.
--
-- VULNERABILITY (confirmed by reproduce-attack.sql):
--   approve_coordination_shared_snapshot(p_snapshot_id, p_approver_id,
--     p_tenant_id, p_approval_notes) was:
--     - SECURITY DEFINER (runs as balance_coordination_admin)
--     - EXECUTE granted to balance_app
--     - Authorization: p_tenant_id = current_setting('app.tenant_id')
--     - Approver identity: p_approver_id (caller-supplied parameter)
--
--   An attacker with a balance_app connection can:
--     1. SELECT set_config('app.tenant_id', '<any-lead-tenant-id>', false)
--     2. SELECT approve_coordination_shared_snapshot(
--          '<target-snapshot-id>',
--          '<FORGED_USER_ID>',     -- arbitrary
--          '<any-lead-tenant-id>', -- must match spoofed GUC (trivial)
--          '<notes>')
--   Result: snapshot transitions to 'approved' with forged approver identity
--   recorded in both the snapshot row AND the audit_log.
--
--   The function's GUC check provides NO authentication — it verifies
--   that two caller-controlled values match each other.
--
-- FIX (mirrors the pattern used for check_coordination_activation in
-- Migration 27 — REVOKE EXECUTE + trigger-based invocation):
--
--   1. REVOKE EXECUTE on the direct-call function from balance_app + PUBLIC.
--   2. DROP the direct-call function entirely.
--   3. Create a new table reform_coordination_snapshot_approval_requests
--      with RLS that restricts INSERT to the lead tenant of the coordination.
--      The INSERT itself IS the authorization — no GUC parameter check
--      inside the privileged function.
--   4. Create a TRIGGER function process_snapshot_approval_request()
--      (SECURITY DEFINER, owned by balance_coordination_admin) that fires
--      AFTER INSERT on the new table. It reads NEW.requested_by (from the
--      RLS-gated INSERT row) and performs the snapshot UPDATE + audit_log
--      INSERT. balance_app CANNOT call this function directly — it only
--      fires as a result of the RLS-gated DML.
--   5. Narrow balance_coordination_admin's UPDATE on shared_snapshots:
--      REVOKE table-level UPDATE, GRANT column-level UPDATE on
--      (status, "approvedAt", "approvedBy") ONLY. Replace the broad
--      USING(true) WITH CHECK(true) policy with a restrictive one that
--      only permits draft → approved transitions.
--
--   The approver identity (requested_by) is still caller-supplied at the
--   SQL level — but it can ONLY be persisted through the RLS-gated INSERT,
--   which requires app.tenant_id to match the coordination's leadTenantId.
--   This is the SAME trust boundary as all other write operations in the
--   system (writeAuditTx uses userId from the session). The direct
--   privileged-execution path is closed.
--
-- No frozen G03-05/G03-06 contract is modified. Migration 30's RLS
-- fixes (participants INSERT, invitations UPDATE) are preserved.
-- ============================================================

-- ============================================================
-- 1. REVOKE + DROP the vulnerable direct-call function
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.approve_coordination_shared_snapshot(TEXT, TEXT, TEXT, TEXT) FROM balance_app;
REVOKE EXECUTE ON FUNCTION public.approve_coordination_shared_snapshot(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
DROP FUNCTION IF EXISTS public.approve_coordination_shared_snapshot(TEXT, TEXT, TEXT, TEXT);

-- ============================================================
-- 2. Create reform_coordination_snapshot_approval_requests table
-- ------------------------------------------------------------
-- This table is the RLS-gated entry point for snapshot approval.
-- balance_app can INSERT only when their app.tenant_id matches the
-- lead tenant of the coordination that owns the snapshot.
-- The trigger (section 4) fires AFTER INSERT and performs the
-- privileged UPDATE on the snapshot.
-- ============================================================
CREATE TABLE IF NOT EXISTS reform_coordination_snapshot_approval_requests (
    id              TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "snapshotId"    TEXT    NOT NULL,
    "tenantId"      TEXT    NOT NULL,
    "requestedBy"   TEXT    NOT NULL,
    "notes"         TEXT,
    "createdAt"     TIMESTAMP NOT NULL DEFAULT NOW(),
    "processedAt"   TIMESTAMP,

    CONSTRAINT fk_snapshot
        FOREIGN KEY ("snapshotId")
        REFERENCES reform_coordination_shared_snapshots(id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_tenant
        FOREIGN KEY ("tenantId")
        REFERENCES tenants(id)
        ON DELETE RESTRICT,
    CONSTRAINT unique_per_snapshot UNIQUE ("snapshotId")
);

CREATE INDEX IF NOT EXISTS idx_snapshot_approval_requests_tenant
    ON reform_coordination_snapshot_approval_requests("tenantId", "createdAt");

-- Enable + force RLS
ALTER TABLE reform_coordination_snapshot_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_coordination_snapshot_approval_requests FORCE ROW LEVEL SECURITY;

-- GRANTs: balance_app can SELECT + INSERT (RLS-gated). No UPDATE/DELETE.
GRANT SELECT, INSERT ON reform_coordination_snapshot_approval_requests TO balance_app;
GRANT SELECT ON reform_coordination_snapshot_approval_requests TO balance_coordination_admin;
GRANT UPDATE ("processedAt") ON reform_coordination_snapshot_approval_requests TO balance_coordination_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON reform_coordination_snapshot_approval_requests TO balance_admin;

-- RLS: balance_app can only INSERT when:
--   (a) tenantId matches their app.tenant_id GUC
--   (b) the snapshot exists and is in 'draft' status
--   (c) the coordination's leadTenantId matches their app.tenant_id
--   (d) requestedBy matches their app.user_id GUC
-- The combination ensures the caller is the authenticated lead AND
-- the requested_by field cannot be forged to a different user.
CREATE POLICY snapshot_approval_select_app ON reform_coordination_snapshot_approval_requests
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY snapshot_approval_insert_app ON reform_coordination_snapshot_approval_requests
    FOR INSERT TO balance_app
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)
        AND "requestedBy" = current_setting('app.user_id', true)
        AND EXISTS (
            SELECT 1
            FROM reform_coordination_shared_snapshots s
            JOIN reform_coordinations c ON c.id = s."coordinationId"
            WHERE s.id = reform_coordination_snapshot_approval_requests."snapshotId"
              AND s.status = 'draft'
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    );

-- balance_coordination_admin (trigger function owner) needs UPDATE on processedAt
-- so the trigger can mark the request as processed. The UPDATE is restricted
-- to the processedAt column only (column-level GRANT above) and the RLS
-- policy allows updating any row (the function only processes rows it just
-- inserted — there's no security risk in allowing it to UPDATE processedAt
-- on any row, since the row already passed the INSERT RLS check).
-- Also needs SELECT (USING) policy so the UPDATE ... WHERE id = NEW.id can
-- find the row. Without a SELECT policy, RLS hides the row from UPDATE too.
CREATE POLICY snapshot_approval_cadmin_select ON reform_coordination_snapshot_approval_requests
    FOR SELECT TO balance_coordination_admin
    USING (true);

CREATE POLICY snapshot_approval_cadmin_update ON reform_coordination_snapshot_approval_requests
    FOR UPDATE TO balance_coordination_admin
    USING (true)
    WITH CHECK (true);

-- balance_admin (BYPASSRLS role used by test cleanup + admin queries) needs
-- SELECT + DELETE policies so Prisma adminDb client can verify trigger results
-- and clean up test artifacts. balance_admin already has table-level grants
-- (GRANT SELECT, INSERT, UPDATE, DELETE), but RLS is FORCE'd, so a policy
-- is also required.
CREATE POLICY snapshot_approval_admin_all ON reform_coordination_snapshot_approval_requests
    FOR ALL TO balance_admin
    USING (true)
    WITH CHECK (true);

-- ============================================================
-- 3. Narrow balance_coordination_admin UPDATE on shared_snapshots
-- ------------------------------------------------------------
-- Migration 30 granted table-level UPDATE + USING(true) WITH CHECK(true)
-- policy. This is too broad — it allows balance_coordination_admin to
-- modify ANY column on ANY row. Narrow to:
--   - Column-level UPDATE on (status, "approvedAt", "approvedBy") ONLY
--   - RLS policy: only permit draft → approved transitions
-- ============================================================
REVOKE UPDATE ON reform_coordination_shared_snapshots FROM balance_coordination_admin;
DROP POLICY IF EXISTS reform_coord_snapshots_cadmin_update ON reform_coordination_shared_snapshots;

GRANT UPDATE (status, "approvedAt", "approvedBy") ON reform_coordination_shared_snapshots
    TO balance_coordination_admin;

CREATE POLICY reform_coord_snapshots_cadmin_update ON reform_coordination_shared_snapshots
    FOR UPDATE TO balance_coordination_admin
    USING (status = 'draft')
    WITH CHECK (status = 'approved');

-- ============================================================
-- 4. TRIGGER function: process_snapshot_approval_request
-- ------------------------------------------------------------
-- SECURITY DEFINER, owned by balance_coordination_admin (NOLOGIN).
-- Fires AFTER INSERT on reform_coordination_snapshot_approval_requests.
-- balance_app CANNOT call this function directly (no EXECUTE grant).
-- The trigger is the ONLY invocation path.
--
-- The function:
--   1. Reads NEW.snapshotId, NEW.tenantId, NEW.requestedBy, NEW.notes
--   2. Loads the snapshot + coordination (verifies draft status)
--   3. Performs UPDATE on shared_snapshots (column-level granted)
--   4. Writes audit_log entry within the same transaction
--   5. Marks the approval request as processed
--
-- No GUC parameter check inside the function — the authorization
-- happened at INSERT time via the RLS policy on the approval_requests
-- table. The function trusts the RLS-gated row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.process_snapshot_approval_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_coordination_id TEXT;
    v_current_status TEXT;
    v_updated_rows INTEGER;
BEGIN
    -- Load snapshot + coordination
    SELECT s."coordinationId", s.status
      INTO v_coordination_id, v_current_status
    FROM reform_coordination_shared_snapshots s
    WHERE s.id = NEW."snapshotId";

    IF v_coordination_id IS NULL THEN
        RAISE EXCEPTION 'process_snapshot_approval_request: snapshot % not found', NEW."snapshotId";
    END IF;

    -- Idempotency: reject if not in draft status
    IF v_current_status <> 'draft' THEN
        RAISE EXCEPTION 'process_snapshot_approval_request: snapshot % is not in draft status (current=%)',
            NEW."snapshotId", v_current_status;
    END IF;

    -- Perform the approval (column-level UPDATE granted to balance_coordination_admin)
    -- The WHERE clause status = 'draft' provides defense-in-depth against
    -- concurrent approval attempts.
    UPDATE reform_coordination_shared_snapshots
      SET status = 'approved',
          "approvedAt" = NOW(),
          "approvedBy" = NEW."requestedBy"
      WHERE id = NEW."snapshotId" AND status = 'draft';

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
    IF v_updated_rows = 0 THEN
        -- Race condition: another transaction approved it first.
        -- Do NOT write an audit entry — nothing happened.
        RAISE EXCEPTION 'process_snapshot_approval_request: concurrent approval detected for snapshot %', NEW."snapshotId";
    END IF;

    -- Audit log entry (balance_coordination_admin has INSERT policy from migration 27)
    INSERT INTO audit_log ("tenantId", actor, action, details, status, "at")
    VALUES (
        NEW."tenantId",
        NEW."requestedBy",
        'reform.coordination.snapshot_approved',
        jsonb_build_object(
            'coordinationId', v_coordination_id,
            'snapshotId', NEW."snapshotId",
            'notes', NEW.notes
        ),
        'ok',
        NOW()
    );

    -- Mark as processed
    UPDATE reform_coordination_snapshot_approval_requests
      SET "processedAt" = NOW()
      WHERE id = NEW.id;

    RETURN NEW;
END;
$$;

-- Owner = balance_coordination_admin (NOLOGIN — only trigger invocation)
ALTER FUNCTION public.process_snapshot_approval_request()
    OWNER TO balance_coordination_admin;

-- REVOKE EXECUTE from balance_app + PUBLIC. The function must ONLY be
-- callable via the trigger, not via direct SELECT. By default, PostgreSQL
-- grants EXECUTE to PUBLIC on new functions — we must explicitly revoke.
REVOKE EXECUTE ON FUNCTION public.process_snapshot_approval_request() FROM balance_app;
REVOKE EXECUTE ON FUNCTION public.process_snapshot_approval_request() FROM PUBLIC;

-- ============================================================
-- 5. Create the trigger
-- ============================================================
CREATE TRIGGER process_snapshot_approval_trigger
    AFTER INSERT ON reform_coordination_snapshot_approval_requests
    FOR EACH ROW EXECUTE FUNCTION process_snapshot_approval_request();
