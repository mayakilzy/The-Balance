-- The Balance — Migration 0017: G01 State Builder Bootstrap
-- Mission 01-00: G01 Bootstrap + Country Pack Extension
--
-- This migration:
--   1. Additive extensions to G00 tables (no breaking changes):
--      a. strategies.compositionBatchId (nullable, groups alternatives)
--      b. strategy_versions.metadata (JSONB, provenance — immutable post-approval)
--   2. Extend the approved-version immutability trigger to cover `metadata`
--   3. Create 8 new PRIVATE tables (all tenant-scoped, RLS ENABLE + FORCE):
--      a. objectives               — human-defined goals
--      b. country_pack_configs     — per-tenant planning overlay on a country
--      c. programs                 — reform programs within a strategy version
--      d. projects                 — specific projects within a program
--      e. budget_lines             — cost estimate line items (conditional ranges)
--      f. dependencies             — directed edges between programs
--      g. risk_registers           — risks associated with a strategy version
--      h. assumptions              — assumptions underpinning a strategy version
--   4. RLS policies on all 8 new tables (same pattern as G00's 14 PRIVATE tables)
--   5. Cross-tenant relation triggers (same pattern as G00 migration 0012)
--   6. Verify RLS + grants at the end
--
-- Per ADR-0013 (G01 Domain Model).
-- Per G01 Mission Pack §13 (Corrections 1, 2, 3, A).
--
-- ALL new tables are PRIVATE (tenant-scoped). No PUBLIC tables are created.
-- PUBLIC reference data (countries, institutions, state_hierarchy, role_references,
-- source_registry, public_knowledge) remains in G00 tables — G01 reads them, never
-- duplicates them. A tenant's planning data (objectives, country_pack_configs,
-- programs, etc.) is PRIVATE and never visible to other tenants.

-- ============================================================
-- 1. ADDITIVE EXTENSIONS TO G00 TABLES
-- ============================================================

-- 1a. strategies.compositionBatchId — groups alternatives from the same composer run
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "compositionBatchId" TEXT;
CREATE INDEX IF NOT EXISTS "strategies_tenantId_compositionBatchId_idx"
    ON "strategies"("tenantId", "compositionBatchId")
    WHERE "compositionBatchId" IS NOT NULL;

-- 1b. strategy_versions.metadata — provenance (simulated, provider, composedAt, etc.)
ALTER TABLE "strategy_versions" ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- 2. EXTEND THE APPROVED-VERSION IMMUTABILITY TRIGGER
-- ============================================================
-- G00 migration 0013 created `enforce_approved_version_immutability()` which blocks
-- UPDATE on content/createdBy/createdAt/approvedBy/approvedAt/approvalNotes/versionNumber/
-- strategyId/tenantId for approved versions. We extend it to ALSO block UPDATE on
-- `metadata` — so the provenance record is frozen at approval time, exactly like content.
--
-- This is a clean extension: we replace the function with an augmented version that
-- adds one more column to the immutability check. The trigger itself is unchanged.
-- Drop + recreate is the safest way to update a function body in PostgreSQL.

CREATE OR REPLACE FUNCTION enforce_approved_version_immutability() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'approved' THEN
        -- Allow status change (approved → superseded)
        -- Block changes to ALL other columns INCLUDING metadata (G01 correction 3)
        IF NEW."content" IS DISTINCT FROM OLD."content"
           OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
           OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
           OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
           OR NEW."approvalNotes" IS DISTINCT FROM OLD."approvalNotes"
           OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
           OR NEW."strategyId" IS DISTINCT FROM OLD."strategyId"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."metadata" IS DISTINCT FROM OLD."metadata"
        THEN
            RAISE EXCEPTION
                'Approved strategy version % is immutable — cannot modify content, approval records, or metadata',
                OLD.id
                USING HINT = 'Only status transition (approved → superseded) is allowed. To change an approved strategy, create a new version via createStrategyVersion() then approve it.';
        END IF;

        -- If status is changing, it must be to 'superseded'
        IF NEW.status != 'superseded' AND NEW.status != OLD.status THEN
            RAISE EXCEPTION
                'Approved version status can only transition to superseded, not %',
                NEW.status
                USING HINT = 'Approved versions can only be superseded, not reverted or changed.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger itself is unchanged (migration 0013 created it; we only updated the function body).
