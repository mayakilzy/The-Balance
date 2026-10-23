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
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_auth') THEN
        CREATE ROLE balance_auth WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    -- G03-06 Trust Boundary Closure (Migration 32): privileged role for
    -- snapshot approval. LOGIN role with separate credentials — the app
    -- uses this for the privileged UPDATE on shared_snapshots.
    -- balance_app is NOT a member and cannot SET ROLE to it.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_snapshot_approver') THEN
        CREATE ROLE balance_snapshot_approver WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
    -- D05 Final Closure (Migration 34): pre-auth security logger.
    -- LOGIN role with separate credentials, INSERT-only on audit_log,
    -- RLS-enforced (tenantId IS NULL). Used ONLY for writing pre-auth
    -- security events (signin attempts, rate-limit hits, health-check).
    -- balance_app CANNOT SET ROLE to it (no membership).
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_security_logger') THEN
        CREATE ROLE balance_security_logger WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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
ALTER ROLE balance_auth  WITH PASSWORD :'balance_auth_pw';
ALTER ROLE balance_snapshot_approver WITH PASSWORD :'balance_snapshot_approver_pw';
ALTER ROLE balance_security_logger  WITH PASSWORD :'balance_security_logger_pw';

-- ============================================================
-- 3. SCHEMA PRIVILEGES
-- ============================================================
GRANT ALL ON SCHEMA public TO balance_admin;
GRANT USAGE ON SCHEMA public TO balance_app;
GRANT USAGE ON SCHEMA public TO balance_auth;
GRANT USAGE ON SCHEMA public TO balance_snapshot_approver;
GRANT USAGE ON SCHEMA public TO balance_security_logger;

-- ============================================================
-- 4. EXTENSIONS (must be done as superuser)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- 5. PRODUCTION CHECKLIST (see ADR-0005)
-- ============================================================
