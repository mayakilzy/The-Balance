-- ============================================================
-- G03-01 FINAL ACCEPTANCE TEST SUITE
-- ============================================================
-- Complete verification per reviewer directive:
-- 1. RLS per-table verification (exact names + relrowsecurity + relforcerowsecurity)
-- 2. Strengthened assertions (row counts, state verification, snapshot metadata)
-- 3. Cross-tenant FK integrity
-- 4. Permission/function execution checks
-- 5. Prisma/migration consistency
-- ============================================================

\set ON_ERROR_STOP on

DROP TABLE IF EXISTS g03_final_results;
CREATE TEMP TABLE g03_final_results (
  test_id TEXT, description TEXT, expected TEXT, actual TEXT, pass BOOLEAN
);

-- ============================================================
-- 1. RLS VERIFICATION — per table, by exact name
-- ============================================================

DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'reform_proposals','reform_alternatives','reform_approvals',
    'reform_actions','reform_action_updates','reform_verifications',
    'reform_feedback_loops','reform_coordinations',
    'reform_coordination_participants','reform_coordination_invitations',
    'reform_coordination_shared_snapshots','reform_coordination_shared_snapshot_revocations'
  ];
  v_t TEXT; v_rls BOOLEAN; v_force BOOLEAN; v_missing TEXT := '';
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls, v_force
    FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = v_t AND c.relkind = 'r';
    IF NOT FOUND THEN
      v_missing := v_missing || v_t || ' (NOT FOUND), ';
    ELSIF NOT v_rls OR NOT v_force THEN
      v_missing := v_missing || v_t || ' (RLS=' || v_rls || ' FORCE=' || v_force || '), ';
    END IF;
  END LOOP;
  IF v_missing = '' THEN
    INSERT INTO g03_final_results VALUES ('RLS-01', 'All 12 tables RLS+FORCE verified by name', 'all RLS=t FORCE=t', 'all verified', TRUE);
  ELSE
    INSERT INTO g03_final_results VALUES ('RLS-01', 'All 12 tables RLS+FORCE verified by name', 'all RLS=t FORCE=t', v_missing, FALSE);
  END IF;
END $$;

-- ============================================================
-- 2. STRENGTHENED ASSERTIONS
-- ============================================================

