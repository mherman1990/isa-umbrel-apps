#!/usr/bin/env bash
# install-pi.sh — set up polibrief on a Raspberry Pi (bare metal, no Docker).
#
# This is the FALLBACK path. The recommended path is the Umbrel app (see the
# README section "Deploying to the Raspberry Pi") which gives you a clickable
# dashboard tile. Use this script if you'd rather run polibrief directly with
# cron and no containers.
#
# Safe to run more than once — it skips anything already done.
#
# Usage (from the polibrief folder on the Pi):
#   bash scripts/install-pi.sh

set -euo pipefail

say()  { printf "\n\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\n\033[1;33m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[1;31m%s\033[0m\n" "$*"; exit 1; }

# ---------------------------------------------------------------- 1. sanity checks
say "1/5 Checking this machine…"

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) say "   ✓ ARM64 processor ($ARCH) — good, this is a Pi (or similar)";;
  x86_64)        warn "   This is an x86_64 machine, not a Pi. Continuing anyway — everything still works.";;
  *)             fail "   Unsupported processor: $ARCH. polibrief needs ARM64 or x86_64.";;
esac

if [ -f /etc/debian_version ]; then
  say "   ✓ Debian-based OS ($(cat /etc/debian_version))"
else
  warn "   This doesn't look like Debian/umbrelOS. Continuing, but paths in the docs may differ."
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
say "   ✓ Project folder: $PROJECT_DIR"

# ---------------------------------------------------------------- 2. Node 20 via nvm
say "2/5 Checking Node.js…"

export NVM_DIR="$HOME/.nvm"

if command -v node >/dev/null 2>&1 && [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 20 ]; then
  say "   ✓ Node $(node --version) already installed"
else
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    say "   Installing nvm (Node version manager)…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  say "   Installing Node 20 LTS (this can take a few minutes on a Pi)…"
  nvm install 20
  nvm alias default 20
  say "   ✓ Node $(node --version) installed"
fi

# ---------------------------------------------------------------- 3. npm install
say "3/5 Installing polibrief's dependencies…"
cd "$PROJECT_DIR"
npm install --omit=dev

say "   Verifying the database engine (better-sqlite3) built correctly…"
node -e "import('better-sqlite3').then(m => { new m.default(':memory:').exec('CREATE TABLE t(x)'); console.log('   ✓ better-sqlite3 works'); })" \
  || fail "   better-sqlite3 failed to load. Try: npm rebuild better-sqlite3 --build-from-source (needs: sudo apt install -y build-essential python3)"

# ---------------------------------------------------------------- 4. .env
say "4/5 Checking configuration…"
if [ ! -f "$PROJECT_DIR/.env" ]; then
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  warn "   ➜ EDIT .env NOW:  nano $PROJECT_DIR/.env"
  warn "     Paste in your ANTHROPIC_API_KEY, CONGRESS_GOV_API_KEY, and LEGISCAN_API_KEY."
  warn "     (Where to get each key is in the README under 'Getting Your API Keys'.)"
else
  say "   ✓ .env already exists — leaving it alone"
fi

mkdir -p "$PROJECT_DIR/logs" "$PROJECT_DIR/briefings"

# ---------------------------------------------------------------- 5. cron
say "5/5 Almost done — schedule the twice-daily runs."
NODE_BIN="$(command -v node)"
cat <<EOF

polibrief does NOT install cron entries automatically. To add them, run:

    crontab -e

…and paste in these two lines (see scripts/crontab.example for timezone notes):

    30 6  * * * cd $PROJECT_DIR && $NODE_BIN src/index.js run --edition am >> logs/cron.log 2>&1
    30 16 * * * cd $PROJECT_DIR && $NODE_BIN src/index.js run --edition pm >> logs/cron.log 2>&1

Or skip cron entirely and run the web app (it schedules itself):

    node src/index.js serve
    # then open http://<this-machine>:8484  (works over Tailscale too)

Test everything first with:

    node src/index.js run --dry-run

EOF
say "✅ Install complete."
