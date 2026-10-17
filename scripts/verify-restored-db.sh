#!/usr/bin/env bash
# ============================================================
# verify-restored-db.sh — Non-destructive verification of a restored DB
# ------------------------------------------------------------
# 00-10 closure: verifies that a database restored from backup is
# structurally sound and secure — WITHOUT requiring an empty database.
#
# Unlike fresh-install-verify.sh (which requires an empty DB and runs
# migrations + seed), this script assumes the DB already contains
# data (from a backup restore) and verifies:
#   1. All expected migrations are applied
#   2. Seed-level data is present (minimum row counts)
#   3. RLS is ENABLED + FORCED on all 14 private tables
#   4. balance_app has NO superuser / NO bypassrls
#   5. audit_log is append-only (no UPDATE/DELETE for balance_app)
#   6. balance_app can read PUBLIC tables (countries, sources, etc.)
#
# Usage:
#   After restoring from backup:
#     bash scripts/verify-restored-db.sh
#
# Exit codes:
#   0 = PASS (restored DB is structurally sound + secure)
#   1 = FAIL (any verification check failed)
# ============================================================
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-balance}"
DB_SUPERUSER="${DB_SUPERUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"

# balance_admin password for migration count query.
# In CI we use dev defaults; in production set PGPASSWORD_BALANCE_ADMIN.
ADMIN_PW="${PGPASSWORD_BALANCE_ADMIN:-balance_admin_dev_only}"

echo "=== 00-10 Restored DB Verification (non-destructive) ==="
echo ""

FAIL=0

# ------------------------------------------------------------
# STEP 1: Verify all migrations are applied
# ------------------------------------------------------------
echo "[1/6] Verifying migrations..."
MIGRATION_COUNT=$(PGPASSWORD="$ADMIN_PW" psql -h "$DB_HOST" -p "$DB_PORT" -U balance_admin -d "$DB_NAME" -t -A 2>/dev/null <<'SQL' || echo "ERROR"
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name IS NOT NULL;
SQL
)
if [ "$MIGRATION_COUNT" = "ERROR" ] || [ -z "$MIGRATION_COUNT" ]; then
  echo "  FAIL: Cannot read _prisma_migrations table (balance_admin may lack access or table missing)"
  FAIL=1
elif [ "$MIGRATION_COUNT" -lt 20 ]; then
  echo "  FAIL: Expected >=20 applied migrations (16 G00 + 4 G01), found $MIGRATION_COUNT"
  FAIL=1
else
  echo "  OK: $MIGRATION_COUNT migrations applied"
fi

# ------------------------------------------------------------
# STEP 2: Verify seed-level data is present (minimum row counts)
# ------------------------------------------------------------
echo "[2/6] Verifying data presence..."
SEED_COUNTS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A 2>/dev/null <<'SQL' || echo "ERROR"
SELECT
  (SELECT count(*) FROM countries) || ':' ||
  (SELECT count(*) FROM tenants) || ':' ||
  (SELECT count(*) FROM users) || ':' ||
  (SELECT count(*) FROM role_references) || ':' ||
  (SELECT count(*) FROM state_hierarchy) || ':' ||
  (SELECT count(*) FROM institutions) || ':' ||
  (SELECT count(*) FROM sources);
SQL
)
if [ "$SEED_COUNTS" = "ERROR" ] || [ -z "$SEED_COUNTS" ]; then
  echo "  FAIL: Cannot read core tables — restore may be incomplete"
  FAIL=1
