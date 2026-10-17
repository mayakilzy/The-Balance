-- The Balance — Migration 0020: Budget line uniqueness guarantee
-- Mission 01-06: Prevent duplicate budget lines under concurrent estimateBudgets calls
--
-- Adds a unique partial index on (tenantId, programId, modelVersion) so that
-- even if two concurrent workers try to estimate the budget for the same
-- program with the same model version, the database rejects the second
-- insertion. The first writer wins; the second recovers via P2002 catch
-- (same pattern as program-service.ts FIX-3 and strategy-composer-service.ts
-- FIX-A-LAST).
--
-- Why (tenantId, programId, modelVersion):
--   - tenantId: tenant isolation (RLS already enforces, but the unique index
--     makes the constraint explicit at the storage layer too)
--   - programId: one budget line per program per model version
--   - modelVersion: when the cost model is upgraded (v2, v3...), new estimates
--     can coexist with old ones for the same program, enabling reproducibility
--     comparison across model versions. Mission 01-06 uses v1-deterministic;
--     future missions may introduce v2 with different assumptions.
--
-- This is a PARTIAL index in spirit — we only enforce uniqueness for
-- non-deleted rows. Since budget_lines has no soft-delete column, a regular
-- UNIQUE index suffices.

CREATE UNIQUE INDEX IF NOT EXISTS "budget_lines_tenant_program_modelVersion_key"
    ON "budget_lines"("tenantId", "programId", "modelVersion");

-- Verify
DO $$
BEGIN
    RAISE NOTICE 'Migration 0020: unique index on (tenantId, programId, modelVersion) created. Prevents duplicate budget lines per program per model version.';
END $$;
