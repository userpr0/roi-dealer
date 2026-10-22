#!/usr/bin/env bash
# ROI Dealer — one-time setup of a Hetzner Cloud server (ADR-0010).
#
# Run by cloud-init (infra/hetzner/cloud-init.yaml) as root on a fresh Ubuntu 24.04 server.
# Reads the owner's keys from /opt/roi-dealer/secrets.env, gives every service only its own
# variables, installs Docker, the firewall, security updates, the update and backup timers,
# takes over the data of the reserve database (Railway, D-029) when it is given and the local
# database is still empty, and starts the system. Safe to run again: the database password,
# env files and data are kept.
set -euo pipefail

ROOT=/opt/roi-dealer
APP="$ROOT/app"
ENV_DIR="$ROOT/env"
SECRETS="$ROOT/secrets.env"
REPO=https://github.com/userpr0/roi-dealer.git

main() {
  [[ $EUID -eq 0 ]] || { echo 'install.sh must run as root' >&2; exit 1; }
  umask 077
  mkdir -p "$ROOT" "$ENV_DIR" "$ROOT/backups"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl git openssl ufw unattended-upgrades docker.io docker-compose-v2
  systemctl enable --now docker

  if [[ -d "$APP/.git" ]]; then
    git -C "$APP" fetch --quiet --depth 1 origin main
    git -C "$APP" reset --quiet --hard origin/main
  else
    git clone --quiet --depth 1 "$REPO" "$APP"
  fi

  write_env_files
  install_timers
  configure_firewall
  configure_updates
  import_from_reserve

  systemctl start roi-dealer-update.service
  echo "ROI Dealer is installed: https://$(compose_value PUBLIC_HOST)"
}

# Value of KEY in secrets.env (empty when absent). The file is parsed, never sourced.
secret() {
  [[ -f "$SECRETS" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ "$key" == "$1" ]] && { printf '%s' "$value"; return 0; }
  done <"$SECRETS"
  return 0
}

compose_value() {
  [[ -f "$ROOT/compose.env" ]] || return 0
  sed -n "s/^$1=//p" "$ROOT/compose.env" | head -n 1
}

# Appends KEY=VALUE to a file only when the value is not empty: an unset optional variable
# keeps the service's default, an empty one would not.
put() {
  local file=$1 key=$2 value=$3
  [[ -n "$value" ]] && printf '%s=%s\n' "$key" "$value" >>"$file"
  return 0
}

public_ip() {
  curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null ||
    hostname -I | awk '{print $1}'
}

write_env_files() {
  local password host
  password=$(compose_value POSTGRES_PASSWORD)
  [[ -n "$password" ]] || password=$(openssl rand -hex 24)
  host=$(secret PUBLIC_HOST)
  if [[ -z "$host" ]]; then
    host="$(public_ip | tr '.' '-').sslip.io"
  fi

  cat >"$ROOT/compose.env" <<EOF
POSTGRES_PASSWORD=$password
PUBLIC_HOST=$host
IMAGE_TAG=main
ENV_DIR=$ENV_DIR
EOF

  # Without the owner's keys (a re-run after the secrets file was removed) the env files stay.
  [[ -f "$SECRETS" ]] || return 0

  local database_url="postgresql://roi_dealer:$password@postgres:5432/roi_dealer"
  local file
  for file in database bot worker api; do : >"$ENV_DIR/$file.env"; done

  put "$ENV_DIR/database.env" DATABASE_URL "$database_url"

  put "$ENV_DIR/bot.env" DATABASE_URL "$database_url"
  put "$ENV_DIR/bot.env" TELEGRAM_BOT_TOKEN "$(secret TELEGRAM_BOT_TOKEN)"
  put "$ENV_DIR/bot.env" TELEGRAM_OWNER_USER_ID "$(secret TELEGRAM_OWNER_USER_ID)"
  put "$ENV_DIR/bot.env" PUBLIC_API_URL "https://$host"

  put "$ENV_DIR/worker.env" DATABASE_URL "$database_url"
  local key
  for key in GEMINI_API_KEY GEMINIFREE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY \
    AI_MONTHLY_LIMIT_USD AI_DAILY_LIMIT_USD; do
    put "$ENV_DIR/worker.env" "$key" "$(secret "$key")"
  done

  # The reserve database (Railway, D-029): read once at install, written every night.
  : >"$ENV_DIR/reserve.env"
  put "$ENV_DIR/reserve.env" RESERVE_DATABASE_URL "$(secret RESERVE_DATABASE_URL)"

  put "$ENV_DIR/api.env" DATABASE_URL "$database_url"
  for key in TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_USER_ID PUBLIC_CONTACT_EMAIL \
    LEMONSQUEEZY_WEBHOOK_SECRET; do
    put "$ENV_DIR/api.env" "$key" "$(secret "$key")"
  done

  chmod 600 "$ROOT/compose.env" "$ENV_DIR"/*.env
  # The keys now live only in the per-service files.
  shred -u "$SECRETS" 2>/dev/null || rm -f "$SECRETS"
}

compose() {
  docker compose -f "$APP/infra/hetzner/compose.yaml" --env-file "$ROOT/compose.env" "$@"
}

# The first start takes over the reserve's data (Railway), so accesses, evidence and decisions
# carry over. Runs only while the local database has no tables: never overwrites local data.
import_from_reserve() {
  local reserve
  reserve=$(sed -n 's/^RESERVE_DATABASE_URL=//p' "$ENV_DIR/reserve.env" 2>/dev/null | head -n 1)
  [[ -n "$reserve" ]] || return 0
  compose up -d --wait postgres
  local tables
  tables=$(compose exec -T postgres psql -U roi_dealer -d roi_dealer -tAc \
    "select count(*) from information_schema.tables where table_schema = 'public'")
  if [[ "${tables//[[:space:]]/}" != "0" ]]; then
    echo 'Local database already has data: no import.'
    return 0
  fi
  echo 'Importing the data of the reserve database...'
  # shellcheck disable=SC2016 # expanded by the shell inside the postgres container
  compose exec -T -e RESERVE_DATABASE_URL="$reserve" postgres sh -c \
    'pg_dump --format=custom --no-owner --no-acl "$RESERVE_DATABASE_URL" | pg_restore --no-owner --no-acl --exit-on-error -U roi_dealer -d roi_dealer'
}

install_timers() {
  cat >/etc/systemd/system/roi-dealer-update.service <<EOF
[Unit]
Description=ROI Dealer: pull main and the CI images, migrate, restart what changed
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash $APP/infra/hetzner/update.sh
EOF
  cat >/etc/systemd/system/roi-dealer-update.timer <<'EOF'
[Unit]
Description=ROI Dealer: check for a new version every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
  cat >/etc/systemd/system/roi-dealer-backup.service <<EOF
[Unit]
Description=ROI Dealer: nightly database dump, 7 days kept
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash $APP/infra/hetzner/backup.sh
EOF
  cat >/etc/systemd/system/roi-dealer-backup.timer <<'EOF'
[Unit]
Description=ROI Dealer: database dump every night

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now roi-dealer-update.timer roi-dealer-backup.timer
}

configure_firewall() {
  # Only HTTPS (and HTTP for the certificate) from outside; SSH stays closed — the Hetzner web
  # console works without it. Docker publishes 80/443 itself; the database is never published.
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
}

configure_updates() {
  cat >/etc/apt/apt.conf.d/52roi-dealer-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
EOF
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
}

main "$@"
