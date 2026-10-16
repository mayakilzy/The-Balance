-- The Balance — Migration 20261016000007: balance_auth role (least-privilege auth)
-- Mission 00-03 final runtime acceptance.
--
-- Founder directive:
--   "فضّل دوراً مخصصاً للمصادقة بصلاحيات قراءة محدودة على الجداول
--    والحقول المطلوبة، أو آلية مكافئة ذات نطاق واضح. لا تستخدم
--    صلاحيات إدارة الهجرات داخل خادم التطبيق."
--
-- This migration creates balance_auth: a dedicated role for auth bootstrap
-- with READ-ONLY access to ONLY the columns needed for authentication.
-- It does NOT have BYPASSRLS, DDL, or write privileges.
--
-- Per ADR-0007 (updated: least-privilege auth bootstrap).

-- ============================================================
-- 1. CREATE balance_auth ROLE
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_auth') THEN
        CREATE ROLE balance_auth WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

-- Set dev-only password (production overrides via scripts/setup-roles.sql)
ALTER ROLE balance_auth WITH PASSWORD 'balance_auth_dev_only';

-- ============================================================
-- 2. SCHEMA USAGE
-- ============================================================
GRANT USAGE ON SCHEMA public TO balance_auth;

-- ============================================================
-- 3. COLUMN-LEVEL SELECT GRANTS (read-only, minimal)
-- ============================================================
-- balance_auth can SELECT ONLY the columns needed for auth:
--   users: id, email, name, passwordHash, status (NOT createdAt, updatedAt)
--   memberships: userId, tenantId, roleCode, status (NOT id, createdAt, updatedAt)
--   tenants: id (for verifying tenant exists — optional but useful)

GRANT SELECT (id, email, name, "passwordHash", status) ON "users" TO balance_auth;
GRANT SELECT ("userId", "tenantId", "roleCode", status) ON "memberships" TO balance_auth;
GRANT SELECT (id) ON "tenants" TO balance_auth;

-- ============================================================
-- 4. RLS EXEMPTION FOR balance_auth on users + memberships
-- ============================================================
-- balance_auth needs to read users + memberships WITHOUT app.user_id
-- context (it's the auth bootstrap). We add RLS policies that allow
-- balance_auth to SELECT all rows.
--
-- SECURITY: balance_auth has NO writes, NO DDL, NO BYPASSRLS.
-- It can only SELECT the columns granted above. RLS policies below
-- allow it to see all rows (for auth lookup), but it cannot modify
-- anything.

DROP POLICY IF EXISTS "auth_read_all_balance_auth" ON "users";
CREATE POLICY "auth_read_all_balance_auth" ON "users"
    FOR SELECT TO balance_auth
    USING (true);

DROP POLICY IF EXISTS "auth_read_all_balance_auth" ON "memberships";
CREATE POLICY "auth_read_all_balance_auth" ON "memberships"
    FOR SELECT TO balance_auth
    USING (true);

DROP POLICY IF EXISTS "auth_read_all_balance_auth" ON "tenants";
CREATE POLICY "auth_read_all_balance_auth" ON "tenants"
    FOR SELECT TO balance_auth
    USING (true);

-- ============================================================
-- 5. VERIFY — confirm balance_auth has correct privileges
-- ============================================================
DO $$
DECLARE
    is_superuser BOOLEAN;
    has_bypassrls BOOLEAN;
    can_select_users BOOLEAN;
    can_insert_users BOOLEAN;
    can_update_users BOOLEAN;
BEGIN
    SELECT rolsuper INTO is_superuser FROM pg_roles WHERE rolname = 'balance_auth';
    SELECT rolbypassrls INTO has_bypassrls FROM pg_roles WHERE rolname = 'balance_auth';

    SELECT has_column_privilege('balance_auth', 'users', 'passwordHash', 'SELECT')
      INTO can_select_users;
    SELECT has_table_privilege('balance_auth', 'users', 'INSERT')
      INTO can_insert_users;
    SELECT has_table_privilege('balance_auth', 'users', 'UPDATE')
      INTO can_update_users;

    IF is_superuser THEN RAISE EXCEPTION 'balance_auth is SUPERUSER — too privileged'; END IF;
    IF has_bypassrls THEN RAISE EXCEPTION 'balance_auth has BYPASSRLS — too privileged'; END IF;
    IF NOT can_select_users THEN RAISE EXCEPTION 'balance_auth cannot SELECT users.passwordHash'; END IF;
    IF can_insert_users THEN RAISE EXCEPTION 'balance_auth can INSERT users — should be read-only'; END IF;
    IF can_update_users THEN RAISE EXCEPTION 'balance_auth can UPDATE users — should be read-only'; END IF;

    RAISE NOTICE 'balance_auth role verified: read-only, no BYPASSRLS, no SUPERUSER.';
END $$;
