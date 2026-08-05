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
web/                  # ブラウザプレイヤー（src/がライブラリ、demo.tsが利用例）
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

ファイルの途中から読み直すときは`Session::anchored(options, Some(origin))`を使います。`origin`には最初のセッションの`origin_ticks()`（時刻0が指すPES timestamp、90 kHz）を渡します。こうすると、GOPヘッダーの手前で切れたバイト列から始めても、フラグメントの`start`はファイル全体で見た本当の時刻になります。末尾だけを読んで`last_pts()`にかければ、`origin`との差がそのまま動画長です。

ブラウザなしで動作を見るには次を使います。出力はそのまま再生可能なfMP4です。

```bash
cargo run --release --example dump_session -- input.ts output.mp4
```

AAC-LC音声はスペクトルを再エンコードせず、通常のステレオCPEはそのまま、モノラルSCEは同じICSを左右へ複製したCPE、デュアルモノは主音声SCEだけを左右へ複製したCPEへ組み替えてからmuxします。このため放送中にモノラルとデュアルモノが切り替わっても、出力トラックは一貫して2chステレオです。5.1chは暗黙のチャンネル構成とPCEによる明示構成のどちらも6chのまま保持します。映像と音声はPESのタイムスタンプが示す実際の間隔で配置されるので、放送でよくある数百ミリ秒のずれがそのまま保たれます。

## WebAssembly

`crates/mpeg2toh264-wasm`は`Session`をそのまま包んだだけの層です。フラグメントはプレーンなJSオブジェクトで返るので`free()`は要らず、`data`は転送可能な`Uint8Array`です。

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
./tools/build-wasm.sh            # web/wasm/ へ出力
```

WASMビルドでは`.cargo/config.toml`により`nontrapping-fptoint`、`bulk-memory`、
`simd128`を有効にしています。これらのWebAssembly機能に対応したブラウザーが必要です。
この設定は`wasm32-unknown-unknown`だけに適用され、CLIなどのネイティブビルドには影響しません。

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

## ブラウザプレイヤー

`web/src/`が、URLと`<video>`を渡すだけのライブラリです。ページ側に残るのはメディア要素だけで、取得・変換・（可能なら）MSEはすべてWorker内で完結します。

```ts
import { Mpeg2TsPlayer } from './src/index.js';

const player = new Mpeg2TsPlayer(video);
player.addEventListener('statechange', (e) => console.log(e.detail.state));
player.addEventListener('stats', (e) => console.log(e.detail.instantFps));
await player.load('https://example.com/video.ts');
```

`load()`はソースが要素に付いて最初のバイトが入った時点でresolveします。変換はその先も続き、`progress`・`stats`・`statechange`・`seekable`で報告されます。失敗は必ず`error`イベントになり、まだresolveしていない`load()`はあわせてrejectされます。`stop()`で現在のロードを中断（プレイヤーは再利用可）、`destroy()`でWorkerごと破棄します。

オプションは`wasmUrl` / `mediaSource` / `oversample` / `queueHighWaterMark` / `keepBehindSeconds`。ローカルファイルを再生したいときは`URL.createObjectURL(file)`で得たblob URLを渡します（`web/demo.ts`がそうしています）。ファイルはページの外へ出ません。

### シーク

サーバーが長さと途中のバイトを返せる入力なら、シークは勝手に効きます。ライブ配信やRangeを断るサーバーでは従来どおり、変換済みの範囲だけが再生対象です。

1. `Content-Length`がない → 生配信として扱い、以降は何もしません。
2. 末尾1 MiBをRangeリクエストで取り、失敗（206以外／取れた範囲が末尾でない）なら生配信のまま。Viteの開発サーバーのように`bytes=-N`を取り違える実装があるので、返ってきた`Content-Range`を見て絶対位置で取り直します。
3. 成功したら、その中の最後のPTSと`Session`が報告する原点との差が動画長です。`MediaSource.duration`に入り、`seekable`が全長になって`seekable`イベントで通知されます。
4. バッファ外へシークされたら、バッファを全消去し、平均ビットレートから割り出したバイト位置でRangeリクエストをやり直します。要求時刻より後ろに着いてしまった場合だけ、戻して最大3回まで試します（手前に着くぶんには少し早く再生が始まるだけなので、そのままです）。

肝は`Session::anchored`です。ふつうのセッションは自分が読み始めた場所を時刻0にしますが、シーク後のセッションには最初のセッションが報告した原点（`origin_ticks`）を渡します。フラグメントはファイル全体の中での本当の時刻を持って出てくるので、appendした先がそのまま`currentTime`と一致します。33ビットで一周するPTSの折り返しも原点からの差で吸収します。

### MediaSourceの置き場所

`MediaSource`はWorker側とページ側のどちらでも動きます。既定の`mediaSource: 'auto'`は`MediaSource.canConstructInDedicatedWorker`を見て決めます。

- **Worker（MSE in Workers）** — `MediaSource`をWorker内に作り、`handle`をtransferしてページが`video.srcObject`へ付けます。フラグメントがスレッドをまたがないので、ページ側は再生ヘッドを200 msごとに送り返すだけです。現状Chromium系のみ。
- **メインスレッド** — フラグメントをtransferでページへ送り、ページの`MseSink`がappendします。FirefoxとSafariはこちらになります。

バッファ管理は`web/src/mse.ts`の`MseSink`ひとつで、どちらの経路も同じコードを通ります。メディア要素に触る2箇所（再生ヘッドの読み書き）だけがコールバックです。溢れたときの破棄は、`Session`が24 GOPごとに置くIDRを境界に使います。

背圧はメッセージを持ちません。Workerの読み出しループが「sinkに置き場所ができるまで待ってから次のスライスを読む」ので、`ReadyGate`ひとつで表現できます。

### ビルド

```bash
./tools/build-wasm.sh    # 先にWASMを生成しておく
npm install
npm run web:dev          # 開発サーバー
npm run web:build        # dist/ へ出力
npm run typecheck        # ページ側とWorker側の2プログラム
```

`web/wasm/`はビルド生成物なのでgit管理外です。`build-wasm.sh`を通していないと`npm run typecheck`もvite buildもimportを解決できません。

`web/src/mse.ts`は両方のプログラムに属します。ページ側は`lib.dom`のMSE宣言を使い、Worker側は`web/src/worker-mse.d.ts`を使います（`lib.webworker.d.ts`は`MediaSourceHandle`しか宣言していないため）。tsconfigの`include`を明示しているのはこの衝突を避けるためです。

## 残作業

- CLIの`.mp4`出力はvideo-onlyのままです。音声が要るなら`Session`を通す必要があります
- `tools/gen-*.py`はまだTypeScriptを出力するので、テーブルを再生成するにはエミッタ側の移植が必要です
