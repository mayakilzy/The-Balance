#!/usr/bin/env bash
# The Balance — Role Setup Wrapper (password-fix v2)
# ------------------------------------------------------------
# Runs scripts/setup-roles.sql with env-var-aware password handling.
#
# Mechanism:
#   - Reads PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP from env.
#   - If empty, falls back to dev defaults (with WARNING).
#   - Loads final values into psql variables via \set + backtick.
#   - setup-roles.sql reads them via :'var' (psql substitution).
#
# Usage:
#   CI/dev:  bash scripts/run-setup-roles.sh
#   Prod:    PGPASSWORD_BALANCE_ADMIN=xxx PGPASSWORD_BALANCE_APP=yyy \
#            bash scripts/run-setup-roles.sh

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-balance}"
DB_SUPERUSER="${DB_SUPERUSER:-postgres}"

# Read env vars; fall back to dev defaults if empty.
ADMIN_PW="${PGPASSWORD_BALANCE_ADMIN:-balance_admin_dev_only}"
APP_PW="${PGPASSWORD_BALANCE_APP:-balance_app_dev_only}"
AUTH_PW="${PGPASSWORD_BALANCE_AUTH:-balance_auth_dev_only}"
APPROVER_PW="${PGPASSWORD_BALANCE_SNAPSHOT_APPROVER:-balance_snapshot_approver_dev_only}"
SECURITY_LOGGER_PW="${PGPASSWORD_BALANCE_SECURITY_LOGGER:-balance_security_logger_dev_only}"

# Warn if using dev defaults
if [ "$ADMIN_PW" = "balance_admin_dev_only" ] || [ "$APP_PW" = "balance_app_dev_only" ] || [ "$AUTH_PW" = "balance_auth_dev_only" ] || [ "$APPROVER_PW" = "balance_snapshot_approver_dev_only" ] || [ "$SECURITY_LOGGER_PW" = "balance_security_logger_dev_only" ]; then
    echo "WARNING: Using dev-default passwords. NOT FOR PRODUCTION." >&2
    echo "  Set PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP + PGPASSWORD_BALANCE_AUTH + PGPASSWORD_BALANCE_SNAPSHOT_APPROVER + PGPASSWORD_BALANCE_SECURITY_LOGGER for production." >&2
fi

# Ensure non-empty (defense in depth)
if [ -z "$ADMIN_PW" ]; then ADMIN_PW="balance_admin_dev_only"; fi
if [ -z "$APP_PW" ]; then APP_PW="balance_app_dev_only"; fi
if [ -z "$AUTH_PW" ]; then AUTH_PW="balance_auth_dev_only"; fi
if [ -z "$APPROVER_PW" ]; then APPROVER_PW="balance_snapshot_approver_dev_only"; fi
if [ -z "$SECURITY_LOGGER_PW" ]; then SECURITY_LOGGER_PW="balance_security_logger_dev_only"; fi

# Run the SQL script.
PGPASSWORD="${PGPASSWORD_POSTGRES:-postgres}" \
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    <<PSQL_EOF
\set balance_admin_pw \`printf '%s' "$ADMIN_PW"\`
\set balance_app_pw \`printf '%s' "$APP_PW"\`
\set balance_auth_pw \`printf '%s' "$AUTH_PW"\`
\set balance_snapshot_approver_pw \`printf '%s' "$APPROVER_PW"\`
\set balance_security_logger_pw \`printf '%s' "$SECURITY_LOGGER_PW"\`
\i scripts/setup-roles.sql
PSQL_EOF

echo "Role setup complete."
