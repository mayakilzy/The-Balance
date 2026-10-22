-- ============================================================
-- g03_06_security_fix_acceptance.sql
-- ------------------------------------------------------------
-- G03-06 Security Fix — SQL-level acceptance tests for Migration 31.
--
-- Tests:
--   S1: Direct EXECUTE on approve_coordination_shared_snapshot DENIED
--       (function dropped — no direct invocation path)
--   S2: Direct EXECUTE on process_snapshot_approval_request DENIED
--       (trigger function — no EXECUTE grant to balance_app)
--   S3: Forged approver identity DENIED
--       (RLS requires requestedBy = current_setting('app.user_id'))
--   S4: Cross-tenant approval DENIED
--       (RLS requires leadTenantId = current_setting('app.tenant_id'))
--   S5: Non-draft snapshot approval DENIED
--       (RLS requires snapshot.status = 'draft')
--   S6: Legitimate approval via INSERT SUCCEEDS
--       (trigger fires, snapshot transitions to approved, audit log written)
--   S7: Duplicate approval DENIED without duplicate audit
--       (UNIQUE constraint on snapshotId + trigger idempotency)
--   S8: balance_coordination_admin UPDATE on shared_snapshots is narrow
--       (only status, approvedAt, approvedBy columns; only draft→approved)
-- ============================================================

\set ON_ERROR_STOP off

-- Helper: clean up any prior test artifacts
\echo '============================================================'
\echo 'S1: Direct EXECUTE on approve_coordination_shared_snapshot DENIED'
\echo '============================================================'

-- The function should NOT EXIST (dropped in migration 31)
SELECT proname FROM pg_proc WHERE proname = 'approve_coordination_shared_snapshot';
-- Expected: 0 rows (function dropped)

-- Attempt to call it as balance_app (should fail with "function does not exist")
SET ROLE balance_app;
SELECT set_config('app.tenant_id', '', false);
SELECT set_config('app.user_id', '', false);
SELECT * FROM public.approve_coordination_shared_snapshot('test', 'test', 'test', 'test');
RESET ROLE;

\echo ''
\echo '============================================================'
\echo 'S2: Direct EXECUTE on process_snapshot_approval_request DENIED'
\echo '============================================================'

-- The trigger function EXISTS but should NOT be callable by balance_app
SELECT proname FROM pg_proc WHERE proname = 'process_snapshot_approval_request';
-- Expected: 1 row (function exists — it's a trigger function)

-- Attempt direct call as balance_app (should fail with "permission denied")
SET ROLE balance_app;
SELECT set_config('app.tenant_id', '', false);
SELECT set_config('app.user_id', '', false);
SELECT public.process_snapshot_approval_request();
RESET ROLE;

\echo ''
\echo '============================================================'
\echo 'S3-S5: Setup — create test snapshot for approval boundary tests'
\echo '============================================================'

-- Clean up prior artifacts
DELETE FROM reform_coordination_shared_snapshot_revocations WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%'
);
DELETE FROM reform_coordination_snapshot_approval_requests WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%'
);
DELETE FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%';
DELETE FROM audit_log WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' IN (
    SELECT id::text FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%'
  );

-- Create a draft snapshot owned by Tenant A (using postgres BYPASSRLS)
DO $$
DECLARE
  v_tenant_a TEXT;
  v_tenant_b TEXT;
  v_coord_id TEXT;
BEGIN
  SELECT id INTO v_tenant_a FROM tenants WHERE code = 'DML-MOP-TENANT';
  SELECT id INTO v_tenant_b FROM tenants WHERE code = 'DML-CB-TENANT';
  SELECT id INTO v_coord_id FROM reform_coordinations WHERE "leadTenantId" = v_tenant_a LIMIT 1;

  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom',
    'SECURITY_TEST_S3_FORGED_APPROVER',
    'Test: forged approver identity should be rejected by RLS.',
    'draft', NOW(), 'test-setup', NOW(), NOW()
  );

  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom',
    'SECURITY_TEST_S4_CROSS_TENANT',
    'Test: cross-tenant approval should be rejected by RLS.',
    'draft', NOW(), 'test-setup', NOW(), NOW()
  );

  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom',
    'SECURITY_TEST_S5_NON_DRAFT',
    'Test: non-draft snapshot approval should be rejected by RLS.',
    'approved', NOW(), 'test-setup', NOW(), NOW()
  );

  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom',
    'SECURITY_TEST_S6_LEGITIMATE',
    'Test: legitimate approval should succeed via RLS-gated INSERT.',
    'draft', NOW(), 'test-setup', NOW(), NOW()
  );

  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom',
    'SECURITY_TEST_S7_DUPLICATE',
    'Test: duplicate approval should be rejected without duplicate audit.',
    'draft', NOW(), 'test-setup', NOW(), NOW()
  );
