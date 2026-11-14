#!/bin/sh
# Sets up a Hive host on Debian 12 or Ubuntu 24.04: the Hive service, the delegatee and its
# Postgres database, the keeper console on its own origin, TLS through Caddy, and backups. Run it as
# root from a checkout of the repository; it copies the checkout to /opt/hive and can be run again
# after each update.
#
#   sudo deploy/setup.sh
#
# The first run writes /etc/hive/hive.env from deploy/hive.env.example and stops, for the two host
# names, the Emulator's address, the delegatee's admin users and the backup key to be filled in.
# Point both host names at this server before the second run, so Caddy can obtain certificates.
#
# Two users run the host, so what faces the network holds as little as it can. `hive` runs the
# service and each hive's agent node: it keeps the channels, the desks and the agents' receipt
# keys. `hive-delegatee` runs the delegatee: it alone reads the delegate key and its database.
# The code in /opt/hive belongs to root, and neither can change it.
#
# Nothing here turns mainnet on: BUZZ_MAINNET stays commented out in hive.env until you enable it.
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
# What is installed for the services to read is readable; what is private is given its mode by name.
umask 022
SRC=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/hive
ENV=/etc/hive/hive.env
DHOME=/var/lib/hive-delegatee
BACKUPS=/var/backups/hive
NODE_VERSION="${NODE_VERSION:-22.23.4}"
GO_VERSION="${GO_VERSION:-$(sed -n 's/^go //p' "$SRC/.local/delegatee/go.mod" 2>/dev/null || echo 1.26.9)}"
ARCH=$(dpkg --print-architecture)
TOOLS="/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"

# The checksums nodejs.org and go.dev publish for the releases named above. Another release needs
# its own, given as NODE_SHA256 or GO_SHA256.
published_sum() {
  case "$1" in
    node-v22.23.4-linux-x64.tar.xz) echo 1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;;
    node-v22.23.4-linux-arm64.tar.xz) echo 6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;;
    go1.26.9.linux-amd64.tar.gz) echo 42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d ;;
    go1.26.9.linux-arm64.tar.gz) echo 4a97373d49fcacdcf3694fea368a500b00ee3e963974f3e7514132717632f052 ;;
  esac
}
# Downloads a release to a file and prints its path, once it is the file its publisher names:
# nothing is unpacked that does not match its checksum.
download() {
  dl_url=$1 dl_name=$2 dl_sum=${3:-$(published_sum "$2")} dl_var=$4
  [ -n "$dl_sum" ] || { echo "no checksum known for $dl_name: set $dl_var to the one its publisher lists" >&2; exit 2; }
  dl_dir=$(mktemp -d)
  curl -fsSL -o "$dl_dir/$dl_name" "$dl_url"
  echo "$dl_sum  $dl_dir/$dl_name" | sha256sum -c - >/dev/null 2>&1 \
    || { echo "$dl_name does not match its checksum; nothing was installed from it" >&2; rm -rf "$dl_dir"; exit 1; }
  echo "$dl_dir/$dl_name"
}

if [ ! -f "$ENV" ]; then
  install -d -m 750 /etc/hive
  install -m 640 "$SRC/deploy/hive.env.example" "$ENV"
  echo "Wrote $ENV: fill it in, point both host names at this server, and run setup.sh again."
  exit 0
fi
# A host set up when one user ran everything named that user's database role here.
sed -i 's|^\(DELEGATEE_DATABASE_URL="\{0,1\}postgres://\)hive@/|\1hive-delegatee@/|' "$ENV"
set -a; . "$ENV"; set +a
for v in HIVE_HOST KEEPER_HOST DELEGATEE_EMULATOR_URL HIVE_BACKUP_RECIPIENT; do
  eval "[ -n \"\${$v:-}\" ]" || { echo "$v is empty in $ENV" >&2; exit 2; }
done
[ -f "${DELEGATEE_ADMIN_USERS_FILE:-/nonexistent}" ] || { echo "DELEGATEE_ADMIN_USERS_FILE names no file" >&2; exit 2; }

