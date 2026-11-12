#!/usr/bin/env bash
# Set up a hive provider in one step: install the pay-arkade plugin into MeshLLM, gate a model
# behind it, create the provider's claim key, and print the command that joins the hive's mesh.
#
#   install-provider.sh --archive pay-arkade-<version>-<os>-<arch>.tar.gz \
#       (--gguf <model.gguf> | --model-id <MeshLLM model id>) [--price-msat-per-mtok N] \
#       [--operator URL] [--emulator URL] [--network NAME] [--delegate URL|none] [--payout-pk-script HEX] \
#       [--allow-peer <hive agent node id>]... [--join <hive invite>] [--mesh-llm <path>]
#       [-- <more plugin arguments>]
#
# On mainnet (--network bitcoin) the operator defaults to https://arkade.computer and the delegate
# service that renews escrow coins to https://delegate.arkade.money (the Arkade wallet's; --delegate
# none turns renewal off). The emulator has no default: pass --emulator <URL> with the one the hive
# gives you. At least one --allow-peer is required: a mainnet provider only quotes the hive's agent.
#
# The plugin's state (claim key, job book, event log) lives in ~/.mesh-llm/pay-arkade, outside the
# plugin store, so reinstalling or removing the plugin never touches the key or unpaid receipts.
set -euo pipefail

EXTRA=() ALLOW=() ARCHIVE="" GGUF="" MODEL_ID="" PRICE="2000000" OPERATOR="" EMULATOR="" NETWORK="" PAYOUT="" JOIN="" MESH="" DELEGATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE=$2; shift 2 ;;
    --gguf) GGUF=$2; shift 2 ;;
    --model-id) MODEL_ID=$2; shift 2 ;;
    --price-msat-per-mtok) PRICE=$2; shift 2 ;;
    --operator) OPERATOR=$2; shift 2 ;;
    --emulator) EMULATOR=$2; shift 2 ;;
    --delegate) DELEGATE=$2; shift 2 ;;
    --network) NETWORK=$2; shift 2 ;;
    --payout-pk-script) PAYOUT=$2; shift 2 ;;
    --join) JOIN=$2; shift 2 ;;
    --allow-peer) ALLOW+=("$2"); shift 2 ;;
    --mesh-llm) MESH=$2; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || fail "--archive <pay-arkade archive> is required"
