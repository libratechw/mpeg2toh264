#!/usr/bin/env bash
# Build the WebAssembly package the browser sources import, into web/wasm.
#
# Needs the wasm32 target and a wasm-bindgen CLI matching the wasm-bindgen
# crate version in Cargo.lock:
#
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/web/wasm"

# The generator and the crate have to agree, or the glue will not load.
wanted="$(sed -n '/^name = "wasm-bindgen"$/,/^version/s/^version = "\(.*\)"/\1/p' "$root/Cargo.lock" | head -1)"
have="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$wanted" != "$have" ]; then
  echo "wasm-bindgen CLI is $have but the crate is $wanted; they must match" >&2
  exit 1
fi

cargo build --release --package mpeg2toh264-wasm --target wasm32-unknown-unknown
wasm-bindgen --target bundler --out-dir "$out" \
  "$root/target/wasm32-unknown-unknown/release/mpeg2toh264_wasm.wasm"

echo "wrote $out"
