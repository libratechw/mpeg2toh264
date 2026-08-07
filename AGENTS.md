# Repository instructions

## Scope

- `crates/mpeg2toh264` is the codec/container core. Keep it dependency-free unless a dependency is clearly justified; `unsafe_code` is forbidden.
- `crates/mpeg2toh264-cli` and `crates/mpeg2toh264-wasm` are thin frontends. Codec or timeline decisions belong in the core.
- `packages/player` is MIT and must not import `packages/yadif`, which is LGPL-2.1-or-later. The demo injects yadif through `PlayerDeinterlacer`.

## Codec invariants

- The normal luma path is coefficient-domain: do not introduce pixel reconstruction, motion compensation, or a decoded-picture pixel buffer outside the random-access intra picture without documenting why the architecture changed.
- H.264 deblocking stays disabled because MPEG-2 has no equivalent in-loop filter.
- The transcoder and `mpeg2_video_timeline` must accept and drop exactly the same source pictures. A mismatch creates MP4 samples with no matching access unit or shifts audio/video timing.
- Interlacing metadata comes from MPEG-2 headers. Do not infer it from the decoded H.264 frames.
- Preserve JavaScript-compatible round-half-up behavior where the implementation calls `round_half_up`; Rust's standard `round` has a different negative-half tie break.

## Generated and reference files

- `h264/*_tables.rs` and `mpeg2/vlc_tables.rs` are generated/spec-derived data. Read their headers before editing.
- `tools/gen-*.py` still emit TypeScript in places. Do not claim that Rust tables can be regenerated unchanged until the emitters have been ported.
- The checked-in ITU/ISO PDFs and `analysis/` files are implementation references, not build inputs.

## Verification

- Run `cargo test --release` after Rust changes. `crates/mpeg2toh264/tests/fixtures.rs` pins the exact Annex B bytes; update hashes only when the coefficient or syntax change is intentional and explain it.
- SPS/PPS tests parse output independently of the writer. Keep this separation when adding syntax.
- For web changes, build WASM first with `./tools/build-wasm.sh`, then run `npm run typecheck` and the relevant package/web build. `packages/player/wasm` is generated and ignored.
- `wasm-bindgen-cli` must match the crate version in `Cargo.lock`; the build script checks it.
- Page and Worker TypeScript are separate programs. `packages/player/src/mse.ts` is shared, while Worker MSE declarations live in `worker-mse.d.ts`; avoid broadening tsconfig inputs in a way that merges conflicting DOM libraries.
- ffmpeg decoding the output cleanly is not the whole story. Safari decodes through VideoToolbox, which has disagreed with ffmpeg about reference picture lists and about how long an IDR stays a reference; `tools/vtdec.swift` and `tools/vtdiff.py` measure that without a browser, and `tools/m2v-pictures.py` finds the sources that reach the awkward paths.
- VideoToolbox decoding the output cleanly is not the whole story either. Safari reaches it through Media Source Extensions, which parses with AVStreamDataParser, submits one sample at a time, and reuses a cached image format description; `tools/sdpdec.m` is the only harness that reproduces all three, and it is what found the field pair decode error. A fault that appears in the browser but not in `tools/vtdec.swift` belongs here.

## Useful commands

```bash
cargo test --release
./tools/build-wasm.sh
npm run typecheck
npm run packages:build
npm run web:build
npm run format:check
cargo fmt --check
npm run format:write
cargo fmt
```
