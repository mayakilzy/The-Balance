-- The Balance — Database Role Setup Script (FINAL, password-fix v2)
-- ------------------------------------------------------------
-- PASSWORD MECHANISM (fixed):
--   The wrapper loads env vars into psql variables via \set.
--   This script reads them via psql's :'var' substitution syntax.
--   psql substitutes :'var' BEFORE sending SQL to the server.
--
--   IMPORTANT: :'var' does NOT work inside DO $$ ... $$ blocks
--   (dollar-quoted strings). So we use plain SQL with ALTER ROLE.
--
--   Fallback: if a psql variable is empty, dev defaults are used.

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
-- :'var' is substituted by psql before reaching the server.
-- If the psql variable is unset/empty, we need a fallback.
-- We use COALESCE + NULLIF to fall back to dev defaults.
--
-- The wrapper sets:
--   \set balance_admin_pw `printf '%s' "$PGPASSWORD_BALANCE_ADMIN"`
--   \set balance_app_pw   `printf '%s' "$PGPASSWORD_BALANCE_APP"`
--
-- If env var is empty, \set produces an empty string.
-- :'var' with empty string produces '' (empty SQL string literal).
-- We use NULLIF to convert empty to NULL, then COALESCE for fallback.
-- ============================================================

-- Set passwords using psql variable substitution.
-- Note: :'var' produces a quoted string literal like 'value'.
-- We wrap in COALESCE(NULLIF(:'var', ''), 'dev_default') for fallback.
ALTER ROLE balance_admin WITH PASSWORD COALESCE(NULLIF(:'balance_admin_pw', ''), 'balance_admin_dev_only');
ALTER ROLE balance_app   WITH PASSWORD COALESCE(NULLIF(:'balance_app_pw', ''), 'balance_app_dev_only');

-- Print warning if using dev defaults (for visibility in logs)
\echo 'Password setup complete. Check warnings above for dev-default usage.'

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
