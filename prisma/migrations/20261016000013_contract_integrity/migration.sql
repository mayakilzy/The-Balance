-- The Balance — Migration 0013: Contract Integrity Closure
-- Mission 00-05 contract integrity closure (3 founder gaps).
--
-- 1. Approved strategy version immutability (DB-level trigger)
-- 2. Decision state transitions (service-layer — no SQL needed)
-- 3. Evidence snapshot completeness (service-layer — no SQL needed)

-- ============================================================
-- 1. APPROVED STRATEGY VERSION IMMUTABILITY
-- ============================================================
-- When a strategy version is 'approved', its content, createdBy, createdAt,
-- approvedBy, approvedAt, approvalNotes are FROZEN.
-- Only the status column can change (approved → superseded).
-- Any UPDATE attempt on frozen columns when status='approved' → exception.

CREATE OR REPLACE FUNCTION enforce_approved_version_immutability() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'approved' THEN
        -- Allow status change (approved → superseded)
        -- Block changes to ALL other columns
        IF NEW."content" IS DISTINCT FROM OLD."content"
           OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
           OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
           OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
           OR NEW."approvalNotes" IS DISTINCT FROM OLD."approvalNotes"
           OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
           OR NEW."strategyId" IS DISTINCT FROM OLD."strategyId"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        THEN
            RAISE EXCEPTION
                'Approved strategy version % is immutable — cannot modify content or approval records',
                OLD.id
                USING HINT = 'Only status transition (approved → superseded) is allowed.';
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

DROP TRIGGER IF EXISTS "approved_version_immutability_check" ON "strategy_versions";
CREATE TRIGGER "approved_version_immutability_check"
    BEFORE UPDATE ON "strategy_versions"
    FOR EACH ROW EXECUTE FUNCTION enforce_approved_version_immutability();

-- ============================================================
-- 2. VERIFY
-- ============================================================
DO $$
DECLARE
    t_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'approved_version_immutability_check'
    ) INTO t_exists;
    IF NOT t_exists THEN
        RAISE EXCEPTION 'approved_version_immutability_check trigger missing';
    END IF;
    RAISE NOTICE 'Contract integrity: approved version immutability trigger verified.';
END $$;
