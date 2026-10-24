#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
TARGET_DIR="${CARGO_TARGET_DIR:-build-cache-fnzsafe}"

# Build the CLI with full features.
cargo build --release --target-dir "$TARGET_DIR" -p fnzero-safe-core --features full

# Copy the binary to project root
cp "$TARGET_DIR/release/fnzero-safe" ./
