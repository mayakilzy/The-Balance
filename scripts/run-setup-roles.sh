#!/usr/bin/env bash
# The Balance — Role Setup Wrapper
# ------------------------------------------------------------
# Runs scripts/setup-roles.sql with env-var-aware password handling.
#
# Usage:
#   CI/dev (dev defaults):
#     bash scripts/run-setup-roles.sh
#
#   Production (strong passwords from secret manager):
#     PGPASSWORD_BALANCE_ADMIN=xxx PGPASSWORD_BALANCE_APP=yyy \
#       bash scripts/run-setup-roles.sh
#
# The wrapper passes passwords as psql variables so the SQL script
# can read them via current_setting('balance_admin_pw', true).
# This avoids putting passwords on the command line (which would be
# visible in process listings).

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-balance}"
DB_SUPERUSER="${DB_SUPERUSER:-postgres}"

# Passwords: env vars override dev defaults.
ADMIN_PW="${PGPASSWORD_BALANCE_ADMIN:-balance_admin_dev_only}"
APP_PW="${PGPASSWORD_BALANCE_APP:-balance_app_dev_only}"

# Warn if using dev defaults
if [ "$ADMIN_PW" = "balance_admin_dev_only" ] || [ "$APP_PW" = "balance_app_dev_only" ]; then
    echo "WARNING: Using dev-default passwords. NOT FOR PRODUCTION." >&2
    echo "  Set PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP for production." >&2
fi

# Run the SQL script, passing passwords as psql variables.
# PGPASSWORD is for the postgres superuser connection (bootstrap).
PGPASSWORD="${PGPASSWORD_POSTGRES:-postgres}" \
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    -v balance_admin_pw="$ADMIN_PW" \
    -v balance_app_pw="$APP_PW" \
    -f scripts/setup-roles.sql

echo "Role setup complete."
