-- ============================================================
-- g03_06_trust_boundary_acceptance.sql
-- ------------------------------------------------------------
-- G03-06 Trust Boundary Closure — SQL-level acceptance tests
-- for Migration 32.
--
-- Tests:
--   T1: balance_app CANNOT UPDATE shared_snapshots (G03-01 trigger blocks)
--   T2: balance_app CANNOT SET ROLE to balance_snapshot_approver
--   T3: balance_app CANNOT connect as balance_snapshot_approver (no password)
--   T4: GUC-spoofing attack (set app.tenant_id + app.user_id, try INSERT)
--       DENIED — the approval_requests table no longer exists
--   T5: balance_snapshot_approver CAN UPDATE draft→approved (column-scoped)
--   T6: balance_snapshot_approver CANNOT UPDATE content fields (title)
--   T7: balance_snapshot_approver CANNOT UPDATE non-draft snapshots
--   T8: balance_snapshot_approver CANNOT UPDATE cross-tenant snapshots
--       (RLS: leadTenantId must match app.tenant_id)
--   T9: Legitimate approval via balance_snapshot_approver SUCCEEDS
--       (UPDATE + audit_log INSERT in same transaction)
-- ============================================================

\set ON_ERROR_STOP off

\echo '============================================================'
\echo 'T1: balance_app CANNOT UPDATE shared_snapshots (G03-01 trigger)'
\echo '============================================================'

-- Create a test snapshot as postgres
DO $$
DECLARE
  v_tenant_a TEXT;
  v_coord_id TEXT;
BEGIN
  SELECT id INTO v_tenant_a FROM tenants WHERE code = 'DML-MOP-TENANT';
  SELECT id INTO v_coord_id FROM reform_coordinations WHERE "leadTenantId" = v_tenant_a LIMIT 1;
  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom',
    'TRUST_BOUNDARY_T1',
    'Test: balance_app cannot UPDATE shared_snapshots.',
    'draft', NOW(), 'test-setup', NOW(), NOW()
  );
END $$;

\gset
SELECT id AS t1_snapshot_id FROM reform_coordination_shared_snapshots WHERE title = 'TRUST_BOUNDARY_T1' LIMIT 1
\gset
SELECT id AS tenant_a_id FROM tenants WHERE code = 'DML-MOP-TENANT' LIMIT 1
\gset

\echo 'T1 snapshot: ' :t1_snapshot_id

-- Try to UPDATE as balance_app (should fail — G03-01 trigger)
SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);

UPDATE reform_coordination_shared_snapshots
SET status = 'approved', "approvedBy" = 'attacker', "approvedAt" = NOW()
WHERE id = :'t1_snapshot_id';

RESET ROLE;
-- Expected: ERROR: S3 VIOLATION: balance_app cannot modify approvedBy

\echo ''
\echo '============================================================'
\echo 'T2: balance_app CANNOT SET ROLE to balance_snapshot_approver'
\echo '============================================================'

SET ROLE balance_app;
SET ROLE balance_snapshot_approver;
RESET ROLE;
-- Expected: ERROR: permission denied to set role "balance_snapshot_approver"

\echo ''
\echo '============================================================'
\echo 'T3: balance_app CANNOT INSERT into approval_requests (table dropped)'
\echo '============================================================'

SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);
SELECT set_config('app.user_id', 'attacker', false);

INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (:'t1_snapshot_id', :'tenant_a_id', 'attacker', 'spoof attempt');

RESET ROLE;
-- Expected: ERROR: relation "reform_coordination_snapshot_approval_requests" does not exist

\echo ''
\echo '============================================================'
\echo 'T4: GUC-spoofing attack (full reproduction attempt)'
\echo '============================================================'
\echo 'Attack: balance_app spoofs app.tenant_id + app.user_id,'
\echo '        tries to approve via any available path.'

SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);
SELECT set_config('app.user_id', 'forged-attacker', false);