echo "== packages"
apt-get update -q
apt-get install -yq git curl ca-certificates xz-utils build-essential postgresql age caddy rsync

if ! node --version 2>/dev/null | grep -q "^v$NODE_VERSION$"; then
  case "$ARCH" in amd64) N=x64 ;; arm64) N=arm64 ;; *) echo "unsupported architecture $ARCH" >&2; exit 2 ;; esac
  FILE=$(download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$N.tar.xz" \
    "node-v$NODE_VERSION-linux-$N.tar.xz" "${NODE_SHA256:-}" NODE_SHA256)
  tar xJ -C /usr/local --strip-components=1 -f "$FILE"
  rm -rf "$(dirname "$FILE")"
fi
corepack enable
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go$GO_VERSION "; then
  FILE=$(download "https://go.dev/dl/go$GO_VERSION.linux-$ARCH.tar.gz" \
    "go$GO_VERSION.linux-$ARCH.tar.gz" "${GO_SHA256:-}" GO_SHA256)
  rm -rf /usr/local/go
  tar xz -C /usr/local -f "$FILE"
  rm -rf "$(dirname "$FILE")"
fi

echo "== the users and the code"
id hive >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/hive --shell /usr/sbin/nologin hive
id hive-delegatee >/dev/null 2>&1 \
  || useradd --system --create-home --home-dir "$DHOME" --shell /usr/sbin/nologin hive-delegatee
# hive.env is read for both services; the delegatee's admin list by the delegatee alone.
usermod -aG hive hive-delegatee
chgrp hive "$ENV" /etc/hive
chmod 640 "$ENV"
chgrp hive-delegatee "$DELEGATEE_ADMIN_USERS_FILE"
chmod 640 "$DELEGATEE_ADMIN_USERS_FILE"
install -d -m 755 "$APP"
install -d -o hive -g hive -m 700 "$APP/.local" "$APP/.secrets"
install -d -o hive-delegatee -g hive-delegatee -m 700 "$DHOME"
install -d -m 700 "$BACKUPS"
# The checkout's code only: state and keys on this host are never overwritten from it.
rsync -a --delete --exclude .git --exclude .local --exclude .secrets --exclude node_modules \
  --exclude '*/node_modules' --exclude dist --exclude target "$SRC/" "$APP/"
# The code is root's, readable by the services and writable by neither. Their state stays theirs.
find "$APP" \( -path "$APP/.local" -o -path "$APP/.secrets" \) -prune -o -exec chown -h root:root {} +
find "$APP" \( -path "$APP/.local" -o -path "$APP/.secrets" \) -prune -o ! -type l -exec chmod go+rX,go-w {} +
chown -R hive:hive "$APP/.local" "$APP/.secrets"
# Dependencies at the versions the lockfiles name, with no package's install script run as root.
(cd "$APP" && pnpm install --frozen-lockfile --ignore-scripts)
(cd "$APP/hive/hive-buzz" && npm ci --ignore-scripts --no-audit --no-fund)
# Runs a command as one of the two users, with hive.env loaded as the services load it.
as_user() {
  as_name=$1 as_home=$2
  shift 2
  runuser -u "$as_name" -- env HOME="$as_home" DELEGATEE_HOME="$DHOME" PATH="$TOOLS" \
    sh -c 'set -a; . "$0"; set +a; exec "$@"' "$ENV" "$@"
}
# The operator's commands run as hive: its copy of pnpm is fetched now, not on first use.
(cd "$APP" && as_user hive /var/lib/hive pnpm --version >/dev/null)

echo "== the delegatee's database"
has_role() { runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$1'" | grep -q 1; }
has_role hive-delegatee || runuser -u postgres -- createuser hive-delegatee
if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='delegatee'" | grep -q 1; then
  # A database made when one user ran everything passes to the delegatee's own role, whole.
  if has_role hive; then
    systemctl stop hive-delegatee.service 2>/dev/null || true
    runuser -u postgres -- psql -d delegatee -qc 'REASSIGN OWNED BY hive TO "hive-delegatee"'
  fi
else
  runuser -u postgres -- createdb -O hive-delegatee delegatee
fi

echo "== the delegatee: built at its pinned commit, its delegate key made once"
case "${DELEGATEE_NETWORK:-regtest}" in bitcoin) KEYS=bitcoin ;; *) KEYS=v4 ;; esac
install -d -o hive-delegatee -g hive-delegatee -m 700 "$DHOME/.secrets" "$DHOME/.secrets/$KEYS"
# A delegate key made when one user ran everything moves to the delegatee's own home. It is part of
# every address the delegatee renews, so it is copied, compared, and only then removed.
if [ -f "$APP/.secrets/$KEYS/delegate-key" ] && [ ! -f "$DHOME/.secrets/$KEYS/delegate-key" ]; then
  systemctl stop hive-delegatee.service 2>/dev/null || true
  install -o hive-delegatee -g hive-delegatee -m 600 "$APP/.secrets/$KEYS/delegate-key" "$DHOME/.secrets/$KEYS/delegate-key"
  cmp -s "$APP/.secrets/$KEYS/delegate-key" "$DHOME/.secrets/$KEYS/delegate-key" \
    || { echo "the delegate key did not copy whole; both files are left as they are" >&2; exit 1; }
  rm -f "$APP/.secrets/$KEYS/delegate-key"
