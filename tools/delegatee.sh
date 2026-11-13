#!/bin/sh
# Build arkade-os/delegatee at the commit v4 is tested against and run it
# beside a local regtest stack, or, with DELEGATEE_NETWORK=bitcoin, on a
# hive's server for mainnet. Every DELEGATEE_* variable can be overridden;
# DELEGATEE_DATABASE_URL has no default and must name a Postgres database.
#
#   DELEGATEE_DATABASE_URL='postgres://postgres@localhost:5432/delegatee?sslmode=disable' tools/delegatee.sh
#
# On mainnet it talks to Ark Labs' Operator at https://arkade.computer, and
# DELEGATEE_EMULATOR_URL must name the mainnet Emulator, which stays in the
# server's environment and out of the repository. Its delegate key is kept in
# .secrets/bitcoin/delegate-key, apart from any test stack's, and the hive's
# tools pin it through BUZZ_DELEGATE_KEY (its /v1/info names it as
# delegatePubkey). The admin port needs DELEGATEE_ADMIN_AUTH set on mainnet.
#
# The source lives in .local/delegatee, the binary in .local/bin, and the
# delegate key, created once, in .secrets/v4/delegate-key. The delegate key is
# part of every address the delegatee renews: keep it for the stack's life.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMMIT=e8a739006fc95932757e936e437830493d46d576
SRC="$ROOT/.local/delegatee"
BIN="$ROOT/.local/bin/delegateed-$COMMIT"
NETWORK="${DELEGATEE_NETWORK:-regtest}"
case "$NETWORK" in
  regtest) KEY="$ROOT/.secrets/v4/delegate-key" ;;
  bitcoin)
    KEY="$ROOT/.secrets/bitcoin/delegate-key"
    # Checked before anything is built or a key is made.
    : "${DELEGATEE_EMULATOR_URL:?set DELEGATEE_EMULATOR_URL to the mainnet Emulator}"
    : "${DELEGATEE_ADMIN_AUTH:?set DELEGATEE_ADMIN_AUTH (file, with DELEGATEE_ADMIN_USERS_FILE) for a mainnet delegatee}"
    : "${DELEGATEE_DATABASE_URL:?set DELEGATEE_DATABASE_URL to a Postgres database for the delegatee}" ;;
  *) echo "DELEGATEE_NETWORK is regtest or bitcoin" >&2; exit 2 ;;
esac

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
export DELEGATEE_DELEGATE_KEY="${DELEGATEE_DELEGATE_KEY:-$(cat "$KEY")}"
export DELEGATEE_PORT="${DELEGATEE_PORT:-7090}"
export DELEGATEE_ADMIN_PORT="${DELEGATEE_ADMIN_PORT:-7091}"
if [ "$NETWORK" = bitcoin ]; then
  # Mainnet keeps the delegatee's own defaults: batches last weeks, so it scans each minute and
  # renews hours ahead of expiry.
  export DELEGATEE_EMULATOR_URL DELEGATEE_ADMIN_AUTH
  export DELEGATEE_ARK_URL="${DELEGATEE_ARK_URL:-https://arkade.computer}"
  export DELEGATEE_EXPLORER_URL="${DELEGATEE_EXPLORER_URL:-https://mempool.space/api}"
else
  export DELEGATEE_ARK_URL="${DELEGATEE_ARK_URL:-localhost:7070}"
  export DELEGATEE_EMULATOR_URL="${DELEGATEE_EMULATOR_URL:-localhost:7073}"
  export DELEGATEE_EXPLORER_URL="${DELEGATEE_EXPLORER_URL:-http://localhost:3000/api}"
  export DELEGATEE_ADMIN_AUTH="${DELEGATEE_ADMIN_AUTH:-disabled}"
  # Regtest batches live about an hour: scan often, accept watches without a long expiry,
  # and submit renewals an hour before expiry, twice the two-minute session limit and more.
  export DELEGATEE_POLL_INTERVAL="${DELEGATEE_POLL_INTERVAL:-5s}"
  export DELEGATEE_MIN_WATCH_EXPIRY="${DELEGATEE_MIN_WATCH_EXPIRY:-0}"
  export DELEGATEE_RENEWAL_TIMEOUT="${DELEGATEE_RENEWAL_TIMEOUT:-2m}"
  export DELEGATEE_RENEWAL_RESERVE="${DELEGATEE_RENEWAL_RESERVE:-60m}"
  export DELEGATEE_PUBLIC_RATE_LIMIT="${DELEGATEE_PUBLIC_RATE_LIMIT:-100}"
fi
exec "$BIN"