-- The existing trigger `approved_version_immutability_check` will call the updated function.

-- ============================================================
-- 3a. OBJECTIVES TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- A human-defined goal for a country (e.g., "reduce unemployment to 10% in 5 years").
-- PRIVATE: each tenant's objectives are isolated via RLS.
-- A tenant's goals are NEVER visible to other tenants (correction A).

CREATE TABLE "objectives" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    -- Target metric (e.g., "unemployment_rate")
    "targetMetric" TEXT NOT NULL,
    -- Target value (e.g., "10" for 10%) — stored as TEXT to support different units
    "targetValue" TEXT NOT NULL,
    -- Horizon in years (e.g., 5 for a 5-year goal)
    "horizon" INTEGER NOT NULL,
    -- Status: draft | active | achieved | abandoned
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "objectives_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "objectives_tenantId_countryId_idx" ON "objectives"("tenantId", "countryId");
CREATE INDEX "objectives_tenantId_status_idx" ON "objectives"("tenantId", "status");

ALTER TABLE "objectives"
    ADD CONSTRAINT "objectives_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "objectives"
    ADD CONSTRAINT "objectives_countryId_fkey"
    FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 3b. COUNTRY_PACK_CONFIGS TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- Per-tenant planning overlay on a country.
-- PRIVATE (correction A): each tenant has its own config for a country.
-- Two tenants in the same country see the same PUBLIC country reference data
-- but DIFFERENT PRIVATE country_pack_configs rows.
--
-- sectors: JSONB array of sectors this tenant tracks (e.g., ["agriculture","finance","health"])
-- observability: JSONB object mapping sector → observability mode (FULL|PARTIAL|LOW)
-- planningAssumptions: JSONB object for tenant-specific planning assumptions

CREATE TABLE "country_pack_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "sectors" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "observability" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "planningAssumptions" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "country_pack_configs_pkey" PRIMARY KEY ("id")
);
-- One config per (tenant, country)
CREATE UNIQUE INDEX "country_pack_configs_tenantId_countryId_key"
    ON "country_pack_configs"("tenantId", "countryId");

ALTER TABLE "country_pack_configs"
    ADD CONSTRAINT "country_pack_configs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "country_pack_configs"
    ADD CONSTRAINT "country_pack_configs_countryId_fkey"
    FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 3c. PROGRAMS TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- A reform program within a strategy version.
-- Programs are expanded in mission 01-04 (Institutional Design).

CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "owningInstitutionId" TEXT,
    "legalMandateRef" TEXT,
    "rationale" TEXT,
    -- Status: draft | proposed | active | completed | retired
    "status" TEXT NOT NULL DEFAULT 'draft',
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "programs_tenantId_strategyVersionId_idx" ON "programs"("tenantId", "strategyVersionId");
CREATE INDEX "programs_tenantId_sector_idx" ON "programs"("tenantId", "sector");

ALTER TABLE "programs"
    ADD CONSTRAINT "programs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "programs"
    ADD CONSTRAINT "programs_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Note: owningInstitutionId references the PUBLIC institutions table, but we don't add a FK
-- constraint because the institution may be from any country. Cross-country validation is
-- enforced at the service layer (mission 01-04).

-- ============================================================
-- 3d. PROJECTS TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- A specific project within a program.

CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    -- Status: draft | planned | active | completed | suspended | cancelled
    "status" TEXT NOT NULL DEFAULT 'draft',
    "startYear" INTEGER,
    "endYear" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "projects_tenantId_programId_idx" ON "projects"("tenantId", "programId");

ALTER TABLE "projects"
    ADD CONSTRAINT "projects_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects"
    ADD CONSTRAINT "projects_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3e. BUDGET_LINES TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- A cost estimate line item for a program.
-- Conditional RANGES (min/max), never point estimates (correction: no fake precision).
-- mission 01-06 (Budget Estimates) populates this.

