-- The Balance — Docker Compose init script (runs once on container creation)
-- ------------------------------------------------------------
-- Simplified version for local dev: creates roles with dev-only passwords.
-- For production, use scripts/setup-roles.sql via scripts/run-setup-roles.sh
-- with PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP env vars set.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_admin') THEN
        CREATE ROLE balance_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION BYPASSRLS PASSWORD 'balance_admin_dev_only';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_app') THEN
        CREATE ROLE balance_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'balance_app_dev_only';
    END IF;
END $$;

-- PostgreSQL 15+ requires explicit CREATE grant on schema public.
GRANT ALL ON SCHEMA public TO balance_admin;
GRANT USAGE ON SCHEMA public TO balance_app;

-- Pre-create pgvector extension (docker-compose runs as postgres superuser)
CREATE EXTENSION IF NOT EXISTS "vector";
