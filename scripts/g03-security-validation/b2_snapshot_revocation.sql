-- ============================================================
-- G03-00 B2 Security Validation — Shared Snapshot Revocation
-- ============================================================
-- Tests:
-- 1. Approved snapshot visible to coordination participants
-- 2. Revoked snapshot NOT visible to participants (DB-level enforcement)
-- 3. Owner retains historical access to their own revoked snapshots
-- 4. coordinationId match enforcement (trigger blocks mismatch)
-- 5. Cross-tenant forgery prevention (RLS blocks INSERT from non-owner)
-- 6. No circular RLS dependency (is_snapshot_revoked works)
-- ============================================================

\set ON_ERROR_STOP off

DROP SCHEMA IF EXISTS g03_b2_test CASCADE;
DO $$ BEGIN DROP ROLE IF EXISTS balance_app; END $$;
DO $$ BEGIN DROP ROLE IF EXISTS balance_admin; END $$;

CREATE SCHEMA g03_b2_test;
CREATE ROLE balance_app NOLOGIN;
CREATE ROLE balance_admin NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA g03_b2_test TO balance_app, balance_admin;
SET search_path = g03_b2_test, public;

-- ============================================================
-- Tables
-- ============================================================
CREATE TABLE g03_b2_test.reform_coordinations (
  id TEXT PRIMARY KEY, "leadTenantId" TEXT NOT NULL, "countryId" TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE g03_b2_test.reform_coordination_participants (
  id TEXT PRIMARY KEY, "coordinationId" TEXT NOT NULL REFERENCES g03_b2_test.reform_coordinations(id),
  "tenantId" TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_invitation'
);

CREATE TABLE g03_b2_test.reform_coordination_shared_snapshots (
  id TEXT PRIMARY KEY,
  "coordinationId" TEXT NOT NULL REFERENCES g03_b2_test.reform_coordinations(id),
  "ownerTenantId" TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  "approvedAt" TIMESTAMP,
  "approvedBy" TEXT
);

CREATE TABLE g03_b2_test.reform_coordination_shared_snapshot_revocations (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "coordinationId" TEXT NOT NULL,  -- DENORMALIZED (breaks circular dependency)
  "snapshotId" TEXT NOT NULL REFERENCES g03_b2_test.reform_coordination_shared_snapshots(id),
  "revokedBy" TEXT NOT NULL,
  "revokedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL
);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE g03_b2_test.reform_coordinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b2_test.reform_coordinations FORCE ROW LEVEL SECURITY;
ALTER TABLE g03_b2_test.reform_coordination_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b2_test.reform_coordination_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE g03_b2_test.reform_coordination_shared_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b2_test.reform_coordination_shared_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE g03_b2_test.reform_coordination_shared_snapshot_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE g03_b2_test.reform_coordination_shared_snapshot_revocations FORCE ROW LEVEL SECURITY;

-- Helper function: is_coordination_participant (SECURITY INVOKER)
CREATE OR REPLACE FUNCTION g03_b2_test.is_coordination_participant(p_coordination_id TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY INVOKER STABLE SET search_path = g03_b2_test, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM g03_b2_test.reform_coordination_participants
    WHERE "coordinationId" = p_coordination_id
      AND "tenantId" = current_setting('app.tenant_id', true)
      AND status = 'active'
  );
$$;
GRANT EXECUTE ON FUNCTION g03_b2_test.is_coordination_participant(TEXT) TO balance_app;

-- Helper function: is_snapshot_revoked (SECURITY INVOKER)
CREATE OR REPLACE FUNCTION g03_b2_test.is_snapshot_revoked(p_snapshot_id TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY INVOKER STABLE SET search_path = g03_b2_test, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM g03_b2_test.reform_coordination_shared_snapshot_revocations
    WHERE "snapshotId" = p_snapshot_id
  );
$$;
GRANT EXECUTE ON FUNCTION g03_b2_test.is_snapshot_revoked(TEXT) TO balance_app;

-- Policies: reform_coordinations (lead OR participant can SELECT)
CREATE POLICY rc_select_app ON g03_b2_test.reform_coordinations FOR SELECT TO balance_app
  USING ("leadTenantId" = current_setting('app.tenant_id', true)
         OR g03_b2_test.is_coordination_participant(id));
CREATE POLICY rc_insert_app ON g03_b2_test.reform_coordinations FOR INSERT TO balance_app
  WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));

-- Policies: participants (own row only for SELECT; lead can INSERT)
CREATE POLICY rcp_select_app ON g03_b2_test.reform_coordination_participants FOR SELECT TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rcp_insert_app ON g03_b2_test.reform_coordination_participants FOR INSERT TO balance_app
  WITH CHECK (EXISTS (SELECT 1 FROM g03_b2_test.reform_coordinations c
                      WHERE c.id = "coordinationId" AND c."leadTenantId" = current_setting('app.tenant_id', true)));

