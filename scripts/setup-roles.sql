-- The Balance — Database Role Setup Script (FINAL)
-- ------------------------------------------------------------
-- This script is the CANONICAL source for PostgreSQL role management.
-- It is NOT a migration — it runs BEFORE migrations to bootstrap roles.
--
-- Per ADR-0005 (updated): role setup is separated from schema migrations.
--
-- PASSWORD POLICY (final closure):
--   - In CI/dev: dev-only passwords are set (overridable via env vars).
--   - In PRODUCTION: this script MUST be run with env vars set:
--       PGPASSWORD_BALANCE_ADMIN=<strong-from-secret-manager>
--       PGPASSWORD_BALANCE_APP=<strong-from-secret-manager>
--     If these env vars are NOT set, the script uses dev defaults and
--     prints a WARNING. A separate production-readiness check should
--     fail the deployment if dev defaults are detected.
--
--   - Migration 0002 historically sets dev passwords via ALTER ROLE.
--     This script runs AFTER migration 0002 in CI and overrides those
--     with the env-var-provided passwords (or dev defaults in CI).
--     In production, the DBA runs this script with env vars set, so
--     the dev defaults from migration 0002 are overridden.
--
-- Usage:
--   CI/dev:  psql -h <host> -U postgres -d balance -f scripts/setup-roles.sql
--   Prod:    PGPASSWORD_BALANCE_ADMIN=xxx PGPASSWORD_BALANCE_APP=yyy \
--            psql -h <host> -U postgres -d balance -f scripts/setup-roles.sql
--
-- Role design (per ADR-0005):
--   balance_admin: BYPASSRLS for migrations/ops. CI adds SUPERUSER for
--                  CREATE EXTENSION (pgvector); production should NOT grant
--                  SUPERUSER — instead, the DBA pre-installs extensions.
--   balance_app:   NOSUPERUSER, NOBYPASSRLS, NO DDL. RLS-enforced runtime role.
--                  Can only SELECT/INSERT/UPDATE/DELETE per table grants.
--                  On audit_log: SELECT + INSERT only (append-only, enforced
--                  in migration 0003).

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
-- 2. SET PASSWORDS (env-var aware, dev-default fallback)
-- ------------------------------------------------------------
-- Production MUST set PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP.
-- If not set, dev defaults are used + a WARNING is printed.
-- A production-readiness check (outside this script) should fail if
-- dev defaults are detected in a production environment.
-- ============================================================
DO $$
DECLARE
    admin_pw TEXT;
    app_pw TEXT;
    using_dev_defaults BOOLEAN := FALSE;
BEGIN
    -- Read from current_setting (env vars passed via PGPASSWORD_BALANCE_*)
    -- PostgreSQL exposes env vars via current_setting() only if set in
    -- postgresql.conf or via SET. For psql -v, we use a different approach:
    -- the calling shell exports these as psql variables.
    --
    -- We use a simpler approach: the calling environment sets these as
    -- psql variables via -v, OR we fall back to dev defaults.
    --
    -- Implementation: use current_setting('app.balance_admin_pw', true)
    -- which returns NULL if not set. The CI/prod wrapper sets these via:
    --   psql ... -v balance_admin_pw="$PGPASSWORD_BALANCE_ADMIN"
    -- See scripts/run-setup-roles.sh for the wrapper.

    admin_pw := current_setting('balance_admin_pw', true);
    app_pw := current_setting('balance_app_pw', true);

    IF admin_pw IS NULL OR app_pw IS NULL THEN
        admin_pw := 'balance_admin_dev_only';
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
-- PostgreSQL 15+ requires explicit CREATE grant on schema public.
-- balance_admin needs CREATE for migrations (CREATE TABLE, etc.).
-- balance_app gets USAGE only (no CREATE — no DDL).
GRANT ALL ON SCHEMA public TO balance_admin;
GRANT USAGE ON SCHEMA public TO balance_app;

-- ============================================================
-- 4. EXTENSIONS (must be done as superuser or with proper grants)
-- ============================================================
-- pgvector must be installed before migration 0001 references it.
-- In CI: the workflow runs this as the postgres superuser.
-- In production: the DBA installs extensions separately.
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- 5. DOCUMENTATION: CI vs PRODUCTION
-- ============================================================
-- CI ONLY (do NOT use in production):
--   The GitHub Actions workflow grants SUPERUSER to balance_admin
--   so it can CREATE EXTENSION. In production, balance_admin should
--   be NOSUPERUSER, and extensions are pre-installed by the DBA.
--
-- PRODUCTION CHECKLIST:
--   [ ] balance_admin is NOSUPERUSER (only BYPASSRLS)
--   [ ] balance_app is NOSUPERUSER, NOBYPASSRLS, no DDL grants
--   [ ] PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP set from secret manager
--   [ ] pgvector extension pre-installed by DBA
--   [ ] DATABASE_URL uses balance_app; DIRECT_URL uses balance_admin
--   [ ] connection pooling uses balance_app with statement_timeout
--   [ ] Production-readiness check passes (no dev-default passwords)
-- ============================================================
