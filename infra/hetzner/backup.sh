#!/usr/bin/env bash
# ROI Dealer — nightly database dump on the server, 7 days kept (ADR-0010). The Hetzner
# "Backups" option keeps daily disk images as well; this dump is the quick way to restore data.
# With a reserve database (Railway, D-029) the dump is also restored there, so the reserve is
# at most a day behind. The restore is one transaction: on any error the reserve keeps its
# previous copy.
set -euo pipefail

ROOT=/opt/roi-dealer
DIR="$ROOT/backups"

main() {
  umask 077
  mkdir -p "$DIR"
  local file
  file="$DIR/roi_dealer-$(date -u +%Y-%m-%d).dump"
  docker compose -f "$ROOT/app/infra/hetzner/compose.yaml" --env-file "$ROOT/compose.env" \
    exec -T postgres pg_dump -U roi_dealer -d roi_dealer --format=custom >"$file.tmp"
  mv "$file.tmp" "$file"
  find "$DIR" -name 'roi_dealer-*.dump' -mtime +7 -delete
  copy_to_reserve "$file"
}

copy_to_reserve() {
  local reserve
  reserve=$(sed -n 's/^RESERVE_DATABASE_URL=//p' "$ROOT/env/reserve.env" 2>/dev/null | head -n 1)
  [[ -n "$reserve" ]] || return 0
  # shellcheck disable=SC2016 # expanded by the shell inside the postgres container
  docker compose -f "$ROOT/app/infra/hetzner/compose.yaml" --env-file "$ROOT/compose.env" \
    exec -T -e RESERVE_DATABASE_URL="$reserve" postgres sh -c \
    'pg_restore --clean --if-exists --no-owner --no-acl --single-transaction -d "$RESERVE_DATABASE_URL"' <"$1"
}

main "$@"
