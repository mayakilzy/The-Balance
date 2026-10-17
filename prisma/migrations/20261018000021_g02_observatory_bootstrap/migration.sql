-- The Balance — Migration 0021: G02 State Observatory Bootstrap
-- Mission 02-00: G02 Bootstrap (Vertical Slice)
--
-- This migration creates 5 new PRIVATE tables (all tenant-scoped, RLS ENABLE + FORCE):
--   a. indicator_definitions  — KPI definitions linked to approved StrategyVersion
--   b. observation_periods    — temporal periods for measurements
--   c. observations           — actual measurements (append-only with correction chains)
--   d. variance_records       — planned vs actual variance computations
--   e. alerts                 — human-actionable alerts (lifecycle separated from execution)
--
-- Per REV-5 FINAL CORRECTED MISSION spec:
--   - Q1-Q15 (architecture) + R1-R5 (refinements) + E1-E8 (execution) + F1-F6 (final fixes)
--   - All 34 decisions frozen.
--
-- Key invariants enforced by this migration:
--   F1: Partial unique index on observations uses COALESCE(geo_ref_id, '') to protect
--       NULL geo_ref_id (national-level indicators have geoRefId = NULL).
--   F2: correctObservation transaction order is enforced by the application layer
--       (lock → deactivate old → insert new → link → audit) and protected by the
--       partial unique index below.
--   F3: Chain integrity trigger forbids branching (target.superseded_by_id must be
--       NULL), cycles, self-reference, and mismatched indicator+period+geo.
--   F4: variance_records.planned_value_source_kind and planned_value_source_id are
--       NULLABLE (null when planned_value_type = 'none').
--   F6: alerts.execution_verified_action is a separate field describing the SPECIFIC
--       action verified (not a policy outcome).
--
-- All 5 new tables are PRIVATE (tenant-scoped). No PUBLIC tables are created.
-- PUBLIC reference data (countries, sources, evidence, etc.) remains in G00 tables.

-- ============================================================
-- 1. CREATE 5 NEW TABLES
-- ============================================================

