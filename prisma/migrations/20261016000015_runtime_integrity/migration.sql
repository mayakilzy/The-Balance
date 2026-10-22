-- The Balance — Migration 0015: Runtime Integrity Closure
-- Mission 00-06 durable runtime integrity closure (3 founder gaps).
--
-- 1. Fencing: add claimGeneration column (increments on each claim)
-- 2. Atomic Idempotency: UNIQUE partial index on (tenantId, idempotencyKey)
-- 3. Durable Reclaim Events: handled in service layer (no SQL needed)

-- ============================================================
-- 1. CLAIM GENERATION (Fencing Token)
-- ============================================================
-- Each time a task is claimed, claimGeneration increments.
-- All task operations (start, renew, progress, complete, fail) must
-- verify that claimGeneration matches the caller's expectation.
-- This prevents a stale worker from overwriting a new worker's results.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "claimGeneration" INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 2. ATOMIC IDEMPOTENCY (UNIQUE partial index)
-- ============================================================
-- The existing index is non-unique. Add a UNIQUE partial index
-- for non-null idempotencyKeys. This prevents concurrent creation
-- of duplicate tasks with the same key.
-- PostgreSQL partial unique index: only enforces uniqueness for
-- rows WHERE idempotencyKey IS NOT NULL.

DROP INDEX IF EXISTS "tasks_tenantId_idempotencyKey_idx";
CREATE UNIQUE INDEX "tasks_tenantId_idempotencyKey_key"
    ON "tasks"("tenantId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;

-- ============================================================
-- 3. VERIFY
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'tasks_tenantId_idempotencyKey_key'
          AND schemaname = 'public'
    ) THEN
        RAISE EXCEPTION 'Unique partial index tasks_tenantId_idempotencyKey_key missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'claimGeneration'
    ) THEN
        RAISE EXCEPTION 'claimGeneration column missing on tasks';
    END IF;

    RAISE NOTICE 'Runtime integrity: claimGeneration + unique idempotency index verified.';
END $$;
