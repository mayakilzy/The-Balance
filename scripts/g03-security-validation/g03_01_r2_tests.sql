-- ============================================================
-- G03-01 Security Remediation R2 Tests — Trust Boundaries
-- ============================================================
-- Tests:
-- S2-R2-1: balance_app CANNOT call remove_coordination_participant (REVOKE'd)
-- S2-R2-2: balance_app CANNOT call grant_commitment_approval (REVOKE'd)
-- S2-R2-3: balance_app CANNOT call verify_institutional_authority (REVOKE'd)
-- S2-R2-4: GUC spoofing (app.service_context) does NOT grant access
-- S3-R2-1: balance_admin cannot UPDATE append-only (no migration_mode bypass)
-- S3-R2-2: balance_admin cannot DELETE append-only (no migration_mode bypass)
-- S3-R2-3: GUC spoofing (app.migration_mode='active') does NOT bypass protection
-- S3-R2-4: balance_app cannot modify approved snapshot content
-- S3-R2-5: Self-withdrawal works (positive control)
-- S3-R2-6: Tenant isolation positive
-- S3-R2-7: Tenant isolation negative
-- S4-R2-1: Exact 12 table names verified (not just count)
-- S4-R2-2: All 3 DEFINER functions have NO EXECUTE grant to balance_app
-- S4-R2-3: All 3 DEFINER functions have REVOKE FROM PUBLIC
-- ============================================================

\set ON_ERROR_STOP on

DROP TABLE IF EXISTS g03_r2_results;
CREATE TEMP TABLE g03_r2_results (
  test_id TEXT, description TEXT, expected TEXT, actual TEXT, pass BOOLEAN
);

-- ============================================================
-- S2-R2-1: balance_app CANNOT call remove_coordination_participant
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('r2c1', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'R2', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('r2p1', 'r2c1', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
    PERFORM set_config('app.user_id', 'user-a', false);
    PERFORM set_config('app.service_context', 'authenticated', false);  -- spoof attempt
    PERFORM public.remove_coordination_participant('r2c1', 'r2p1', 'spoofed');
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S2-R2-1', 'remove_coordination_participant REVOKE''d from balance_app', 'ERROR (permission denied)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S2-R2-1', 'remove_coordination_participant REVOKE''d from balance_app', 'ERROR (permission denied)', SQLERRM, SQLERRM LIKE '%permission denied%');
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 'r2p1';
  DELETE FROM reform_coordinations WHERE id = 'r2c1';
  RESET ROLE;
END $$;

-- ============================================================
-- S2-R2-2: balance_app CANNOT call grant_commitment_approval
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('r2c2', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'R2', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('r2p2', 'r2c2', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
    PERFORM set_config('app.user_id', 'user-a', false);
    PERFORM set_config('app.service_context', 'authenticated', false);
    PERFORM public.grant_commitment_approval('r2c2', 'r2p2', 'spoofed');
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S2-R2-2', 'grant_commitment_approval REVOKE''d from balance_app', 'ERROR (permission denied)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S2-R2-2', 'grant_commitment_approval REVOKE''d from balance_app', 'ERROR (permission denied)', SQLERRM, SQLERRM LIKE '%permission denied%');
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 'r2p2';
  DELETE FROM reform_coordinations WHERE id = 'r2c2';
  RESET ROLE;
END $$;

-- ============================================================
-- S2-R2-3: balance_app CANNOT call verify_institutional_authority
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('r2c3', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'R2', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('r2p3', 'r2c3', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
    PERFORM set_config('app.user_id', 'user-a', false);
    PERFORM set_config('app.role', 'admin', false);
    PERFORM set_config('app.service_context', 'authenticated', false);
    PERFORM public.verify_institutional_authority('r2c3', 'r2p3', 'INST-CB', 'spoofed');
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S2-R2-3', 'verify_institutional_authority REVOKE''d from balance_app', 'ERROR (permission denied)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S2-R2-3', 'verify_institutional_authority REVOKE''d from balance_app', 'ERROR (permission denied)', SQLERRM, SQLERRM LIKE '%permission denied%');
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 'r2p3';
  DELETE FROM reform_coordinations WHERE id = 'r2c3';
  RESET ROLE;
END $$;

-- ============================================================
-- S3-R2-1: balance_admin cannot UPDATE append-only (NO migration_mode bypass)
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('r2s3p', 'cmveksd72000copg0lim5xiiw', 'R2S3', 'P', 'user', NOW());
  INSERT INTO reform_alternatives (id, "tenantId", "proposalId", title, description, "createdBy", "updatedAt")
  VALUES ('r2s3a', 'cmveksd72000copg0lim5xiiw', 'r2s3p', 'A', 'D', 'user', NOW());
  INSERT INTO reform_approvals (id, "tenantId", "proposalId", "alternativeId", "approvedBy", rationale)
  VALUES ('r2s3appr', 'cmveksd72000copg0lim5xiiw', 'r2s3p', 'r2s3a', 'user', 'test');
  RESET ROLE;

  BEGIN
    SET ROLE balance_admin;
    -- Try setting migration_mode (spoof attempt)
    PERFORM set_config('app.migration_mode', 'active', false);
    UPDATE reform_approvals SET "approvalNotes" = 'HACKED' WHERE id = 'r2s3appr';
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-1', 'UPDATE blocked even with spoofed migration_mode', 'ERROR (S3 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-1', 'UPDATE blocked even with spoofed migration_mode', 'ERROR (S3 VIOLATION)', SQLERRM, SQLERRM LIKE '%S3 VIOLATION%');
  END;
END $$;

-- ============================================================
-- S3-R2-2: balance_admin cannot DELETE append-only (NO migration_mode bypass)
-- ============================================================
DO $$
BEGIN
  BEGIN
    SET ROLE balance_admin;
    PERFORM set_config('app.migration_mode', 'active', false);  -- spoof attempt
    DELETE FROM reform_approvals WHERE id = 'r2s3appr';
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-2', 'DELETE blocked even with spoofed migration_mode', 'ERROR (S3 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-2', 'DELETE blocked even with spoofed migration_mode', 'ERROR (S3 VIOLATION)', SQLERRM, SQLERRM LIKE '%S3 VIOLATION%');
  END;
END $$;

-- ============================================================
-- S3-R2-3: Cleanup r2s3 data (use superuser to bypass triggers)
-- ============================================================
-- Only postgres superuser can disable triggers for cleanup
-- (this is the correct maintenance path — not a GUC)
ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_update_reform_approvals;
ALTER TABLE "reform_approvals" DISABLE TRIGGER prevent_delete_reform_approvals;
SET ROLE balance_admin;
DELETE FROM reform_approvals WHERE id = 'r2s3appr';
DELETE FROM reform_alternatives WHERE id = 'r2s3a';
DELETE FROM reform_proposals WHERE id = 'r2s3p';
RESET ROLE;
ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_update_reform_approvals;
ALTER TABLE "reform_approvals" ENABLE TRIGGER prevent_delete_reform_approvals;

-- ============================================================
-- S3-R2-4: balance_app cannot modify approved snapshot content
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('r2s4c', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'R2S4', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_shared_snapshots (id, "coordinationId", "ownerTenantId", "snapshotType", title, summary, status, "approvedAt", "approvedBy", "createdBy", "updatedAt")
  VALUES ('r2s4snap', 'r2s4c', 'cmveksd72000copg0lim5xiiw', 'commitment', 'Original', 'Original summary', 'approved', NOW(), 'reviewer', 'user', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
    PERFORM set_config('app.service_context', 'authenticated', false);
    UPDATE reform_coordination_shared_snapshots SET title = 'HACKED' WHERE id = 'r2s4snap';
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-4', 'Approved snapshot content immutable', 'ERROR (S3 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-4', 'Approved snapshot content immutable', 'ERROR (S3 VIOLATION)', SQLERRM, SQLERRM LIKE '%S3 VIOLATION%');
  END;

  -- Cleanup (disable trigger for cleanup as superuser)
  ALTER TABLE "reform_coordination_shared_snapshots" DISABLE TRIGGER shared_snapshot_immutable_after_approval_trigger;
  SET ROLE balance_admin;
  DELETE FROM reform_coordination_shared_snapshots WHERE id = 'r2s4snap';
  DELETE FROM reform_coordinations WHERE id = 'r2s4c';
  RESET ROLE;
  ALTER TABLE "reform_coordination_shared_snapshots" ENABLE TRIGGER shared_snapshot_immutable_after_approval_trigger;
END $$;

-- ============================================================
-- S3-R2-5: Self-withdrawal still works (positive control)
-- ============================================================
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('r2s5c', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'R2S5', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('r2s5p', 'r2s5c', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
    PERFORM set_config('app.user_id', 'user-b', false);
    UPDATE reform_coordination_participants SET status = 'withdrawn', "withdrawnAt" = NOW(), "withdrawalReason" = 'test'
    WHERE id = 'r2s5p' AND status = 'active';
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-5', 'Self-withdrawal works', 'OK', 'OK', TRUE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_r2_results VALUES ('S3-R2-5', 'Self-withdrawal works', 'OK', SQLERRM, FALSE);
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 'r2s5p';
  DELETE FROM reform_coordinations WHERE id = 'r2s5c';
  RESET ROLE;
END $$;

-- ============================================================
-- S3-R2-6: Tenant isolation positive
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('r2s6p', 'cmveksd72000copg0lim5xiiw', 'R2S6', 'P', 'user', NOW());
  RESET ROLE;

  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
  PERFORM set_config('app.service_context', 'authenticated', false);
  SELECT count(*) INTO v_count FROM reform_proposals WHERE id = 'r2s6p';
  RESET ROLE;
  INSERT INTO g03_r2_results VALUES ('S3-R2-6', 'Tenant A sees own proposal', 'count=1', 'count=' || v_count, v_count = 1);

  SET ROLE balance_admin;
  DELETE FROM reform_proposals WHERE id = 'r2s6p';
  RESET ROLE;
END $$;

-- ============================================================
-- S3-R2-7: Tenant isolation negative
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('r2s7p', 'cmveksd72000copg0lim5xiiw', 'R2S7', 'P', 'user', NOW());
  RESET ROLE;

  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
  PERFORM set_config('app.service_context', 'authenticated', false);
  SELECT count(*) INTO v_count FROM reform_proposals WHERE id = 'r2s7p';
  RESET ROLE;
  INSERT INTO g03_r2_results VALUES ('S3-R2-7', 'Tenant B cannot see A proposal', 'count=0', 'count=' || v_count, v_count = 0);

  SET ROLE balance_admin;
  DELETE FROM reform_proposals WHERE id = 'r2s7p';
  RESET ROLE;
END $$;

-- ============================================================
-- S4-R2-1: Exact 12 table names verified
-- ============================================================
DO $$
DECLARE v_expected TEXT[] := ARRAY[
  'reform_action_updates','reform_actions','reform_alternatives','reform_approvals',
  'reform_coordination_invitations','reform_coordination_participants',
  'reform_coordination_shared_snapshot_revocations','reform_coordination_shared_snapshots',
  'reform_coordinations','reform_feedback_loops','reform_proposals','reform_verifications'
];
DECLARE v_actual TEXT; v_missing TEXT := ''; v_t TEXT;
BEGIN
  FOREACH v_t IN ARRAY v_expected LOOP
    SELECT count(*) INTO v_actual FROM pg_tables WHERE schemaname='public' AND tablename = v_t;
    IF v_actual = '0' THEN v_missing := v_missing || v_t || ', '; END IF;
  END LOOP;
  IF v_missing = '' THEN
    INSERT INTO g03_r2_results VALUES ('S4-R2-1', 'All 12 table names verified', 'all exist', 'all exist', TRUE);
  ELSE
    INSERT INTO g03_r2_results VALUES ('S4-R2-1', 'All 12 table names verified', 'all exist', 'MISSING: ' || v_missing, FALSE);
  END IF;
END $$;

-- ============================================================
-- S4-R2-2: No EXECUTE grant to balance_app on DEFINER functions
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.role_routine_grants
  WHERE grantee = 'balance_app' AND routine_name IN
    ('remove_coordination_participant','grant_commitment_approval','verify_institutional_authority');
  INSERT INTO g03_r2_results VALUES ('S4-R2-2', 'No EXECUTE on DEFINER functions for balance_app', '0 grants', v_count || ' grants', v_count = 0);
END $$;

-- ============================================================
-- S4-R2-3: REVOKE FROM PUBLIC on all DEFINER functions
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  -- Check that PUBLIC does NOT have EXECUTE on these functions
  SELECT count(*) INTO v_count FROM information_schema.role_routine_grants
  WHERE grantee = 'PUBLIC' AND routine_name IN
    ('remove_coordination_participant','grant_commitment_approval','verify_institutional_authority');
  INSERT INTO g03_r2_results VALUES ('S4-R2-3', 'REVOKE FROM PUBLIC on all DEFINER functions', '0 grants', v_count || ' grants', v_count = 0);
END $$;

-- ============================================================
-- Results
-- ============================================================
\echo ''
\echo '============================================================'
\echo 'G03-01 SECURITY REMEDIATION R2 TEST RESULTS'
\echo '============================================================'
SELECT test_id, description, expected, actual,
  CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM g03_r2_results ORDER BY test_id;
\echo ''
SELECT COUNT(*) FILTER (WHERE pass) AS passed, COUNT(*) FILTER (WHERE NOT pass) AS failed, COUNT(*) AS total
FROM g03_r2_results;

DO $$
DECLARE v_failed INT;
BEGIN
  SELECT COUNT(*) INTO v_failed FROM g03_r2_results WHERE NOT pass;
  IF v_failed > 0 THEN RAISE EXCEPTION 'G03-01 R2: % tests FAILED', v_failed; END IF;
  RAISE NOTICE 'G03-01 R2: ALL % TESTS PASSED', (SELECT COUNT(*) FROM g03_r2_results);
END $$;
