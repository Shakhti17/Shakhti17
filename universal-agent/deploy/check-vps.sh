#!/usr/bin/env sh
# Read-only check: can this server run Ofis? Changes nothing.
#   curl -fsSL https://raw.githubusercontent.com/Shakhti17/Shakhti17/claude/quirky-babbage-35531k/universal-agent/deploy/check-vps.sh | sh
# or copy this file to the server and run: sh check-vps.sh

ok()   { printf '  [ok]   %s\n' "$1"; }
warn() { printf '  [warn] %s\n' "$1"; }
bad()  { printf '  [no]   %s\n' "$1"; }

echo "== System"
[ -r /etc/os-release ] && . /etc/os-release && echo "  OS: ${PRETTY_NAME:-unknown}"
echo "  Kernel: $(uname -r), arch: $(uname -m)"
CPUS=$(nproc 2>/dev/null || echo 1)
echo "  CPUs: $CPUS"

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
echo "  RAM: ${MEM_MB} MB total, ${AVAIL_MB} MB available, swap ${SWAP_MB} MB"
if [ "$MEM_MB" -ge 1800 ]; then ok "RAM is plenty"
elif [ "$MEM_MB" -ge 900 ]; then ok "RAM is enough (add 1-2 GB swap for builds)"
elif [ "$MEM_MB" -ge 450 ]; then warn "RAM is tight: add 2 GB swap; Docker builds may be slow"
else bad "under 512 MB RAM: too small"; fi

DISK_GB=$(df -Pk / | awk 'NR==2 {print int($4/1024/1024)}')
echo "  Free disk on /: ${DISK_GB} GB"
if [ "$DISK_GB" -ge 5 ]; then ok "disk space is enough"
elif [ "$DISK_GB" -ge 3 ]; then warn "disk is tight (Docker image + workspace need ~3 GB)"
else bad "less than 3 GB free"; fi

echo "== Software"
if command -v docker >/dev/null 2>&1; then
  ok "Docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
  docker compose version >/dev/null 2>&1 && ok "docker compose available" || warn "docker compose plugin missing"
else warn "Docker not installed (installable with one command)"; fi
command -v node >/dev/null 2>&1 && echo "  Node.js: $(node -v)" || echo "  Node.js: not installed (not needed with Docker)"
command -v git  >/dev/null 2>&1 && ok "git installed" || warn "git not installed"
for p in caddy nginx apache2 httpd; do command -v "$p" >/dev/null 2>&1 && echo "  Web server present: $p"; done

echo "== Network"
if command -v ss >/dev/null 2>&1; then
  for port in 80 443 3000; do
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port\$" && warn "port $port already in use" || ok "port $port free"
  done
fi
PUBLIC_IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || echo unknown)
echo "  Public IP: $PUBLIC_IP"
curl -fsS -m 8 -o /dev/null https://api.anthropic.com/v1/models 2>/dev/null; CODE=$?
# 22 = HTTP error (401 without a key) means the API is reachable.
if [ "$CODE" -eq 0 ] || [ "$CODE" -eq 22 ]; then ok "can reach api.anthropic.com"; else bad "cannot reach api.anthropic.com (curl exit $CODE)"; fi
command -v ufw >/dev/null 2>&1 && echo "  Firewall (ufw): $(ufw status 2>/dev/null | head -1)"
echo "== Done. Paste everything above back to Claude."
