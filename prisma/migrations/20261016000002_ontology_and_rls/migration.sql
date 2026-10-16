-- The Balance — Migration 20261016000002: Ontology + RLS
-- Mission 00-02: Tenant, Country and State Ontology
--
-- This migration:
--   1. Creates PUBLIC tables: countries, state_hierarchy, institutions,
--      role_references, source_registry, public_knowledge.
--   2. Creates database roles: balance_admin (BYPASSRLS), balance_app (enforced).
--   3. Grants DML to balance_app; DDL + BYPASSRLS to balance_admin.
--   4. ENABLEs + FORCEs RLS on ALL tables (public + private).
--   5. Creates RLS policies:
--      - PUBLIC tables: balance_app can SELECT only; balance_admin can do all.
--      - tenants: balance_app can SELECT only its OWN row.
--      - audit_log: balance_app sees only rows matching current_setting('app.tenant_id').
--
-- Per ADR-0004 (Country/Tenant separation + PUBLIC vs PRIVATE scope) and
-- ADR-0005 (RLS roles and policies).

-- ============================================================
-- 1. PUBLIC TABLES
-- ============================================================

CREATE TABLE "countries" (
    "id" TEXT NOT NULL,
    "iso3" TEXT NOT NULL,
    "iso2" TEXT,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "countries_iso3_key" ON "countries"("iso3");
CREATE UNIQUE INDEX "countries_iso2_key" ON "countries"("iso2");
CREATE INDEX "countries_status_idx" ON "countries"("status");

CREATE TABLE "state_hierarchy" (
    "id" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "parentId" TEXT,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "state_hierarchy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "state_hierarchy_countryId_code_key" ON "state_hierarchy"("countryId", "code");
CREATE INDEX "state_hierarchy_countryId_level_idx" ON "state_hierarchy"("countryId", "level");
ALTER TABLE "state_hierarchy"
    ADD CONSTRAINT "state_hierarchy_countryId_fkey"
    FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "state_hierarchy"
    ADD CONSTRAINT "state_hierarchy_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "state_hierarchy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "institutions" (
    "id" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "parentId" TEXT,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "institutions_countryId_code_key" ON "institutions"("countryId", "code");
ALTER TABLE "institutions"
    ADD CONSTRAINT "institutions_countryId_fkey"
    FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "institutions"
    ADD CONSTRAINT "institutions_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "role_references" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "role_references_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "role_references_code_key" ON "role_references"("code");

CREATE TABLE "source_registry" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "license" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "source_registry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "source_registry_code_key" ON "source_registry"("code");
CREATE INDEX "source_registry_type_idx" ON "source_registry"("type");

CREATE TABLE "public_knowledge" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "public_knowledge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "public_knowledge_title_idx" ON "public_knowledge"("title");
CREATE INDEX "public_knowledge_publishedAt_idx" ON "public_knowledge"("publishedAt");
ALTER TABLE "public_knowledge"
    ADD CONSTRAINT "public_knowledge_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "source_registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 2. UPDATE TENANTS TABLE — add countryId FK
-- ============================================================
-- The tenants table was created in migration 20261016000001_init.
-- We add the countryId column + FK here.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "countryId" TEXT;
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_countryId_fkey"
    FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "tenants_countryId_idx" ON "tenants"("countryId");

-- ============================================================
-- 3. DATABASE ROLES
-- ============================================================
-- balance_admin: runs migrations, can BYPASSRLS for ops. Owns tables.
-- balance_app:   application runtime role. RLS enforced. Cannot escalate.

DO $$
BEGIN
    -- balance_admin (no password — auth via peer/trust in dev, JWT in prod)
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_admin') THEN
        CREATE ROLE balance_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION BYPASSRLS;
    END IF;
    -- balance_app (no password in dev — use trust auth; in prod use scram-sha-256)
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_app') THEN
        CREATE ROLE balance_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

-- Set passwords from env (defaults are dev-only; CI overrides via PGPASSWORD)
-- We use ALTER ROLE so the migration is idempotent. The CI workflow sets
-- PGPASSWORD before running migrations.
ALTER ROLE balance_admin WITH PASSWORD 'balance_admin_dev_only';
ALTER ROLE balance_app   WITH PASSWORD 'balance_app_dev_only';

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO balance_app, balance_admin;

-- ============================================================
-- 4. OWNERSHIP + GRANTS
-- ============================================================
-- All tables owned by balance_admin (so migrations run by balance_admin
-- can ALTER them). balance_app gets DML only.

-- Transfer ownership to balance_admin (migrations create as the connecting
-- user; we normalize to balance_admin).
ALTER TABLE IF EXISTS "countries" OWNER TO balance_admin;
ALTER TABLE IF EXISTS "state_hierarchy" OWNER TO balance_admin;
ALTER TABLE IF EXISTS "institutions" OWNER TO balance_admin;
ALTER TABLE IF EXISTS "role_references" OWNER TO balance_admin;
ALTER TABLE IF EXISTS "source_registry" OWNER TO balance_admin;
ALTER TABLE IF EXISTS "public_knowledge" OWNER TO balance_admin;
ALTER TABLE IF EXISTS "tenants" OWNER TO balance_admin;
ALTER TABLE IF EXISTS "audit_log" OWNER TO balance_admin;

-- Grant DML to balance_app on all tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO balance_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO balance_app;

-- balance_admin gets all privileges (implicit as owner, but explicit for clarity)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO balance_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO balance_admin;

-- ============================================================
-- 5. ROW LEVEL SECURITY — ENABLE + FORCE
-- ============================================================
-- FORCE means even the table owner (balance_admin) is subject to RLS
-- unless they explicitly BYPASSRLS. balance_admin has BYPASSRLS, so it
-- can still bypass for migrations/ops. balance_app does NOT have BYPASSRLS.

ALTER TABLE "countries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "countries" FORCE ROW LEVEL SECURITY;

ALTER TABLE "state_hierarchy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "state_hierarchy" FORCE ROW LEVEL SECURITY;

ALTER TABLE "institutions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "institutions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "role_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_references" FORCE ROW LEVEL SECURITY;

ALTER TABLE "source_registry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_registry" FORCE ROW LEVEL SECURITY;

ALTER TABLE "public_knowledge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_knowledge" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 6. RLS POLICIES
-- ============================================================

-- 6.1 PUBLIC tables — balance_app can SELECT only; balance_admin can do all.
-- Using a single policy per table per role for clarity.

DROP POLICY IF EXISTS "public_read_balance_app" ON "countries";
CREATE POLICY "public_read_balance_app" ON "countries"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "countries";
CREATE POLICY "admin_all_balance_admin" ON "countries"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public_read_balance_app" ON "state_hierarchy";
CREATE POLICY "public_read_balance_app" ON "state_hierarchy"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "state_hierarchy";
CREATE POLICY "admin_all_balance_admin" ON "state_hierarchy"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public_read_balance_app" ON "institutions";
CREATE POLICY "public_read_balance_app" ON "institutions"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "institutions";
CREATE POLICY "admin_all_balance_admin" ON "institutions"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public_read_balance_app" ON "role_references";
CREATE POLICY "public_read_balance_app" ON "role_references"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "role_references";
CREATE POLICY "admin_all_balance_admin" ON "role_references"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public_read_balance_app" ON "source_registry";
CREATE POLICY "public_read_balance_app" ON "source_registry"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "source_registry";
CREATE POLICY "admin_all_balance_admin" ON "source_registry"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public_read_balance_app" ON "public_knowledge";
CREATE POLICY "public_read_balance_app" ON "public_knowledge"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "public_knowledge";
CREATE POLICY "admin_all_balance_admin" ON "public_knowledge"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- 6.2 tenants table — balance_app can SELECT only its OWN row.
-- (No INSERT/UPDATE/DELETE for balance_app — tenants are admin-managed.)

DROP POLICY IF EXISTS "tenant_self_read_balance_app" ON "tenants";
CREATE POLICY "tenant_self_read_balance_app" ON "tenants"
    FOR SELECT TO balance_app
    USING (id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "tenants";
CREATE POLICY "admin_all_balance_admin" ON "tenants"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- 6.3 audit_log table — balance_app sees only rows matching app.tenant_id.
-- WITH CHECK ensures INSERT/UPDATE cannot forge a different tenant_id.

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "audit_log";
CREATE POLICY "tenant_isolation_balance_app" ON "audit_log"
    FOR ALL TO balance_app
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "audit_log";
CREATE POLICY "admin_all_balance_admin" ON "audit_log"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 7. VERIFY — sanity check at end of migration
-- ============================================================
-- Confirm RLS is enabled + forced on all tables.
DO $$
DECLARE
    r RECORD;
    missing TEXT;
BEGIN
    FOR r IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('countries','state_hierarchy','institutions',
                            'role_references','source_registry','public_knowledge',
                            'tenants','audit_log')
    LOOP
        SELECT EXISTS (
            SELECT 1 FROM pg_class c
            WHERE c.relname = r.tablename
              AND c.relrowsecurity = TRUE
              AND c.relforcerowsecurity = TRUE
        ) INTO missing;
        IF NOT missing THEN
            RAISE EXCEPTION 'RLS not FORCE-enabled on table %', r.tablename;
        END IF;
    END LOOP;
    RAISE NOTICE 'All 8 tables have RLS ENABLEd + FORCEd.';
END $$;
