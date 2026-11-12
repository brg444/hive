#!/bin/sh
# Build arkade-os/delegatee at the commit v4 is tested against and run it
# beside a local regtest stack. Every DELEGATEE_* variable can be overridden;
# DELEGATEE_DATABASE_URL has no default and must name a Postgres database.
#
#   DELEGATEE_DATABASE_URL='postgres://postgres@localhost:5432/delegatee?sslmode=disable' tools/delegatee.sh
#
# The source lives in .local/delegatee, the binary in .local/bin, and the
# delegate key, created once, in .secrets/v4/delegate-key. The delegate key is
# part of every address the delegatee renews: keep it for the stack's life.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMMIT=e8a739006fc95932757e936e437830493d46d576
SRC="$ROOT/.local/delegatee"
BIN="$ROOT/.local/bin/delegateed-$COMMIT"
KEY="$ROOT/.secrets/v4/delegate-key"

if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/arkade-os/delegatee "$SRC"
fi
if [ "$(git -C "$SRC" rev-parse HEAD)" != "$COMMIT" ]; then
  git -C "$SRC" cat-file -e "$COMMIT^{commit}" 2>/dev/null || git -C "$SRC" fetch origin
  git -C "$SRC" checkout -q "$COMMIT"
fi
if [ ! -x "$BIN" ]; then
  mkdir -p "$(dirname "$BIN")"
  (cd "$SRC" && go build -o "$BIN" ./cmd/delegateed)
fi
if [ ! -f "$KEY" ]; then
  (umask 077 && mkdir -p "$(dirname "$KEY")" && openssl rand -hex 32 > "$KEY")
fi

: "${DELEGATEE_DATABASE_URL:?set DELEGATEE_DATABASE_URL to a Postgres database for the delegatee}"
export DELEGATEE_DATABASE_URL
export DELEGATEE_ARK_URL="${DELEGATEE_ARK_URL:-localhost:7070}"
export DELEGATEE_EMULATOR_URL="${DELEGATEE_EMULATOR_URL:-localhost:7073}"
export DELEGATEE_EXPLORER_URL="${DELEGATEE_EXPLORER_URL:-http://localhost:3000/api}"
export DELEGATEE_DELEGATE_KEY="${DELEGATEE_DELEGATE_KEY:-$(cat "$KEY")}"
export DELEGATEE_ADMIN_AUTH="${DELEGATEE_ADMIN_AUTH:-disabled}"
export DELEGATEE_PORT="${DELEGATEE_PORT:-7090}"
export DELEGATEE_ADMIN_PORT="${DELEGATEE_ADMIN_PORT:-7091}"
# Regtest batches live about an hour: scan often, accept watches without a long expiry,
# and submit renewals an hour before expiry, twice the two-minute session limit and more.
export DELEGATEE_POLL_INTERVAL="${DELEGATEE_POLL_INTERVAL:-5s}"
export DELEGATEE_MIN_WATCH_EXPIRY="${DELEGATEE_MIN_WATCH_EXPIRY:-0}"
export DELEGATEE_RENEWAL_TIMEOUT="${DELEGATEE_RENEWAL_TIMEOUT:-2m}"
export DELEGATEE_RENEWAL_RESERVE="${DELEGATEE_RENEWAL_RESERVE:-60m}"
export DELEGATEE_PUBLIC_RATE_LIMIT="${DELEGATEE_PUBLIC_RATE_LIMIT:-100}"
exec "$BIN"