[ -n "$GGUF$MODEL_ID" ] || fail "--gguf <file> or --model-id <id> is required"
[[ "$PRICE" =~ ^[0-9]+$ ]] || fail "--price-msat-per-mtok must be a whole number"
if [ "$NETWORK" = "bitcoin" ]; then
  OPERATOR=${OPERATOR:-https://arkade.computer}
  [ -n "$EMULATOR" ] || fail "--emulator <URL> is required on mainnet: use the one the hive gives you"
  DELEGATE=${DELEGATE:-https://delegate.arkade.money}
  [ ${#ALLOW[@]} -gt 0 ] || fail "--allow-peer <hive agent node id> is required on mainnet"
fi

[ "$DELEGATE" = "none" ] && DELEGATE=""
MESH=${MESH:-$(command -v mesh-llm || true)}
[ -n "$MESH" ] && [ -x "$MESH" ] || fail "mesh-llm not found: install MeshLLM 0.79 or later first, or pass --mesh-llm"
echo "MeshLLM: $("$MESH" --version 2>/dev/null || echo "$MESH")"

# A local GGUF is named by MeshLLM after its file hash.
if [ -n "$GGUF" ]; then
  [ -f "$GGUF" ] || fail "no such model file: $GGUF"
  MODEL_ID="local-gguf/sha256-$( (sha256sum "$GGUF" 2>/dev/null || shasum -a 256 "$GGUF") | cut -c1-64)"
fi
echo "Model:   $MODEL_ID"

# 1. Install the plugin into MeshLLM's plugin store.
VERSION=$(tar -xzOf "$ARCHIVE" pay-arkade/plugin.toml | sed -n 's/^version = "\(.*\)"/\1/p')
[ -n "$VERSION" ] || fail "the archive has no pay-arkade/plugin.toml version"
"$MESH" plugins install --archive "$ARCHIVE" --name pay-arkade --version "$VERSION" >/dev/null
PLUGIN_DIR=$("$MESH" plugins info pay-arkade 2>/dev/null | sed -n 's/^path[[:space:]]*//p')
[ -x "$PLUGIN_DIR/pay-arkade" ] || fail "plugin install did not produce $PLUGIN_DIR/pay-arkade"
echo "Plugin:  pay-arkade $VERSION in $PLUGIN_DIR"

# 2. The provider's claim key, created once and kept.
STATE="$HOME/.mesh-llm/pay-arkade"
mkdir -p "$STATE" && chmod 700 "$STATE"
WORKER_ARGS=(--key-file "$STATE/key")
[ -n "$OPERATOR" ] && WORKER_ARGS+=(--operator "$OPERATOR")
[ -n "$EMULATOR" ] && WORKER_ARGS+=(--emulator "$EMULATOR")
[ -n "$NETWORK" ] && WORKER_ARGS+=(--network "$NETWORK")
INFO=$(printf '{"id":1,"op":"info"}\n{"id":2,"op":"ping"}\n' | "$PLUGIN_DIR/pay-arkade-worker" "${WORKER_ARGS[@]}" 2>/dev/null || true)
if [ -n "$OPERATOR$EMULATOR" ] || [ "$NETWORK" = "bitcoin" ]; then
  PRE=$(printf '{"id":1,"op":"preflight"}\n' | "$PLUGIN_DIR/pay-arkade-worker" "${WORKER_ARGS[@]}" 2>/dev/null || true)
  printf '%s' "$PRE" | grep -q '"ok":true' || fail "preflight against the operator and emulator failed: $PRE"
  echo "Checked:  operator and emulator answer, and match the network"
fi
CLAIM_KEY=$(printf '%s\n' "$INFO" | sed -n 's/.*"pubkey":"\([0-9a-f]\{64\}\)".*/\1/p' | head -1)
ADDRESS=$(printf '%s\n' "$INFO" | sed -n 's/.*"address":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$CLAIM_KEY" ] || fail "the contract worker did not start"

# 3. Gate the model: one [[plugin]] entry naming the installed executable by path. A path makes
#    the plugin required, so the node will not start, and so will not serve the model ungated,
#    if the plugin cannot.
CONFIG="$HOME/.mesh-llm/config.toml"
touch "$CONFIG"
if grep -q '^name = "pay-arkade"' "$CONFIG"; then
  echo "Config:  $CONFIG already has a pay-arkade entry; left unchanged"
else
  BACKUP="$CONFIG.bak.$(date +%s)"
  cp "$CONFIG" "$BACKUP"
  ARGS=("--role" "seller" "--model" "$MODEL_ID" "--price-msat-per-mtok" "$PRICE" "--state-dir" "$STATE" "--log" "$STATE/events.jsonl")
  [ -n "$PAYOUT" ] && ARGS+=("--payout-pk-script" "$PAYOUT")
  [ -n "$OPERATOR" ] && ARGS+=("--operator" "$OPERATOR")
  [ -n "$EMULATOR" ] && ARGS+=("--emulator" "$EMULATOR")
  [ -n "$DELEGATE" ] && ARGS+=("--delegate" "$DELEGATE")
  [ -n "$NETWORK" ] && ARGS+=("--network" "$NETWORK")
  for peer in ${ALLOW[@]+"${ALLOW[@]}"}; do ARGS+=("--allow-peer" "$peer"); done
  [ ${#EXTRA[@]} -gt 0 ] && ARGS+=("${EXTRA[@]}")
  quoted=$(printf '"%s", ' "${ARGS[@]}"); quoted=${quoted%, }
  cat >> "$CONFIG" <<TOML

[[plugin]]
name = "pay-arkade"
command = "$PLUGIN_DIR/pay-arkade"
args = [$quoted]

[plugin.openai_exchange_grant]
endpoints = ["chat_completions", "completions", "responses"]
phases = ["request_received", "backend_selected", "exchange_finished"]
metadata = true
request_body = true
admission = true
failure_policy = "required"
deadline_ms = 30000
max_body_bytes = 1048576
max_queue_bytes = 4194304
max_in_flight = 32
TOML
  if ! "$MESH" config validate --config-path "$CONFIG" >/dev/null; then
    cp "$BACKUP" "$CONFIG"
    fail "MeshLLM rejected the new entry; $CONFIG is back as it was"
  fi
  echo "Config:  pay-arkade entry added to $CONFIG"
fi

echo
echo "Claim key:  $CLAIM_KEY"
[ -n "$ADDRESS" ] && echo "Paid to:    $ADDRESS"
[ -n "$ADDRESS" ] || echo "Paid to:    this key's Arkade address (the operator was not reachable to show it)"
echo "Key file:   $STATE/key  (back it up: it claims what you earn)"
echo
MODEL_ARG=$([ -n "$GGUF" ] && echo "--gguf $GGUF" || echo "--model $MODEL_ID")
echo "Start serving the hive:"
echo "  $MESH serve $MODEL_ARG --join ${JOIN:-<hive invite>}"