-- Policies: shared_snapshots (B2 — DB-level revocation enforcement)
CREATE POLICY rss_select_app ON g03_b2_test.reform_coordination_shared_snapshots FOR SELECT TO balance_app
  USING (
    "ownerTenantId" = current_setting('app.tenant_id', true)
    OR (
      "approvedAt" IS NOT NULL
      AND g03_b2_test.is_coordination_participant("coordinationId")
      AND NOT g03_b2_test.is_snapshot_revoked(id)
    )
  );
CREATE POLICY rss_insert_app ON g03_b2_test.reform_coordination_shared_snapshots FOR INSERT TO balance_app
  WITH CHECK ("ownerTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY rss_update_app ON g03_b2_test.reform_coordination_shared_snapshots FOR UPDATE TO balance_app
  USING ("ownerTenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("ownerTenantId" = current_setting('app.tenant_id', true));

-- Policies: revocations (denormalized coordinationId — no circular dependency)
CREATE POLICY rssr_select_app ON g03_b2_test.reform_coordination_shared_snapshot_revocations FOR SELECT TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true)
         OR g03_b2_test.is_coordination_participant("coordinationId"));
CREATE POLICY rssr_insert_app ON g03_b2_test.reform_coordination_shared_snapshot_revocations FOR INSERT TO balance_app
  WITH CHECK (
    "tenantId" = current_setting('app.tenant_id', true)
    AND EXISTS (SELECT 1 FROM g03_b2_test.reform_coordination_shared_snapshots s
                WHERE s.id = "snapshotId"
                  AND s."ownerTenantId" = current_setting('app.tenant_id', true))
  );

-- Trigger: enforce coordinationId match on revocation INSERT
CREATE OR REPLACE FUNCTION g03_b2_test.enforce_revocation_coordination_match()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_snapshot_coord_id TEXT;
BEGIN
  SELECT "coordinationId" INTO v_snapshot_coord_id
    FROM g03_b2_test.reform_coordination_shared_snapshots WHERE id = NEW."snapshotId";
  IF v_snapshot_coord_id IS NULL THEN
    RAISE EXCEPTION 'Cannot revoke: snapshot % does not exist', NEW."snapshotId";
  END IF;
  IF v_snapshot_coord_id != NEW."coordinationId" THEN
    RAISE EXCEPTION 'Coordination mismatch: revocation % does not match snapshot %',
      NEW."coordinationId", v_snapshot_coord_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_revocation_coordination_match
  BEFORE INSERT ON g03_b2_test.reform_coordination_shared_snapshot_revocations
  FOR EACH ROW EXECUTE FUNCTION g03_b2_test.enforce_revocation_coordination_match();

-- Grants
GRANT SELECT, INSERT, UPDATE ON g03_b2_test.reform_coordinations TO balance_app;
GRANT SELECT, INSERT ON g03_b2_test.reform_coordination_participants TO balance_app;
GRANT SELECT, INSERT, UPDATE ON g03_b2_test.reform_coordination_shared_snapshots TO balance_app;
GRANT SELECT, INSERT ON g03_b2_test.reform_coordination_shared_snapshot_revocations TO balance_app;
GRANT ALL ON ALL TABLES IN SCHEMA g03_b2_test TO balance_admin;

-- ============================================================
-- Test data (as balance_admin — BYPASSRLS)
-- ============================================================
SET ROLE balance_admin;
-- Coordination: tenant-A is lead, tenant-B is participant
INSERT INTO g03_b2_test.reform_coordinations VALUES ('coord-1', 'tenant-A', 'country-X', 'Test Coord', 'active');
INSERT INTO g03_b2_test.reform_coordination_participants VALUES
  ('part-A1', 'coord-1', 'tenant-A', 'active'),
  ('part-B1', 'coord-1', 'tenant-B', 'active');
-- Shared snapshots: one approved (snap-1), one approved+revoked (snap-2)
INSERT INTO g03_b2_test.reform_coordination_shared_snapshots VALUES
  ('snap-1', 'coord-1', 'tenant-A', 'Commitment A', 'Summary A', 'approved', NOW(), 'user-A-reviewer'),
  ('snap-2', 'coord-1', 'tenant-A', 'Commitment B', 'Summary B', 'approved', NOW(), 'user-A-reviewer');
-- Revoke snap-2
INSERT INTO g03_b2_test.reform_coordination_shared_snapshot_revocations
  (id, "tenantId", "coordinationId", "snapshotId", "revokedBy", reason) VALUES
  ('revoke-1', 'tenant-A', 'coord-1', 'snap-2', 'user-A-reviewer', 'Test revocation');
RESET ROLE;

