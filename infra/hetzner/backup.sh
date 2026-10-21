#!/usr/bin/env bash
# ROI Dealer — nightly database dump on the server, 7 days kept (ADR-0010). The Hetzner
# "Backups" option keeps daily disk images as well; this dump is the quick way to restore data.
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
}

main "$@"
