-- The Balance — Database Role Setup Script (FINAL, password-fix)
-- ------------------------------------------------------------
-- This script is the CANONICAL source for PostgreSQL role management.
-- It is NOT a migration — it runs BEFORE migrations to bootstrap roles.
--
-- PASSWORD MECHANISM (fixed in 00-03):
--   The wrapper script (run-setup-roles.sh) loads env vars into psql
--   variables via \set. This script reads them via psql's variable
--   substitution syntax (:'var'), NOT via current_setting().
--
--   Why NOT current_setting():
--   - psql -v variables are client-side; they do NOT become PostgreSQL
--     session GUCs automatically.
--   - current_setting('var', true) reads GUCs, not psql variables.
--   - So the old code silently fell back to dev defaults even when
--     env vars were set.
--
--   Why :'var' (psql substitution):
--   - psql substitutes :'var' with a properly-quoted string literal
--     BEFORE sending SQL to the server.
--   - The password does not appear in PostgreSQL server logs (only
--     in the SQL text, which psql doesn't log by default).
--   - The password does not appear in process listings (it's in a
--     psql variable, not the command line).
--
--   Fallback: if a psql variable is not set (empty), the script uses
--   dev defaults and prints a WARNING.
--
-- Usage:
--   CI/dev:  bash scripts/run-setup-roles.sh
--   Prod:    PGPASSWORD_BALANCE_ADMIN=xxx PGPASSWORD_BALANCE_APP=yyy \
--            bash scripts/run-setup-roles.sh

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
-- 2. SET PASSWORDS (psql variable substitution)
-- ------------------------------------------------------------
-- The wrapper loads env vars into psql variables:
--   \set balance_admin_pw `printf '%s' "$PGPASSWORD_BALANCE_ADMIN"`
--   \set balance_app_pw   `printf '%s' "$PGPASSWORD_BALANCE_APP"`
--
-- Here we read them via :'var' syntax. If the variable is empty
-- (not set or empty string), we fall back to dev defaults.
--
-- The :- syntax: :'var' produces the variable value or empty string.
-- We use a CASE to detect empty and fall back.
-- ============================================================

-- Detect if psql variables are set; fall back to dev defaults if not.
-- NOTE: :'var' substitution happens at psql layer; we cannot use IFNULL
-- because the substitution already occurred. Instead, we use a DO block
-- that receives the substituted values as string literals.

DO $$
DECLARE
    -- :'var' is substituted by psql before reaching the server.
    -- If the psql variable is unset, :'var' produces '' (empty string).
    admin_pw TEXT := :'balance_admin_pw';
    app_pw TEXT := :'balance_app_pw';
    using_dev_defaults BOOLEAN := FALSE;
BEGIN
    IF admin_pw IS NULL OR admin_pw = '' THEN
        admin_pw := 'balance_admin_dev_only';
        using_dev_defaults := TRUE;
    END IF;
    IF app_pw IS NULL OR app_pw = '' THEN
        app_pw := 'balance_app_dev_only';
        using_dev_defaults := TRUE;
    END IF;

    EXECUTE format('ALTER ROLE balance_admin WITH PASSWORD %L', admin_pw);
    EXECUTE format('ALTER ROLE balance_app   WITH PASSWORD %L', app_pw);

    IF using_dev_defaults THEN
        RAISE WARNING 'Using DEV-DEFAULT passwords for balance_admin/balance_app. NOT FOR PRODUCTION.';
        RAISE WARNING 'Set PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP env vars for production.';
    ELSE
        RAISE NOTICE 'Passwords set from env vars (production-safe).';
    END IF;
END $$;

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