else
  IFS=':' read -r COUNTRIES TENANTS USERS ROLES HIERARCHY INSTITUTIONS SOURCES <<< "$SEED_COUNTS"
  echo "  Counts: countries=$COUNTRIES tenants=$TENANTS users=$USERS roles=$ROLES hierarchy=$HIERARCHY institutions=$INSTITUTIONS sources=$SOURCES"

  if [ "$COUNTRIES" -lt 1 ]; then echo "  FAIL: No countries — restore incomplete"; FAIL=1; fi
  if [ "$TENANTS" -lt 2 ]; then echo "  FAIL: Expected >=2 tenants, got $TENANTS"; FAIL=1; fi
  if [ "$USERS" -lt 4 ]; then echo "  FAIL: Expected >=4 users, got $USERS"; FAIL=1; fi
  if [ "$ROLES" -lt 4 ]; then echo "  FAIL: Expected >=4 role_references, got $ROLES"; FAIL=1; fi
  if [ "$HIERARCHY" -lt 3 ]; then echo "  FAIL: Expected >=3 hierarchy nodes, got $HIERARCHY"; FAIL=1; fi
  if [ "$INSTITUTIONS" -lt 2 ]; then echo "  FAIL: Expected >=2 institutions, got $INSTITUTIONS"; FAIL=1; fi
  if [ "$SOURCES" -lt 3 ]; then echo "  FAIL: Expected >=3 sources, got $SOURCES"; FAIL=1; fi

  if [ "$FAIL" -eq 0 ]; then
    echo "  OK: All seed-level data present"
  fi
fi

# ------------------------------------------------------------
# STEP 3: Verify RLS is ENABLED + FORCED on all 22 private tables
# ------------------------------------------------------------
# 14 G00 private tables + 8 G01 private tables (migration 0017)
echo "[3/6] Verifying RLS (ENABLE + FORCE) on all private tables..."
RLS_RESULT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A 2>/dev/null <<'SQL' || echo "ERROR"
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE relrowsecurity = true) AS rls_enabled,
  count(*) FILTER (WHERE relforcerowsecurity = true) AS rls_forced
FROM pg_class
WHERE relname IN (
  -- G00 private tables (14)
  'users', 'memberships', 'tasks', 'task_events', 'evidence',
  'evidence_embeddings', 'strategies', 'strategy_versions',
  'decisions', 'decision_events', 'events', 'audit_log',
  'capability_invocations', 'tenants',
  -- G01 private tables (8, migration 0017)
  'objectives', 'country_pack_configs', 'programs', 'projects',
  'budget_lines', 'dependencies', 'risk_registers', 'assumptions'
);
SQL
)
if [ "$RLS_RESULT" = "ERROR" ] || [ -z "$RLS_RESULT" ]; then
  echo "  FAIL: Cannot query pg_class for RLS status"
  FAIL=1
else
  IFS='|' read -r TOTAL ENABLED FORCED <<< "$(echo "$RLS_RESULT" | tr -d ' ')"
  echo "  Private tables: total=$TOTAL, RLS enabled=$ENABLED, RLS forced=$FORCED (expected 22/22/22)"

  if [ "$TOTAL" -ne 22 ]; then
    echo "  FAIL: Expected 22 private tables, found $TOTAL — some tables missing from restore"
    FAIL=1
  elif [ "$ENABLED" -ne 22 ]; then
    echo "  FAIL: $((22 - ENABLED)) table(s) missing ENABLE ROW LEVEL SECURITY"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -c "
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'users', 'memberships', 'tasks', 'task_events', 'evidence',
        'evidence_embeddings', 'strategies', 'strategy_versions',
        'decisions', 'decision_events', 'events', 'audit_log',
        'capability_invocations', 'tenants',
        'objectives', 'country_pack_configs', 'programs', 'projects',
        'budget_lines', 'dependencies', 'risk_registers', 'assumptions'
      )
        AND (relrowsecurity = false OR relforcerowsecurity = false)
      ORDER BY relname;
    " 2>/dev/null
    FAIL=1
  elif [ "$FORCED" -ne 22 ]; then
    echo "  FAIL: $((22 - FORCED)) table(s) missing FORCE ROW LEVEL SECURITY"
    FAIL=1
  else
    echo "  OK: All 22 private tables have ENABLE + FORCE RLS"
  fi
fi