CREATE TABLE "budget_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "minAmount" DECIMAL(20,2) NOT NULL,
    "maxAmount" DECIMAL(20,2) NOT NULL,
    "horizonYears" INTEGER NOT NULL,
    "assumptions" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "financingSources" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "modelVersion" TEXT NOT NULL DEFAULT 'v1-deterministic',
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_lines_min_le_max" CHECK ("minAmount" <= "maxAmount")
);
CREATE INDEX "budget_lines_tenantId_programId_idx" ON "budget_lines"("tenantId", "programId");

ALTER TABLE "budget_lines"
    ADD CONSTRAINT "budget_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budget_lines"
    ADD CONSTRAINT "budget_lines_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3f. DEPENDENCIES TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- A directed edge between programs (A depends on B).
-- type: requires | enables | conflicts
-- mission 01-05 (Portfolio Graph) populates this + adds cycle detection trigger.

CREATE TABLE "dependencies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromProgramId" TEXT NOT NULL,
    "toProgramId" TEXT NOT NULL,
    -- type: requires | enables | conflicts
    "type" TEXT NOT NULL,
    "rationale" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dependencies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dependencies_no_self_ref" CHECK ("fromProgramId" <> "toProgramId")
);
CREATE INDEX "dependencies_tenantId_fromProgramId_idx" ON "dependencies"("tenantId", "fromProgramId");
CREATE INDEX "dependencies_tenantId_toProgramId_idx" ON "dependencies"("tenantId", "toProgramId");
-- One dependency per (from, to, type) within a tenant
CREATE UNIQUE INDEX "dependencies_tenantId_from_to_type_key"
    ON "dependencies"("tenantId", "fromProgramId", "toProgramId", "type");

