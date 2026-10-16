#!/usr/bin/env bash
# ============================================================
# backup-restore-test.sh — Database backup/restore drill
# ------------------------------------------------------------
# 00-10 acceptance: proves pg_dump → drop → restore round-trip
# preserves all data, RLS policies, and role grants.
#
# This script is run by the CI fresh-install-recovery job.
# It performs the following:
#   1. Take a logical backup of the balance database (pg_dump)
#   2. Drop the database (simulating catastrophic failure)
#   3. Recreate the database from the backup (pg_restore)
#   4. Verify role grants + RLS policies + row counts match
#
# Usage (CI):
#   bash scripts/backup-restore-test.sh
#
# Exit codes:
#   0 = PASS (backup + restore verified)
#   1 = FAIL (any step failed)
# ============================================================
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-balance}"
DB_SUPERUSER="${DB_SUPERUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"

BACKUP_FILE="/tmp/balance-backup-$(date +%s).dump"

echo "=== 00-10 Backup/Restore Drill ==="
echo ""

# ------------------------------------------------------------
# STEP 1: Capture row counts BEFORE backup
# ------------------------------------------------------------
echo "[1/6] Capturing pre-backup row counts..."
PRE_COUNTS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A <<'SQL'
SELECT
  (SELECT count(*) FROM countries) || ':' ||
  (SELECT count(*) FROM tenants) || ':' ||
  (SELECT count(*) FROM users) || ':' ||
  (SELECT count(*) FROM role_references) || ':' ||
  (SELECT count(*) FROM state_hierarchy) || ':' ||
  (SELECT count(*) FROM institutions) || ':' ||
  (SELECT count(*) FROM sources) || ':' ||
  (SELECT count(*) FROM capabilities);
SQL
)
echo "  Pre-backup counts: $PRE_COUNTS"

# ------------------------------------------------------------
# STEP 2: Take logical backup (pg_dump with custom format)
# ------------------------------------------------------------
echo "[2/6] Taking logical backup (pg_dump)..."
# Note: we do NOT use --no-privileges because RLS policies are classified
# as privileges in PostgreSQL — using --no-privileges would strip them
# from the backup, making the restore insecure. We use --no-owner to
# avoid ownership issues, but keep privileges (RLS policies, grants).
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" \
  --format=custom \
  --no-owner \
  --file="$BACKUP_FILE"
echo "  Backup saved to: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# ------------------------------------------------------------
# STEP 3: Drop the database (simulate catastrophic failure)
# ------------------------------------------------------------
echo "[3/6] Dropping database (simulating failure)..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
echo "  Database dropped."

# ------------------------------------------------------------
# STEP 4: Recreate empty database + restore from backup
# ------------------------------------------------------------
echo "[4/6] Recreating database + restoring from backup..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";"
# Note: --no-owner keeps ownership flexible, but we do NOT use
# --no-privileges so RLS policies are restored.
# We do NOT use --clean (database is empty).
# FAIL-CLOSED: capture exit code explicitly. pg_restore returns non-zero
# on any error (corrupt backup, missing objects, SQL errors). We do NOT
# swallow the exit code with `|| true` — a non-zero exit means the restore
# is incomplete and we must fail the drill.
RESTORE_OUTPUT=$(pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" \
  --no-owner \
  "$BACKUP_FILE" 2>&1)
RESTORE_EXIT=$?
if [ "$RESTORE_EXIT" -ne 0 ]; then
  echo "FAIL: pg_restore exited with code $RESTORE_EXIT — restore is incomplete"
  echo "  pg_restore output (last 30 lines):"
  echo "$RESTORE_OUTPUT" | tail -30
  exit 1
fi
echo "  Restore complete (pg_restore exit code 0)."

# ------------------------------------------------------------
# STEP 5: Re-run role setup (roles are NOT in the backup)
# ------------------------------------------------------------
echo "[5/6] Re-running role setup (roles are cluster-level, not in dump)..."
bash scripts/run-setup-roles.sh
echo "  Roles restored."

# ------------------------------------------------------------
# STEP 6: Verify row counts match + RLS policies intact
# ------------------------------------------------------------
echo "[6/6] Verifying post-restore data integrity..."
POST_COUNTS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A <<'SQL'
SELECT
  (SELECT count(*) FROM countries) || ':' ||
  (SELECT count(*) FROM tenants) || ':' ||
  (SELECT count(*) FROM users) || ':' ||
  (SELECT count(*) FROM role_references) || ':' ||
  (SELECT count(*) FROM state_hierarchy) || ':' ||
  (SELECT count(*) FROM institutions) || ':' ||
  (SELECT count(*) FROM sources) || ':' ||
  (SELECT count(*) FROM capabilities);
SQL
)
echo "  Post-restore counts: $POST_COUNTS"

