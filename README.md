# mpeg2toh264

MPEG-2の係数・動きベクトル構造を保ちながらH.264へ変換するビットストリームトランスコーダーです。IDCTも動き補償も参照フレームバッファも持たず、MPEG-2の量子化レベルを直交DCT値へ逆量子化してH.264のレベルへ再量子化します。

実装はRustです。将来ブラウザ向けにWASMを載せる前提で、次の構成になっています。

```
Cargo.toml            # Cargoワークスペース
crates/
  mpeg2toh264/        # コアライブラリ（mpeg2 / h264 / container / session）
  mpeg2toh264-cli/    # CLI
  mpeg2toh264-wasm/   # Sessionのwasm-bindgenラッパー
testdata/             # 合成MPEG-2テストストリーム
tools/                # テーブル生成・解析スクリプト（Python）
web/                  # ブラウザMSEプレイヤー（後述）
```

## CLI

```bash
cargo build --release
./target/release/mpeg2toh264 input.ts output.mp4
```

MPEG-TSとMPEG-2 video elementary streamを自動判別します。出力は拡張子で選択され、`.mp4`ならvideo-only fragmented MP4、それ以外は生のAnnex B H.264です。

```
  -o, --oversample <n>      量子化探索のオーバーサンプル係数（既定: 2）
      --i-frames-only       MPEG-2 Iピクチャのみ変換
  -q, --quiet               変換サマリを表示しない
  -h, --help                ヘルプを表示
```

## ストリーミングAPI

`Session`がWASM/ブラウザ向けの入口です。TSのチャンクを渡すと、そのまま`SourceBuffer`へappendできるfMP4フラグメントが返ります。demux・GOP分割・変換・mux・**2トラックのタイムライン合わせ**はすべてこの中で完結するので、呼び出し側はファイル読み出しとMSEの面倒だけを見ます。

```rust
let mut session = Session::default();
for chunk in stream.chunks(1 << 20) {
    for fragment in session.push(chunk)? {
        match fragment {
            Fragment::Init { data, mime_codec } => open_source_buffer(&mime_codec, &data),
            Fragment::Media { data, start, random_access, .. } => append(&data, start, random_access),
        }
    }
}
for fragment in session.finish()? { /* 同上 */ }
```

`Media`が持つ`start`（秒）と`random_access`は、再生済み範囲を破棄するときにどこまで消してよいかを決めるためのものです。24 GOPごとにIDRを置いて復帰点にしています。

ブラウザなしで動作を見るには次を使います。出力はそのまま再生可能なfMP4です。

```bash
cargo run --release --example dump_session -- input.ts output.mp4
```

AAC-LC音声は再エンコードせず、ADTSヘッダーだけを外して音声トラックへmuxします。映像と音声はPESのタイムスタンプが示す実際の間隔で配置されるので、放送でよくある数百ミリ秒のずれがそのまま保たれます。

## WebAssembly

`crates/mpeg2toh264-wasm`は`Session`をそのまま包んだだけの層です。フラグメントはプレーンなJSオブジェクトで返るので`free()`は要らず、`data`は転送可能な`Uint8Array`です。

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
./tools/build-wasm.sh            # web/wasm/ へ出力
```

```ts
import init, { Session } from './wasm/mpeg2toh264_wasm.js';

await init({ module_or_path: new URL('./wasm/mpeg2toh264_wasm_bg.wasm', import.meta.url) });

const session = new Session();
for (const fragment of session.push(chunk)) {
  if (fragment.kind === 'init') openSourceBuffer(fragment.mimeCodec, fragment.data);
  else append(fragment.data, fragment.start, fragment.randomAccess);
}
```

`--target web`で生成しているので、`.wasm`の場所は上のように呼び出し側が渡します。bundlerターゲットは`.wasm`を`import`するため、Viteにプラグインが要ります。

wasm-bindgen CLIのバージョンは`Cargo.lock`のcrateと一致している必要があります（ビルドスクリプトが確認します）。

## テスト

```bash
cargo test --release
```

`crates/mpeg2toh264/tests/fixtures.rs`は各フィクスチャの出力バイト列をハッシュで固定しています。係数が1つでも変わればここで落ちるので、変わった理由を説明できないなら意図しない変更です。

## ブラウザMSEプレイヤー

TSファイルを選ぶと、Web Worker内のWASM `Session`が変換し、返ってきたフラグメントをそのままMSEへappendします。ファイルはページの外へ出ません。

```bash
./tools/build-wasm.sh    # 先にWASMを生成しておく
npm install
npm run web:dev          # 開発サーバー
npm run web:build        # dist/ へ出力
npm run typecheck
```

`web/wasm/`はビルド生成物なのでgit管理外です。`build-wasm.sh`を通していないと`npm run typecheck`もvite buildもimportを解決できません。

`web/worker.ts`はメッセージの受け渡しだけで、変換の中身は持ちません。フラグメントの`data`はwasm-bindgenが作ったコピーなので、ページへはtransferで渡していて再コピーは起きません。バッファが溢れたときの破棄（`main.ts`の`relieveQuota`）は、`Session`が24 GOPごとに置くIDRを境界に使います。

## 残作業

- CLIの`.mp4`出力はvideo-onlyのままです。音声が要るなら`Session`を通す必要があります
- `tools/gen-*.py`はまだTypeScriptを出力するので、テーブルを再生成するにはエミッタ側の移植が必要です
