-- ============================================================
-- G03-00 B3 Security Validation — Institutional Authority
-- ============================================================
-- Tests:
-- 1. Lead grants commitment approval (cross-tenant) — should succeed via dedicated function
-- 2. Non-lead cannot grant commitment approval
-- 3. Participant with canApproveCommitments=TRUE but verifiedInstitutionId=NULL cannot approve institutional commitment (fail-closed)
-- 4. Participant with verifiedInstitutionId that doesn't match claimed institution cannot approve
-- 5. Non-admin cannot set verifiedInstitutionId
-- 6. Participant without canApproveCommitments cannot approve any commitment
-- 7. Non-institutional commitment (no actingOnBehalfOfInstitutionId) approved by participant without canApproveCommitments — should succeed
-- ============================================================

\set ON_ERROR_STOP off

DROP SCHEMA IF EXISTS g03_b3_test CASCADE;
DO $$ BEGIN DROP ROLE IF EXISTS balance_app; END $$;
DO $$ BEGIN DROP ROLE IF EXISTS balance_admin; END $$;

CREATE SCHEMA g03_b3_test;
CREATE ROLE balance_app NOLOGIN;
CREATE ROLE balance_admin NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA g03_b3_test TO balance_app, balance_admin;
SET search_path = g03_b3_test, public;

-- ============================================================
-- Tables
-- ============================================================
CREATE TABLE g03_b3_test.reform_coordinations (
  id TEXT PRIMARY KEY, "leadTenantId" TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE g03_b3_test.reform_coordination_participants (
  id TEXT PRIMARY KEY, "coordinationId" TEXT NOT NULL REFERENCES g03_b3_test.reform_coordinations(id),
  "tenantId" TEXT NOT NULL,
  "institutionId" TEXT,  -- CLAIMED (documentation only)
  "verifiedInstitutionId" TEXT,  -- VERIFIED (admin-set)
  "verifiedAt" TIMESTAMP,
  "verifiedBy" TEXT,
  "canApproveCommitments" BOOLEAN NOT NULL DEFAULT FALSE,
  "approvalAuthorityGrantedBy" TEXT,
  "approvalAuthorityGrantedAt" TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending_invitation'
);

CREATE TABLE g03_b3_test.reform_proposals (
  id TEXT PRIMARY KEY,
  "coordinationId" TEXT REFERENCES g03_b3_test.reform_coordinations(id),
  "tenantId" TEXT NOT NULL,
  title TEXT NOT NULL,
  "actingOnBehalfOfInstitutionId" TEXT,  -- if set, requires institutional authority
  status TEXT NOT NULL DEFAULT 'draft'
);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE g03_b3_test.reform_coordinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b3_test.reform_coordinations FORCE ROW LEVEL SECURITY;
ALTER TABLE g03_b3_test.reform_coordination_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b3_test.reform_coordination_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE g03_b3_test.reform_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b3_test.reform_proposals FORCE ROW LEVEL SECURITY;

-- Helper: is_coordination_participant
CREATE OR REPLACE FUNCTION g03_b3_test.is_coordination_participant(p_coordination_id TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY INVOKER STABLE SET search_path = g03_b3_test, public AS $$
  SELECT EXISTS (SELECT 1 FROM g03_b3_test.reform_coordination_participants
    WHERE "coordinationId" = p_coordination_id AND "tenantId" = current_setting('app.tenant_id', true) AND status = 'active');
$$;
GRANT EXECUTE ON FUNCTION g03_b3_test.is_coordination_participant(TEXT) TO balance_app;

-- Policies: coordinations (lead OR participant)
CREATE POLICY rc_select_app ON g03_b3_test.reform_coordinations FOR SELECT TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true)
         OR g03_b3_test.is_coordination_participant(id));
CREATE POLICY rc_insert_app ON g03_b3_test.reform_coordinations FOR INSERT TO balance_app
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rc_update_app ON g03_b3_test.reform_coordinations FOR UPDATE TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));

-- Policies: participants (own row SELECT/UPDATE; lead can INSERT)
CREATE POLICY rcp_select_app ON g03_b3_test.reform_coordination_participants FOR SELECT TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rcp_insert_app ON g03_b3_test.reform_coordination_participants FOR INSERT TO balance_app
  WITH CHECK (EXISTS (SELECT 1 FROM g03_b3_test.reform_coordinations c
                      WHERE c.id = "coordinationId" AND c."leadTenantId" = current_setting('app.tenant_id', true)));
