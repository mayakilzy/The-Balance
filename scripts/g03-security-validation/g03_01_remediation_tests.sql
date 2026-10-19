-- ============================================================
-- G03-01 Security Remediation Tests — S1 through S6 (FIXED v3)
-- ============================================================
-- Each test does its own setup + test + cleanup in a self-contained DO block.
-- EXCEPTION blocks don't roll back setup because setup is done BEFORE the
-- test action (and the test action's failure is caught by EXCEPTION).
-- ============================================================

\set ON_ERROR_STOP on

DROP TABLE IF EXISTS g03_remediation_results;
CREATE TEMP TABLE g03_remediation_results (
  test_id TEXT, description TEXT, expected TEXT, actual TEXT, pass BOOLEAN
);

-- ============================================================
-- S1-TEST1: balance_app CANNOT set canApproveCommitments directly
-- ============================================================
DO $$
BEGIN
  -- Setup (as admin, before test)
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('s1t1-coord', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'S1T1', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('s1t1-part', 's1t1-coord', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  -- Test (as balance_app)
  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
    PERFORM set_config('app.user_id', 'user-b', false);
    PERFORM set_config('app.service_context', 'authenticated', false);
    UPDATE reform_coordination_participants SET "canApproveCommitments" = TRUE WHERE id = 's1t1-part';
    RESET ROLE;
    -- If we reach here, protection failed
    INSERT INTO g03_remediation_results VALUES ('S1-TEST1', 'Direct canApproveCommitments blocked', 'ERROR (S1 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S1-TEST1', 'Direct canApproveCommitments blocked', 'ERROR (S1 VIOLATION)', SQLERRM, SQLERRM LIKE '%S1 VIOLATION%');
  END;

  -- Cleanup
  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 's1t1-part';
  DELETE FROM reform_coordinations WHERE id = 's1t1-coord';
  RESET ROLE;
END $$;

-- ============================================================
-- S1-TEST2: balance_app CANNOT set verifiedInstitutionId directly
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('s1t2-coord', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'S1T2', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('s1t2-part', 's1t2-coord', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
    PERFORM set_config('app.user_id', 'user-b', false);
    PERFORM set_config('app.service_context', 'authenticated', false);
    UPDATE reform_coordination_participants SET "verifiedInstitutionId" = 'INST-CB' WHERE id = 's1t2-part';
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S1-TEST2', 'Direct verifiedInstitutionId blocked', 'ERROR (S1 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S1-TEST2', 'Direct verifiedInstitutionId blocked', 'ERROR (S1 VIOLATION)', SQLERRM, SQLERRM LIKE '%S1 VIOLATION%');
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 's1t2-part';
  DELETE FROM reform_coordinations WHERE id = 's1t2-coord';
  RESET ROLE;
END $$;

-- ============================================================
-- S1-TEST3: balance_app CAN self-withdraw (status change allowed)
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('s1t3-coord', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'S1T3', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('s1t3-part', 's1t3-coord', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
    PERFORM set_config('app.user_id', 'user-b', false);
    PERFORM set_config('app.service_context', 'authenticated', false);
    UPDATE reform_coordination_participants SET status = 'withdrawn', "withdrawnAt" = NOW(), "withdrawalReason" = 'self-withdrawal'
    WHERE id = 's1t3-part' AND status = 'active';
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S1-TEST3', 'Self-withdrawal allowed', 'OK', 'OK', TRUE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S1-TEST3', 'Self-withdrawal allowed', 'OK', SQLERRM, FALSE);
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 's1t3-part';
  DELETE FROM reform_coordinations WHERE id = 's1t3-coord';
  RESET ROLE;
END $$;

-- ============================================================
-- S2-TEST1: remove_coordination_participant fails WITHOUT service_context
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('s2t1-coord', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'S2T1', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('s2t1-part', 's2t1-coord', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  -- Call WITHOUT service_context
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
  PERFORM set_config('app.user_id', 'user-a', false);
  -- app.service_context NOT set
  PERFORM set_config('app.service_context', '', false);  -- explicitly clear
  SELECT public.remove_coordination_participant('s2t1-coord', 's2t1-part', 'no context') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_remediation_results VALUES ('S2-TEST1', 'Function fails without service_context', 'FALSE', v_result::TEXT, v_result = FALSE);

  -- Cleanup
  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 's2t1-part';
  DELETE FROM reform_coordinations WHERE id = 's2t1-coord';
  RESET ROLE;
END $$;

-- ============================================================
-- S2-TEST2: remove_coordination_participant succeeds WITH service_context
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('s2t2-coord', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'S2T2', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('s2t2-part', 's2t2-coord', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
  PERFORM set_config('app.user_id', 'user-a', false);
  PERFORM set_config('app.service_context', 'authenticated', false);
  SELECT public.remove_coordination_participant('s2t2-coord', 's2t2-part', 'with context') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_remediation_results VALUES ('S2-TEST2', 'Function succeeds with service_context', 'TRUE', v_result::TEXT, v_result = TRUE);

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 's2t2-part';
  DELETE FROM reform_coordinations WHERE id = 's2t2-coord';
  RESET ROLE;
END $$;

-- ============================================================
-- S3-TEST1: UPDATE on reform_approvals blocked
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('s3t1-prop', 'cmveksd72000copg0lim5xiiw', 'S3T1', 'P', 'user', NOW());
  INSERT INTO reform_alternatives (id, "tenantId", "proposalId", title, description, "createdBy", "updatedAt")
  VALUES ('s3t1-alt', 'cmveksd72000copg0lim5xiiw', 's3t1-prop', 'A', 'D', 'user', NOW());
  INSERT INTO reform_approvals (id, "tenantId", "proposalId", "alternativeId", "approvedBy", rationale)
  VALUES ('s3t1-approval', 'cmveksd72000copg0lim5xiiw', 's3t1-prop', 's3t1-alt', 'user', 'test');
  RESET ROLE;

  BEGIN
    SET ROLE balance_admin;
    UPDATE reform_approvals SET "approvalNotes" = 'HACKED' WHERE id = 's3t1-approval';
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S3-TEST1', 'UPDATE on reform_approvals blocked', 'ERROR (S3 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S3-TEST1', 'UPDATE on reform_approvals blocked', 'ERROR (S3 VIOLATION)', SQLERRM, SQLERRM LIKE '%S3 VIOLATION%');
  END;

  -- Cleanup (use migration_mode to allow DELETE)
  SET ROLE balance_admin;
  PERFORM set_config('app.migration_mode', 'active', false);
  DELETE FROM reform_approvals WHERE id = 's3t1-approval';
  DELETE FROM reform_alternatives WHERE id = 's3t1-alt';
  DELETE FROM reform_proposals WHERE id = 's3t1-prop';
  PERFORM set_config('app.migration_mode', '', false);
  RESET ROLE;
END $$;

-- ============================================================
-- S3-TEST2: DELETE on reform_action_updates blocked
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  -- s3t1 data was cleaned up, need fresh data
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('s3t2-prop', 'cmveksd72000copg0lim5xiiw', 'S3T2', 'P', 'user', NOW());
  INSERT INTO reform_alternatives (id, "tenantId", "proposalId", title, description, "createdBy", "updatedAt")
  VALUES ('s3t2-alt', 'cmveksd72000copg0lim5xiiw', 's3t2-prop', 'A', 'D', 'user', NOW());
  INSERT INTO reform_actions (id, "tenantId", "proposalId", "alternativeId", title, "createdBy", "updatedAt")
  VALUES ('s3t2-action', 'cmveksd72000copg0lim5xiiw', 's3t2-prop', 's3t2-alt', 'Action', 'user', NOW());
  INSERT INTO reform_action_updates (id, "tenantId", "actionId", "updateType", notes, actor)
  VALUES ('s3t2-update', 'cmveksd72000copg0lim5xiiw', 's3t2-action', 'note', 'test', 'user');
  RESET ROLE;

  BEGIN
    SET ROLE balance_admin;
    DELETE FROM reform_action_updates WHERE id = 's3t2-update';
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S3-TEST2', 'DELETE on reform_action_updates blocked', 'ERROR (S3 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S3-TEST2', 'DELETE on reform_action_updates blocked', 'ERROR (S3 VIOLATION)', SQLERRM, SQLERRM LIKE '%S3 VIOLATION%');
  END;

  -- Cleanup
  SET ROLE balance_admin;
  PERFORM set_config('app.migration_mode', 'active', false);
  DELETE FROM reform_action_updates WHERE id = 's3t2-update';
  DELETE FROM reform_actions WHERE id = 's3t2-action';
  DELETE FROM reform_alternatives WHERE id = 's3t2-alt';
  DELETE FROM reform_proposals WHERE id = 's3t2-prop';
  PERFORM set_config('app.migration_mode', '', false);
  RESET ROLE;
END $$;

-- ============================================================
-- S3-TEST3: balance_admin DELETE on append-only blocked
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('s3t3-prop', 'cmveksd72000copg0lim5xiiw', 'S3T3', 'P', 'user', NOW());
  INSERT INTO reform_alternatives (id, "tenantId", "proposalId", title, description, "createdBy", "updatedAt")
  VALUES ('s3t3-alt', 'cmveksd72000copg0lim5xiiw', 's3t3-prop', 'A', 'D', 'user', NOW());
  INSERT INTO reform_approvals (id, "tenantId", "proposalId", "alternativeId", "approvedBy", rationale)
  VALUES ('s3t3-approval', 'cmveksd72000copg0lim5xiiw', 's3t3-prop', 's3t3-alt', 'user', 'test');
  RESET ROLE;

  BEGIN
    SET ROLE balance_admin;
    DELETE FROM reform_approvals WHERE id = 's3t3-approval';
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S3-TEST3', 'balance_admin DELETE blocked', 'ERROR (S3 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_remediation_results VALUES ('S3-TEST3', 'balance_admin DELETE blocked', 'ERROR (S3 VIOLATION)', SQLERRM, SQLERRM LIKE '%S3 VIOLATION%');
  END;

  -- Cleanup
  SET ROLE balance_admin;
  PERFORM set_config('app.migration_mode', 'active', false);
  DELETE FROM reform_approvals WHERE id = 's3t3-approval';
  DELETE FROM reform_alternatives WHERE id = 's3t3-alt';
  DELETE FROM reform_proposals WHERE id = 's3t3-prop';
  PERFORM set_config('app.migration_mode', '', false);
  RESET ROLE;
END $$;

-- ============================================================
-- S3-TEST4: Tenant isolation positive (tenant A sees own)
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('s3t4-prop', 'cmveksd72000copg0lim5xiiw', 'S3T4', 'P', 'user', NOW());
  RESET ROLE;

  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
  PERFORM set_config('app.service_context', 'authenticated', false);
  SELECT count(*) INTO v_count FROM reform_proposals WHERE id = 's3t4-prop';
  RESET ROLE;
  INSERT INTO g03_remediation_results VALUES ('S3-TEST4', 'Tenant A sees own proposal', 'count=1', 'count=' || v_count, v_count = 1);

  SET ROLE balance_admin;
  PERFORM set_config('app.migration_mode', 'active', false);
  DELETE FROM reform_proposals WHERE id = 's3t4-prop';
  PERFORM set_config('app.migration_mode', '', false);
  RESET ROLE;
END $$;

-- ============================================================
-- S3-TEST5: Tenant isolation negative (tenant B cannot see A)
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('s3t5-prop', 'cmveksd72000copg0lim5xiiw', 'S3T5', 'P', 'user', NOW());
  RESET ROLE;

  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
  PERFORM set_config('app.service_context', 'authenticated', false);
  SELECT count(*) INTO v_count FROM reform_proposals WHERE id = 's3t5-prop';
  RESET ROLE;
  INSERT INTO g03_remediation_results VALUES ('S3-TEST5', 'Tenant B cannot see A proposal', 'count=0', 'count=' || v_count, v_count = 0);

  SET ROLE balance_admin;
  PERFORM set_config('app.migration_mode', 'active', false);
  DELETE FROM reform_proposals WHERE id = 's3t5-prop';
  PERFORM set_config('app.migration_mode', '', false);
  RESET ROLE;
END $$;

-- ============================================================
-- S4-TEST1: RLS on all 12 tables
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM pg_class c
  JOIN pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'public' AND c.relname LIKE 'reform%'
    AND c.relrowsecurity = true AND c.relforcerowsecurity = true AND c.relkind = 'r';
  INSERT INTO g03_remediation_results VALUES ('S4-TEST1', 'RLS ENABLE+FORCE all 12 tables', '12', v_count::TEXT, v_count >= 12);
END $$;

-- ============================================================
-- Results
-- ============================================================
\echo ''
\echo '============================================================'
\echo 'G03-01 SECURITY REMEDIATION TEST RESULTS'
\echo '============================================================'
SELECT test_id, description, expected, actual,
  CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM g03_remediation_results ORDER BY test_id;
\echo ''
SELECT COUNT(*) FILTER (WHERE pass) AS passed, COUNT(*) FILTER (WHERE NOT pass) AS failed, COUNT(*) AS total
FROM g03_remediation_results;

DO $$
DECLARE v_failed INT;
BEGIN
  SELECT COUNT(*) INTO v_failed FROM g03_remediation_results WHERE NOT pass;
  IF v_failed > 0 THEN RAISE EXCEPTION 'G03-01 REMEDIATION: % tests FAILED', v_failed; END IF;
  RAISE NOTICE 'G03-01 REMEDIATION: ALL % TESTS PASSED', (SELECT COUNT(*) FROM g03_remediation_results);
END $$;
