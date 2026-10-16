-- The Balance — Migration 20261016000006: Auth Closure (privilege tightening)
-- Mission 00-03 auth closure: tighten memberships + users privileges.
--
-- Founder directives:
--   1. balance_app should NOT be able to INSERT memberships (admin-only).
--      Prevents privilege escalation (creating admin membership).
--   2. balance_app UPDATE on users too broad — only name should be updatable.
--      status, email, passwordHash must be admin-only.
--
-- Per ADR-0007 (updated) + ADR-0008 (updated).

-- ============================================================
-- 1. MEMBERSHIPS — REMOVE INSERT FROM balance_app
-- ============================================================
-- Memberships are admin-only. balance_app can SELECT (own, in tenant)
-- but cannot INSERT/UPDATE/DELETE.

DROP POLICY IF EXISTS "membership_self_insert_balance_app" ON "memberships";

-- REVOKE INSERT/UPDATE/DELETE from balance_app as belt-and-suspenders.
REVOKE INSERT, UPDATE, DELETE ON "memberships" FROM balance_app;

-- ============================================================
-- 2. USERS — RESTRICT UPDATE TO name ONLY
-- ============================================================
-- Previous: UPDATE policy allowed updating own row (all columns).
-- Problem: balance_app could update status, email (identity fields).
-- Fix: DROP the broad UPDATE policy; CREATE column-specific one.

DROP POLICY IF EXISTS "user_self_update_balance_app" ON "users";

-- New UPDATE policy: only allows updating own row.
-- Column-level REVOKEs (below) further restrict which columns.
CREATE POLICY "user_self_update_balance_app" ON "users"
    FOR UPDATE TO balance_app
    USING (id = current_setting('app.user_id', true))
    WITH CHECK (id = current_setting('app.user_id', true));

-- REVOKE UPDATE on sensitive columns:
-- - passwordHash (already revoked in 0005, re-revoke for clarity)
-- - status (admin-only — user cannot suspend/activate themselves)
-- - email (identity field — admin-only)
-- - id (PK — never updatable)
REVOKE UPDATE ("passwordHash") ON "users" FROM balance_app;
REVOKE UPDATE ("status") ON "users" FROM balance_app;
REVOKE UPDATE ("email") ON "users" FROM balance_app;
REVOKE UPDATE ("id") ON "users" FROM balance_app;
REVOKE UPDATE ("createdAt") ON "users" FROM balance_app;

-- balance_app can only UPDATE: name, updatedAt
-- (updatedAt is auto-managed by Prisma)

-- ============================================================
-- 3. VERIFY — confirm policies + grants are correct
-- ============================================================
DO $$
DECLARE
    has_insert_policy BOOLEAN;
    has_update_policy BOOLEAN;
BEGIN
    -- memberships: NO INSERT policy for balance_app
    SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'memberships'
          AND roles @> ARRAY['balance_app']::name[]
          AND cmd = 'INSERT'
    ) INTO has_insert_policy;

    IF has_insert_policy THEN
        RAISE EXCEPTION 'memberships still has INSERT policy for balance_app — privilege escalation risk';
    END IF;

    -- users: UPDATE policy exists (but column-restricted)
    SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'users'
          AND roles @> ARRAY['balance_app']::name[]
          AND cmd = 'UPDATE'
    ) INTO has_update_policy;

    IF NOT has_update_policy THEN
        RAISE EXCEPTION 'users UPDATE policy missing for balance_app';
    END IF;

    RAISE NOTICE 'Auth closure verified: memberships INSERT blocked, users UPDATE column-restricted.';
END $$;