-- Results table
DROP TABLE IF EXISTS g03_b2_test.test_results;
CREATE TABLE g03_b2_test.test_results (test_id TEXT, description TEXT, expected TEXT, actual TEXT, pass BOOLEAN);

-- ============================================================
-- TEST 1: Approved non-revoked snapshot visible to participant (tenant-B)
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  SELECT count(*) INTO v_count FROM g03_b2_test.reform_coordination_shared_snapshots WHERE id = 'snap-1';
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST1', 'Approved non-revoked snapshot visible to participant', 'count=1',
     'count=' || v_count, v_count = 1);
END $$;

-- ============================================================
-- TEST 2: Revoked snapshot NOT visible to participant (DB-level)
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  SELECT count(*) INTO v_count FROM g03_b2_test.reform_coordination_shared_snapshots WHERE id = 'snap-2';
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST2', 'Revoked snapshot NOT visible to participant (DB-level)', 'count=0',
     'count=' || v_count, v_count = 0);
END $$;

-- ============================================================
-- TEST 3: Owner retains historical access to their own revoked snapshot
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  SELECT count(*) INTO v_count FROM g03_b2_test.reform_coordination_shared_snapshots WHERE id = 'snap-2';
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST3', 'Owner retains historical access to revoked snapshot', 'count=1',
     'count=' || v_count, v_count = 1);
END $$;

-- ============================================================
-- TEST 4: coordinationId match enforcement (trigger blocks mismatch)
-- ============================================================
DO $$
DECLARE v_err TEXT;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-A', false);
  -- Insert a new approved snapshot first (to revoke)
  INSERT INTO g03_b2_test.reform_coordination_shared_snapshots
    VALUES ('snap-3', 'coord-1', 'tenant-A', 'Commitment C', 'Summary C', 'approved', NOW(), 'user-A');
  -- Attempt revocation with WRONG coordinationId
  INSERT INTO g03_b2_test.reform_coordination_shared_snapshot_revocations
    (id, "tenantId", "coordinationId", "snapshotId", "revokedBy", reason) VALUES
    ('revoke-bad', 'tenant-A', 'coord-WRONG', 'snap-3', 'user-A', 'forgery attempt');
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST4', 'coordinationId match enforcement (trigger)', 'ERROR (mismatch blocked)',
     'NO ERROR (forgery accepted)', FALSE);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST4', 'coordinationId match enforcement (trigger)', 'ERROR (mismatch blocked)',
     SQLERRM, SQLERRM LIKE '%mismatch%' OR SQLERRM LIKE '%Coordination%');
END $$;

-- ============================================================
-- TEST 5: Cross-tenant forgery prevention (tenant-B cannot revoke tenant-A's snapshot)
-- ============================================================
DO $$
DECLARE v_err TEXT;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  -- tenant-B attempts to revoke tenant-A's snapshot (snap-1)
  INSERT INTO g03_b2_test.reform_coordination_shared_snapshot_revocations
    (id, "tenantId", "coordinationId", "snapshotId", "revokedBy", reason) VALUES
    ('revoke-forge', 'tenant-B', 'coord-1', 'snap-1', 'user-B', 'forgery');
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST5', 'Cross-tenant forgery prevention', 'ERROR (RLS blocks)',
     'NO ERROR (forgery accepted)', FALSE);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST5', 'Cross-tenant forgery prevention', 'ERROR (RLS blocks)',
     SQLERRM, SQLERRM LIKE '%row level%' OR SQLERRM LIKE '%new row violates%');
END $$;

-- ============================================================
-- TEST 6: No circular RLS dependency (is_snapshot_revoked works)
-- ============================================================
DO $$
DECLARE v_result BOOLEAN;
BEGIN
  SET ROLE balance_app;
  PERFORM set_config('app.tenant_id', 'tenant-B', false);
  -- Call is_snapshot_revoked on snap-2 (which has a revocation)
  SELECT g03_b2_test.is_snapshot_revoked('snap-2') INTO v_result;
  RESET ROLE;
  INSERT INTO g03_b2_test.test_results VALUES
    ('B2-TEST6', 'No circular RLS (is_snapshot_revoked works)', 'TRUE (snap-2 is revoked)',
     v_result::TEXT, v_result = TRUE);
END $$;

-- Results
\echo ''
\echo '============================================================'
\echo 'B2 EMPIRICAL VALIDATION RESULTS (PostgreSQL 16.4)'
\echo '============================================================'
SELECT test_id, description, expected, actual,
  CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM g03_b2_test.test_results ORDER BY test_id;
\echo ''
SELECT COUNT(*) FILTER (WHERE pass) AS passed, COUNT(*) FILTER (WHERE NOT pass) AS failed, COUNT(*) AS total
FROM g03_b2_test.test_results;