ALTER TABLE "dependencies"
    ADD CONSTRAINT "dependencies_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dependencies"
    ADD CONSTRAINT "dependencies_fromProgramId_fkey"
    FOREIGN KEY ("fromProgramId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dependencies"
    ADD CONSTRAINT "dependencies_toProgramId_fkey"
    FOREIGN KEY ("toProgramId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3g. RISK_REGISTERS TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- Risks associated with a strategy version.

CREATE TABLE "risk_registers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    -- severity: low | medium | high | critical
    "severity" TEXT NOT NULL DEFAULT 'medium',
    -- likelihood: low | medium | high
    "likelihood" TEXT NOT NULL DEFAULT 'medium',
    "mitigation" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "risk_registers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "risk_registers_tenantId_strategyVersionId_idx" ON "risk_registers"("tenantId", "strategyVersionId");

ALTER TABLE "risk_registers"
    ADD CONSTRAINT "risk_registers_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "risk_registers"
    ADD CONSTRAINT "risk_registers_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3h. ASSUMPTIONS TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- Assumptions underpinning a strategy version.

CREATE TABLE "assumptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    -- validationMethod: how this assumption can be validated (e.g., "monitor quarterly")
    "validationMethod" TEXT,
    -- status: unverified | validated | invalidated
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assumptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assumptions_tenantId_strategyVersionId_idx" ON "assumptions"("tenantId", "strategyVersionId");

ALTER TABLE "assumptions"
    ADD CONSTRAINT "assumptions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assumptions"
    ADD CONSTRAINT "assumptions_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 4. OWNERSHIP + GRANTS
-- ============================================================
ALTER TABLE "objectives" OWNER TO balance_admin;
ALTER TABLE "country_pack_configs" OWNER TO balance_admin;
ALTER TABLE "programs" OWNER TO balance_admin;
ALTER TABLE "projects" OWNER TO balance_admin;
ALTER TABLE "budget_lines" OWNER TO balance_admin;
ALTER TABLE "dependencies" OWNER TO balance_admin;
ALTER TABLE "risk_registers" OWNER TO balance_admin;
ALTER TABLE "assumptions" OWNER TO balance_admin;

-- balance_app: DML on all 8 new tables (tenant-scoped via RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "objectives", "country_pack_configs", "programs", "projects",
    "budget_lines", "dependencies", "risk_registers", "assumptions"
    TO balance_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO balance_app;

-- ============================================================
-- 5. ROW LEVEL SECURITY (all 8 new tables — PRIVATE, tenant-scoped)
-- ============================================================
-- Same pattern as G00's 14 PRIVATE tables (migrations 0002, 0008, 0012, 0014, 0016).

-- objectives: tenant-scoped
ALTER TABLE "objectives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "objectives" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "objectives";
CREATE POLICY "tenant_isolation_balance_app" ON "objectives"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "objectives";
CREATE POLICY "admin_all_balance_admin" ON "objectives"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- country_pack_configs: tenant-scoped
ALTER TABLE "country_pack_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "country_pack_configs" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "country_pack_configs";
CREATE POLICY "tenant_isolation_balance_app" ON "country_pack_configs"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "country_pack_configs";
CREATE POLICY "admin_all_balance_admin" ON "country_pack_configs"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- programs: tenant-scoped
ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "programs" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "programs";
CREATE POLICY "tenant_isolation_balance_app" ON "programs"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "programs";
CREATE POLICY "admin_all_balance_admin" ON "programs"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- projects: tenant-scoped
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "projects";
CREATE POLICY "tenant_isolation_balance_app" ON "projects"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "projects";
CREATE POLICY "admin_all_balance_admin" ON "projects"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- budget_lines: tenant-scoped
ALTER TABLE "budget_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_lines" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "budget_lines";
CREATE POLICY "tenant_isolation_balance_app" ON "budget_lines"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "budget_lines";
CREATE POLICY "admin_all_balance_admin" ON "budget_lines"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- dependencies: tenant-scoped
ALTER TABLE "dependencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dependencies" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "dependencies";
CREATE POLICY "tenant_isolation_balance_app" ON "dependencies"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "dependencies";
CREATE POLICY "admin_all_balance_admin" ON "dependencies"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- risk_registers: tenant-scoped
ALTER TABLE "risk_registers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "risk_registers" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "risk_registers";
CREATE POLICY "tenant_isolation_balance_app" ON "risk_registers"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "risk_registers";
CREATE POLICY "admin_all_balance_admin" ON "risk_registers"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- assumptions: tenant-scoped
ALTER TABLE "assumptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assumptions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "assumptions";
CREATE POLICY "tenant_isolation_balance_app" ON "assumptions"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "assumptions";
CREATE POLICY "admin_all_balance_admin" ON "assumptions"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 6. CROSS-TENANT RELATION TRIGGERS (same pattern as G00 migration 0012)
-- ============================================================
-- Prevent child rows from pointing to a parent in a different tenant.
-- These triggers complement RLS: even if RLS were misconfigured, the trigger
-- would still reject the cross-tenant reference.

-- programs.strategyVersionId must be in the same tenant
CREATE OR REPLACE FUNCTION enforce_program_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "strategy_versions"
        WHERE id = NEW."strategyVersionId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Program tenant mismatch: strategy version % is not in tenant %',
            NEW."strategyVersionId", NEW."tenantId"
            USING HINT = 'Program must be in the same tenant as its strategy version.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "program_tenant_check" ON "programs";
CREATE TRIGGER "program_tenant_check"
    BEFORE INSERT OR UPDATE OF "strategyVersionId", "tenantId" ON "programs"
    FOR EACH ROW EXECUTE FUNCTION enforce_program_same_tenant();

-- projects.programId must be in the same tenant
CREATE OR REPLACE FUNCTION enforce_project_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "programs" WHERE id = NEW."programId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Project tenant mismatch: program % is not in tenant %',
            NEW."programId", NEW."tenantId"
            USING HINT = 'Project must be in the same tenant as its program.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_tenant_check" ON "projects";
CREATE TRIGGER "project_tenant_check"
    BEFORE INSERT OR UPDATE OF "programId", "tenantId" ON "projects"
    FOR EACH ROW EXECUTE FUNCTION enforce_project_same_tenant();

-- budget_lines.programId must be in the same tenant
CREATE OR REPLACE FUNCTION enforce_budget_line_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "programs" WHERE id = NEW."programId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Budget line tenant mismatch: program % is not in tenant %',
            NEW."programId", NEW."tenantId"
            USING HINT = 'Budget line must be in the same tenant as its program.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "budget_line_tenant_check" ON "budget_lines";
CREATE TRIGGER "budget_line_tenant_check"
    BEFORE INSERT OR UPDATE OF "programId", "tenantId" ON "budget_lines"
    FOR EACH ROW EXECUTE FUNCTION enforce_budget_line_same_tenant();

-- dependencies: fromProgramId + toProgramId must both be in the same tenant as the dependency row
CREATE OR REPLACE FUNCTION enforce_dependency_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "programs" WHERE id = NEW."fromProgramId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Dependency tenant mismatch: fromProgram % is not in tenant %',
            NEW."fromProgramId", NEW."tenantId"
            USING HINT = 'Dependency fromProgram must be in the same tenant as the dependency.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "programs" WHERE id = NEW."toProgramId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Dependency tenant mismatch: toProgram % is not in tenant %',
            NEW."toProgramId", NEW."tenantId"
            USING HINT = 'Dependency toProgram must be in the same tenant as the dependency.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "dependency_tenant_check" ON "dependencies";
CREATE TRIGGER "dependency_tenant_check"
    BEFORE INSERT OR UPDATE OF "fromProgramId", "toProgramId", "tenantId" ON "dependencies"
    FOR EACH ROW EXECUTE FUNCTION enforce_dependency_same_tenant();

-- risk_registers.strategyVersionId must be in the same tenant
CREATE OR REPLACE FUNCTION enforce_risk_register_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "strategy_versions"
        WHERE id = NEW."strategyVersionId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Risk register tenant mismatch: strategy version % is not in tenant %',
            NEW."strategyVersionId", NEW."tenantId"
            USING HINT = 'Risk register must be in the same tenant as its strategy version.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "risk_register_tenant_check" ON "risk_registers";
CREATE TRIGGER "risk_register_tenant_check"
    BEFORE INSERT OR UPDATE OF "strategyVersionId", "tenantId" ON "risk_registers"
    FOR EACH ROW EXECUTE FUNCTION enforce_risk_register_same_tenant();

-- assumptions.strategyVersionId must be in the same tenant
CREATE OR REPLACE FUNCTION enforce_assumption_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "strategy_versions"
        WHERE id = NEW."strategyVersionId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Assumption tenant mismatch: strategy version % is not in tenant %',
            NEW."strategyVersionId", NEW."tenantId"
            USING HINT = 'Assumption must be in the same tenant as its strategy version.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "assumption_tenant_check" ON "assumptions";
CREATE TRIGGER "assumption_tenant_check"
    BEFORE INSERT OR UPDATE OF "strategyVersionId", "tenantId" ON "assumptions"
    FOR EACH ROW EXECUTE FUNCTION enforce_assumption_same_tenant();

-- ============================================================
-- 7. VERIFY
-- ============================================================
DO $$
DECLARE
    rls_ok BOOLEAN;
    new_tables TEXT[] := ARRAY[
        'objectives', 'country_pack_configs', 'programs', 'projects',
        'budget_lines', 'dependencies', 'risk_registers', 'assumptions'
    ];
    t_name TEXT;
    col_exists BOOLEAN;
BEGIN
    -- RLS enabled + forced on all 8 new tables
    FOREACH t_name IN ARRAY new_tables LOOP
        SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
        FROM pg_class c WHERE c.relname = t_name;
        IF NOT rls_ok THEN
            RAISE EXCEPTION 'RLS not FORCE-enabled on %', t_name;
        END IF;
    END LOOP;

    -- Verify the two additive columns exist on G00 tables
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'strategies' AND column_name = 'compositionBatchId'
    ) INTO col_exists;
    IF NOT col_exists THEN
        RAISE EXCEPTION 'strategies.compositionBatchId column missing';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'strategy_versions' AND column_name = 'metadata'
    ) INTO col_exists;
    IF NOT col_exists THEN
        RAISE EXCEPTION 'strategy_versions.metadata column missing';
    END IF;

    -- Verify the immutability trigger function references metadata
    SELECT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'enforce_approved_version_immutability'
        AND prosrc LIKE '%metadata%'
    ) INTO col_exists;
    IF NOT col_exists THEN
        RAISE EXCEPTION 'Immutability trigger function does not reference metadata column';
    END IF;

    RAISE NOTICE 'G01 State Builder bootstrap: 8 new PRIVATE tables + 2 additive columns + immutability extension. RLS enforced on all new tables.';
END $$;
