-- ============================================================
-- The Balance — Migration 0032: G03-06 Trust Boundary Closure
-- ------------------------------------------------------------
-- CORRECTIVE migration (forward-only) addressing the remaining
-- GUC-spoofing vulnerability in Migration 31's snapshot approval path.
--
-- VULNERABILITY (confirmed by reproduce-attack-migration31.sql):
--   Migration 31 replaced the direct-call function with an RLS-gated
--   INSERT into reform_coordination_snapshot_approval_requests + trigger.
--   But the RLS INSERT policy checks:
--     "tenantId" = current_setting('app.tenant_id', true)
--     AND "requestedBy" = current_setting('app.user_id', true)
--
--   Both GUCs are caller-controllable by a balance_app connection.
--   An attacker with a balance_app DB connection can:
--     1. SET app.tenant_id to a valid lead institution
--     2. SET app.user_id to a valid authorized user's ID
--     3. INSERT into reform_coordination_snapshot_approval_requests
--     4. The trigger fires, approves the snapshot, writes audit with forged identity
--
--   The trust boundary is still GUC-based, not credential-based.
--
-- FIX — Establish a REAL trust boundary via a dedicated privileged
-- database connection with separate credentials:
--
--   1. Drop the trigger + function + approval_requests table from
--      Migration 31. The RLS-gated INSERT + trigger pattern is removed
--      entirely because its RLS check depends on spoofable GUCs.
--
--   2. Create a new LOGIN role `balance_snapshot_approver` with a
--      password known ONLY to the application server (stored in
--      PRIVILEGED_DATABASE_URL env var). balance_app CANNOT:
--        - Connect as this role (no password)
--        - SET ROLE to it (not a member)
--        - Assume its privileges in any way
--
--   3. Grant balance_snapshot_approver:
--        - UPDATE (status, approvedAt, approvedBy) on shared_snapshots
--        - INSERT on audit_log + USAGE on audit_log_id_seq
--        - SELECT on shared_snapshots + reform_coordinations (for RLS subqueries)
--
--   4. RLS policies for balance_snapshot_approver:
--        - UPDATE on shared_snapshots: USING (status='draft' AND lead=app.tenant_id)
--          WITH CHECK (status='approved')
--        - INSERT on audit_log: WITH CHECK (tenantId = app.tenant_id)
--        - SELECT on shared_snapshots: USING (coordination.leadTenantId = app.tenant_id)
--
--   The G03-01 trigger (enforce_shared_snapshot_immutable_after_approval)
--   only fires for current_user = 'balance_app'. balance_snapshot_approver
--   is exempt (same as balance_coordination_admin), so it can perform the
--   UPDATE that balance_app cannot.
--
-- TRUST CHAIN:
--   1. User authenticates via Auth.js (password verified via bcrypt)
--   2. App loads current membership from DB (via balance_auth, read-only)
--   3. App verifies coordination.leadTenantId === session.user.tenantId
--      (TypeScript authorization check)
--   4. App opens a SEPARATE DB connection as balance_snapshot_approver
--      (credentials from PRIVILEGED_DATABASE_URL, not accessible to
--      balance_app)
--   5. App sets GUCs (app.tenant_id, app.user_id) from the verified session
--   6. Privileged connection performs UPDATE + audit INSERT atomically
--      (RLS verifies leadTenantId = app.tenant_id as defense-in-depth)
--
-- ATTACKER WITH balance_app CREDENTIALS:
--   - CANNOT connect as balance_snapshot_approver (no password)
--   - CANNOT SET ROLE to it (not a member)
--   - balance_app's UPDATE on shared_snapshots is blocked by G03-01 trigger
--   - balance_app's INSERT on approval_requests is removed (table dropped)
--   - NO path to approve snapshots with forged identity
--
-- No frozen G03-05/G03-06 contract is modified. Migration 30's RLS fixes
-- (participants INSERT, invitations UPDATE) are preserved. Migration 27's
-- activation trigger is untouched. The G03-01 immutable-after-approval
-- trigger is preserved verbatim.
-- ============================================================

-- ============================================================
-- 1. Drop Migration 31's trigger + function + table
-- ============================================================
DROP TRIGGER IF EXISTS process_snapshot_approval_trigger ON reform_coordination_snapshot_approval_requests;
DROP FUNCTION IF EXISTS public.process_snapshot_approval_request();
DROP TABLE IF EXISTS reform_coordination_snapshot_approval_requests CASCADE;

