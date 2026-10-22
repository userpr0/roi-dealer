#!/usr/bin/env bash
# ROI Dealer — replace one key on the server and restart the services that use it (ADR-0010).
# Run as root in the Hetzner web console:  bash /opt/roi-dealer/app/infra/hetzner/set-key.sh
# Asks for the variable name and its value; the value is not shown and not written to any log.
set -euo pipefail

ROOT=/opt/roi-dealer
ENV_DIR="$ROOT/env"

# Which services read each variable the owner may replace.
declare -A SERVICES=(
  [TELEGRAM_BOT_TOKEN]="bot api"
  [TELEGRAM_OWNER_USER_ID]="bot api"
  [PUBLIC_CONTACT_EMAIL]="api"
  [LEMONSQUEEZY_WEBHOOK_SECRET]="api"
  [GEMINIFREE_API_KEY]="worker"
  [GEMINI_API_KEY]="worker"
  [OPENAI_API_KEY]="worker"
  [ANTHROPIC_API_KEY]="worker"
  [AI_MONTHLY_LIMIT_USD]="worker"
  [AI_DAILY_LIMIT_USD]="worker"
  [RESERVE_DATABASE_URL]="reserve"
)

main() {
  [[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
  local key value service file
  read -r -p 'Variable (for example GEMINI_API_KEY): ' key
  [[ -n "${SERVICES[$key]:-}" ]] || { echo "Unknown variable: $key" >&2; exit 1; }
  read -r -s -p 'Value (empty removes it): ' value
  echo

  for service in ${SERVICES[$key]}; do
    file="$ENV_DIR/$service.env"
    touch "$file"
    grep -v "^$key=" "$file" >"$file.new" || true
    [[ -n "$value" ]] && printf '%s=%s\n' "$key" "$value" >>"$file.new"
    chmod 600 "$file.new"
    mv "$file.new" "$file"
  done

  # The reserve address is read by the nightly backup only: nothing to restart.
  if [[ "${SERVICES[$key]}" == reserve ]]; then
    echo "Done: $key updated."
    return 0
  fi
  # shellcheck disable=SC2086 # the list of services is meant to split into words
  docker compose -f "$ROOT/app/infra/hetzner/compose.yaml" --env-file "$ROOT/compose.env" \
    up -d --force-recreate ${SERVICES[$key]}
  echo "Done: $key updated for ${SERVICES[$key]}."
}

main "$@"
