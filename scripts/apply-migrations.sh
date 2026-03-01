#!/usr/bin/env bash
# apply-migrations.sh — Apply all Supabase migrations to the cafezin project.
# Reads DB password from pedrin/.env (source of truth for all credentials).
#
# Usage: bash scripts/apply-migrations.sh
# Run from: cafezin/ root

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PEDRIN_ENV="$(dirname "$PROJECT_ROOT")/pedrin/.env"
MIGRATIONS_DIR="$PROJECT_ROOT/supabase/migrations"

PROJECT_REF="dxxwlnvemqgpdrnkzrcr"
DB_HOST="db.${PROJECT_REF}.supabase.co"
DB_USER="postgres"
DB_NAME="postgres"
DB_PORT="5432"

PSQL="/usr/local/opt/libpq/bin/psql"
if [[ ! -x "$PSQL" ]]; then
  PSQL="$(command -v psql 2>/dev/null || true)"
  if [[ -z "$PSQL" ]]; then
    echo "ERROR: psql not found. Install with: brew install libpq"
    echo "  Then add to PATH: export PATH=\"/usr/local/opt/libpq/bin:\$PATH\""
    exit 1
  fi
fi

# Load DB password from pedrin/.env
DB_PASS=""
if [[ -f "$PEDRIN_ENV" ]]; then
  DB_PASS="$(grep '^SUPABASE_DB_PASSWORD_CAFEZIN=' "$PEDRIN_ENV" | cut -d'=' -f2- | tr -d '[:space:]')"
fi
if [[ -z "$DB_PASS" ]]; then
  echo "ERROR: SUPABASE_DB_PASSWORD_CAFEZIN not found in $PEDRIN_ENV"
  exit 1
fi

echo "==> Applying cafezin migrations to $DB_HOST..."
for f in "$MIGRATIONS_DIR"/*.sql; do
  echo "  → $(basename "$f")"
  PGPASSWORD="$DB_PASS" "$PSQL" \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -f "$f" \
    --quiet
done

echo "==> Done."
