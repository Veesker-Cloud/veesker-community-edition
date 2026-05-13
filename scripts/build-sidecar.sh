#!/usr/bin/env bash
set -euo pipefail

# Compile the Bun sidecar to a native binary tagged with the Rust target triple,
# so Tauri's externalBin can pick it up.

cd "$(dirname "$0")/.."

TARGET_TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
OUT="src-tauri/binaries/veesker-sidecar-${TARGET_TRIPLE}"

echo "Building sidecar → ${OUT}"
cd sidecar
bun build src/index.ts --compile --minify --outfile "../${OUT}"

echo "Done."