-- 1a. indicator_definitions — KPI definitions
CREATE TABLE "indicator_definitions" (
    "id"                        TEXT NOT NULL,
    "tenantId"                  TEXT NOT NULL,
    "code"                      TEXT NOT NULL,
    "displayName"               TEXT NOT NULL,
    "description"               TEXT,
    "unit"                      TEXT NOT NULL,
    "formula"                   TEXT,
    "preferredDirection"        TEXT NOT NULL,
    "preferredDirectionRationale" TEXT,
    "geographicLevels"          JSONB NOT NULL DEFAULT '[]'::jsonb,
    "coverage"                  TEXT,
    "frequency"                 TEXT,
    "methodologyDate"           TIMESTAMP(3),
    "measurementConstraints"    JSONB NOT NULL DEFAULT '{}'::jsonb,
    "uncertaintyMethod"         TEXT,
    "usedBy"                    JSONB NOT NULL DEFAULT '[]'::jsonb,
    "objectiveId"               TEXT,
    "programId"                 TEXT,
    "strategyVersionId"         TEXT,
    "defaultTargetValue"        DECIMAL(20,4),
    "targetTimeHorizon"         TEXT NOT NULL DEFAULT 'annual',
    "periodMilestones"          JSONB NOT NULL DEFAULT '[]'::jsonb,
    "alertThresholds"           JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status"                    TEXT NOT NULL DEFAULT 'draft',
    "createdBy"                 TEXT NOT NULL,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indicator_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "indicator_definitions_tenantId_code_key"
    ON "indicator_definitions"("tenantId", "code");
CREATE INDEX "indicator_definitions_tenantId_status_idx"
    ON "indicator_definitions"("tenantId", "status");
CREATE INDEX "indicator_definitions_tenantId_strategyVersionId_idx"
    ON "indicator_definitions"("tenantId", "strategyVersionId");
CREATE INDEX "indicator_definitions_tenantId_objectiveId_idx"
    ON "indicator_definitions"("tenantId", "objectiveId");

-- 1b. observation_periods — temporal periods
CREATE TABLE "observation_periods" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "periodType"  TEXT NOT NULL,
    "periodValue" TEXT NOT NULL,
    "startAt"     TIMESTAMP(3) NOT NULL,
    "endAt"       TIMESTAMP(3) NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'open',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observation_periods_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "observation_periods_tenantId_periodType_periodValue_key"
    ON "observation_periods"("tenantId", "periodType", "periodValue");
CREATE INDEX "observation_periods_tenantId_status_idx"
    ON "observation_periods"("tenantId", "status");

-- 1c. observations — actual measurements (append-only with correction chains)
CREATE TABLE "observations" (
    "id"                      TEXT NOT NULL,
    "tenantId"                TEXT NOT NULL,
    "indicatorDefinitionId"   TEXT NOT NULL,
    "strategyVersionId"       TEXT,
    "observationPeriodId"     TEXT NOT NULL,
    "observedValue"           DECIMAL(20,4),
    "originType"              TEXT NOT NULL,
    "verificationStatus"      TEXT NOT NULL DEFAULT 'unverified',
    "derivationMethod"        TEXT,
    "sourceId"                TEXT,
    "evidenceId"              TEXT,
    "isSynthetic"             BOOLEAN NOT NULL DEFAULT true,
    "observedAt"              TIMESTAMP(3),
    "retrievedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualityNotes"            JSONB NOT NULL DEFAULT '{}'::jsonb,
    "geoLevel"                TEXT NOT NULL DEFAULT 'national',
    "geoRefId"                TEXT,
    "supersedesId"            TEXT,
    "supersededById"          TEXT,
    "correctionReason"        TEXT,
    "correctedById"           TEXT,
    "correctedAt"             TIMESTAMP(3),
    "isCurrent"               BOOLEAN NOT NULL DEFAULT true,
    "createdBy"               TEXT NOT NULL,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "observations_current_idx"
    ON "observations"("tenantId", "indicatorDefinitionId", "observationPeriodId", "isCurrent");
CREATE INDEX "observations_geo_current_idx"
    ON "observations"("tenantId", "indicatorDefinitionId", "observationPeriodId", "geoLevel", "geoRefId", "isCurrent");
CREATE INDEX "observations_supersedes_idx"
    ON "observations"("tenantId", "supersedesId");

-- supersedesId is unique (one successor per observation) — supports 1:1 self-relation
CREATE UNIQUE INDEX "observations_supersedesId_key"
    ON "observations"("supersedesId")
    WHERE "supersedesId" IS NOT NULL;

-- 1d. variance_records — planned vs actual computations
CREATE TABLE "variance_records" (
    "id"                       TEXT NOT NULL,
    "tenantId"                 TEXT NOT NULL,
    "strategyVersionId"        TEXT NOT NULL,
    "indicatorDefinitionId"    TEXT NOT NULL,
    "observationPeriodId"      TEXT NOT NULL,
    "observationId"            TEXT,
    "observationSnapshot"      JSONB NOT NULL DEFAULT '{}'::jsonb,
    "plannedValue"             DECIMAL(20,4),
    "plannedValueType"         TEXT NOT NULL,
    "plannedValueSourceKind"   TEXT,
    "plannedValueSourceId"     TEXT,
    "plannedValueAtPeriodId"   TEXT,
    "plannedValueSnapshot"     JSONB NOT NULL DEFAULT '{}'::jsonb,
    "varianceAbsolute"         DECIMAL(20,4),
    "varianceDirection"        TEXT NOT NULL,
    "comparisonValid"          BOOLEAN NOT NULL,
    "attributionLevel"         TEXT NOT NULL DEFAULT 'descriptive',
    "notes"                    TEXT,
    "metadata"                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdBy"                TEXT NOT NULL,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variance_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "variance_records_tenantId_strategyVersionId_observationPeriodId_idx"
    ON "variance_records"("tenantId", "strategyVersionId", "observationPeriodId");
CREATE INDEX "variance_records_tenantId_indicatorDefinitionId_observationPeriodId_idx"
    ON "variance_records"("tenantId", "indicatorDefinitionId", "observationPeriodId");

-- 1e. alerts — human-actionable alerts (lifecycle separated from execution)
CREATE TABLE "alerts" (
    "id"                          TEXT NOT NULL,
    "tenantId"                    TEXT NOT NULL,
    "strategyVersionId"           TEXT NOT NULL,
    "indicatorDefinitionId"       TEXT,
    "varianceRecordId"            TEXT,
    "title"                       TEXT NOT NULL,
    "description"                 TEXT NOT NULL,
    "severity"                    TEXT NOT NULL,
    "lifecycleStage"              TEXT NOT NULL DEFAULT 'detected',
    "decisionDescription"         TEXT,
    "decidedById"                 TEXT,
    "decidedAt"                   TIMESTAMP(3),
    "executionStatus"             TEXT NOT NULL DEFAULT 'not_applicable',
    "executionVerifiedAction"     TEXT,
    "executionVerifiedAt"         TIMESTAMP(3),
    "executionVerificationSource" TEXT,
    "executionVerifiedById"       TEXT,
    "executionNotes"              TEXT,
    "requiresHumanAction"         BOOLEAN NOT NULL DEFAULT true,
    "createdBy"                   TEXT NOT NULL,
    "reviewedBy"                  TEXT,
    "reviewedAt"                  TIMESTAMP(3),
    "reviewNotes"                 TEXT,
    "closedBy"                    TEXT,
    "closedAt"                    TIMESTAMP(3),
    "closureReason"               TEXT,
    "isAutoGenerated"             BOOLEAN NOT NULL DEFAULT false,
    "metadata"                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alerts_tenantId_strategyVersionId_lifecycleStage_idx"
    ON "alerts"("tenantId", "strategyVersionId", "lifecycleStage");
CREATE INDEX "alerts_tenantId_indicatorDefinitionId_idx"
    ON "alerts"("tenantId", "indicatorDefinitionId");

-- ============================================================
-- 2. FOREIGN KEY CONSTRAINTS
-- ============================================================

-- indicator_definitions
ALTER TABLE "indicator_definitions"
    ADD CONSTRAINT "indicator_definitions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "indicator_definitions"
    ADD CONSTRAINT "indicator_definitions_objectiveId_fkey"
    FOREIGN KEY ("objectiveId") REFERENCES "objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "indicator_definitions"
    ADD CONSTRAINT "indicator_definitions_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "indicator_definitions"
    ADD CONSTRAINT "indicator_definitions_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- observation_periods
ALTER TABLE "observation_periods"
    ADD CONSTRAINT "observation_periods_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- observations
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_indicatorDefinitionId_fkey"
    FOREIGN KEY ("indicatorDefinitionId") REFERENCES "indicator_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_observationPeriodId_fkey"
    FOREIGN KEY ("observationPeriodId") REFERENCES "observation_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_evidenceId_fkey"
    FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_supersedesId_fkey"
    FOREIGN KEY ("supersedesId") REFERENCES "observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "observations"
    ADD CONSTRAINT "observations_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- variance_records
ALTER TABLE "variance_records"
    ADD CONSTRAINT "variance_records_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variance_records"
    ADD CONSTRAINT "variance_records_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variance_records"
    ADD CONSTRAINT "variance_records_indicatorDefinitionId_fkey"
    FOREIGN KEY ("indicatorDefinitionId") REFERENCES "indicator_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variance_records"
    ADD CONSTRAINT "variance_records_observationPeriodId_fkey"
    FOREIGN KEY ("observationPeriodId") REFERENCES "observation_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variance_records"
    ADD CONSTRAINT "variance_records_observationId_fkey"
    FOREIGN KEY ("observationId") REFERENCES "observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- alerts
ALTER TABLE "alerts"
    ADD CONSTRAINT "alerts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alerts"
    ADD CONSTRAINT "alerts_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alerts"
    ADD CONSTRAINT "alerts_indicatorDefinitionId_fkey"
    FOREIGN KEY ("indicatorDefinitionId") REFERENCES "indicator_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "alerts"
    ADD CONSTRAINT "alerts_varianceRecordId_fkey"
    FOREIGN KEY ("varianceRecordId") REFERENCES "variance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 3. OWNERSHIP + GRANTS
-- ============================================================
ALTER TABLE "indicator_definitions" OWNER TO balance_admin;
ALTER TABLE "observation_periods"   OWNER TO balance_admin;
ALTER TABLE "observations"          OWNER TO balance_admin;
ALTER TABLE "variance_records"      OWNER TO balance_admin;
ALTER TABLE "alerts"                OWNER TO balance_admin;

-- balance_app: DML on all 5 new tables (tenant-scoped via RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "indicator_definitions", "observation_periods", "observations",
    "variance_records", "alerts"
    TO balance_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO balance_app;

-- ============================================================
-- 4. ROW LEVEL SECURITY (all 5 new tables — PRIVATE, tenant-scoped)
-- ============================================================
-- Same pattern as G00's 14 PRIVATE tables and G01's 8 PRIVATE tables.

-- indicator_definitions: tenant-scoped
ALTER TABLE "indicator_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "indicator_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "indicator_definitions";
CREATE POLICY "tenant_isolation_balance_app" ON "indicator_definitions"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS "admin_all_balance_admin" ON "indicator_definitions";
CREATE POLICY "admin_all_balance_admin" ON "indicator_definitions"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- observation_periods: tenant-scoped
ALTER TABLE "observation_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "observation_periods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "observation_periods";
CREATE POLICY "tenant_isolation_balance_app" ON "observation_periods"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS "admin_all_balance_admin" ON "observation_periods";
CREATE POLICY "admin_all_balance_admin" ON "observation_periods"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- observations: tenant-scoped
ALTER TABLE "observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "observations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "observations";
CREATE POLICY "tenant_isolation_balance_app" ON "observations"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS "admin_all_balance_admin" ON "observations";
CREATE POLICY "admin_all_balance_admin" ON "observations"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- variance_records: tenant-scoped
ALTER TABLE "variance_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "variance_records" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "variance_records";
CREATE POLICY "tenant_isolation_balance_app" ON "variance_records"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS "admin_all_balance_admin" ON "variance_records";
CREATE POLICY "admin_all_balance_admin" ON "variance_records"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- alerts: tenant-scoped
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alerts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "alerts";
CREATE POLICY "tenant_isolation_balance_app" ON "alerts"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS "admin_all_balance_admin" ON "alerts";
CREATE POLICY "admin_all_balance_admin" ON "alerts"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 5. F1 — PARTIAL UNIQUE INDEX FOR isCurrent UNIQUENESS (NULL-safe)
-- ============================================================
-- PostgreSQL does not treat NULL values as equal in a default UNIQUE index,
-- so multiple "current" observations for the same (tenant, indicator, period,
-- geo_level, NULL geo_ref_id) would be allowed without protection.
-- Using COALESCE(geo_ref_id, '') collapses NULL to '' so the uniqueness
-- constraint applies uniformly to national-level (geo_ref_id IS NULL) and
-- subnational (geo_ref_id IS NOT NULL) observations.
CREATE UNIQUE INDEX "observations_one_current_idx"
    ON "observations" (
        "tenantId",
        "indicatorDefinitionId",
        "observationPeriodId",
        "geoLevel",
        COALESCE("geoRefId", '')
    )
    WHERE "isCurrent" = TRUE;

-- ============================================================
-- 6. F3 — CHAIN INTEGRITY TRIGGER (anti-branching, anti-cycle)
-- ============================================================
-- Enforces the following invariants on observation correction chains:
--   (a) An observation cannot be both current and superseded simultaneously.
--   (b) An observation cannot supersede itself (no self-reference).
--   (c) When supersedes_id is set:
--       - The target observation must exist in the same tenant.
--       - The target must NOT already have a direct successor (no branching).
--       - No cycle in the ancestor chain (bounded depth 100).
--       - The target must have the same (indicator, period, geo_level, geo_ref_id).
CREATE OR REPLACE FUNCTION enforce_observation_chain_integrity()
RETURNS TRIGGER AS $$
DECLARE
    ancestor_id TEXT;
    target_superseded_by TEXT;
BEGIN
    -- (a) cannot be current and superseded simultaneously
    IF NEW."isCurrent" = TRUE AND NEW."supersededById" IS NOT NULL THEN
        RAISE EXCEPTION 'Observation % cannot be current and superseded simultaneously', NEW."id";
    END IF;

    -- (b) no self-reference
    IF NEW."supersedesId" IS NOT NULL AND NEW."supersedesId" = NEW."id" THEN
        RAISE EXCEPTION 'Observation cannot supersede itself';
    END IF;

    -- (c) when supersedes_id present: validate chain integrity
    IF NEW."supersedesId" IS NOT NULL THEN
        -- F3: forbid branching — target must not have a direct successor yet
        SELECT "supersededById" INTO target_superseded_by
        FROM "observations"
        WHERE "id" = NEW."supersedesId" AND "tenantId" = NEW."tenantId";

        IF NOT FOUND THEN
            RAISE EXCEPTION 'supersedes_id references non-existent observation in same tenant';
        END IF;

        IF target_superseded_by IS NOT NULL THEN
            RAISE EXCEPTION 'Branching forbidden: target observation % already has a direct successor', NEW."supersedesId";
        END IF;

        -- cycle detection (bounded depth 100)
        ancestor_id := NEW."supersedesId";
        FOR i IN 1..100 LOOP
            IF ancestor_id = NEW."id" THEN
                RAISE EXCEPTION 'Cycle detected in observation correction chain';
            END IF;
            SELECT "supersedesId" INTO ancestor_id FROM "observations" WHERE "id" = ancestor_id;
            EXIT WHEN ancestor_id IS NULL;
        END LOOP;

        -- same indicator + period + geo
        IF NOT EXISTS (
            SELECT 1 FROM "observations"
            WHERE "id" = NEW."supersedesId"
              AND "tenantId" = NEW."tenantId"
              AND "indicatorDefinitionId" = NEW."indicatorDefinitionId"
              AND "observationPeriodId" = NEW."observationPeriodId"
              AND COALESCE("geoLevel", '') = COALESCE(NEW."geoLevel", '')
              AND COALESCE("geoRefId", '') = COALESCE(NEW."geoRefId", '')
        ) THEN
            RAISE EXCEPTION 'supersedes_id must reference same indicator+period+geo in same tenant';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "observation_chain_integrity_trigger" ON "observations";
CREATE TRIGGER "observation_chain_integrity_trigger"
    BEFORE INSERT OR UPDATE ON "observations"
    FOR EACH ROW EXECUTE FUNCTION enforce_observation_chain_integrity();

-- ============================================================
-- 7. VERIFICATION
-- ============================================================
DO $$
DECLARE
    t_name TEXT;
    rls_count INTEGER;
BEGIN
    FOR t_name IN SELECT unnest(ARRAY['indicator_definitions','observation_periods','observations','variance_records','alerts']) LOOP
        -- RLS enabled + forced
        SELECT count(*) INTO rls_count
        FROM pg_tables
        WHERE tablename = t_name
          AND rowsecurity = TRUE
          AND forcerowsecurity = TRUE;
        IF rls_count = 0 THEN
            RAISE EXCEPTION 'RLS not FORCE-enabled on %', t_name;
        END IF;
        -- balance_app policy exists
        SELECT count(*) INTO rls_count
        FROM pg_policies
        WHERE tablename = t_name
          AND policyname = 'tenant_isolation_balance_app';
        IF rls_count = 0 THEN
            RAISE EXCEPTION 'tenant_isolation_balance_app policy missing on %', t_name;
        END IF;
    END LOOP;
    RAISE NOTICE 'G02 State Observatory bootstrap: 5 new PRIVATE tables + RLS + F1 NULL-safe uniqueness + F3 chain integrity trigger.';
END $$;