END $$;

-- Capture snapshot IDs
\gset
SELECT
  (SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'SECURITY_TEST_S3_FORGED_APPROVER' LIMIT 1) AS s3_snapshot_id,
  (SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'SECURITY_TEST_S4_CROSS_TENANT' LIMIT 1) AS s4_snapshot_id,
  (SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'SECURITY_TEST_S5_NON_DRAFT' LIMIT 1) AS s5_snapshot_id,
  (SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'SECURITY_TEST_S6_LEGITIMATE' LIMIT 1) AS s6_snapshot_id,
  (SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'SECURITY_TEST_S7_DUPLICATE' LIMIT 1) AS s7_snapshot_id,
  (SELECT id FROM tenants WHERE code = 'DML-MOP-TENANT' LIMIT 1) AS tenant_a_id,
  (SELECT id FROM tenants WHERE code = 'DML-CB-TENANT' LIMIT 1) AS tenant_b_id
\gset

\echo 'S3 snapshot: ' :s3_snapshot_id
\echo 'S4 snapshot: ' :s4_snapshot_id
\echo 'S5 snapshot: ' :s5_snapshot_id
\echo 'S6 snapshot: ' :s6_snapshot_id
\echo 'S7 snapshot: ' :s7_snapshot_id
\echo 'Tenant A:    ' :tenant_a_id
\echo 'Tenant B:    ' :tenant_b_id

\echo ''
\echo '============================================================'
\echo 'S3: Forged approver identity DENIED'
\echo '============================================================'
\echo 'Attack: balance_app sets app.tenant_id=lead, but sets'
\echo '        app.user_id=REAL_USER while INSERTing requestedBy=FORGED_USER'
\echo 'Expected: RLS INSERT policy rejects (requestedBy != app.user_id)'

SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);
SELECT set_config('app.user_id', 'real-user-id', false);

INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (:'s3_snapshot_id', :'tenant_a_id', 'FORGED_USER_ID', 'attempt to forge approver');

RESET ROLE;
-- Expected: ERROR: new row violates row-level security policy

\echo ''
\echo '============================================================'
\echo 'S4: Cross-tenant approval DENIED'
\echo '============================================================'
\echo 'Attack: balance_app with app.tenant_id=Tenant_B tries to approve'
\echo '        a snapshot in a coordination where Tenant_A is the lead'
\echo 'Expected: RLS INSERT policy rejects (leadTenantId != app.tenant_id)'

SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_b_id', false);
SELECT set_config('app.user_id', 'tenant-b-user', false);

INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (:'s4_snapshot_id', :'tenant_b_id', 'tenant-b-user', 'cross-tenant attempt');

RESET ROLE;
-- Expected: ERROR: new row violates row-level security policy

\echo ''
\echo '============================================================'
\echo 'S5: Non-draft snapshot approval DENIED'
\echo '============================================================'
\echo 'Attack: balance_app tries to approve a snapshot already in approved state'
\echo 'Expected: RLS INSERT policy rejects (snapshot.status != draft)'

SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);
SELECT set_config('app.user_id', 'tenant-a-user', false);

INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (:'s5_snapshot_id', :'tenant_a_id', 'tenant-a-user', 'non-draft attempt');

RESET ROLE;
-- Expected: ERROR: new row violates row-level security policy

\echo ''
\echo '============================================================'
\echo 'S6: Legitimate approval via INSERT SUCCEEDS'
\echo '============================================================'
\echo 'Setup: balance_app with app.tenant_id=lead, app.user_id=real-user'
\echo 'Expected: INSERT succeeds, trigger fires, snapshot approved, audit logged'

SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);
SELECT set_config('app.user_id', 'legitimate-approver', false);

INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (:'s6_snapshot_id', :'tenant_a_id', 'legitimate-approver', 'legitimate approval');

RESET ROLE;

-- Verify the snapshot was approved
SELECT title, status, "approvedBy" FROM reform_coordination_shared_snapshots
WHERE id = :'s6_snapshot_id';
-- Expected: status = 'approved', approvedBy = 'legitimate-approver'

-- Verify the audit log entry was written
SELECT actor, action, details->>'snapshotId' AS snapshot_id, status
FROM audit_log
WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' = :'s6_snapshot_id'
ORDER BY "at" DESC LIMIT 1;
-- Expected: actor = 'legitimate-approver', action = 'reform.coordination.snapshot_approved', status = 'ok'

\echo ''
\echo '============================================================'
\echo 'S7: Duplicate approval DENIED without duplicate audit'
\echo '============================================================'
\echo 'Attack: try to approve S7 snapshot twice'
\echo 'Expected: first INSERT succeeds, second INSERT fails (UNIQUE constraint)'

-- First approval (should succeed)
SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);
SELECT set_config('app.user_id', 'first-approver', false);

INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (:'s7_snapshot_id', :'tenant_a_id', 'first-approver', 'first approval');

RESET ROLE;

-- Check audit count (should be 1)
SELECT count(*) AS audit_count_after_first FROM audit_log
WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' = :'s7_snapshot_id';

-- Second approval attempt (should fail — snapshot no longer draft)
SET ROLE balance_app;
SELECT set_config('app.tenant_id', :'tenant_a_id', false);
SELECT set_config('app.user_id', 'second-approver', false);

INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (:'s7_snapshot_id', :'tenant_a_id', 'second-approver', 'second approval attempt');

RESET ROLE;

-- Check audit count again (should still be 1 — no duplicate audit)
SELECT count(*) AS audit_count_after_second FROM audit_log
WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' = :'s7_snapshot_id';

\echo ''
\echo '============================================================'
\echo 'S8: balance_coordination_admin UPDATE scope is narrow'
\echo '============================================================'

-- Check column-level GRANTs for balance_coordination_admin
SELECT column_name, privilege_type
FROM information_schema.column_privileges
WHERE grantee = 'balance_coordination_admin'
  AND table_name = 'reform_coordination_shared_snapshots'
ORDER BY column_name;
-- Expected: only status, approvedAt, approvedBy columns have UPDATE privilege

-- Check RLS policy for balance_coordination_admin UPDATE
SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr,
       pg_get_expr(polwithcheck, polrelid) AS check_expr
FROM pg_policy
WHERE polrelid = 'reform_coordination_shared_snapshots'::regclass
  AND polname = 'reform_coord_snapshots_cadmin_update';
-- Expected: USING (status = 'draft') WITH CHECK (status = 'approved')

-- Verify that balance_coordination_admin CANNOT modify content fields
-- (e.g., title) even on a draft snapshot
SET ROLE balance_coordination_admin;
UPDATE reform_coordination_shared_snapshots
SET title = 'HACKED_TITLE'
WHERE id = :'s6_snapshot_id';
RESET ROLE;
-- Expected: ERROR (no UPDATE privilege on column "title")

\echo ''
\echo '============================================================'
\echo 'CLEANUP'
\echo '============================================================'

-- Remove test artifacts
DELETE FROM reform_coordination_snapshot_approval_requests WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%'
);
DELETE FROM reform_coordination_shared_snapshot_revocations WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%'
);
DELETE FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%';
DELETE FROM audit_log WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' IN (
    SELECT id::text FROM reform_coordination_shared_snapshots WHERE title LIKE 'SECURITY_TEST_%'
  );

\echo ''
\echo '============================================================'
\echo 'SECURITY TEST SUITE COMPLETE'
\echo '============================================================'
\echo 'All expected errors above (RLS violations, permission denied)'
\echo 'confirm the security boundary is enforced.'
\echo 'The legitimate approval (S6) should show status=approved.'
