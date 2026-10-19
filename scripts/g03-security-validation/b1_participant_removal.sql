-- ============================================================
-- G03-00 B1 Security Validation — PL/pgSQL DO blocks with EXCEPTION handling
-- ============================================================

\set ON_ERROR_STOP off

DROP SCHEMA IF EXISTS g03_b1_test CASCADE;
DO $$ BEGIN DROP ROLE IF EXISTS test_public_user; END $$;
DO $$ BEGIN DROP ROLE IF EXISTS balance_app; END $$;
DO $$ BEGIN DROP ROLE IF EXISTS balance_admin; END $$;
DO $$ BEGIN DROP ROLE IF EXISTS balance_coordination_admin; END $$;

CREATE SCHEMA g03_b1_test;
CREATE ROLE balance_app NOLOGIN;
CREATE ROLE balance_admin NOLOGIN BYPASSRLS;
CREATE ROLE balance_coordination_admin NOLOGIN;
GRANT USAGE ON SCHEMA g03_b1_test TO balance_app, balance_admin, balance_coordination_admin;
SET search_path = g03_b1_test, public;

CREATE TABLE g03_b1_test.reform_coordinations (
  id TEXT PRIMARY KEY, "leadTenantId" TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
);
CREATE TABLE g03_b1_test.reform_coordination_participants (
  id TEXT PRIMARY KEY, "coordinationId" TEXT NOT NULL REFERENCES g03_b1_test.reform_coordinations(id),
  "tenantId" TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_invitation',
  "removedAt" TIMESTAMP, "removedBy" TEXT, "removalReason" TEXT
);
CREATE INDEX ON g03_b1_test.reform_coordination_participants ("coordinationId");

ALTER TABLE g03_b1_test.reform_coordinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b1_test.reform_coordinations FORCE ROW LEVEL SECURITY;
ALTER TABLE g03_b1_test.reform_coordination_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b1_test.reform_coordination_participants FORCE ROW LEVEL SECURITY;

CREATE POLICY rc_select_app ON g03_b1_test.reform_coordinations FOR SELECT TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rc_insert_app ON g03_b1_test.reform_coordinations FOR INSERT TO balance_app
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rc_update_app ON g03_b1_test.reform_coordinations FOR UPDATE TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rcp_select_app ON g03_b1_test.reform_coordination_participants FOR SELECT TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rcp_insert_app ON g03_b1_test.reform_coordination_participants FOR INSERT TO balance_app
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rcp_update_app ON g03_b1_test.reform_coordination_participants FOR UPDATE TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rc_select_cadmin ON g03_b1_test.reform_coordinations FOR SELECT TO balance_coordination_admin USING (true);
CREATE POLICY rcp_select_cadmin ON g03_b1_test.reform_coordination_participants FOR SELECT TO balance_coordination_admin USING (true);
CREATE POLICY rcp_update_cadmin ON g03_b1_test.reform_coordination_participants FOR UPDATE TO balance_coordination_admin USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON g03_b1_test.reform_coordinations TO balance_app;
GRANT SELECT, INSERT, UPDATE ON g03_b1_test.reform_coordination_participants TO balance_app;
GRANT SELECT ON g03_b1_test.reform_coordinations TO balance_coordination_admin;
GRANT SELECT, UPDATE ON g03_b1_test.reform_coordination_participants TO balance_coordination_admin;
GRANT ALL ON ALL TABLES IN SCHEMA g03_b1_test TO balance_admin;

