-- The Balance — Migration 0018: Strategy composition uniqueness guarantee
-- Mission 01-03-FIX-02: Prevent duplicate strategies in the same composition batch
--
-- Adds a unique partial index on (tenantId, compositionBatchId, title) so that
-- even if two concurrent workers try to create the same alternative in the same
-- batch, the database rejects the second insertion. This is the DB-level
-- guarantee that complements the application-level findFirst check.
--
-- The index is PARTIAL (WHERE compositionBatchId IS NOT NULL) so that
-- G00 strategies (which have NULL compositionBatchId) are not affected.

CREATE UNIQUE INDEX IF NOT EXISTS "strategies_tenant_compositionBatch_title_key"
    ON "strategies"("tenantId", "compositionBatchId", "title")
    WHERE "compositionBatchId" IS NOT NULL;

-- Verify
DO $$
BEGIN
    RAISE NOTICE 'Migration 0018: unique partial index on (tenantId, compositionBatchId, title) created. Prevents duplicate alternatives in composition batches.';
END $$;