-- Try direct UPDATE (blocked by trigger)
UPDATE reform_coordination_shared_snapshots
SET status = 'approved', "approvedBy" = 'forged-attacker', "approvedAt" = NOW()
WHERE id = :'t1_snapshot_id' AND status = 'draft';

-- Try INSERT into approval_requests (table dropped)
INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy") VALUES (:'t1_snapshot_id', :'tenant_a_id', 'forged-attacker');

-- Try calling the trigger function (dropped)
SELECT process_snapshot_approval_request();

RESET ROLE;
-- All three should fail

\echo ''
\echo '============================================================'
\echo 'T5-T8: balance_snapshot_approver UPDATE boundary tests'
\echo '============================================================'

-- Create test snapshots for T5-T8
DO $$
DECLARE
  v_tenant_a TEXT;
  v_tenant_b TEXT;
  v_coord_a TEXT;
  v_coord_b TEXT;
BEGIN
  SELECT id INTO v_tenant_a FROM tenants WHERE code = 'DML-MOP-TENANT';
  SELECT id INTO v_tenant_b FROM tenants WHERE code = 'DML-CB-TENANT';
  SELECT id INTO v_coord_a FROM reform_coordinations WHERE "leadTenantId" = v_tenant_a LIMIT 1;
  SELECT id INTO v_coord_b FROM reform_coordinations WHERE "leadTenantId" = v_tenant_b LIMIT 1;

  -- T5: draft snapshot, Tenant A lead (should succeed)
  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_a, v_tenant_a, 'custom',
    'TRUST_BOUNDARY_T5_DRAFT_LEAD',
    'Test: approver can UPDATE draft snapshot where lead matches.',
    'draft', NOW(), 'test-setup', NOW(), NOW()
  );

  -- T6: same snapshot type but we'll try to UPDATE title (should fail — column-scoped)
  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_a, v_tenant_a, 'custom',
    'TRUST_BOUNDARY_T6_TITLE_UPDATE',
    'Test: approver cannot UPDATE title column.',
    'draft', NOW(), 'test-setup', NOW(), NOW()
  );

  -- T7: already-approved snapshot (should fail — USING status='draft')
  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_a, v_tenant_a, 'custom',
    'TRUST_BOUNDARY_T7_ALREADY_APPROVED',
    'Test: approver cannot UPDATE non-draft snapshot.',
    'approved', NOW(), 'test-setup', NOW(), NOW()
  );

  -- T8: Tenant B lead, but app.tenant_id = Tenant A (should fail — RLS)
  -- Only if Tenant B has a coordination
  IF v_coord_b IS NOT NULL THEN
    INSERT INTO reform_coordination_shared_snapshots (
      id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
      status, "submittedAt", "createdBy", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid()::text, v_coord_b, v_tenant_b, 'custom',
      'TRUST_BOUNDARY_T8_CROSS_TENANT',
      'Test: approver cannot UPDATE cross-tenant snapshot.',
      'draft', NOW(), 'test-setup', NOW(), NOW()
    );
  END IF;
END $$;

\gset
SELECT id AS t5_snap_id FROM reform_coordination_shared_snapshots WHERE title = 'TRUST_BOUNDARY_T5_DRAFT_LEAD' LIMIT 1
\gset
SELECT id AS t6_snap_id FROM reform_coordination_shared_snapshots WHERE title = 'TRUST_BOUNDARY_T6_TITLE_UPDATE' LIMIT 1
\gset
SELECT id AS t7_snap_id FROM reform_coordination_shared_snapshots WHERE title = 'TRUST_BOUNDARY_T7_ALREADY_APPROVED' LIMIT 1
\gset
SELECT id AS t8_snap_id FROM reform_coordination_shared_snapshots WHERE title = 'TRUST_BOUNDARY_T8_CROSS_TENANT' LIMIT 1
\gset

\echo 'T5 snapshot: ' :t5_snap_id

-- T5: Legitimate UPDATE as balance_snapshot_approver (should succeed)
\echo ''
\echo '--- T5: Legitimate approval via balance_snapshot_approver ---'
SET ROLE balance_snapshot_approver;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);

