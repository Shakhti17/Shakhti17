#!/usr/bin/env bash
# One-command setup (and update) of Ofis on an Ubuntu/Debian server.
#
#   curl -fsSL https://raw.githubusercontent.com/Shakhti17/Shakhti17/main/universal-agent/deploy/install.sh | sudo bash
#
# It asks for anything it needs. To skip the questions, pass values in:
#   ... | sudo ANTHROPIC_API_KEY=sk-ant-... APP_PASSWORD=... DOMAIN=ofis.example.uz bash
#
# Safe to run again: it pulls the latest code and restarts, keeping your .env,
# conversations, memory and files.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Shakhti17/Shakhti17.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/ofis}"
APP_DIR="$INSTALL_DIR/universal-agent"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# Read a value from the terminal even when this script is piped into bash.
ask() {
  local prompt="$1" secret="${2:-}" value=""
  [ -r /dev/tty ] || die "no terminal to ask for ${prompt}; pass it as an environment variable instead"
  if [ -n "$secret" ]; then
    read -r -s -p "    $prompt: " value </dev/tty
    printf '\n' >/dev/tty
  else
    read -r -p "    $prompt: " value </dev/tty
  fi
  printf '%s' "$value"
}

[ "$(id -u)" -eq 0 ] || die "run as root (prefix the command with sudo)"
command -v apt-get >/dev/null 2>&1 || die "this script supports Ubuntu/Debian (apt). See the README for manual steps."

# ---------- 1. memory: builds need headroom on small servers ----------
say "Checking memory and disk"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_GB=$(df -Pk / | awk 'NR==2 {print int($4/1024/1024)}')
info "RAM ${MEM_MB} MB, swap ${SWAP_MB} MB, free disk ${DISK_GB} GB"
[ "$MEM_MB" -ge 450 ] || die "at least 512 MB RAM is needed"
[ "$DISK_GB" -ge 3 ] || die "at least 3 GB of free disk is needed"
if [ "$MEM_MB" -lt 2000 ] && [ "$SWAP_MB" -lt 1000 ] && [ ! -e /swapfile ]; then
  info "Adding a 2 GB swap file so builds don't run out of memory"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------- 2. packages and Docker ----------
say "Installing git, curl and Docker (if missing)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null
info "$(docker --version)"

# ---------- 3. code ----------
say "Getting the code ($BRANCH)"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch -q origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi
info "$(git -C "$INSTALL_DIR" log -1 --format='%h %s')"

# ---------- 4. settings (.env) ----------
cd "$APP_DIR"
PUBLIC_IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
if [ ! -f .env ]; then
  say "Settings"
  KEY="${ANTHROPIC_API_KEY:-}"
  [ -n "$KEY" ] || KEY=$(ask "Anthropic API key (sk-ant-...)" secret)
  [ -n "$KEY" ] || die "an Anthropic API key is required"
  PASS="${APP_PASSWORD:-}"
  [ -n "$PASS" ] || PASS=$(ask "Password to sign in to Ofis (8+ characters)" secret)
  [ "${#PASS}" -ge 8 ] || die "the password must be at least 8 characters"
  DEFAULT_DOMAIN="$(echo "$PUBLIC_IP" | tr . -).sslip.io"
  DOM="${DOMAIN:-}"
  if [ -z "$DOM" ]; then
    DOM=$(ask "Domain for HTTPS (press Enter to use $DEFAULT_DOMAIN)")
    DOM="${DOM:-$DEFAULT_DOMAIN}"
  fi
  umask 077
  cat > .env <<ENV
ANTHROPIC_API_KEY=$KEY
APP_PASSWORD=$PASS
SESSION_SECRET=$(openssl rand -hex 32)
TRUST_PROXY=1
DOMAIN=$DOM
ENV
  umask 022
  info "Saved to $APP_DIR/.env (readable by root only)"
else
  info "Keeping existing settings in $APP_DIR/.env"
fi
DOM=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
[ -n "$DOM" ] || die "DOMAIN is empty in $APP_DIR/.env"

# ---------- 5. ports ----------
say "Checking ports"
# Stop a previous Ofis run first so its own ports don't look taken (data volumes are kept).
docker compose --profile https down --remove-orphans >/dev/null 2>&1 || true

port_in_use() {
  # Something answers on the port (works even where `ss` is missing)...
  timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$1" 2>/dev/null && return 0
  # ...or something listens on it, or a Docker container has claimed it.
  ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . && return 0
  docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE "(^|[ ,:])$1->" && return 0
  return 1
}
port_owner() {
  ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2
  docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E "(^|[ ,:])$1->" | awk '{print "container " $1}'
}
set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

OFIS_PORT=$(grep -E '^OFIS_PORT=' .env | cut -d= -f2- || true)
if [ -z "$OFIS_PORT" ] || port_in_use "$OFIS_PORT"; then
  for candidate in $(seq 3000 3100); do
    if ! port_in_use "$candidate"; then OFIS_PORT=$candidate; break; fi
  done
fi
[ -n "$OFIS_PORT" ] || die "no free port between 3000 and 3100 for Ofis"
set_env OFIS_PORT "$OFIS_PORT"
info "Ofis will listen on 127.0.0.1:$OFIS_PORT (private; the public site goes through HTTPS)"

BLOCKED=""
for p in 80 443; do
  if port_in_use "$p"; then
    BLOCKED="$BLOCKED $p"
    info "Port $p is already used by: $(port_owner "$p" | tr '\n' ' ')"
  fi
done

# ---------- 6. firewall ----------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in ufw"
  ufw allow OpenSSH >/dev/null || true
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# ---------- 7. start ----------
say "Building and starting Ofis (the first build takes a few minutes)"
if [ -n "$BLOCKED" ]; then
  # Start Ofis itself so nothing is wasted, but not Caddy, which needs 80 and 443.
  docker compose up -d --build --remove-orphans ofis
else
  docker compose --profile https up -d --build --remove-orphans
fi

say "Waiting for Ofis to answer"
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "http://127.0.0.1:$OFIS_PORT/api/me" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [ "${READY:-0}" != 1 ]; then
  docker compose logs --tail 40 ofis || true
  die "Ofis did not start; the logs above show why"
fi

if [ -n "$BLOCKED" ]; then
  say "Ofis is running, but HTTPS could not start"
  info "Port(s)$BLOCKED are taken by another program (listed above). Caddy needs ports 80 and 443"
  info "to get a free HTTPS certificate. Send this output to Claude to finish the setup."
  exit 2
fi

say "Done"
info "Open:      https://$DOM"
info "Sign in with the password you set (APP_PASSWORD in $APP_DIR/.env)."
info "The HTTPS certificate is issued on the first visit and can take up to a minute."
info "If the page doesn't load, make sure ports 80 and 443 are open in your VPS provider's firewall."
info ""
info "Logs:      cd $APP_DIR && docker compose logs -f"
info "Update:    run this script again"
info "Stop:      cd $APP_DIR && docker compose --profile https down"