-- ============================================================
-- 2. Create balance_snapshot_approver LOGIN role
-- ------------------------------------------------------------
-- This is a LOGIN role with a password. The password is stored ONLY
-- in the application server's environment (PRIVILEGED_DATABASE_URL).
-- balance_app CANNOT:
--   - Connect as this role (doesn't have the password)
--   - SET ROLE to it (not a member of this role)
--   - Assume its privileges in any way
--
-- Dev password is used in CI + local dev. Production MUST override
-- via environment variable.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_snapshot_approver') THEN
    CREATE ROLE balance_snapshot_approver
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      PASSWORD 'balance_snapshot_approver_dev_only';
  END IF;
END $$;

-- ============================================================
-- 3. Grant privileges to balance_snapshot_approver
-- ------------------------------------------------------------
-- Column-level UPDATE on shared_snapshots: only the 3 columns needed
-- for approval transition. No UPDATE on content fields (title, summary,
-- snapshotType, classification, proposalId, actionId, ownerTenantId,
-- coordinationId) — those remain immutable.
-- ============================================================
GRANT USAGE ON SCHEMA public TO balance_snapshot_approver;
GRANT SELECT ON reform_coordination_shared_snapshots TO balance_snapshot_approver;
GRANT UPDATE (status, "approvedAt", "approvedBy") ON reform_coordination_shared_snapshots TO balance_snapshot_approver;
GRANT SELECT ON reform_coordinations TO balance_snapshot_approver;
GRANT INSERT ON audit_log TO balance_snapshot_approver;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO balance_snapshot_approver;

-- ============================================================
-- 4. RLS policies for balance_snapshot_approver
-- ------------------------------------------------------------
-- These policies verify that the coordination's leadTenantId matches
-- the app.tenant_id GUC. The GUC is set by the APPLICATION SERVER
-- (from the verified Auth.js session), NOT by a direct DB caller.
--
-- An attacker with balance_app credentials CANNOT set GUCs for
-- balance_snapshot_approver because they cannot connect as that role.
-- ============================================================

-- SELECT: can see snapshots where the coordination's lead = app.tenant_id
CREATE POLICY shared_snapshots_approver_select ON reform_coordination_shared_snapshots
    FOR SELECT TO balance_snapshot_approver
    USING (EXISTS (
        SELECT 1 FROM reform_coordinations c
        WHERE c.id = reform_coordination_shared_snapshots."coordinationId"
          AND c."leadTenantId" = current_setting('app.tenant_id', true)
    ));

-- UPDATE: only draft snapshots where lead = app.tenant_id, transition to approved only
CREATE POLICY shared_snapshots_approver_update ON reform_coordination_shared_snapshots
    FOR UPDATE TO balance_snapshot_approver
    USING (
        status = 'draft'
        AND EXISTS (
            SELECT 1 FROM reform_coordinations c
            WHERE c.id = reform_coordination_shared_snapshots."coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    )
    WITH CHECK (status = 'approved');

-- SELECT on reform_coordinations: can see coordinations where lead = app.tenant_id
-- (needed for the RLS subqueries above)
CREATE POLICY reform_coordinations_approver_select ON reform_coordinations
    FOR SELECT TO balance_snapshot_approver
    USING ("leadTenantId" = current_setting('app.tenant_id', true));

-- INSERT on audit_log: must match app.tenant_id (set by app from verified session)
CREATE POLICY audit_log_approver_insert ON audit_log
    FOR INSERT TO balance_snapshot_approver
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- ============================================================
-- 5. Verify balance_app CANNOT SET ROLE to balance_snapshot_approver
-- ------------------------------------------------------------
-- This is enforced by PostgreSQL's role membership system.
-- balance_app is NOT a member of balance_snapshot_approver, so
-- SET ROLE balance_snapshot_approver will fail with "permission denied."
-- No additional SQL needed — the absence of a GRANT statement means
-- no membership exists.
-- ============================================================

-- ============================================================
-- 6. Verify balance_app still CANNOT UPDATE shared_snapshots
-- ------------------------------------------------------------
-- The G03-01 trigger (migration 25) blocks balance_app from modifying
-- approvedBy/approvedAt/status=approved. balance_app has table-level
-- UPDATE (from migration 0022), but the trigger raises an exception.
-- This is the existing defense — no change needed.
--
-- balance_app also still has INSERT on the (now-dropped) approval_requests
-- table — but the table no longer exists, so the INSERT path is gone.
-- ============================================================
