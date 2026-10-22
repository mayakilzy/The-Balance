-- The Balance — Migration 20261016000005: Identity (User + Membership)
-- Mission 00-03: Identity, Permissions and Tenant Isolation
--
-- This migration:
--   1. Creates `users` table (PRIVATE — self-isolated via RLS)
--   2. Creates `memberships` table (PRIVATE — tenant-scoped via RLS)
--   3. Adds foreign keys: memberships.userId → users.id, memberships.tenantId → tenants.id
--   4. Adds foreign key: memberships.roleCode → role_references.code
--   5. RLS policies: users self-isolation, memberships tenant-scoped
--   6. Grants DML to balance_app; revokes UPDATE on users.passwordHash
--
-- Per ADR-0007 (auth design) + ADR-0008 (RBAC/ABAC).

-- ============================================================
-- 1. USERS TABLE
-- ============================================================
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_status_idx" ON "users"("status");

-- ============================================================
-- 2. MEMBERSHIPS TABLE
-- ============================================================
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memberships_userId_tenantId_key" ON "memberships"("userId", "tenantId");
CREATE INDEX "memberships_tenantId_status_idx" ON "memberships"("tenantId", "status");
CREATE INDEX "memberships_userId_status_idx" ON "memberships"("userId", "status");

ALTER TABLE "memberships"
    ADD CONSTRAINT "memberships_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memberships"
    ADD CONSTRAINT "memberships_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memberships"
    ADD CONSTRAINT "memberships_roleCode_fkey"
    FOREIGN KEY ("roleCode") REFERENCES "role_references"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 3. OWNERSHIP + GRANTS
-- ============================================================
ALTER TABLE "users" OWNER TO balance_admin;
ALTER TABLE "memberships" OWNER TO balance_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON "users", "memberships" TO balance_app;

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================
-- users: self-isolation — a user sees only their own row.
-- Requires app.user_id to be set (similar to app.tenant_id).

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_self_read_balance_app" ON "users";
CREATE POLICY "user_self_read_balance_app" ON "users"
    FOR SELECT TO balance_app
    USING (id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS "user_self_update_balance_app" ON "users";
CREATE POLICY "user_self_update_balance_app" ON "users"
    FOR UPDATE TO balance_app
    USING (id = current_setting('app.user_id', true))
    WITH CHECK (id = current_setting('app.user_id', true));

-- No INSERT/DELETE policy for balance_app on users — user creation is admin-only.

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "users";
CREATE POLICY "admin_all_balance_admin" ON "users"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- memberships: tenant-scoped + user-scoped.
-- balance_app sees only memberships for THEIR user_id in the current tenant.

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "membership_self_in_tenant_balance_app" ON "memberships";
CREATE POLICY "membership_self_in_tenant_balance_app" ON "memberships"
    FOR SELECT TO balance_app
    USING (
        "userId" = current_setting('app.user_id', true)
        AND "tenantId" = current_setting('app.tenant_id', true)
    );

DROP POLICY IF EXISTS "membership_self_insert_balance_app" ON "memberships";
CREATE POLICY "membership_self_insert_balance_app" ON "memberships"
    FOR INSERT TO balance_app
    WITH CHECK (
        "userId" = current_setting('app.user_id', true)
        AND "tenantId" = current_setting('app.tenant_id', true)
    );

-- No UPDATE/DELETE policy for balance_app on memberships — admin-only.

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "memberships";
CREATE POLICY "admin_all_balance_admin" ON "memberships"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 5. REVOKE UPDATE on users.passwordHash (defense in depth)
-- ============================================================
REVOKE UPDATE ("passwordHash") ON "users" FROM balance_app;

-- ============================================================
-- 6. VERIFY
-- ============================================================
DO $$
DECLARE
    rls_ok BOOLEAN;
BEGIN
    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'users';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on users'; END IF;

    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'memberships';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on memberships'; END IF;

    RAISE NOTICE 'users + memberships tables created with RLS ENABLEd + FORCEd.';
END $$;