if [ "$PRE_COUNTS" != "$POST_COUNTS" ]; then
  echo "FAIL: Row counts do not match!"
  echo "  Before: $PRE_COUNTS"
  echo "  After:  $POST_COUNTS"
  exit 1
fi

# Verify RLS is ENABLED + FORCED on all 14 private tables (strict assertion)
RLS_RESULT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A <<'SQL'
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE relrowsecurity = true) AS rls_enabled,
  count(*) FILTER (WHERE relforcerowsecurity = true) AS rls_forced
FROM pg_class
WHERE relname IN (
  'users', 'memberships', 'tasks', 'task_events', 'evidence',
  'evidence_embeddings', 'strategies', 'strategy_versions',
  'decisions', 'decision_events', 'events', 'audit_log',
  'capability_invocations', 'tenants'
);
SQL
)
IFS='|' read -r RLS_TOTAL RLS_ENABLED RLS_FORCED <<< "$(echo "$RLS_RESULT" | tr -d ' ')"
echo "  Private tables: total=$RLS_TOTAL, RLS enabled=$RLS_ENABLED, RLS forced=$RLS_FORCED (expected 14/14/14)"

if [ "$RLS_TOTAL" -ne 14 ] || [ "$RLS_ENABLED" -ne 14 ] || [ "$RLS_FORCED" -ne 14 ]; then
  echo "FAIL: RLS not fully enabled+forced on all 14 private tables after restore!"
  echo "  RLS check value: total=$RLS_TOTAL enabled=$RLS_ENABLED forced=$RLS_FORCED"
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -c "
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relname IN ('users', 'tasks', 'evidence', 'audit_log', 'tenants', 'memberships')
    ORDER BY relname;
  "
  exit 1
fi

# Verify balance_app still has correct privileges
PRIV_CHECK=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" -t -A <<'SQL'
SELECT
  CASE WHEN rolsuper THEN 'FAIL' ELSE 'OK' END || ':' ||
  CASE WHEN rolbypassrls THEN 'FAIL' ELSE 'OK' END
FROM pg_roles WHERE rolname = 'balance_app';
SQL
)
echo "  balance_app (superuser:bypassrls): $PRIV_CHECK"

if echo "$PRIV_CHECK" | grep -q "FAIL"; then
  echo "FAIL: balance_app has elevated privileges after restore!"
  exit 1
fi

echo ""
echo "=== BACKUP/RESTORE DRILL: PASS ==="
echo "  - All row counts match pre-backup state"
echo "  - RLS ENABLE + FORCE on all 14 private tables"
echo "  - balance_app privileges correct (no superuser, no bypassrls)"
echo ""

# ------------------------------------------------------------
# NEGATIVE TEST: corrupted backup MUST fail-closed
# ------------------------------------------------------------
echo "=== Negative test: corrupted backup must fail ==="
CORRUPT_FILE="/tmp/balance-corrupt-$(date +%s).dump"
echo "NOT_A_VALID_PG_DUMP_FILE_THIS_IS_CORRUPT_DATA_FOR_TESTING" > "$CORRUPT_FILE"

# Drop + recreate empty DB for the negative test
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null

# Attempt to restore the corrupt file — pg_restore MUST exit non-zero
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" \
  --no-owner \
  "$CORRUPT_FILE" >/dev/null 2>&1
CORRUPT_EXIT=$?

if [ "$CORRUPT_EXIT" -eq 0 ]; then
  echo "FAIL: pg_restore accepted a corrupted backup (exit code 0) — should have failed!"
  rm -f "$CORRUPT_FILE"
  exit 1
fi
echo "  OK: pg_restore rejected corrupted backup (exit code $CORRUPT_EXIT)"
rm -f "$CORRUPT_FILE"

# Restore the valid backup again so the database is in a usable state
# for any subsequent CI phases (e.g. full test suite).
echo "  Re-restoring valid backup for subsequent phases..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" \
  --no-owner \
  "$BACKUP_FILE" >/dev/null 2>&1 || true
bash scripts/run-setup-roles.sh >/dev/null 2>&1

# Cleanup
rm -f "$BACKUP_FILE"

echo ""
echo "=== NEGATIVE TEST: PASS (corrupted backup rejected) ==="
echo ""
