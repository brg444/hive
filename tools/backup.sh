#!/bin/sh
# Back up what a Hive host cannot rebuild: the delegatee's delegate key and its
# database, and the service's own state (each hive's record, desk, channel copy
# and agent receipts). The keepers' keys never reach the host, so they are not
# here; each keeper keeps their own.
#
#   HIVE_BACKUP_RECIPIENT=age1… DELEGATEE_DATABASE_URL='postgres://…/delegatee' tools/backup.sh
#
# Everything goes into one archive encrypted to HIVE_BACKUP_RECIPIENT, an age
# public key whose secret half lives off the host. The archive lands in
# HIVE_BACKUP_DIR (default .local/backups) and archives older than
# HIVE_BACKUP_DAYS days (default 30) are removed. Copy the directory off the
# host as well, with rclone or rsync; a backup on the same disk is no backup.
#
# The delegate key is part of every treasury address the delegatee renews: a
# host that loses it can no longer renew those coins, and they have to leave
# through the keepers or the exit path. Run this from cron or a systemd timer at
# least daily, and once by hand right after the delegatee first starts.
#
# Restore, on a fresh host with the repository checked out:
#   age -d -i <secret key file> hive-<stamp>.tar.age | tar xf - -C <repository>
#   pg_restore --clean --if-exists -d "$DELEGATEE_DATABASE_URL" <repository>/delegatee.dump
#   rm <repository>/delegatee.dump
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${HIVE_BACKUP_RECIPIENT:?set HIVE_BACKUP_RECIPIENT to the age public key backups are encrypted to}"
: "${DELEGATEE_DATABASE_URL:?set DELEGATEE_DATABASE_URL to the delegatee's Postgres database}"
OUT="${HIVE_BACKUP_DIR:-$ROOT/.local/backups}"
DAYS="${HIVE_BACKUP_DAYS:-30}"
command -v age >/dev/null || { echo "age is not installed" >&2; exit 2; }
command -v pg_dump >/dev/null || { echo "pg_dump is not installed" >&2; exit 2; }

umask 077
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pg_dump --format=custom --no-owner --file="$WORK/delegatee.dump" "$DELEGATEE_DATABASE_URL"

cd "$ROOT"
set --
for path in .secrets/bitcoin .secrets/v4 .secrets/ops .local/service .local/ops; do
  [ -e "$path" ] && set -- "$@" "$path"
done
# The service writes each file whole (write, then rename), so a copy taken while it runs holds no torn file.
tar cf "$WORK/hive.tar" -C "$WORK" delegatee.dump -C "$ROOT" "$@"
# A backup without a delegate key would only look like one: older backups stay until a whole one exists.
tar tf "$WORK/hive.tar" | grep -q '^\.secrets/\(bitcoin\|v4\)/delegate-key$' \
  || { echo "no delegate key found under .secrets; older backups kept" >&2; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$OUT/hive-$STAMP.tar.age"
age -r "$HIVE_BACKUP_RECIPIENT" -o "$ARCHIVE.part" "$WORK/hive.tar"
mv "$ARCHIVE.part" "$ARCHIVE"
find "$OUT" -name 'hive-*.tar.age' -mtime +"$DAYS" -delete
echo "$ARCHIVE ($(wc -c < "$ARCHIVE") bytes)"