-- 2a: Self-withdrawal changes EXACTLY ONE row to 'withdrawn'
DO $$
DECLARE v_affected INT; v_status TEXT;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('fa-c1', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'FA', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('fa-p1', 'fa-c1', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  RESET ROLE;

  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
  PERFORM set_config('app.user_id', 'user-b', false);
  UPDATE reform_coordination_participants SET status = 'withdrawn', "withdrawnAt" = NOW(), "withdrawalReason" = 'test'
  WHERE id = 'fa-p1' AND status = 'active';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RESET ROLE;

  SET ROLE balance_admin;
  SELECT status INTO v_status FROM reform_coordination_participants WHERE id = 'fa-p1';
  RESET ROLE;

  INSERT INTO g03_final_results VALUES ('SA-01', 'Self-withdrawal changes exactly 1 row to withdrawn', '1 row + status=withdrawn',
    v_affected || ' rows + status=' || v_status, v_affected = 1 AND v_status = 'withdrawn');

  SET ROLE balance_admin;
  DELETE FROM reform_coordination_participants WHERE id = 'fa-p1';
  DELETE FROM reform_coordinations WHERE id = 'fa-c1';
  RESET ROLE;
END $$;

-- 2b: Failed operation leaves records unchanged (cross-tenant INSERT blocked)
DO $$
DECLARE v_before INT; v_after INT;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('fa-p2', 'cmveksd72000copg0lim5xiiw', 'FA2', 'P', 'user', NOW());
  SELECT count(*) INTO v_before FROM reform_proposals WHERE "tenantId" = 'cmveksd72000copg0lim5xiiw';
  RESET ROLE;

  -- Tenant B tries to insert with tenant A's tenantId (cross-tenant INSERT)
  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
    INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
    VALUES ('fa-hack', 'cmveksd72000copg0lim5xiiw', 'HACK', 'H', 'hacker', NOW());
    RESET ROLE;
    -- If we reach here, RLS failed to block
    SET ROLE balance_admin;
    SELECT count(*) INTO v_after FROM reform_proposals WHERE "tenantId" = 'cmveksd72000copg0lim5xiiw';
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('SA-02', 'Cross-tenant INSERT blocked (count unchanged)', 'before=after', 'before=' || v_before || ' after=' || v_after, v_before = v_after);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    SET ROLE balance_admin;
    SELECT count(*) INTO v_after FROM reform_proposals WHERE "tenantId" = 'cmveksd72000copg0lim5xiiw';
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('SA-02', 'Cross-tenant INSERT blocked (count unchanged)', 'before=after', 'RLS blocked: ' || SQLERRM || ' before=' || v_before || ' after=' || v_after, v_before = v_after);
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_proposals WHERE id IN ('fa-p2','fa-hack');
  RESET ROLE;
END $$;

-- 2c: Approved shared snapshot approval metadata cannot be changed by balance_app
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('fa-c3', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'FA3', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_shared_snapshots (id, "coordinationId", "ownerTenantId", "snapshotType", title, summary, status, "approvedAt", "approvedBy", "createdBy", "updatedAt")
  VALUES ('fa-snap', 'fa-c3', 'cmveksd72000copg0lim5xiiw', 'commitment', 'Title', 'Summary', 'approved', NOW(), 'reviewer', 'user', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_app;
    PERFORM set_config('app.tenant_id', 'cmveksd72000copg0lim5xiiw', false);
    PERFORM set_config('app.service_context', 'authenticated', false);
    -- Try to change approvedBy and approvedAt
    UPDATE reform_coordination_shared_snapshots SET "approvedBy" = 'HACKED', "approvedAt" = NOW(), title = 'HACKED' WHERE id = 'fa-snap';
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('SA-03', 'Approved snapshot content+metadata immutable', 'ERROR (S3 VIOLATION)', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('SA-03', 'Approved snapshot content+metadata immutable', 'ERROR (S3 VIOLATION)', SQLERRM, SQLERRM LIKE '%S3 VIOLATION%');
  END;

  ALTER TABLE "reform_coordination_shared_snapshots" DISABLE TRIGGER shared_snapshot_immutable_after_approval_trigger;
  SET ROLE balance_admin;
  DELETE FROM reform_coordination_shared_snapshots WHERE id = 'fa-snap';
  DELETE FROM reform_coordinations WHERE id = 'fa-c3';
  RESET ROLE;
  ALTER TABLE "reform_coordination_shared_snapshots" ENABLE TRIGGER shared_snapshot_immutable_after_approval_trigger;
END $$;

-- 2d: Revoked snapshot invisible to non-owner participant
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_coordinations (id, "leadTenantId", "countryId", title, description, "approvalPolicy", "createdBy", "updatedAt")
  VALUES ('fa-c4', 'cmveksd72000copg0lim5xiiw', (SELECT id FROM countries WHERE iso3='DML'), 'FA4', 'T', 'lead_only', 'admin', NOW());
  INSERT INTO reform_coordination_participants (id, "coordinationId", "tenantId", "addedBy", status, "updatedAt")
  VALUES ('fa-p4', 'fa-c4', 'cmveksd74000eopg0p1tbcda0', 'admin', 'active', NOW());
  INSERT INTO reform_coordination_shared_snapshots (id, "coordinationId", "ownerTenantId", "snapshotType", title, summary, status, "approvedAt", "approvedBy", "createdBy", "updatedAt")
  VALUES ('fa-snap4', 'fa-c4', 'cmveksd72000copg0lim5xiiw', 'commitment', 'Title', 'Summary', 'approved', NOW(), 'reviewer', 'user', NOW());
  INSERT INTO reform_coordination_shared_snapshot_revocations (id, "tenantId", "coordinationId", "snapshotId", "revokedBy", reason)
  VALUES ('fa-rev4', 'cmveksd72000copg0lim5xiiw', 'fa-c4', 'fa-snap4', 'reviewer', 'test revocation');
  RESET ROLE;

  -- Tenant B (participant) should NOT see the revoked snapshot
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'cmveksd74000eopg0p1tbcda0', false);
  PERFORM set_config('app.service_context', 'authenticated', false);
  SELECT count(*) INTO v_count FROM reform_coordination_shared_snapshots WHERE id = 'fa-snap4';
  RESET ROLE;

  INSERT INTO g03_final_results VALUES ('SA-04', 'Revoked snapshot invisible to participant', 'count=0', 'count=' || v_count, v_count = 0);

  ALTER TABLE "reform_coordination_shared_snapshot_revocations" DISABLE TRIGGER prevent_delete_reform_coord_revocations;
  SET ROLE balance_admin;
  DELETE FROM reform_coordination_shared_snapshot_revocations WHERE id = 'fa-rev4';
  DELETE FROM reform_coordination_shared_snapshots WHERE id = 'fa-snap4';
  DELETE FROM reform_coordination_participants WHERE id = 'fa-p4';
  DELETE FROM reform_coordinations WHERE id = 'fa-c4';
  RESET ROLE;
  ALTER TABLE "reform_coordination_shared_snapshot_revocations" ENABLE TRIGGER prevent_delete_reform_coord_revocations;
END $$;

-- ============================================================
-- 3. CROSS-TENANT FK INTEGRITY
-- ============================================================

-- 3a: reform_alternatives.tenantId must match reform_proposals.tenantId
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('fa-p5', 'cmveksd72000copg0lim5xiiw', 'FA5', 'P', 'user', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_admin;
    -- Try inserting alternative with WRONG tenantId
    INSERT INTO reform_alternatives (id, "tenantId", "proposalId", title, description, "createdBy", "updatedAt")
    VALUES ('fa-alt5', 'cmveksd74000eopg0p1tbcda0', 'fa-p5', 'Alt', 'Desc', 'user', NOW());
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('FK-01', 'Cross-tenant FK: alternative tenant mismatch blocked', 'ERROR', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('FK-01', 'Cross-tenant FK: alternative tenant mismatch blocked', 'ERROR', SQLERRM, TRUE);
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_proposals WHERE id = 'fa-p5';
  RESET ROLE;
END $$;

-- 3b: reform_actions.tenantId must match reform_proposals.tenantId
DO $$
BEGIN
  SET ROLE balance_admin;
  INSERT INTO reform_proposals (id, "tenantId", title, "problemStatement", "createdBy", "updatedAt")
  VALUES ('fa-p6', 'cmveksd72000copg0lim5xiiw', 'FA6', 'P', 'user', NOW());
  INSERT INTO reform_alternatives (id, "tenantId", "proposalId", title, description, "createdBy", "updatedAt")
  VALUES ('fa-alt6', 'cmveksd72000copg0lim5xiiw', 'fa-p6', 'Alt', 'Desc', 'user', NOW());
  RESET ROLE;

  BEGIN
    SET ROLE balance_admin;
    INSERT INTO reform_actions (id, "tenantId", "proposalId", "alternativeId", title, "createdBy", "updatedAt")
    VALUES ('fa-act6', 'cmveksd74000eopg0p1tbcda0', 'fa-p6', 'fa-alt6', 'Action', 'user', NOW());
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('FK-02', 'Cross-tenant FK: action tenant mismatch blocked', 'ERROR', 'NO ERROR', FALSE);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO g03_final_results VALUES ('FK-02', 'Cross-tenant FK: action tenant mismatch blocked', 'ERROR', SQLERRM, TRUE);
  END;

  SET ROLE balance_admin;
  DELETE FROM reform_alternatives WHERE id = 'fa-alt6';
  DELETE FROM reform_proposals WHERE id = 'fa-p6';
  RESET ROLE;
END $$;

-- ============================================================
-- 4. PERMISSION/FUNCTION EXECUTION CHECKS
-- ============================================================

-- 4a: balance_app cannot call DEFINER functions (DORMANT)
DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.role_routine_grants
  WHERE grantee = 'balance_app' AND routine_name IN
    ('remove_coordination_participant','grant_commitment_approval','verify_institutional_authority');
  INSERT INTO g03_final_results VALUES ('FN-01', 'No EXECUTE on DEFINER functions for balance_app', '0', v_count::TEXT, v_count = 0);
END $$;

-- 4b: PUBLIC has no EXECUTE on DEFINER functions
DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.role_routine_grants
  WHERE grantee = 'PUBLIC' AND routine_name IN
    ('remove_coordination_participant','grant_commitment_approval','verify_institutional_authority');
  INSERT INTO g03_final_results VALUES ('FN-02', 'REVOKE FROM PUBLIC on DEFINER functions', '0', v_count::TEXT, v_count = 0);
END $$;

-- 4c: SECURITY INVOKER functions ARE available to balance_app
DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.role_routine_grants
  WHERE grantee = 'balance_app' AND routine_name IN
    ('is_coordination_participant','is_snapshot_revoked');
  INSERT INTO g03_final_results VALUES ('FN-03', 'INVOKER functions available to balance_app', '2', v_count::TEXT, v_count = 2);
END $$;

-- ============================================================
-- 5. PRISMA/MIGRATION CONSISTENCY
-- ============================================================

-- 5a: Migration count = 24
DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM "_prisma_migrations" WHERE migration_name LIKE '2026%';
  INSERT INTO g03_final_results VALUES ('PM-01', 'Total migrations applied', '>=24', v_count::TEXT, v_count >= 24);
END $$;

-- 5b: All G03 migrations applied
DO $$
DECLARE v_22 INT; v_23 INT; v_24 INT;
BEGIN
  SELECT count(*) INTO v_22 FROM "_prisma_migrations" WHERE migration_name = '20261018000022_g03_reform_bootstrap';
  SELECT count(*) INTO v_23 FROM "_prisma_migrations" WHERE migration_name = '20261019000023_g03_01_security_remediation';
  SELECT count(*) INTO v_24 FROM "_prisma_migrations" WHERE migration_name = '20261019000024_g03_01_trust_boundary_r2';
  INSERT INTO g03_final_results VALUES ('PM-02', 'G03 migrations 0022+0023+0024 applied', '3 applied',
    '0022=' || v_22 || ' 0023=' || v_23 || ' 0024=' || v_24, v_22 = 1 AND v_23 = 1 AND v_24 = 1);
END $$;

-- ============================================================
-- Results
-- ============================================================
\echo ''
\echo '============================================================'
\echo 'G03-01 FINAL ACCEPTANCE TEST RESULTS'
\echo '============================================================'
SELECT test_id, description, expected, actual,
  CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM g03_final_results ORDER BY test_id;
\echo ''
SELECT COUNT(*) FILTER (WHERE pass) AS passed, COUNT(*) FILTER (WHERE NOT pass) AS failed, COUNT(*) AS total
FROM g03_final_results;

DO $$
DECLARE v_failed INT;
BEGIN
  SELECT COUNT(*) INTO v_failed FROM g03_final_results WHERE NOT pass;
  IF v_failed > 0 THEN RAISE EXCEPTION 'G03-01 FINAL: % tests FAILED', v_failed; END IF;
  RAISE NOTICE 'G03-01 FINAL: ALL % TESTS PASSED', (SELECT COUNT(*) FROM g03_final_results);
END $$;
