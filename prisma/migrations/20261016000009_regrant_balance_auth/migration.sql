-- The Balance — Migration 20261016000009: Re-grant column-level SELECT to balance_auth
-- Migration 0008's REVOKE SELECT ON table also revoked column-level grants.
-- This migration re-grants the specific columns needed for auth bootstrap.
-- Raw SQL queries in auth-bootstrap.ts select ONLY these columns.

-- Re-grant column-level SELECT on users
GRANT SELECT (id, email, name, "passwordHash", status) ON "users" TO balance_auth;

-- Re-grant column-level SELECT on memberships
-- Includes "createdAt" for ORDER BY in loadFirstActiveMembership
GRANT SELECT ("userId", "tenantId", "roleCode", status, "createdAt") ON "memberships" TO balance_auth;

-- Re-grant column-level SELECT on tenants
GRANT SELECT (id) ON "tenants" TO balance_auth;

-- Re-grant column-level SELECT on sources (added in 0008, also revoked)
GRANT SELECT (id, code, "displayName", type, license, url, "urlHash", "independenceGroup") ON "sources" TO balance_auth;

-- Verify: balance_auth has column-level but NOT table-level SELECT
DO $$
DECLARE
    has_table_select BOOLEAN;
    has_col_select BOOLEAN;
BEGIN
    SELECT has_table_privilege('balance_auth', 'users', 'SELECT') INTO has_table_select;
    SELECT has_column_privilege('balance_auth', 'users', 'passwordHash', 'SELECT') INTO has_col_select;

    IF has_table_select THEN
        RAISE EXCEPTION 'balance_auth has table-level SELECT on users — should be column-level only';
    END IF;
    IF NOT has_col_select THEN
        RAISE EXCEPTION 'balance_auth lacks column-level SELECT on users.passwordHash';
    END IF;

    RAISE NOTICE 'balance_auth: column-level SELECT verified, table-level denied.';
END $$;