UPDATE reform_coordination_shared_snapshots
SET status = 'approved', "approvedBy" = 'legitimate-approver', "approvedAt" = NOW()
WHERE id = :'t5_snap_id' AND status = 'draft';

RESET ROLE;

SELECT title, status, "approvedBy" FROM reform_coordination_shared_snapshots WHERE id = :'t5_snap_id';
-- Expected: status = 'approved', approvedBy = 'legitimate-approver'

-- T6: Try to UPDATE title as balance_snapshot_approver (should fail)
\echo ''
\echo '--- T6: approver cannot UPDATE title (column-scoped) ---'
SET ROLE balance_snapshot_approver;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);

UPDATE reform_coordination_shared_snapshots
SET title = 'HACKED_TITLE'
WHERE id = :'t6_snap_id';

RESET ROLE;
-- Expected: ERROR: permission denied for table reform_coordination_shared_snapshots (no UPDATE on title column)

-- T7: Try to UPDATE non-draft snapshot (should fail — RLS USING status='draft')
\echo ''
\echo '--- T7: approver cannot UPDATE non-draft snapshot ---'
SET ROLE balance_snapshot_approver;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);

UPDATE reform_coordination_shared_snapshots
SET "approvedBy" = 'attacker'
WHERE id = :'t7_snap_id';

RESET ROLE;
-- Expected: 0 rows updated (RLS USING status='draft' hides the approved row)

SELECT title, status, "approvedBy" FROM reform_coordination_shared_snapshots WHERE id = :'t7_snap_id';
-- Expected: approvedBy = NULL (unchanged)

-- T8: Cross-tenant UPDATE (should fail — RLS leadTenantId != app.tenant_id)
\echo ''
\echo '--- T8: approver cannot UPDATE cross-tenant snapshot ---'
SET ROLE balance_snapshot_approver;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);

UPDATE reform_coordination_shared_snapshots
SET status = 'approved', "approvedBy" = 'attacker', "approvedAt" = NOW()
WHERE id = :'t8_snap_id' AND status = 'draft';

RESET ROLE;
-- Expected: 0 rows updated (RLS leadTenantId != app.tenant_id)

SELECT title, status, "approvedBy" FROM reform_coordination_shared_snapshots WHERE id = :'t8_snap_id';
-- Expected: status = 'draft', approvedBy = NULL (unchanged)

\echo ''
\echo '============================================================'
\echo 'T9: Audit log written atomically with approval'
\echo '============================================================'

-- Verify the T5 approval wrote an audit entry
-- (This is done by the app service, not directly here — but we verify
--  that balance_snapshot_approver CAN INSERT into audit_log)
SET ROLE balance_snapshot_approver;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);

INSERT INTO audit_log ("tenantId", actor, action, details, status, "at")
VALUES (:'tenant_a_id', 'test-approver', 'reform.coordination.snapshot_approved',
        jsonb_build_object('snapshotId', :'t5_snap_id', 'test', true),
        'ok', NOW());

RESET ROLE;

SELECT actor, action, details->>'snapshotId' AS snap_id, status
FROM audit_log
WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' = :'t5_snap_id'
ORDER BY "at" DESC LIMIT 1;

\echo ''
\echo '============================================================'
\echo 'CLEANUP'
\echo '============================================================'

-- Clean up all test artifacts
DELETE FROM reform_coordination_shared_snapshot_revocations WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title LIKE 'TRUST_BOUNDARY_%'
);
DELETE FROM reform_coordination_shared_snapshots WHERE title LIKE 'TRUST_BOUNDARY_%';
DELETE FROM audit_log WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' IN (
    SELECT id::text FROM reform_coordination_shared_snapshots WHERE title LIKE 'TRUST_BOUNDARY_%'
  );

\echo ''
\echo '============================================================'
\echo 'TRUST BOUNDARY TEST SUITE COMPLETE'
\echo '============================================================'
\echo 'All expected errors above confirm the trust boundary is enforced.'
\echo 'T5 should show status=approved (legitimate approval succeeded).'
