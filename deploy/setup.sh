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
# Nothing here turns mainnet on: BUZZ_MAINNET stays commented out in hive.env until you enable it.
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
SRC=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/hive
ENV=/etc/hive/hive.env
NODE_VERSION="${NODE_VERSION:-22.23.4}"
GO_VERSION="${GO_VERSION:-$(sed -n 's/^go //p' "$SRC/.local/delegatee/go.mod" 2>/dev/null || echo 1.26.9)}"
ARCH=$(dpkg --print-architecture)

if [ ! -f "$ENV" ]; then
  install -d -m 750 /etc/hive
  install -m 640 "$SRC/deploy/hive.env.example" "$ENV"
  echo "Wrote $ENV: fill it in, point both host names at this server, and run setup.sh again."
  exit 0
fi
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
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$N.tar.xz" | tar xJ -C /usr/local --strip-components=1
fi
corepack enable
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go$GO_VERSION "; then
  rm -rf /usr/local/go
  curl -fsSL "https://go.dev/dl/go$GO_VERSION.linux-$ARCH.tar.gz" | tar xz -C /usr/local
fi

echo "== the hive user and the code"
id hive >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/hive --shell /usr/sbin/nologin hive
chgrp hive "$ENV" /etc/hive "$DELEGATEE_ADMIN_USERS_FILE"
chmod 640 "$ENV" "$DELEGATEE_ADMIN_USERS_FILE"
install -d -o hive -g hive -m 700 "$APP" "$APP/.local" "$APP/.secrets"
# The checkout's code only: state and keys on this host are never overwritten from it.
rsync -a --delete --exclude .git --exclude .local --exclude .secrets --exclude node_modules \
  --exclude '*/node_modules' --exclude dist --exclude target "$SRC/" "$APP/"
chown -R hive:hive "$APP"
# Runs a command as the hive user, with hive.env loaded as the services load it.
as_hive() {
  runuser -u hive -- env HOME=/var/lib/hive PATH="/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin" \
    sh -c 'set -a; . "$0"; set +a; exec "$@"' "$ENV" "$@"
}
(cd "$APP" && as_hive pnpm install --frozen-lockfile)
(cd "$APP/hive/hive-buzz" && as_hive npm install --no-audit --no-fund)

echo "== the delegatee's database"
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='hive'" | grep -q 1 \
  || runuser -u postgres -- createuser hive
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='delegatee'" | grep -q 1 \
  || runuser -u postgres -- createdb -O hive delegatee

echo "== the delegatee: built at its pinned commit, its delegate key made once"
(cd "$APP" && as_hive env DELEGATEE_BUILD_ONLY=1 tools/delegatee.sh)

echo "== the keeper console, on its own origin"
CONSOLE_FLAG=""
[ "${HIVE_NETWORK:-}" = bitcoin ] && CONSOLE_FLAG=--mainnet
(cd "$APP/hive/hive-buzz" && as_hive node keeper/build.mjs "$APP/.local/keeper" $CONSOLE_FLAG)
install -d -m 755 /srv/hive/keeper
install -m 644 "$APP/.local/keeper/index.html" "$APP/.local/keeper/console.js" "$APP/.local/keeper/SHA256SUMS" /srv/hive/keeper/

echo "== services"
install -m 644 "$APP"/deploy/systemd/*.service "$APP"/deploy/systemd/*.timer /etc/systemd/system/
install -m 644 "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s\n' "$ENV" > /etc/systemd/system/caddy.service.d/hive.conf
usermod -aG hive caddy
systemctl daemon-reload
systemctl enable --now hive-delegatee.service
# The hive's tools pin the delegate key the delegatee names; it is public, so it goes in hive.env.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  KEY=$(curl -fsS http://127.0.0.1:7090/v1/info 2>/dev/null | sed -n 's/.*"delegatePubkey" *: *"\([0-9a-f]*\)".*/\1/p')
  [ -n "$KEY" ] && break
  sleep 2
done
[ -n "${KEY:-}" ] || { echo "the delegatee did not answer on 127.0.0.1:7090; see journalctl -u hive-delegatee" >&2; exit 1; }
sed -i "s/^BUZZ_DELEGATE_KEY=.*/BUZZ_DELEGATE_KEY=$KEY/" "$ENV"
systemctl enable --now hive-service.service hive-backup.timer
systemctl restart hive-service.service caddy
# A first backup now, with the delegate key in it, before any coin arrives.
systemctl start hive-backup.service

echo
echo "Service:  https://$HIVE_HOST/healthz"
echo "Console:  https://$KEEPER_HOST/  (hashes below; keepers can build the same and compare)"
cat /srv/hive/keeper/SHA256SUMS
echo "Delegate key: $KEY"
echo "Approve a hive once HiveBot asks for it:  cd $APP && sudo -u hive pnpm ops service-list --network ${HIVE_NETWORK:-bitcoin}"