CREATE OR REPLACE FUNCTION g03_b1_test.remove_coordination_participant(
  p_coordination_id TEXT, p_participant_id TEXT, p_reason TEXT
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = g03_b1_test, public AS $$
  WITH updated AS (
    UPDATE g03_b1_test.reform_coordination_participants p
    SET "status" = 'removed', "removedAt" = NOW(),
        "removedBy" = current_setting('app.user_id', true),
        "removalReason" = p_reason
    WHERE p."coordinationId" = p_coordination_id
      AND p."id" = p_participant_id AND p."status" = 'active'
      AND EXISTS (SELECT 1 FROM g03_b1_test.reform_coordinations c
                  WHERE c."id" = p_coordination_id AND c."leadTenantId" = current_setting('app.tenant_id', true))
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION g03_b1_test.remove_coordination_participant(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION g03_b1_test.remove_coordination_participant(TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION g03_b1_test.remove_coordination_participant(TEXT, TEXT, TEXT) FROM PUBLIC;

-- Test data
SET ROLE balance_admin;
INSERT INTO g03_b1_test.reform_coordinations VALUES ('coord-1', 'tenant-A', 'Coord 1', 'active'), ('coord-2', 'tenant-B', 'Coord 2', 'active');
INSERT INTO g03_b1_test.reform_coordination_participants VALUES
  ('part-A1', 'coord-1', 'tenant-A', 'active'), ('part-B1', 'coord-1', 'tenant-B', 'active'),
  ('part-A2', 'coord-2', 'tenant-A', 'active'), ('part-B2', 'coord-2', 'tenant-B', 'active');
RESET ROLE;

DROP TABLE IF EXISTS g03_b1_test.test_results;
CREATE TABLE g03_b1_test.test_results (test_id TEXT, description TEXT, expected TEXT, actual TEXT, pass BOOLEAN);

-- ============================================================
-- All tests via DO blocks with EXECUTE (avoids psql \gset issues)
-- ============================================================

-- TEST 1: Lead removes participant
DO $$
DECLARE v_result BOOLEAN; v_status TEXT; v_removedby TEXT;
BEGIN
  -- Set context and call function (subtransaction via EXECUTE)
  EXECUTE 'SET ROLE balance_app';
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  PERFORM set_config('app.user_id', 'user-A-admin', false);
  SELECT g03_b1_test.remove_coordination_participant('coord-1', 'part-B1', 'Lead removes') INTO v_result;
  EXECUTE 'RESET ROLE';
  -- Verify
  SET ROLE balance_admin;
  SELECT status, "removedBy" INTO v_status, v_removedby
    FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-B1';
  RESET ROLE;
  INSERT INTO g03_b1_test.test_results VALUES
    ('TEST1', 'Lead removes participant', 'TRUE+removed+user-A-admin',
     v_result::TEXT || '+' || v_status || '+' || COALESCE(v_removedby, 'NULL'),
     v_result = TRUE AND v_status = 'removed' AND v_removedby = 'user-A-admin');
END $$;

-- TEST 2: Non-lead cannot remove
DO $$
DECLARE v_result BOOLEAN; v_status TEXT; v_removedby TEXT;
BEGIN
  EXECUTE 'SET ROLE balance_app';
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  PERFORM set_config('app.user_id', 'user-B-admin', false);
  SELECT g03_b1_test.remove_coordination_participant('coord-1', 'part-A1', 'Non-lead') INTO v_result;
  EXECUTE 'RESET ROLE';
  SET ROLE balance_admin;
  SELECT status, "removedBy" INTO v_status, v_removedby
    FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-A1';
  RESET ROLE;
  INSERT INTO g03_b1_test.test_results VALUES
    ('TEST2', 'Non-lead cannot remove', 'FALSE+active+NULL',
     v_result::TEXT || '+' || v_status || '+' || COALESCE(v_removedby, 'NULL'),
     v_result = FALSE AND v_status = 'active' AND v_removedby IS NULL);
END $$;

-- TEST 3: Direct cross-tenant UPDATE blocked
DO $$
DECLARE v_reason TEXT;
BEGIN
  EXECUTE 'SET ROLE balance_app';
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  -- This UPDATE should affect 0 rows (RLS blocks visibility of part-B2)
  UPDATE g03_b1_test.reform_coordination_participants SET "removalReason" = 'direct attempt'
    WHERE id = 'part-B2' AND status = 'active';
  EXECUTE 'RESET ROLE';
  SET ROLE balance_admin;
  SELECT "removalReason" INTO v_reason FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-B2';
  RESET ROLE;
  INSERT INTO g03_b1_test.test_results VALUES
    ('TEST3', 'Direct cross-tenant UPDATE blocked', 'NULL reason (RLS blocks)',
     COALESCE(v_reason, 'NULL'), v_reason IS NULL);
END $$;

-- TEST 4: PUBLIC cannot EXECUTE (expect error)
DO $$
DECLARE v_err TEXT;
BEGIN
  EXECUTE 'CREATE ROLE test_public_user LOGIN';
  EXECUTE 'GRANT USAGE ON SCHEMA g03_b1_test TO test_public_user';
  EXECUTE 'SET ROLE test_public_user';
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  PERFORM set_config('app.user_id', 'attacker', false);
  PERFORM g03_b1_test.remove_coordination_participant('coord-2', 'part-A2', 'public');
  -- If we reach here, function was callable (FAIL)
  EXECUTE 'RESET ROLE';
  INSERT INTO g03_b1_test.test_results VALUES
    ('TEST4', 'PUBLIC cannot EXECUTE', 'ERROR (permission denied)',
     'NO ERROR — function executed', FALSE);
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  INSERT INTO g03_b1_test.test_results VALUES
    ('TEST4', 'PUBLIC cannot EXECUTE', 'ERROR (permission denied)',
     SQLERRM, SQLERRM LIKE '%permission denied%');
END $$;

-- TEST 5: set_config impersonation (LIMITATION)
DO $$
DECLARE v_result BOOLEAN; v_status TEXT;
BEGIN
  EXECUTE 'SET ROLE balance_app';
  -- tenant-A user impersonates tenant-B
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  PERFORM set_config('app.user_id', 'impersonator', false);
  SELECT g03_b1_test.remove_coordination_participant('coord-2', 'part-A2', 'impersonation') INTO v_result;
  EXECUTE 'RESET ROLE';
  SET ROLE balance_admin;
  SELECT status INTO v_status FROM g03_b1_test.reform_coordination_participants WHERE id = 'part-A2';
  RESET ROLE;
  INSERT INTO g03_b1_test.test_results VALUES
    ('TEST5', 'set_config impersonation (LIMITATION)', 'TRUE+removed (impersonation succeeds)',
     v_result::TEXT || '+' || v_status,
     v_result = TRUE AND v_status = 'removed');
END $$;

-- Cleanup
DO $$ BEGIN
  REVOKE USAGE ON SCHEMA g03_b1_test FROM test_public_user;
  DROP ROLE IF EXISTS test_public_user;
END $$;

-- Results
\echo ''
\echo '============================================================'
\echo 'B1 EMPIRICAL VALIDATION RESULTS (PostgreSQL 16.4)'
\echo '============================================================'
SELECT test_id, description, expected, actual,
  CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM g03_b1_test.test_results ORDER BY test_id;
\echo ''
SELECT COUNT(*) FILTER (WHERE pass) AS passed, COUNT(*) FILTER (WHERE NOT pass) AS failed, COUNT(*) AS total
FROM g03_b1_test.test_results;
