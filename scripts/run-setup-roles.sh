#!/usr/bin/env bash
# The Balance — Role Setup Wrapper (password-fix)
# ------------------------------------------------------------
# Runs scripts/setup-roles.sql with env-var-aware password handling.
#
# Mechanism:
#   - Reads PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP from env.
#   - Loads them into psql variables via \set with backtick execution.
#   - setup-roles.sql reads them via :'var' (psql substitution).
#   - If env vars are unset, dev defaults are used + WARNING printed.
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

# Read env vars (empty string if unset)
ADMIN_PW="${PGPASSWORD_BALANCE_ADMIN:-}"
APP_PW="${PGPASSWORD_BALANCE_APP:-}"

# Warn if using dev defaults
if [ -z "$ADMIN_PW" ] || [ -z "$APP_PW" ]; then
    echo "WARNING: Using dev-default passwords. NOT FOR PRODUCTION." >&2
    echo "  Set PGPASSWORD_BALANCE_ADMIN + PGPASSWORD_BALANCE_APP for production." >&2
fi

# Run the SQL script.
# We use a heredoc to send \set commands + \i (include) the SQL file.
# The \set with backtick loads the env var into a psql variable.
# printf '%s' avoids trailing newline; the value is shell-escaped by being
# in a single-quoted backtick context (psql handles it).
#
# Security: the password is in the psql variable, NOT on the command line,
# so it doesn't appear in process listings. psql doesn't log variable values.
PGPASSWORD="${PGPASSWORD_POSTGRES:-postgres}" \
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    <<PSQL_EOF
\set balance_admin_pw \`printf '%s' "$ADMIN_PW"\`
\set balance_app_pw \`printf '%s' "$APP_PW"\`
\i scripts/setup-roles.sql
PSQL_EOF

echo "Role setup complete."