# ------------------------------------------------------------
# STEP 4: Verify balance_app has NO superuser / NO bypassrls
# ------------------------------------------------------------
echo "[4/6] Verifying balance_app privileges..."
PRIV_CHECK=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A 2>/dev/null <<'SQL' || echo "ERROR"
SELECT
  CASE WHEN rolsuper THEN 'FAIL' ELSE 'OK' END || ':' ||
  CASE WHEN rolbypassrls THEN 'FAIL' ELSE 'OK' END
FROM pg_roles WHERE rolname = 'balance_app';
SQL
)
if [ "$PRIV_CHECK" = "ERROR" ] || [ -z "$PRIV_CHECK" ]; then
  echo "  FAIL: balance_app role does not exist — run scripts/run-setup-roles.sh"
  FAIL=1
elif echo "$PRIV_CHECK" | grep -q "FAIL"; then
  echo "  FAIL: balance_app has elevated privileges ($PRIV_CHECK)"
  FAIL=1
else
  echo "  OK: balance_app is not superuser, no bypassrls"
fi

# ------------------------------------------------------------
# STEP 5: Verify audit_log is append-only (no UPDATE/DELETE for balance_app)
# ------------------------------------------------------------
echo "[5/6] Verifying audit_log append-only..."
AUDIT_PRIVS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A 2>/dev/null <<'SQL' || echo "ERROR"
SELECT
  CASE WHEN has_table_privilege('balance_app', 'audit_log', 'UPDATE')
       THEN 'FAIL:UPDATE' ELSE 'OK:UPDATE' END || ':' ||
  CASE WHEN has_table_privilege('balance_app', 'audit_log', 'DELETE')
       THEN 'FAIL:DELETE' ELSE 'OK:DELETE' END;
SQL
)
if [ "$AUDIT_PRIVS" = "ERROR" ] || [ -z "$AUDIT_PRIVS" ]; then
  echo "  FAIL: Cannot check audit_log privileges"
  FAIL=1
elif echo "$AUDIT_PRIVS" | grep -q "FAIL"; then
  echo "  FAIL: balance_app has UPDATE/DELETE on audit_log ($AUDIT_PRIVS)"
  FAIL=1
else
  echo "  OK: balance_app has no UPDATE/DELETE on audit_log"
fi

# ------------------------------------------------------------
# STEP 6: Verify balance_app can read PUBLIC tables (basic connectivity)
# ------------------------------------------------------------
echo "[6/6] Verifying balance_app can read PUBLIC tables..."
PUBLIC_READ=$(PGPASSWORD="${PGPASSWORD_BALANCE_APP:-balance_app_dev_only}" psql -h "$DB_HOST" -p "$DB_PORT" -U balance_app -d "$DB_NAME" -t -A 2>/dev/null <<'SQL' || echo "ERROR"
SELECT count(*) FROM countries;
SQL
)
if [ "$PUBLIC_READ" = "ERROR" ] || [ -z "$PUBLIC_READ" ]; then
  echo "  FAIL: balance_app cannot read countries table"
  FAIL=1
elif [ "$PUBLIC_READ" -lt 1 ]; then
  echo "  FAIL: countries table is empty or unreadable for balance_app"
  FAIL=1
else
  echo "  OK: balance_app can read PUBLIC tables ($PUBLIC_READ countries)"
fi

# ------------------------------------------------------------
# Final result
# ------------------------------------------------------------
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== RESTORED DB VERIFICATION: PASS ==="
  echo "  - $MIGRATION_COUNT migrations applied"
  echo "  - Seed-level data present"
  echo "  - RLS ENABLE + FORCE on all 22 private tables (14 G00 + 8 G01)"
  echo "  - balance_app: not superuser, no bypassrls"
  echo "  - audit_log: append-only"
  echo "  - balance_app can read PUBLIC tables"
  echo ""
  exit 0
else
  echo "=== RESTORED DB VERIFICATION: FAIL ==="
  echo "  One or more checks failed. See output above."
  echo ""
  exit 1
fi
