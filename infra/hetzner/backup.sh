#!/usr/bin/env bash
# ROI Dealer — nightly database dump on the server, 7 days kept (ADR-0010). The Hetzner
# "Backups" option keeps daily disk images as well; this dump is the quick way to restore data.
# With a reserve database (Railway, D-029) the dump is also restored there, so the reserve is
# at most a day behind. The restore is one transaction: on any error the reserve keeps its
# previous copy. Only after both succeed it marks the backup in the database (migration 0020):
# the bot's watchdog tells the owner when no backup has succeeded for 26 hours.
set -euo pipefail

ROOT=/opt/roi-dealer
DIR="$ROOT/backups"
COMPOSE=(docker compose -f "$ROOT/app/infra/hetzner/compose.yaml" --env-file "$ROOT/compose.env")

main() {
  umask 077
  mkdir -p "$DIR"
  local file
  file="$DIR/roi_dealer-$(date -u +%Y-%m-%d).dump"
  "${COMPOSE[@]}" exec -T postgres pg_dump -U roi_dealer -d roi_dealer --format=custom >"$file.tmp"
  mv "$file.tmp" "$file"
  find "$DIR" -name 'roi_dealer-*.dump' -mtime +7 -delete
  local reserve=0
  if copy_to_reserve "$file"; then reserve=1; fi
  "${COMPOSE[@]}" run --rm --no-deps -e BACKUP_RESERVE="$reserve" migrate \
    node /app/node_modules/@roi-dealer/database/dist/backup-mark-cli.js
}

copy_to_reserve() {
  local reserve
  reserve=$(sed -n 's/^RESERVE_DATABASE_URL=//p' "$ROOT/env/reserve.env" 2>/dev/null | head -n 1)
  # No reserve configured: nothing to copy (status 1, not an error).
  [[ -n "$reserve" ]] || return 1
  # A failed restore stops the script (set -e) before the backup is marked.
  # shellcheck disable=SC2016 # expanded by the shell inside the postgres container
  "${COMPOSE[@]}" exec -T -e RESERVE_DATABASE_URL="$reserve" postgres sh -c \
    'pg_restore --clean --if-exists --no-owner --no-acl --single-transaction -d "$RESERVE_DATABASE_URL"' <"$1" \
    || exit 1
}

main "$@"
