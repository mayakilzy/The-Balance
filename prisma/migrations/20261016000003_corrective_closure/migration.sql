-- The Balance — Migration 20261016000003: Corrective Closure for 00-02
-- Founder directives:
--   1. audit_log must be append-only for balance_app (no UPDATE/DELETE)
--   2. StateHierarchy + Institution parents must be in the same country
--
-- This migration does NOT touch roles (role setup is separated to
-- scripts/setup-roles.sql per ADR-0005 update).
--
-- Per ADR-0005 (updated) and new ADR-0006 (hierarchy integrity).

-- ============================================================
-- 1. AUDIT LOG — APPEND-ONLY FOR balance_app
-- ============================================================
-- Previous (migration 0002): FOR ALL policy allowed UPDATE/DELETE.
-- Now: separate SELECT + INSERT policies; no UPDATE/DELETE policy.
-- Additionally REVOKE UPDATE/DELETE as belt-and-suspenders.

-- 1.1 Drop the old FOR ALL policy
DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "audit_log";

-- 1.2 Create SELECT-only policy (read own tenant's rows)
CREATE POLICY "audit_log_select_balance_app" ON "audit_log"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));

-- 1.3 Create INSERT-only policy (write own tenant's rows)
CREATE POLICY "audit_log_insert_balance_app" ON "audit_log"
    FOR INSERT TO balance_app
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- 1.4 Revoke UPDATE and DELETE from balance_app (belt-and-suspenders).
-- Even if a future policy accidentally allows them, the GRANT won't.
REVOKE UPDATE, DELETE ON "audit_log" FROM balance_app;

-- 1.5 Document: balance_admin retains all privileges (for maintenance).
-- The maintenance path for audit_log corrections (rare, e.g., GDPR erasure)
-- is: connect as balance_admin, which has BYPASSRLS. This is audited at
-- the application layer (a separate audit entry recording the admin action).
-- See ADR-0005 §"Audit log maintenance path".

-- ============================================================
-- 2. STATE HIERARCHY — COUNTRY INTEGRITY
-- ============================================================
-- A StateHierarchy node's parent MUST be in the same country.
-- CHECK constraints cannot reference other rows, so we use a trigger.

CREATE OR REPLACE FUNCTION enforce_state_hierarchy_country() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."parentId" IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "state_hierarchy"
            WHERE id = NEW."parentId" AND "countryId" = NEW."countryId"
        ) THEN
            RAISE EXCEPTION
                'StateHierarchy integrity violation: parent % is not in country %',
                NEW."parentId", NEW."countryId"
                USING HINT = 'Parent and child must belong to the same country.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "state_hierarchy_country_check" ON "state_hierarchy";
CREATE TRIGGER "state_hierarchy_country_check"
    BEFORE INSERT OR UPDATE OF "parentId", "countryId" ON "state_hierarchy"
    FOR EACH ROW EXECUTE FUNCTION enforce_state_hierarchy_country();

-- ============================================================
-- 3. INSTITUTION — COUNTRY INTEGRITY
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_institution_country() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."parentId" IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "institutions"
            WHERE id = NEW."parentId" AND "countryId" = NEW."countryId"
        ) THEN
            RAISE EXCEPTION
                'Institution integrity violation: parent % is not in country %',
                NEW."parentId", NEW."countryId"
                USING HINT = 'Parent and child must belong to the same country.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "institution_country_check" ON "institutions";
CREATE TRIGGER "institution_country_check"
    BEFORE INSERT OR UPDATE OF "parentId", "countryId" ON "institutions"
    FOR EACH ROW EXECUTE FUNCTION enforce_institution_country();

-- ============================================================
-- 4. VERIFY — confirm audit_log policies are correct
-- ============================================================
DO $$
DECLARE
    has_select BOOLEAN;
    has_insert BOOLEAN;
    has_update BOOLEAN;
    has_delete BOOLEAN;
BEGIN
    -- Check that balance_app has SELECT policy
    SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'audit_log'
          AND policyname = 'audit_log_select_balance_app'
          AND roles @> ARRAY['balance_app']::name[]
          AND cmd = 'SELECT'
    ) INTO has_select;

    SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'audit_log'
          AND policyname = 'audit_log_insert_balance_app'
          AND roles @> ARRAY['balance_app']::name[]
          AND cmd = 'INSERT'
    ) INTO has_insert;

    -- Check that NO UPDATE or DELETE policy exists for balance_app
    SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'audit_log'
          AND roles @> ARRAY['balance_app']::name[]
          AND cmd IN ('UPDATE', 'DELETE')
    ) INTO has_update;

    has_delete := has_update; -- same check covers both

    IF NOT has_select THEN
        RAISE EXCEPTION 'audit_log_select_balance_app policy missing';
    END IF;
    IF NOT has_insert THEN
        RAISE EXCEPTION 'audit_log_insert_balance_app policy missing';
    END IF;
    IF has_update THEN
        RAISE EXCEPTION 'audit_log still has UPDATE or DELETE policy for balance_app — append-only violated';
    END IF;

    RAISE NOTICE 'audit_log policies verified: SELECT+INSERT only for balance_app. Append-only enforced.';
END $$;

-- ============================================================
-- 5. VERIFY — confirm triggers exist
-- ============================================================
DO $$
DECLARE
    sh_trigger_exists BOOLEAN;
    inst_trigger_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'state_hierarchy_country_check'
    ) INTO sh_trigger_exists;

    SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'institution_country_check'
    ) INTO inst_trigger_exists;

    IF NOT sh_trigger_exists THEN
        RAISE EXCEPTION 'state_hierarchy_country_check trigger missing';
    END IF;
    IF NOT inst_trigger_exists THEN
        RAISE EXCEPTION 'institution_country_check trigger missing';
    END IF;

    RAISE NOTICE 'Country integrity triggers verified on state_hierarchy + institutions.';
END $$;
