-- The Balance — Database Role Setup Script (FINAL, password-fix v2)
-- ------------------------------------------------------------
-- PASSWORD MECHANISM (fixed):
--   The wrapper (run-setup-roles.sh) handles fallback to dev defaults.
--   This script receives NON-EMPTY psql variables via \set.
--   :'var' produces a quoted string literal, used directly in ALTER ROLE.
--
--   No fallback logic here — the wrapper guarantees non-empty values.

-- ============================================================
-- 1. CREATE ROLES (idempotent)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_admin') THEN
        CREATE ROLE balance_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_app') THEN
        CREATE ROLE balance_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

-- ============================================================
-- 2. SET PASSWORDS (psql variable substitution, plain SQL)
-- ------------------------------------------------------------
-- :'var' produces a quoted string literal like 'value'.
-- The wrapper guarantees non-empty values (fallback in bash).
-- ============================================================
ALTER ROLE balance_admin WITH PASSWORD :'balance_admin_pw';
ALTER ROLE balance_app   WITH PASSWORD :'balance_app_pw';

-- ============================================================
-- 3. SCHEMA PRIVILEGES
-- ============================================================
GRANT ALL ON SCHEMA public TO balance_admin;
GRANT USAGE ON SCHEMA public TO balance_app;

-- ============================================================
-- 4. EXTENSIONS (must be done as superuser)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- 5. PRODUCTION CHECKLIST (see ADR-0005)
-- ============================================================
