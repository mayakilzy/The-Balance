-- ============================================================
-- G03-00 Security Contract Validation — B1 (Participant Removal)
-- REVISED: Tests run in proper transactions so SET LOCAL persists
-- ============================================================
-- This script tests the B1 closure: the remove_coordination_participant
-- function with lead check INSIDE the UPDATE's WHERE clause.
-- ============================================================

\set ON_ERROR_STOP off

-- Clean slate
DROP SCHEMA IF EXISTS g03_b1_test CASCADE;
CREATE SCHEMA g03_b1_test;

-- Drop roles if exist
DO $$ BEGIN DROP ROLE IF EXISTS balance_app; END $$;
DO $$ BEGIN DROP ROLE IF EXISTS balance_admin; END $$;
DO $$ BEGIN DROP ROLE IF EXISTS balance_coordination_admin; END $$;

-- Create roles
CREATE ROLE balance_app NOLOGIN;
CREATE ROLE balance_admin NOLOGIN BYPASSRLS;
CREATE ROLE balance_coordination_admin NOLOGIN;

-- Grant USAGE on schema
GRANT USAGE ON SCHEMA g03_b1_test TO balance_app, balance_admin, balance_coordination_admin;

SET search_path = g03_b1_test, public;

-- ============================================================
-- Tables
-- ============================================================
CREATE TABLE g03_b1_test.reform_coordinations (
  id TEXT PRIMARY KEY,
  "leadTenantId" TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE g03_b1_test.reform_coordination_participants (
  id TEXT PRIMARY KEY,
  "coordinationId" TEXT NOT NULL REFERENCES g03_b1_test.reform_coordinations(id),
  "tenantId" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_invitation',
  "removedAt" TIMESTAMP,
  "removedBy" TEXT,
  "removalReason" TEXT
);

CREATE INDEX ON g03_b1_test.reform_coordination_participants ("coordinationId");

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE g03_b1_test.reform_coordinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b1_test.reform_coordinations FORCE ROW LEVEL SECURITY;
ALTER TABLE g03_b1_test.reform_coordination_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b1_test.reform_coordination_participants FORCE ROW LEVEL SECURITY;

-- Policies for balance_app on coordinations
CREATE POLICY rc_select_app ON g03_b1_test.reform_coordinations
  FOR SELECT TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true));

CREATE POLICY rc_insert_app ON g03_b1_test.reform_coordinations
  FOR INSERT TO balance_app
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));

CREATE POLICY rc_update_app ON g03_b1_test.reform_coordinations
  FOR UPDATE TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));

-- Policies for balance_coordination_admin on coordinations (for lead check subquery)
CREATE POLICY rc_select_cadmin ON g03_b1_test.reform_coordinations
  FOR SELECT TO balance_coordination_admin
  USING (true);

-- Policies for balance_app on participants (own row only)
CREATE POLICY rcp_select_app ON g03_b1_test.reform_coordination_participants
  FOR SELECT TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY rcp_insert_app ON g03_b1_test.reform_coordination_participants
  FOR INSERT TO balance_app
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY rcp_update_app ON g03_b1_test.reform_coordination_participants
  FOR UPDATE TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Policies for balance_coordination_admin on participants
-- FIX: PostgreSQL requires SELECT privilege for UPDATE...RETURNING and WHERE clause column reads
CREATE POLICY rcp_select_cadmin ON g03_b1_test.reform_coordination_participants
  FOR SELECT TO balance_coordination_admin
  USING (true);

CREATE POLICY rcp_update_cadmin ON g03_b1_test.reform_coordination_participants
  FOR UPDATE TO balance_coordination_admin
  USING (true)
  WITH CHECK (true);

-- Grants
GRANT SELECT, INSERT, UPDATE ON g03_b1_test.reform_coordinations TO balance_app;
GRANT SELECT, INSERT, UPDATE ON g03_b1_test.reform_coordination_participants TO balance_app;
GRANT SELECT ON g03_b1_test.reform_coordinations TO balance_coordination_admin;
GRANT SELECT, UPDATE ON g03_b1_test.reform_coordination_participants TO balance_coordination_admin;
GRANT ALL ON ALL TABLES IN SCHEMA g03_b1_test TO balance_admin;