CREATE POLICY rcp_update_app ON g03_b3_test.reform_coordination_participants FOR UPDATE TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Policies: proposals (own tenant)
CREATE POLICY rp_select_app ON g03_b3_test.reform_proposals FOR SELECT TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rp_insert_app ON g03_b3_test.reform_proposals FOR INSERT TO balance_app
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rp_update_app ON g03_b3_test.reform_proposals FOR UPDATE TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Grants
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA g03_b3_test TO balance_app;
GRANT ALL ON ALL TABLES IN SCHEMA g03_b3_test TO balance_admin;

-- ============================================================
-- Function: grant_commitment_approval (lead grants to participant in their coordination)
-- Lead check INSIDE UPDATE WHERE (same pattern as B1)
-- ============================================================
CREATE OR REPLACE FUNCTION g03_b3_test.grant_commitment_approval(
  p_coordination_id TEXT, p_participant_id TEXT, p_reason TEXT
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = g03_b3_test, public AS $$
  WITH updated AS (
    UPDATE g03_b3_test.reform_coordination_participants p
    SET "canApproveCommitments" = TRUE,
        "approvalAuthorityGrantedBy" = current_setting('app.user_id', true),
        "approvalAuthorityGrantedAt" = NOW()
    WHERE p."coordinationId" = p_coordination_id
      AND p."id" = p_participant_id
      AND p."status" = 'active'
      AND EXISTS (SELECT 1 FROM g03_b3_test.reform_coordinations c
                  WHERE c.id = p_coordination_id AND c."leadTenantId" = current_setting('app.tenant_id', true))
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;
-- For grant_commitment_approval, we use balance_admin as owner (simpler for test; in production use dedicated role)
ALTER FUNCTION g03_b3_test.grant_commitment_approval(TEXT, TEXT, TEXT) OWNER TO balance_admin;
GRANT EXECUTE ON FUNCTION g03_b3_test.grant_commitment_approval(TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION g03_b3_test.grant_commitment_approval(TEXT, TEXT, TEXT) FROM PUBLIC;

-- ============================================================
-- Function: verify_institutional_authority (admin-only — sets verifiedInstitutionId)
-- This simulates the B3 verification workflow.
-- In production, only admin (tenant:write permission) can call this.
-- ============================================================
CREATE OR REPLACE FUNCTION g03_b3_test.verify_institutional_authority(
  p_coordination_id TEXT, p_participant_id TEXT, p_institution_id TEXT, p_method TEXT
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = g03_b3_test, public AS $$
  -- NOTE: This function does NOT check "leadTenantId" — it checks the caller's role.
  -- In production, requirePermissionWithCurrentRole(session, "tenant:write") enforces admin-only.
  -- For this test, we check that current_setting('app.role') = 'admin'.
  WITH updated AS (
    UPDATE g03_b3_test.reform_coordination_participants p
    SET "verifiedInstitutionId" = p_institution_id,
        "verifiedAt" = NOW(),
        "verifiedBy" = current_setting('app.user_id', true)
    WHERE p."coordinationId" = p_coordination_id
      AND p."id" = p_participant_id
      AND current_setting('app.role', true) = 'admin'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION g03_b3_test.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) OWNER TO balance_admin;
GRANT EXECUTE ON FUNCTION g03_b3_test.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION g03_b3_test.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- ============================================================
-- Function: approve_reform_proposal (B3 three-check institutional approval)
-- ============================================================
CREATE OR REPLACE FUNCTION g03_b3_test.approve_reform_proposal(
  p_proposal_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = g03_b3_test, public AS $$
DECLARE
  v_proposal g03_b3_test.reform_proposals%ROWTYPE;
  v_participant g03_b3_test.reform_coordination_participants%ROWTYPE;
BEGIN
  -- Load proposal
  SELECT * INTO v_proposal FROM g03_b3_test.reform_proposals WHERE id = p_proposal_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- If proposal does NOT claim institutional authority → no special check needed
  IF v_proposal."actingOnBehalfOfInstitutionId" IS NULL THEN
    UPDATE g03_b3_test.reform_proposals SET status = 'approved' WHERE id = p_proposal_id;
    RETURN TRUE;
  END IF;

  -- Proposal claims institutional authority → three checks
  SELECT * INTO v_participant FROM g03_b3_test.reform_coordination_participants
    WHERE "coordinationId" = v_proposal."coordinationId"
      AND "tenantId" = current_setting('app.tenant_id', true)
      AND status = 'active';
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Check 1: canApproveCommitments = TRUE
  IF v_participant."canApproveCommitments" = FALSE THEN RETURN FALSE; END IF;

  -- Check 2: verifiedInstitutionId is set (fail-closed if NULL)
  IF v_participant."verifiedInstitutionId" IS NULL THEN RETURN FALSE; END IF;

  -- Check 3: verifiedInstitutionId matches claimed institution
  IF v_participant."verifiedInstitutionId" != v_proposal."actingOnBehalfOfInstitutionId" THEN
    RETURN FALSE;
  END IF;

  -- All checks passed → approve
  UPDATE g03_b3_test.reform_proposals SET status = 'approved' WHERE id = p_proposal_id;
  RETURN TRUE;
END $$;
ALTER FUNCTION g03_b3_test.approve_reform_proposal(TEXT) OWNER TO balance_admin;
GRANT EXECUTE ON FUNCTION g03_b3_test.approve_reform_proposal(TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION g03_b3_test.approve_reform_proposal(TEXT) FROM PUBLIC;

-- ============================================================
-- Test data
-- ============================================================
SET ROLE balance_admin;
-- Coordination: tenant-A is lead, tenant-B is participant
INSERT INTO g03_b3_test.reform_coordinations VALUES ('coord-1', 'tenant-A', 'Test Coord', 'active');
INSERT INTO g03_b3_test.reform_coordination_participants VALUES
  ('part-A1', 'coord-1', 'tenant-A', 'INST-MOP', NULL, NULL, NULL, FALSE, NULL, NULL, 'active'),
  ('part-B1', 'coord-1', 'tenant-B', 'INST-CB', NULL, NULL, NULL, FALSE, NULL, NULL, 'active');
RESET ROLE;

-- Results table
DROP TABLE IF EXISTS g03_b3_test.test_results;
CREATE TABLE g03_b3_test.test_results (test_id TEXT, description TEXT, expected TEXT, actual TEXT, pass BOOLEAN);

-- ============================================================
-- TEST 1: Lead (tenant-A) grants commitment approval to participant (tenant-B) — cross-tenant
-- ============================================================
DO $$
DECLARE v_result BOOLEAN; v_can_approve BOOLEAN;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  PERFORM set_config('app.user_id', 'user-A-lead', false);
  SELECT g03_b3_test.grant_commitment_approval('coord-1', 'part-B1', 'test grant') INTO v_result;
  RESET ROLE;
  SET ROLE balance_admin;
  SELECT "canApproveCommitments" INTO v_can_approve FROM g03_b3_test.reform_coordination_participants WHERE id = 'part-B1';
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST1', 'Lead grants commitment approval (cross-tenant)', 'TRUE+canApprove=TRUE',
     v_result::TEXT || '+canApprove=' || v_can_approve::TEXT,
     v_result = TRUE AND v_can_approve = TRUE);
END $$;

-- ============================================================
-- TEST 2: Non-lead (tenant-B) tries to grant commitment approval
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  PERFORM set_config('app.user_id', 'user-B', false);
  SELECT g03_b3_test.grant_commitment_approval('coord-1', 'part-A1', 'non-lead attempt') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST2', 'Non-lead cannot grant commitment approval', 'FALSE (zero modification)',
     v_result::TEXT, v_result = FALSE);
END $$;

-- ============================================================
-- TEST 3: Participant with canApproveCommitments=TRUE but verifiedInstitutionId=NULL (fail-closed)
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  -- Create a proposal claiming institutional authority
  SET ROLE balance_admin;
  INSERT INTO g03_b3_test.reform_proposals VALUES
    ('prop-inst-1', 'coord-1', 'tenant-B', 'Institutional Commitment', 'INST-CB', 'under_review');
  RESET ROLE;

  -- tenant-B (has canApproveCommitments=TRUE from TEST1, but verifiedInstitutionId=NULL)
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  PERFORM set_config('app.user_id', 'user-B', false);
  SELECT g03_b3_test.approve_reform_proposal('prop-inst-1') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST3', 'Institutional commitment FAIL-CLOSED (no verified authority)', 'FALSE (fail-closed)',
     v_result::TEXT, v_result = FALSE);
END $$;

-- ============================================================
-- TEST 4: Admin verifies institutional authority for tenant-B
-- ============================================================
DO $$
DECLARE v_result BOOLEAN; v_verified_id TEXT;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-A', false);  -- admin is in lead tenant
  PERFORM set_config('app.user_id', 'user-A-admin', false);
  PERFORM set_config('app.role', 'admin', false);
  SELECT g03_b3_test.verify_institutional_authority('coord-1', 'part-B1', 'INST-CB', 'manual_admin') INTO v_result;
  RESET ROLE;
  SET ROLE balance_admin;
  SELECT "verifiedInstitutionId" INTO v_verified_id FROM g03_b3_test.reform_coordination_participants WHERE id = 'part-B1';
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST4', 'Admin verifies institutional authority', 'TRUE+verifiedInstitutionId=INST-CB',
     v_result::TEXT || '+' || COALESCE(v_verified_id, 'NULL'),
     v_result = TRUE AND v_verified_id = 'INST-CB');
END $$;

-- ============================================================
-- TEST 5: Now tenant-B can approve institutional commitment (all 3 checks pass)
-- ============================================================
DO $$
DECLARE v_result BOOLEAN; v_status TEXT;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  PERFORM set_config('app.user_id', 'user-B', false);
  SELECT g03_b3_test.approve_reform_proposal('prop-inst-1') INTO v_result;
  RESET ROLE;
  SET ROLE balance_admin;
  SELECT status INTO v_status FROM g03_b3_test.reform_proposals WHERE id = 'prop-inst-1';
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST5', 'Institutional commitment approved (3 checks pass)', 'TRUE+approved',
     v_result::TEXT || '+' || v_status, v_result = TRUE AND v_status = 'approved');
END $$;

-- ============================================================
-- TEST 6: Non-admin cannot verify institutional authority
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  PERFORM set_config('app.user_id', 'user-A-reviewer', false);
  PERFORM set_config('app.role', 'reviewer', false);  -- NOT admin
  -- Attempt to verify institution for part-A1 (own tenant)
  SELECT g03_b3_test.verify_institutional_authority('coord-1', 'part-A1', 'INST-MOP', 'reviewer attempt') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST6', 'Non-admin cannot verify institutional authority', 'FALSE (admin-only)',
     v_result::TEXT, v_result = FALSE);
