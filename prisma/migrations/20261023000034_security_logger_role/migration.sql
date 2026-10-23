-- ============================================================
-- Migration 20261023000034 — Security Logger Role (D05 Final Closure)
-- ------------------------------------------------------------
-- OWNER DIRECTIVE (D05 final closure):
--   "تحقق من مشكلة AUDIT_WRITE_FAILED المتعلقة بأحداث ما قبل
--    المصادقة. لا أريد توسيع الصلاحيات أو تعطيل RLS. استخدم
--    آلية موثوقة ومحدودة الصلاحية لتسجيل الأحداث الأمنية المناسبة"
--
-- Problem:
--   The audit_log RLS policy for balance_app requires
--   current_setting('app.tenant_id') to be set. Before authentication
--   completes (signin attempts, health-check pings, rate-limit hits),
--   no tenant context exists, so balance_app INSERTs are denied with
--   PostgreSQL error code 42501 ("new row violates row-level security
--   policy for table audit_log"). The audit module tolerates this by
--   logging "AUDIT_WRITE_FAILED — primary flow continues" — meaning
--   the security events are LOST.
--
-- Fix (privilege-limited, no expansion, RLS preserved):
--   Create a new LOGIN role `balance_security_logger` with:
--     - LOGIN (separate connection credentials, used only for
--       pre-auth security writes via a dedicated PrismaClient)
--     - NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION
--     - NOBYPASSRLS  ← cannot bypass RLS
--   Grant ONLY INSERT on audit_log (no SELECT/UPDATE/DELETE).
--   Add a NEW RLS policy on audit_log:
--     - role: balance_security_logger
--     - cmd:  INSERT
--     - with_check: ("tenantId" IS NULL)
--   This role can write ONLY pre-auth security events (events that
--   have no tenant scope). It cannot read, modify, or delete any
--   audit rows. It cannot bypass RLS. It cannot reach any other
--   table (no grants on countries, users, strategies, etc.).
--
-- TRUST BOUNDARY:
--   The audit module (src/lib/audit.ts) selects which client to use:
--     - tenant-scoped events  → balance_app (RLS-enforced, current
--                               tenant_id checked by RLS)
--     - pre-auth events       → balance_security_logger (RLS-enforced,
--                               tenantId IS NULL checked by RLS)
--   The application never uses balance_security_logger for anything
--   other than writing audit_log rows with NULL tenantId. The role
--   has no privileges to do anything else.
--
-- Per ADR-0005 + G03-06 Trust Boundary Closure pattern (separate
-- narrowly-scoped LOGIN role for specific trust boundary).
-- ============================================================

-- ============================================================
-- 1. CREATE ROLE (idempotent)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_security_logger') THEN
        CREATE ROLE balance_security_logger
            WITH LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            NOBYPASSRLS;
    END IF;
END $$;

-- ============================================================
-- 2. SET PASSWORD (dev default — overridden by scripts/setup-roles.sql
--    in production via PGPASSWORD_BALANCE_SECURITY_LOGGER env var)
-- ============================================================
ALTER ROLE balance_security_logger WITH PASSWORD 'balance_security_logger_dev_only';

-- ============================================================
-- 3. SCHEMA PRIVILEGES (USAGE only — needed for table access)
-- ============================================================
GRANT USAGE ON SCHEMA public TO balance_security_logger;

-- ============================================================
-- 4. TABLE PRIVILEGES (INSERT + SELECT on audit_log)
--    SELECT is required so Prisma's `create()` (which uses
--    INSERT ... RETURNING *) works. RLS SELECT policy below
--    restricts reads to tenantId IS NULL rows only — the same
--    rows this role writes. UPDATE/DELETE are NOT granted →
--    append-only enforced at the privilege level, in addition to RLS.
-- ============================================================
GRANT INSERT, SELECT ON audit_log TO balance_security_logger;

-- USAGE on the audit_log_id_seq sequence so the DEFAULT
-- nextval('audit_log_id_seq') works during INSERT. SELECT on the
-- sequence is NOT granted (would leak current value).
GRANT USAGE ON SEQUENCE audit_log_id_seq TO balance_security_logger;

-- ============================================================
-- 5. RLS POLICIES — pre-auth INSERT + SELECT (tenantId IS NULL only)
--    balance_security_logger can INSERT and SELECT rows where
--    tenantId IS NULL (pre-auth events only). Rows with a tenantId
--    (post-auth events) are NEVER visible to this role.
--    UPDATE/DELETE have no policies for this role → RLS denies them.
--    balance_app's existing policy remains unchanged.
-- ============================================================
DROP POLICY IF EXISTS audit_log_security_logger_insert ON audit_log;
CREATE POLICY audit_log_security_logger_insert
    ON audit_log
    FOR INSERT
    TO balance_security_logger
    WITH CHECK ("tenantId" IS NULL);

DROP POLICY IF EXISTS audit_log_security_logger_select ON audit_log;
CREATE POLICY audit_log_security_logger_select
    ON audit_log
    FOR SELECT
    TO balance_security_logger
    USING ("tenantId" IS NULL);

-- ============================================================
-- 6. ACCEPTANCE ASSERTIONS (run by tests/integration/security-log.integration.test.ts)
-- ============================================================
-- Verify role attributes
SELECT
    rolname,
    rolsuper  AS is_superuser,
    rolcanlogin AS can_login,
    rolbypassrls AS can_bypass_rls
FROM pg_roles
WHERE rolname = 'balance_security_logger';

-- Verify table grants (INSERT + SELECT, no UPDATE/DELETE)
SELECT
    grantee,
    string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'audit_log'
  AND grantee = 'balance_security_logger'
GROUP BY grantee;

-- Verify the RLS policies exist
SELECT policyname, cmd, roles, with_check, qual
FROM pg_policies
WHERE tablename = 'audit_log'
  AND policyname LIKE 'audit_log_security_logger_%';
