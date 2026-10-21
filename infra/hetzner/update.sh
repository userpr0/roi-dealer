#!/usr/bin/env bash
# ROI Dealer — keeps the server on the latest green main (ADR-0010). Run every 5 minutes by
# roi-dealer-update.timer: pulls the repository and the CI images, applies migrations through
# the one-shot `migrate` service, and restarts only the services whose image or config changed.
set -euo pipefail

ROOT=/opt/roi-dealer
APP="$ROOT/app"

# The whole script is read before `git reset` can replace this file.
main() {
  git -C "$APP" fetch --quiet --depth 1 origin main
  git -C "$APP" reset --quiet --hard origin/main

  local compose=(docker compose -f "$APP/infra/hetzner/compose.yaml" --env-file "$ROOT/compose.env")
  "${compose[@]}" pull --quiet
  "${compose[@]}" up -d --remove-orphans
  docker image prune -f >/dev/null
}

main "$@"
exit 0
