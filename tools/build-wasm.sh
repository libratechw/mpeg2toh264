#!/usr/bin/env bash
# Build the WebAssembly package the player imports, into packages/player/wasm.
#
# Needs the wasm32 target and a wasm-bindgen CLI matching the wasm-bindgen
# crate version in Cargo.lock:
#
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/packages/player/wasm"

# The generator and the crate have to agree, or the glue will not load.
wanted="$(sed -n '/^name = "wasm-bindgen"$/,/^version/s/^version = "\(.*\)"/\1/p' "$root/Cargo.lock" | head -1)"
have="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$wanted" != "$have" ]; then
  echo "wasm-bindgen CLI is $have but the crate is $wanted; they must match" >&2
  exit 1
fi

cargo build --release --package mpeg2toh264-wasm --target wasm32-unknown-unknown
# The web target loads the module itself, from a URL the caller passes in. The
# bundler target would instead `import` the .wasm, which Vite only understands
# with a plugin.
wasm-bindgen --target web --out-dir "$out" \
  "$root/target/wasm32-unknown-unknown/release/mpeg2toh264_wasm.wasm"

echo "wrote $out"