END $$;

-- ============================================================
-- TEST 7: Non-institutional commitment approved without canApproveCommitments
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  SET ROLE balance_admin;
  INSERT INTO g03_b3_test.reform_proposals VALUES
    ('prop-noninst-1', 'coord-1', 'tenant-A', 'Own Reform (no institutional claim)', NULL, 'under_review');
  RESET ROLE;
  -- tenant-A (part-A1 has canApproveCommitments=FALSE, but this is non-institutional)
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  PERFORM set_config('app.user_id', 'user-A', false);
  SELECT g03_b3_test.approve_reform_proposal('prop-noninst-1') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST7', 'Non-institutional commitment approved without canApproveCommitments', 'TRUE (no institutional claim)',
     v_result::TEXT, v_result = TRUE);
END $$;

-- ============================================================
-- TEST 8: Institution mismatch (verified INST-CB, claiming INST-MOP)
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  SET ROLE balance_admin;
  -- tenant-B verified for INST-CB (from TEST4), but proposal claims INST-MOP
  INSERT INTO g03_b3_test.reform_proposals VALUES
    ('prop-mismatch-1', 'coord-1', 'tenant-B', 'Wrong Institution Claim', 'INST-MOP', 'under_review');
  RESET ROLE;
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  PERFORM set_config('app.user_id', 'user-B', false);
  SELECT g03_b3_test.approve_reform_proposal('prop-mismatch-1') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_b3_test.test_results VALUES
    ('B3-TEST8', 'Institution mismatch blocks approval', 'FALSE (verified != claimed)',
     v_result::TEXT, v_result = FALSE);
END $$;

-- Results
\echo ''
\echo '============================================================'
\echo 'B3 EMPIRICAL VALIDATION RESULTS (PostgreSQL 16.4)'
\echo '============================================================'
SELECT test_id, description, expected, actual,
  CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM g03_b3_test.test_results ORDER BY test_id;
\echo ''
SELECT COUNT(*) FILTER (WHERE pass) AS passed, COUNT(*) FILTER (WHERE NOT pass) AS failed, COUNT(*) AS total
FROM g03_b3_test.test_results;
