#!/usr/bin/env bash
# Keep a node's --join-file current with the hive's invite, which changes whenever the hive's agent
# restarts. Run it every minute (cron or launchd); MeshLLM re-reads the file on every rejoin.
#
#   hive-join-sync.sh --url https://<hive host>/hive/v1/invite [--file ~/.mesh-llm/hive-invite.txt]
#
# Then serve with:  mesh-llm serve --join-file ~/.mesh-llm/hive-invite.txt ...
set -euo pipefail

URL="" FILE="$HOME/.mesh-llm/hive-invite.txt"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL=$2; shift 2 ;;
    --file) FILE=$2; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$URL" == https://* || "$URL" =~ ^http://(127\.0\.0\.1|localhost)[:/] ]] || { echo "error: --url <https://.../hive/v1/invite> is required" >&2; exit 2; }

INVITE=$(curl -fsS --max-time 10 "$URL" | tr -d '[:space:]')
# An invite is base64url; refuse anything else rather than hand MeshLLM a broken file.
[[ "$INVITE" =~ ^[A-Za-z0-9_-]{16,}={0,2}$ ]] || { echo "error: $URL did not return an invite" >&2; exit 1; }

mkdir -p "$(dirname "$FILE")"
if [ -f "$FILE" ] && [ "$(tr -d '[:space:]' < "$FILE")" = "$INVITE" ]; then
  exit 0
fi
TMP=$(mktemp "$FILE.XXXXXX")
printf '%s\n' "$INVITE" > "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$FILE"
echo "updated $FILE"
