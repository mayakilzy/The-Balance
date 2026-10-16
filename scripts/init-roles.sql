-- The Balance — PostgreSQL init script (runs once on container creation)
-- Creates the balance_admin + balance_app roles for local dev.
-- In CI, the workflow creates these roles explicitly via psql.

-- balance_admin: BYPASSRLS, used for migrations + seed
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_admin') THEN
        CREATE ROLE balance_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION BYPASSRLS PASSWORD 'balance_admin_dev_only';
    END IF;
END $$;

-- balance_app: RLS-enforced, used by app runtime + tests
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_app') THEN
        CREATE ROLE balance_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'balance_app_dev_only';
    END IF;
END $$;

-- Grant schema usage (tables are created + granted by migrations)
-- PostgreSQL 15+ requires explicit CREATE grant on schema public.
GRANT ALL ON SCHEMA public TO balance_admin;
GRANT USAGE ON SCHEMA public TO balance_app;
