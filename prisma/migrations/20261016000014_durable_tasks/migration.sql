-- The Balance — Migration 0014: Durable Task Runtime
-- Mission 00-06: Durable Task Runtime and Balance Master Stub
--
-- Creates:
--   1. tasks table (PRIVATE — tenant-scoped, durable)
--   2. task_events table (PRIVATE — append-only execution trail)
--
-- Task lifecycle: pending → claimed → running → completed | failed | abandoned
-- Lease mechanism: claimedBy + leaseExpiresAt; stale tasks can be reclaimed

-- ============================================================
-- 1. TASKS TABLE
-- ============================================================
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "output" JSONB,
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tasks_tenantId_status_idx" ON "tasks"("tenantId", "status");
CREATE INDEX "tasks_status_priority_createdAt_idx" ON "tasks"("status", "priority" DESC, "createdAt" ASC)
    WHERE "status" = 'pending';
CREATE INDEX "tasks_tenantId_idempotencyKey_idx" ON "tasks"("tenantId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX "tasks_leaseExpiresAt_idx" ON "tasks"("leaseExpiresAt")
    WHERE "status" IN ('claimed', 'running') AND "leaseExpiresAt" IS NOT NULL;

ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 2. TASK_EVENTS TABLE (append-only execution trail)
-- ============================================================
CREATE TABLE "task_events" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "task_events_taskId_at_idx" ON "task_events"("taskId", "at");
CREATE INDEX "task_events_tenantId_at_idx" ON "task_events"("tenantId", "at");

ALTER TABLE "task_events"
    ADD CONSTRAINT "task_events_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_events"
    ADD CONSTRAINT "task_events_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3. OWNERSHIP + GRANTS
-- ============================================================
ALTER TABLE "tasks" OWNER TO balance_admin;
ALTER TABLE "task_events" OWNER TO balance_admin;

GRANT SELECT, INSERT, UPDATE ON "tasks" TO balance_app;
GRANT SELECT, INSERT ON "task_events" TO balance_app;

-- task_events: append-only (no UPDATE/DELETE for balance_app)
REVOKE UPDATE, DELETE ON "task_events" FROM balance_app;

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
-- tasks: tenant-scoped
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "tasks";
CREATE POLICY "tenant_isolation_balance_app" ON "tasks"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "tasks";
CREATE POLICY "admin_all_balance_admin" ON "tasks"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- task_events: tenant-scoped, append-only (SELECT + INSERT)
ALTER TABLE "task_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_read_balance_app" ON "task_events";
CREATE POLICY "tenant_read_balance_app" ON "task_events"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "tenant_insert_balance_app" ON "task_events";
CREATE POLICY "tenant_insert_balance_app" ON "task_events"
    FOR INSERT TO balance_app
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "task_events";
CREATE POLICY "admin_all_balance_admin" ON "task_events"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 5. CROSS-TENANT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION enforce_task_event_same_tenant() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "tasks" WHERE id = NEW."taskId" AND "tenantId" = NEW."tenantId"
    ) THEN
        RAISE EXCEPTION 'Task event tenant mismatch: task % is not in tenant %',
            NEW."taskId", NEW."tenantId"
            USING HINT = 'Task event must be in the same tenant as the task.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_event_tenant_check" ON "task_events";
CREATE TRIGGER "task_event_tenant_check"
    BEFORE INSERT OR UPDATE OF "taskId", "tenantId" ON "task_events"
    FOR EACH ROW EXECUTE FUNCTION enforce_task_event_same_tenant();

-- ============================================================
-- 6. VERIFY
-- ============================================================
DO $$
DECLARE
    rls_ok BOOLEAN;
    has_update_te BOOLEAN;
BEGIN
    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'tasks';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on tasks'; END IF;

    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'task_events';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on task_events'; END IF;

    SELECT has_table_privilege('balance_app', 'task_events', 'UPDATE') INTO has_update_te;
    IF has_update_te THEN
        RAISE EXCEPTION 'balance_app has UPDATE on task_events — should be append-only';
    END IF;

    RAISE NOTICE 'Durable task runtime: tasks + task_events created with RLS + append-only events.';
END $$;
