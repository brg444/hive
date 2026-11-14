#!/bin/sh
# Checks a Hive host and says what is wrong, one line each: whether the service and the delegatee
# answer, whether the keeper console being served is still the one that was built, whether the last
# backup is recent, and whether the disk has room. Run it from a timer (deploy/systemd/hive-check.timer
# runs it every five minutes) or by hand.
#
#   tools/check.sh            exits 0 when all is well, 1 when anything is not
#
# Every finding goes to the journal at error priority, so `journalctl -p err -u hive-check` is the
# host's list of troubles. With HIVE_ALERT_URL set, the findings are also posted there as plain
# text (an ntfy topic, or any address that takes a POST), once per run that finds something.
set -u
SERVICE="${HIVE_SERVICE_URL:-http://127.0.0.1:8080}"
DELEGATEE="${HIVE_DELEGATEE_URL:-http://127.0.0.1:7090}"
BACKUPS="${HIVE_BACKUP_DIR:-}"
MAX_BACKUP_HOURS="${HIVE_MAX_BACKUP_HOURS:-13}"
found=""
trouble() {
  found="${found}${found:+
}$1"
  echo "<3>hive-check: $1" >&2
}

curl -fsS -m 10 "$SERVICE/healthz" >/dev/null 2>&1 || trouble "the Hive service does not answer at $SERVICE/healthz"
info=$(curl -fsS -m 10 "$DELEGATEE/v1/info" 2>/dev/null) || trouble "the delegatee does not answer at $DELEGATEE/v1/info"
# The delegate key the hive's tools pin must be the one the delegatee signs with.
if [ -n "${info:-}" ] && [ -n "${BUZZ_DELEGATE_KEY:-}" ]; then
  key=$(printf '%s' "$info" | sed -n 's/.*"delegatePubkey" *: *"\([0-9a-f]*\)".*/\1/p')
  [ "$key" = "$BUZZ_DELEGATE_KEY" ] || trouble "the delegatee names delegate key ${key:-none}, not the one in hive.env"
fi
# The console served to keepers must be byte for byte the one built from this host's checkout.
if [ -n "${HIVE_CONSOLE_DIR:-}" ] && [ -n "${HIVE_CONSOLE_BUILD:-}" ]; then
  for f in index.html console.js; do
    cmp -s "$HIVE_CONSOLE_DIR/$f" "$HIVE_CONSOLE_BUILD/$f" || trouble "the keeper console's $f being served is not the one that was built"
  done
  (cd "$HIVE_CONSOLE_DIR" && sha256sum -c SHA256SUMS >/dev/null 2>&1) || trouble "the keeper console being served does not match its SHA256SUMS"
fi
if [ -n "$BACKUPS" ]; then
  recent=$(find "$BACKUPS" -name 'hive-*.tar.age' -mmin -$((MAX_BACKUP_HOURS * 60)) 2>/dev/null | head -n 1)
  [ -n "$recent" ] || trouble "no backup in $BACKUPS from the last $MAX_BACKUP_HOURS hours"
fi
used=$(df -P / | awk 'NR==2 { sub("%", "", $5); print $5 }')
[ "${used:-0}" -lt 90 ] || trouble "the disk is ${used}% full"

[ -z "$found" ] && exit 0
if [ -n "${HIVE_ALERT_URL:-}" ]; then
  printf 'Hive host %s:\n%s\n' "${HIVE_HOST:-$(hostname)}" "$found" | curl -fsS -m 10 --data-binary @- "$HIVE_ALERT_URL" >/dev/null 2>&1 \
    || echo "<3>hive-check: the alert could not be sent" >&2
fi
exit 1
