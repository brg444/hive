#!/usr/bin/env bash
# Build both halves of pay-arkade and package them as one MeshLLM plugin archive:
#   dist/pay-arkade-<version>-<os>-<arch>.tar.gz
# containing pay-arkade/{plugin.toml, plugin-manifest.json, pay-arkade, pay-arkade-worker, job_escrow.ark}.
# Builds for this machine; run it on each platform you ship.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/plugin/Cargo.toml" | head -1)
TARGET="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
OUT="$ROOT/dist"
STAGE="$OUT/stage/pay-arkade"

rm -rf "$OUT/stage"
mkdir -p "$STAGE"
(cd "$ROOT/plugin" && cargo build --release --quiet)
(cd "$ROOT/worker" && bun install --frozen-lockfile --silent \
  && bun build src/main.ts --compile --minify --outfile "$STAGE/pay-arkade-worker" >/dev/null)
cp "$ROOT/plugin/target/release/pay-arkade" "$STAGE/"
"$STAGE/pay-arkade" --manifest > "$STAGE/plugin-manifest.json"
sed "s/@VERSION@/$VERSION/" "$ROOT/packaging/plugin.toml" > "$STAGE/plugin.toml"
# The contract the worker spends, shipped for anyone who wants to audit what their sats go into.
cp "$ROOT/contracts/job_escrow.ark" "$STAGE/"
cp "$ROOT/packaging/hive-join-sync.sh" "$STAGE/"

ARCHIVE="$OUT/pay-arkade-$VERSION-$TARGET.tar.gz"
tar -C "$OUT/stage" -czf "$ARCHIVE" pay-arkade
rm -rf "$OUT/stage"
(cd "$OUT" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
echo "$ARCHIVE"
