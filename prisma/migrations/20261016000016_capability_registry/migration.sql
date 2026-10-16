-- The Balance — Migration 0016: Capability Registry
-- Mission 00-07: Expert Tool Capability Registry and Swarm Audit
--
-- Creates:
--   1. capabilities table (PUBLIC — global registry of tools/experts)
--   2. capability_invocations table (PRIVATE — tenant-scoped execution log)
--
-- Per ADR-0011 (capability registry design).

-- ============================================================
-- 1. CAPABILITIES TABLE (PUBLIC)
-- ============================================================
-- A Capability describes what a tool/expert can do, its input/output
-- schema, required permissions, readiness, and type (stub/mock/live).
-- PUBLIC because capability metadata is shared across tenants.
-- Tenants invoke capabilities; they don't own them.

CREATE TABLE "capabilities" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    -- Type: "tool" | "expert" | "source" | "adapter"
    "type" TEXT NOT NULL,
    -- Readiness: "stub" | "mock" | "live" | "untested"
    "readiness" TEXT NOT NULL DEFAULT 'stub',
    -- Input/output schemas (JSON Schema format)
    "inputSchema" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "outputSchema" JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Required permission to invoke (e.g., "evidence:read", "strategy:write")
    "requiredPermission" TEXT NOT NULL,
    -- Domains this capability serves (e.g., ["agriculture", "finance"])
    "domains" JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Adapter endpoint (for live capabilities; null for stub/mock)
    "adapterEndpoint" TEXT,
    -- Metadata (license, version, author, etc.)
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "capabilities_code_key" ON "capabilities"("code");
CREATE INDEX "capabilities_type_idx" ON "capabilities"("type");
CREATE INDEX "capabilities_readiness_idx" ON "capabilities"("readiness");

-- ============================================================
-- 2. CAPABILITY_INVOCATIONS TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- Records each invocation of a capability by a tenant.
-- Append-only (like audit_log + task_events).

CREATE TABLE "capability_invocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "taskId" TEXT,
    "invokedBy" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "output" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "capability_invocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cap_invocations_tenantId_idx" ON "capability_invocations"("tenantId");
CREATE INDEX "cap_invocations_capabilityId_idx" ON "capability_invocations"("capabilityId");
CREATE INDEX "cap_invocations_taskId_idx" ON "capability_invocations"("taskId") WHERE "taskId" IS NOT NULL;

ALTER TABLE "capability_invocations"
    ADD CONSTRAINT "cap_invocations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capability_invocations"
    ADD CONSTRAINT "cap_invocations_capabilityId_fkey"
    FOREIGN KEY ("capabilityId") REFERENCES "capabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "capability_invocations"
    ADD CONSTRAINT "cap_invocations_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 3. OWNERSHIP + GRANTS
-- ============================================================
ALTER TABLE "capabilities" OWNER TO balance_admin;
ALTER TABLE "capability_invocations" OWNER TO balance_admin;

-- capabilities: PUBLIC read for balance_app; admin write
GRANT SELECT ON "capabilities" TO balance_app;
GRANT SELECT, INSERT, UPDATE ON "capability_invocations" TO balance_app;

-- capability_invocations: append-only (no UPDATE/DELETE for balance_app — except status update)
-- Actually we need UPDATE for status changes (pending → completed/failed)
-- So we allow UPDATE but restrict via RLS
-- REVOKE UPDATE, DELETE ON "capability_invocations" FROM balance_app;

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
-- capabilities: PUBLIC read
ALTER TABLE "capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capabilities" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_balance_app" ON "capabilities";
CREATE POLICY "public_read_balance_app" ON "capabilities"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "public_read_balance_auth" ON "capabilities";
CREATE POLICY "public_read_balance_auth" ON "capabilities"
    FOR SELECT TO balance_auth USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "capabilities";
CREATE POLICY "admin_all_balance_admin" ON "capabilities"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- capability_invocations: tenant-scoped
ALTER TABLE "capability_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_invocations" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "capability_invocations";
CREATE POLICY "tenant_isolation_balance_app" ON "capability_invocations"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "capability_invocations";
CREATE POLICY "admin_all_balance_admin" ON "capability_invocations"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 5. VERIFY
-- ============================================================
DO $$
DECLARE
    rls_ok BOOLEAN;
BEGIN
    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'capabilities';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on capabilities'; END IF;

    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'capability_invocations';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on capability_invocations'; END IF;

    RAISE NOTICE 'Capability registry: capabilities + capability_invocations created with RLS.';
END $$;
