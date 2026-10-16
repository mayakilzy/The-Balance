-- The Balance — Migration 0012: Strategy Contracts + Pre-setup fixes
-- Mission 00-05: Strategy, Version, Decision and Event Contracts
--
-- Pre-setup:
--   1. Fix sources INSERT RLS: enforce submittedByTenantId = current tenant
--   2. verifyEvidence permission enforcement is in TypeScript (not SQL)
--
-- Main:
--   3. strategies table (PRIVATE — tenant-scoped)
--   4. strategy_versions table (PRIVATE — immutable approved versions)
--   5. decisions table (PRIVATE — linked to strategy version + evidence)
--   6. decision_events table (PRIVATE — temporal audit trail)
--   7. events table (PRIVATE — generic timeline)
--
-- Per ADR-0010 (strategy contracts design).

-- ============================================================
-- 1. PRE-SETUP: Fix sources INSERT RLS
-- ============================================================
-- Old: WITH CHECK (reviewStatus = 'candidate')
-- New: WITH CHECK (reviewStatus = 'candidate' AND submittedByTenantId = current_setting('app.tenant_id', true))
-- This prevents a tenant from creating a candidate source attributed to another tenant.

DROP POLICY IF EXISTS "public_insert_balance_app" ON "sources";
CREATE POLICY "public_insert_balance_app" ON "sources"
    FOR INSERT TO balance_app
    WITH CHECK (
        "reviewStatus" = 'candidate'
        AND "submittedByTenantId" = current_setting('app.tenant_id', true)
    );

-- ============================================================
-- 2. STRATEGIES TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- A Strategy is a high-level plan document. It has versions.
-- Status: draft | submitted | approved | archived

CREATE TABLE "strategies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "strategies_tenantId_status_idx" ON "strategies"("tenantId", "status");

ALTER TABLE "strategies"
    ADD CONSTRAINT "strategies_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3. STRATEGY_VERSIONS TABLE (PRIVATE — tenant-scoped, immutable when approved)
-- ============================================================
-- A StrategyVersion is a specific draft or approved version of a strategy.
-- Status: draft | approved | superseded
-- Approved versions are IMMUTABLE — any change creates a new version.

CREATE TABLE "strategy_versions" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalNotes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "strategy_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "strategy_versions_strategyId_versionNumber_key" ON "strategy_versions"("strategyId", "versionNumber");
CREATE INDEX "strategy_versions_tenantId_status_idx" ON "strategy_versions"("tenantId", "status");

ALTER TABLE "strategy_versions"
    ADD CONSTRAINT "strategy_versions_strategyId_fkey"
    FOREIGN KEY ("strategyId") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "strategy_versions"
    ADD CONSTRAINT "strategy_versions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 4. DECISIONS TABLE (PRIVATE — tenant-scoped, linked to evidence)
-- ============================================================
-- A Decision records what was decided, why, and on what evidence.
-- It captures evidence verification status AT DECISION TIME (not live).
-- This is critical: if evidence is later refuted, the decision record
-- shows what was known when the decision was made.

CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "strategyVersionId" TEXT,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    -- Evidence snapshot at decision time (JSONB)
    "supportingEvidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "counterEvidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "decisions_tenantId_status_idx" ON "decisions"("tenantId", "status");
CREATE INDEX "decisions_strategyVersionId_idx" ON "decisions"("strategyVersionId") WHERE "strategyVersionId" IS NOT NULL;

ALTER TABLE "decisions"
    ADD CONSTRAINT "decisions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decisions"
    ADD CONSTRAINT "decisions_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 5. DECISION_EVENTS TABLE (PRIVATE — temporal audit trail)
-- ============================================================
-- Records the lifecycle of a decision: proposed → reviewed → approved → implemented → reversed
-- Each event is append-only (RLS blocks UPDATE/DELETE for balance_app).

CREATE TABLE "decision_events" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "decision_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "decision_events_decisionId_at_idx" ON "decision_events"("decisionId", "at");
CREATE INDEX "decision_events_tenantId_at_idx" ON "decision_events"("tenantId", "at");

ALTER TABLE "decision_events"
    ADD CONSTRAINT "decision_events_decisionId_fkey"
    FOREIGN KEY ("decisionId") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decision_events"
    ADD CONSTRAINT "decision_events_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 6. EVENTS TABLE (PRIVATE — generic timeline events)
-- ============================================================
-- Generic events for audit trail: strategy created, version approved, etc.

CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "events_tenantId_at_idx" ON "events"("tenantId", "at");
CREATE INDEX "events_entityType_entityId_idx" ON "events"("entityType", "entityId") WHERE "entityType" IS NOT NULL;

ALTER TABLE "events"
    ADD CONSTRAINT "events_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 7. OWNERSHIP + GRANTS
-- ============================================================
ALTER TABLE "strategies" OWNER TO balance_admin;
ALTER TABLE "strategy_versions" OWNER TO balance_admin;
ALTER TABLE "decisions" OWNER TO balance_admin;
ALTER TABLE "decision_events" OWNER TO balance_admin;
ALTER TABLE "events" OWNER TO balance_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON "strategies", "strategy_versions", "decisions", "decision_events", "events" TO balance_app;

