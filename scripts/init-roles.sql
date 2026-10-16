-- The Balance — Database Role Setup Script
-- ------------------------------------------------------------
-- This script is the CANONICAL source for PostgreSQL role management.
-- It is NOT a migration — it runs BEFORE migrations to bootstrap roles.
--
-- Per ADR-0005 (updated): role setup is separated from schema migrations.
-- Migration 0002 historically created roles; going forward, this script
-- is the single source of truth.
--
-- Usage:
--   psql -h <host> -U postgres -d balance -f scripts/setup-roles.sql
--
-- Production deployment:
--   1. DBA runs this script with PASSWORD overrides via environment.
--   2. DBA rotates the dev-only passwords set in migration 0002.
--   3. The application connects as balance_app; migrations run as balance_admin.
--
-- CI usage:
--   The GitHub Actions workflow runs this script (with PGPASSWORD=postgres)
--   before running prisma migrate deploy.
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
-- 2. SET PASSWORDS
-- ------------------------------------------------------------
-- DEV/CI: use known dev passwords (overridden below for CI).
-- PRODUCTION: DBA MUST override these with strong passwords set out-of-band.
-- The dev passwords here are intentionally weak and documented as dev-only.
--
-- To override in production:
--   ALTER ROLE balance_admin WITH PASSWORD '<strong-from-secret-manager>';
--   ALTER ROLE balance_app   WITH PASSWORD '<strong-from-secret-manager>';
-- ============================================================
ALTER ROLE balance_admin WITH PASSWORD 'balance_admin_dev_only';
ALTER ROLE balance_app   WITH PASSWORD 'balance_app_dev_only';

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
-- ------------------------------------------------------------
-- pgvector must be installed before migration 0001 references it.
-- In CI: the workflow runs this as the postgres superuser.
-- In production: the DBA installs extensions separately.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- 5. POST-MIGRATION GRANTS (run AFTER migrations)
-- ------------------------------------------------------------
-- These are also in migration 0002, but we re-run them here so the
-- script is the canonical source. Migrations + this script are
-- idempotent.
--
-- NOTE: Table-level DML grants are set in migration 0002.
-- This script only handles roles + schema + extensions.
-- ============================================================

-- ============================================================
-- 6. DOCUMENTATION: CI vs PRODUCTION
-- ------------------------------------------------------------
-- CI ONLY (do NOT use in production):
--   The GitHub Actions workflow grants SUPERUSER to balance_admin
--   so it can CREATE EXTENSION. In production, balance_admin should
--   be NOSUPERUSER, and extensions are pre-installed by the DBA.
--
-- PRODUCTION CHECKLIST:
--   [ ] balance_admin is NOSUPERUSER (only BYPASSRLS)
--   [ ] balance_app is NOSUPERUSER, NOBYPASSRLS, no DDL grants
--   [ ] Passwords rotated from dev defaults
--   [ ] pgvector extension pre-installed by DBA
--   [ ] DATABASE_URL uses balance_app; DIRECT_URL uses balance_admin
--   [ ] connection pooling uses balance_app with statement_timeout
-- ============================================================