-- ============================================================
-- Function (REV 5 — Option A corrected)
-- ============================================================
CREATE OR REPLACE FUNCTION g03_b1_test.remove_coordination_participant(
  p_coordination_id TEXT,
  p_participant_id TEXT,
  p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = g03_b1_test, public
AS $$
  WITH updated AS (
    UPDATE g03_b1_test.reform_coordination_participants p
    SET "status" = 'removed',
        "removedAt" = NOW(),
        "removedBy" = current_setting('app.user_id', true),
        "removalReason" = p_reason
    WHERE p."coordinationId" = p_coordination_id
      AND p."id" = p_participant_id
      AND p."status" = 'active'
      AND EXISTS (
        SELECT 1 FROM g03_b1_test.reform_coordinations c
        WHERE c."id" = p_coordination_id
          AND c."leadTenantId" = current_setting('app.tenant_id', true)
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

ALTER FUNCTION g03_b1_test.remove_coordination_participant(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;

GRANT EXECUTE ON FUNCTION g03_b1_test.remove_coordination_participant(TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION g03_b1_test.remove_coordination_participant(TEXT, TEXT, TEXT) FROM PUBLIC;

-- ============================================================
-- Setup: Test data (as balance_admin — BYPASSRLS)
-- ============================================================
SET ROLE balance_admin;

INSERT INTO g03_b1_test.reform_coordinations (id, "leadTenantId", title, status) VALUES
  ('coord-1', 'tenant-A', 'Coordination 1 (lead: A)', 'active'),
  ('coord-2', 'tenant-B', 'Coordination 2 (lead: B)', 'active');

INSERT INTO g03_b1_test.reform_coordination_participants (id, "coordinationId", "tenantId", status) VALUES
  ('part-A1', 'coord-1', 'tenant-A', 'active'),
  ('part-B1', 'coord-1', 'tenant-B', 'active'),
  ('part-A2', 'coord-2', 'tenant-A', 'active'),
  ('part-B2', 'coord-2', 'tenant-B', 'active');

RESET ROLE;

-- ============================================================
-- TEST 1: Lead (tenant-A) removes participant from their coordination
-- Expected: TRUE, participant status changed to 'removed'
-- ============================================================
\echo ''
\echo '=== B1 TEST 1: Lead removes participant ==='
SET ROLE balance_app;
BEGIN;
SET LOCAL app.tenant_id = 'tenant-A';
SET LOCAL app.user_id = 'user-A-admin';
SELECT g03_b1_test.remove_coordination_participant('coord-1', 'part-B1', 'Lead removes participant') AS test1_result;
COMMIT;
RESET ROLE;

SET ROLE balance_admin;
SELECT 'TEST1_verify' AS test, id, status, "removedBy" FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-B1';
RESET ROLE;

-- ============================================================
-- TEST 2: Non-lead (tenant-B) tries to remove participant from coord-1 (lead: A)
-- Expected: FALSE, ZERO rows modified
-- ============================================================
\echo ''
\echo '=== B1 TEST 2: Non-lead tries to remove participant ==='
SET ROLE balance_app;
BEGIN;
SET LOCAL app.tenant_id = 'tenant-B';
SET LOCAL app.user_id = 'user-B-admin';
SELECT g03_b1_test.remove_coordination_participant('coord-1', 'part-A1', 'Non-lead attempt') AS test2_result;
COMMIT;
RESET ROLE;

SET ROLE balance_admin;
SELECT 'TEST2_verify' AS test, id, status, "removedBy" FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-A1';
RESET ROLE;

-- ============================================================
-- TEST 3: Direct UPDATE by balance_app (bypassing function) — cross-tenant
-- Expected: 0 rows affected (RLS blocks SELECT visibility)
-- ============================================================
\echo ''
\echo '=== B1 TEST 3: Direct cross-tenant UPDATE blocked by RLS ==='
SET ROLE balance_app;
BEGIN;
SET LOCAL app.tenant_id = 'tenant-A';
UPDATE g03_b1_test.reform_coordination_participants
SET "removalReason" = 'direct update attempt'
WHERE id = 'part-B2' AND status = 'active';
COMMIT;
RESET ROLE;

SET ROLE balance_admin;
SELECT 'TEST3_verify' AS test, id, status, "removalReason" FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-B2';
RESET ROLE;

-- ============================================================
-- TEST 4: PUBLIC cannot call the function (EXECUTE revoked)
-- Expected: ERROR (permission denied)
-- ============================================================
\echo ''
\echo '=== B1 TEST 4: PUBLIC cannot call function ==='
DO $$ BEGIN DROP ROLE IF EXISTS test_public_user; END $$;
CREATE ROLE test_public_user LOGIN;
GRANT USAGE ON SCHEMA g03_b1_test TO test_public_user;

SET ROLE test_public_user;
BEGIN;
SET LOCAL app.tenant_id = 'tenant-A';
SET LOCAL app.user_id = 'attacker';
SELECT g03_b1_test.remove_coordination_participant('coord-2', 'part-A2', 'public attempt') AS test4_result;
COMMIT;
RESET ROLE;
DROP ROLE test_public_user;

-- ============================================================
-- TEST 5: set_config impersonation — DOCUMENTED LIMITATION
-- balance_app CAN set app.tenant_id arbitrarily (PostgreSQL allows it)
-- This proves protection depends on application context, NOT DB-level enforcement
-- ============================================================
\echo ''
\echo '=== B1 TEST 5: set_config impersonation (documented limitation) ==='
SET ROLE balance_app;
BEGIN;
SET LOCAL app.tenant_id = 'tenant-B';  -- tenant-A user impersonates tenant-B
SET LOCAL app.user_id = 'impersonator';
-- This WILL succeed because PostgreSQL allows set_config freely
-- Protection depends on the application not allowing arbitrary set_config calls
SELECT g03_b1_test.remove_coordination_participant('coord-2', 'part-A2', 'impersonation') AS test5_result;
COMMIT;
RESET ROLE;

SET ROLE balance_admin;
SELECT 'TEST5_verify' AS test, id, status, "removedBy" FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-A2';
RESET ROLE;

\echo ''
\echo '=== B1 VALIDATION COMPLETE ==='
\echo 'Expected results:'
\echo 'TEST 1: result=t, status=removed (lead can remove)'
\echo 'TEST 2: result=f, status=active (non-lead cannot remove)'
\echo 'TEST 3: 0 rows updated (RLS blocks cross-tenant direct UPDATE)'
\echo 'TEST 4: ERROR permission denied (PUBLIC cannot EXECUTE)'
\echo 'TEST 5: result=t — IMPERSONATION SUCCEEDS (documented limitation)'