-- decision_events: append-only for balance_app (SELECT + INSERT only)
REVOKE UPDATE, DELETE ON "decision_events" FROM balance_app;

-- events: append-only for balance_app (SELECT + INSERT only)
REVOKE UPDATE, DELETE ON "events" FROM balance_app;

-- ============================================================
-- 8. ROW LEVEL SECURITY
-- ============================================================

-- strategies: tenant-scoped
ALTER TABLE "strategies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strategies" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "strategies";
CREATE POLICY "tenant_isolation_balance_app" ON "strategies"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "strategies";
CREATE POLICY "admin_all_balance_admin" ON "strategies"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- strategy_versions: tenant-scoped
ALTER TABLE "strategy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strategy_versions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "strategy_versions";
CREATE POLICY "tenant_isolation_balance_app" ON "strategy_versions"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "strategy_versions";
CREATE POLICY "admin_all_balance_admin" ON "strategy_versions"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- decisions: tenant-scoped
ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "decisions";
CREATE POLICY "tenant_isolation_balance_app" ON "decisions"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "decisions";
CREATE POLICY "admin_all_balance_admin" ON "decisions"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- decision_events: tenant-scoped, append-only (SELECT + INSERT)
ALTER TABLE "decision_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_read_balance_app" ON "decision_events";
CREATE POLICY "tenant_read_balance_app" ON "decision_events"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "tenant_insert_balance_app" ON "decision_events";
CREATE POLICY "tenant_insert_balance_app" ON "decision_events"
    FOR INSERT TO balance_app
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- No UPDATE/DELETE policy for balance_app → append-only enforced

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "decision_events";
CREATE POLICY "admin_all_balance_admin" ON "decision_events"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- events: tenant-scoped, append-only (SELECT + INSERT)
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_read_balance_app" ON "events";
CREATE POLICY "tenant_read_balance_app" ON "events"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "tenant_insert_balance_app" ON "events";
CREATE POLICY "tenant_insert_balance_app" ON "events"
    FOR INSERT TO balance_app
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "events";
CREATE POLICY "admin_all_balance_admin" ON "events"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 9. CROSS-TENANT RELATION TRIGGERS
-- ============================================================
-- Prevent strategy_versions.strategyId from pointing to different tenant's strategy
CREATE OR REPLACE FUNCTION enforce_strategy_version_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "strategies" WHERE id = NEW."strategyId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Strategy version tenant mismatch: strategy % is not in tenant %',
            NEW."strategyId", NEW."tenantId"
            USING HINT = 'Strategy version must be in the same tenant as the strategy.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "strategy_version_tenant_check" ON "strategy_versions";
CREATE TRIGGER "strategy_version_tenant_check"
    BEFORE INSERT OR UPDATE OF "strategyId", "tenantId" ON "strategy_versions"
    FOR EACH ROW EXECUTE FUNCTION enforce_strategy_version_same_tenant();

-- Prevent decisions.strategyVersionId from pointing to different tenant's version
CREATE OR REPLACE FUNCTION enforce_decision_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."strategyVersionId" IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "strategy_versions"
            WHERE id = NEW."strategyVersionId" AND "tenantId" = NEW."tenantId"
        ) THEN
            RAISE EXCEPTION 'Decision tenant mismatch: strategy version % is not in tenant %',
                NEW."strategyVersionId", NEW."tenantId"
                USING HINT = 'Decision must link to a strategy version in the same tenant.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "decision_tenant_check" ON "decisions";
CREATE TRIGGER "decision_tenant_check"
    BEFORE INSERT OR UPDATE OF "strategyVersionId", "tenantId" ON "decisions"
    FOR EACH ROW EXECUTE FUNCTION enforce_decision_same_tenant();

-- Prevent decision_events.decisionId from pointing to different tenant's decision
CREATE OR REPLACE FUNCTION enforce_decision_event_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "decisions" WHERE id = NEW."decisionId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Decision event tenant mismatch: decision % is not in tenant %',
            NEW."decisionId", NEW."tenantId"
            USING HINT = 'Decision event must be in the same tenant as the decision.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "decision_event_tenant_check" ON "decision_events";
CREATE TRIGGER "decision_event_tenant_check"
    BEFORE INSERT OR UPDATE OF "decisionId", "tenantId" ON "decision_events"
    FOR EACH ROW EXECUTE FUNCTION enforce_decision_event_same_tenant();

-- ============================================================
-- 10. VERIFY
-- ============================================================
DO $$
DECLARE
    rls_ok BOOLEAN;
    has_update_de BOOLEAN;
BEGIN
    FOR rls_ok IN
        SELECT c.relrowsecurity AND c.relforcerowsecurity
        FROM pg_class c
        WHERE c.relname IN ('strategies','strategy_versions','decisions','decision_events','events')
    LOOP
        IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on one of the new tables'; END IF;
    END LOOP;

    -- decision_events: balance_app should NOT have UPDATE
    SELECT has_table_privilege('balance_app', 'decision_events', 'UPDATE') INTO has_update_de;
    IF has_update_de THEN
        RAISE EXCEPTION 'balance_app has UPDATE on decision_events — should be append-only';
    END IF;

    RAISE NOTICE 'Strategy contracts: 5 tables created with RLS + cross-tenant triggers.';
END $$;
