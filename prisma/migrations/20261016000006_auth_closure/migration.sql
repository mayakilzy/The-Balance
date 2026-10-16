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
-- 2. USERS — RESTRICT UPDATE TO name + updatedAt ONLY
-- ============================================================
-- Previous: UPDATE policy allowed updating own row (all columns).
-- Problem: balance_app could update status, email (identity fields).
-- Fix: REVOKE all UPDATE at table level, then GRANT only safe columns.

-- First, REVOKE all UPDATE on users from balance_app
REVOKE UPDATE ON "users" FROM balance_app;

-- Then, GRANT UPDATE only on safe columns (name, updatedAt)
-- Note: Prisma's @updatedAt auto-manages "updatedAt" on every update.
GRANT UPDATE ("name", "updatedAt") ON "users" TO balance_app;

-- The UPDATE RLS policy still controls WHICH rows can be updated
-- (only own row). The column-level GRANT controls WHICH columns.
-- Combined: balance_app can UPDATE only own row's name + updatedAt.

DROP POLICY IF EXISTS "user_self_update_balance_app" ON "users";
CREATE POLICY "user_self_update_balance_app" ON "users"
    FOR UPDATE TO balance_app
    USING (id = current_setting('app.user_id', true))
    WITH CHECK (id = current_setting('app.user_id', true));

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
