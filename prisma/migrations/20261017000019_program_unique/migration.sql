-- The Balance — Migration 0019: Program uniqueness guarantee
-- Mission 01-04-FIX-3: Prevent duplicate programs under concurrent expandPrograms calls
--
-- Adds a unique partial index on (tenantId, strategyVersionId, title) so that
-- even if two concurrent workers try to expand the same program, the database
-- rejects the second insertion.

CREATE UNIQUE INDEX IF NOT EXISTS "programs_tenant_strategyVersion_title_key"
    ON "programs"("tenantId", "strategyVersionId", "title");

-- Verify
DO $$
BEGIN
    RAISE NOTICE 'Migration 0019: unique index on (tenantId, strategyVersionId, title) created. Prevents duplicate programs.';
END $$;
