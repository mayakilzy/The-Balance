-- The Balance — Initial Migration (mission 00-01)
-- Creates: pgvector extension, tenants table, audit_log table.
-- RLS policies are deferred to mission 00-03 (see ADR-0003).

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "vector";
-- Note: pgvector is pre-installed in the pgvector/pgvector:pg16 image.
-- In other environments, ensure the extension is available before running this.

-- ============================================================
-- tenants
-- ============================================================
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- ============================================================
-- audit_log (append-only)
-- ============================================================
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "route" TEXT,
    "method" TEXT,
    "ipHash" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "errorCode" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_tenantId_at_idx" ON "audit_log"("tenantId", "at");
CREATE INDEX "audit_log_action_at_idx" ON "audit_log"("action", "at");

-- ============================================================
-- AddForeignKey: audit_log.tenantId → tenants.id
-- (ON DELETE SET NULL — audit logs survive tenant deletion)
-- ============================================================
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- RLS placeholders (activated in 00-03)
-- ============================================================
-- ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
-- Policies will be created in mission 00-03. See docs/adr/ADR-0003-tenant-isolation.md.
