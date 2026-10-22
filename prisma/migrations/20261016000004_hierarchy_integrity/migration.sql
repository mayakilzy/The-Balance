-- The Balance — Migration 20261016000004: Hierarchy Integrity (final closure)
-- Founder directives (00-02 final integrity closure):
--   1. Prevent cycles in StateHierarchy (A → B → A)
--   2. Prevent cycles in Institution
--   3. Prevent changing countryId of a node that has children (creates inconsistency)
--
-- This migration does NOT modify migration 0002 (preserves checksum).
-- It adds new triggers on top of the existing country-integrity triggers
-- from migration 0003.
--
-- Per ADR-0006 (updated).

-- ============================================================
-- 1. STATE HIERARCHY — CYCLE DETECTION
-- ============================================================
-- A cycle is A → B → A (A's parent is B, B's parent is A).
-- We detect by walking up the parent chain from NEW.parentId; if we
-- encounter NEW.id, it's a cycle.
--
-- The walk is bounded by a safety counter (max 64 levels) to prevent
-- infinite loops in case of pre-existing data corruption.

CREATE OR REPLACE FUNCTION enforce_state_hierarchy_no_cycles() RETURNS TRIGGER AS $$
DECLARE
    current_id TEXT;
    depth INTEGER := 0;
    max_depth CONSTANT INTEGER := 64;
BEGIN
    IF NEW."parentId" IS NULL THEN
        RETURN NEW;
    END IF;

    -- Walk up the chain from NEW.parentId
    current_id := NEW."parentId";
    WHILE current_id IS NOT NULL AND depth < max_depth LOOP
        IF current_id = NEW.id THEN
            RAISE EXCEPTION
                'StateHierarchy cycle detected: setting parent of % to % creates a cycle',
                NEW.id, NEW."parentId"
                USING HINT = 'A node cannot be its own ancestor.';
        END IF;
        SELECT "parentId" INTO current_id FROM "state_hierarchy" WHERE id = current_id;
        depth := depth + 1;
    END LOOP;

    IF depth >= max_depth THEN
        RAISE EXCEPTION
            'StateHierarchy cycle detection aborted: chain exceeded % levels starting from %',
            max_depth, NEW.id
            USING HINT = 'Likely pre-existing data corruption; investigate manually.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "state_hierarchy_no_cycles_check" ON "state_hierarchy";
CREATE TRIGGER "state_hierarchy_no_cycles_check"
    BEFORE INSERT OR UPDATE OF "parentId" ON "state_hierarchy"
    FOR EACH ROW EXECUTE FUNCTION enforce_state_hierarchy_no_cycles();

-- ============================================================
-- 2. STATE HIERARCHY — COUNTRY CHANGE BLOCKED WHEN HAS CHILDREN
-- ============================================================
-- If a node has children, changing its countryId would orphan the
-- children's parent reference (parent in country X, child in country Y).
-- The migration 0003 trigger on children would then reject them, but
-- the damage is done. Better: block the country change at the source.

CREATE OR REPLACE FUNCTION enforce_state_hierarchy_country_immutable_with_children() RETURNS TRIGGER AS $$
DECLARE
    child_count INTEGER;
BEGIN
    -- Only fires on UPDATE of countryId (INSERT has no OLD to compare)
    IF TG_OP = 'UPDATE' AND NEW."countryId" IS DISTINCT FROM OLD."countryId" THEN
        SELECT count(*) INTO child_count
        FROM "state_hierarchy"
        WHERE "parentId" = NEW.id;

        IF child_count > 0 THEN
            RAISE EXCEPTION
                'StateHierarchy countryId change blocked: node % has % child(ren); changing countryId would orphan them',
                NEW.id, child_count
                USING HINT = 'Re-parent or delete children before changing a node''s country.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "state_hierarchy_country_immutable_check" ON "state_hierarchy";
CREATE TRIGGER "state_hierarchy_country_immutable_check"
    BEFORE UPDATE OF "countryId" ON "state_hierarchy"
    FOR EACH ROW EXECUTE FUNCTION enforce_state_hierarchy_country_immutable_with_children();

-- ============================================================
-- 3. INSTITUTION — CYCLE DETECTION
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_institution_no_cycles() RETURNS TRIGGER AS $$
DECLARE
    current_id TEXT;
    depth INTEGER := 0;
    max_depth CONSTANT INTEGER := 64;
BEGIN
    IF NEW."parentId" IS NULL THEN
        RETURN NEW;
    END IF;

    current_id := NEW."parentId";
    WHILE current_id IS NOT NULL AND depth < max_depth LOOP
        IF current_id = NEW.id THEN
            RAISE EXCEPTION
                'Institution cycle detected: setting parent of % to % creates a cycle',
                NEW.id, NEW."parentId"
                USING HINT = 'A node cannot be its own ancestor.';
        END IF;
        SELECT "parentId" INTO current_id FROM "institutions" WHERE id = current_id;
        depth := depth + 1;
    END LOOP;

    IF depth >= max_depth THEN
        RAISE EXCEPTION
            'Institution cycle detection aborted: chain exceeded % levels starting from %',
            max_depth, NEW.id
            USING HINT = 'Likely pre-existing data corruption; investigate manually.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "institution_no_cycles_check" ON "institutions";
CREATE TRIGGER "institution_no_cycles_check"
    BEFORE INSERT OR UPDATE OF "parentId" ON "institutions"
    FOR EACH ROW EXECUTE FUNCTION enforce_institution_no_cycles();

-- ============================================================
-- 4. INSTITUTION — COUNTRY CHANGE BLOCKED WHEN HAS CHILDREN
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_institution_country_immutable_with_children() RETURNS TRIGGER AS $$
DECLARE
    child_count INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."countryId" IS DISTINCT FROM OLD."countryId" THEN
        SELECT count(*) INTO child_count
        FROM "institutions"
        WHERE "parentId" = NEW.id;

        IF child_count > 0 THEN
            RAISE EXCEPTION
                'Institution countryId change blocked: node % has % child(ren); changing countryId would orphan them',
                NEW.id, child_count
                USING HINT = 'Re-parent or delete children before changing a node''s country.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "institution_country_immutable_check" ON "institutions";
CREATE TRIGGER "institution_country_immutable_check"
    BEFORE UPDATE OF "countryId" ON "institutions"
    FOR EACH ROW EXECUTE FUNCTION enforce_institution_country_immutable_with_children();

-- ============================================================
-- 5. VERIFY — confirm all 4 new triggers exist
-- ============================================================
DO $$
DECLARE
    t_exists BOOLEAN;
    trigger_name TEXT;
BEGIN
    FOREACH trigger_name IN ARRAY ARRAY[
        'state_hierarchy_no_cycles_check',
        'state_hierarchy_country_immutable_check',
        'institution_no_cycles_check',
        'institution_country_immutable_check'
    ] LOOP
        SELECT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = trigger_name
        ) INTO t_exists;
        IF NOT t_exists THEN
            RAISE EXCEPTION 'Trigger % missing', trigger_name;
        END IF;
    END LOOP;
    RAISE NOTICE 'All 4 hierarchy integrity triggers verified.';
END $$;