fi
(cd "$DHOME" && as_user hive-delegatee "$DHOME" env DELEGATEE_BUILD_ONLY=1 "$APP/tools/delegatee.sh")

echo "== the keeper console, on its own origin"
CONSOLE_FLAG=""
[ "${HIVE_NETWORK:-}" = bitcoin ] && CONSOLE_FLAG=--mainnet
(cd "$APP/hive/hive-buzz" && as_user hive /var/lib/hive node keeper/build.mjs "$APP/.local/keeper" $CONSOLE_FLAG)
install -d -m 755 /srv/hive/keeper
install -m 644 "$APP/.local/keeper/index.html" "$APP/.local/keeper/console.js" "$APP/.local/keeper/SHA256SUMS" /srv/hive/keeper/

echo "== services"
install -m 644 "$APP"/deploy/systemd/*.service "$APP"/deploy/systemd/*.timer /etc/systemd/system/
install -m 644 "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s\n' "$ENV" > /etc/systemd/system/caddy.service.d/hive.conf
systemctl daemon-reload
systemctl enable hive-delegatee.service
systemctl restart hive-delegatee.service
# The hive's tools pin the delegate key the delegatee names; it is public, so it goes in hive.env.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  KEY=$(curl -fsS http://127.0.0.1:7090/v1/info 2>/dev/null | sed -n 's/.*"delegatePubkey" *: *"\([0-9a-f]*\)".*/\1/p')
  [ -n "$KEY" ] && break
  sleep 2
done
[ -n "${KEY:-}" ] || { echo "the delegatee did not answer on 127.0.0.1:7090; see journalctl -u hive-delegatee" >&2; exit 1; }
sed -i "s/^BUZZ_DELEGATE_KEY=.*/BUZZ_DELEGATE_KEY=$KEY/" "$ENV"
systemctl enable --now hive-service.service hive-backup.timer hive-check.timer
systemctl restart hive-service.service caddy
# A first backup now, with the delegate key in it, before any coin arrives.
systemctl start hive-backup.service

echo
echo "Service:  https://$HIVE_HOST/healthz"
echo "Console:  https://$KEEPER_HOST/  (hashes below; keepers can build the same and compare)"
cat /srv/hive/keeper/SHA256SUMS
echo "Delegate key: $KEY"
echo "Backups:  $BACKUPS, every six hours; copy them off this host"
echo "Approve a hive once HiveBot asks for it, with HiveBot's key as its profile in the channel shows it:"
echo "  cd $APP && sudo -u hive pnpm ops service-list --network ${HIVE_NETWORK:-bitcoin}"
echo "  cd $APP && sudo -u hive pnpm ops service-approve <hive> --bot <npub> --network ${HIVE_NETWORK:-bitcoin}"
