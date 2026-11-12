#!/usr/bin/env bash
# Set up a hive member in one step: install the pay-arkade plugin into MeshLLM as a member, so the
# hive appears as a model on this node. No key, no wallet: the hive's agent pays from the hive's
# budget, within the allowance the hive gives this node.
#
#   install-member.sh --archive pay-arkade-<version>-<os>-<arch>.tar.gz --agent <hive agent node id> \
#       [--join <hive invite>] [--hive-model hive] [--mesh-llm <path>]
set -euo pipefail

ARCHIVE="" AGENT="" JOIN="" MODEL="hive" MESH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE=$2; shift 2 ;;
    --agent) AGENT=$2; shift 2 ;;
    --join) JOIN=$2; shift 2 ;;
    --hive-model) MODEL=$2; shift 2 ;;
    --mesh-llm) MESH=$2; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || fail "--archive <pay-arkade archive> is required"
[[ "$AGENT" =~ ^[0-9a-fA-F]{64}$ ]] || fail "--agent <the hive agent's 64-hex node id> is required"
MESH=${MESH:-$(command -v mesh-llm || true)}
[ -n "$MESH" ] && [ -x "$MESH" ] || fail "mesh-llm not found: install MeshLLM 0.79 or later first, or pass --mesh-llm"

VERSION=$(tar -xzOf "$ARCHIVE" pay-arkade/plugin.toml | sed -n 's/^version = "\(.*\)"/\1/p')
"$MESH" plugins install --archive "$ARCHIVE" --name pay-arkade --version "$VERSION" >/dev/null
PLUGIN_DIR=$("$MESH" plugins info pay-arkade 2>/dev/null | sed -n 's/^path[[:space:]]*//p')
[ -x "$PLUGIN_DIR/pay-arkade" ] || fail "plugin install did not produce $PLUGIN_DIR/pay-arkade"

CONFIG="$HOME/.mesh-llm/config.toml"
mkdir -p "$(dirname "$CONFIG")" && touch "$CONFIG"
if grep -q '^name = "pay-arkade"' "$CONFIG"; then
  echo "Config:  $CONFIG already has a pay-arkade entry; left unchanged"
else
  BACKUP="$CONFIG.bak.$(date +%s)"
  cp "$CONFIG" "$BACKUP"
  # A member needs no exchange grant: it serves the hive as a model and forwards to the agent.
  cat >> "$CONFIG" <<TOML

[[plugin]]
name = "pay-arkade"
command = "$PLUGIN_DIR/pay-arkade"
args = ["--role", "member", "--agent", "$AGENT", "--hive-model", "$MODEL", "--log", "$HOME/.mesh-llm/pay-arkade-member.jsonl"]
TOML
  if ! "$MESH" config validate --config-path "$CONFIG" >/dev/null; then
    cp "$BACKUP" "$CONFIG"
    fail "MeshLLM rejected the new entry; $CONFIG is back as it was"
  fi
  echo "Config:  pay-arkade member entry added to $CONFIG"
fi

echo
echo "Join the hive's mesh:"
echo "  $MESH serve --join ${JOIN:-<hive invite>}"
echo "or, if the hive publishes its invite, keep a join file current and serve from it:"
echo "  $PLUGIN_DIR/hive-join-sync.sh --url https://<hive host>/hive/v1/invite   # every minute"
echo "  $MESH serve --join-file ~/.mesh-llm/hive-invite.txt"
echo
echo "Then point any OpenAI-compatible tool at http://127.0.0.1:9337/v1 with the model \"$MODEL\"."
echo "Until the keepers add this node to an approved budget, a request answers with this node's id to give them."
