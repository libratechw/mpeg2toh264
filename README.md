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
  src/yadif/          #   FFmpeg由来のyadifシェーダーだけLGPL-2.1-or-later
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

ファイルの途中から読み直すときは`Session::anchored(options, Some(origin))`を使います。`origin`には最初のセッションの`origin_ticks()`（時刻0が指すPES timestamp、90 kHz）を渡します。こうすると、GOPヘッダーの手前で切れたバイト列から始めても、フラグメントの`start`はファイル全体で見た本当の時刻になります。末尾だけを読んで`last_pts()`にかければ、`origin`との差がそのまま動画長です。同じく`first_pts()`は「そのスライスの先頭バイトは何秒地点か」を返すので、索引のないTSでシーク位置を探すのに使えます。

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

オプションは`wasmUrl` / `mediaSource` / `oversample` / `queueHighWaterMark` / `keepBehindSeconds` / `deinterlace`。ローカルファイルを再生したいときは`URL.createObjectURL(file)`で得たblob URLを渡します（`web/demo.ts`がそうしています）。ファイルはページの外へ出ません。

### デインタレース

放送のTSはインターレースで、変換後のH.264もそのままなので、`<video>`が出す絵は動いた場所が櫛状になります。`deinterlace`を有効にすると、要素の上に`<canvas>`を重ね、要素が出したフレームをWebGL2で**yadif**にかけて表示します。`player.deinterlace = true/false`で再生中に切り替えられるので、同じフレームで見比べられます。

- フレームの取得は`requestVideoFrameCallback`です。yadifは前後1枚ずつを見るので、次のフレームが来るまで1枚分（約33 ms）遅れて表示されます。音より33 ms遅れる代わりに、動き検出の3つの尺度が全部揃います。シークやストリームの切り替わりは`mediaTime`の飛びで検知して履歴を捨てます。
- 既定は1フレームあたり1枚出力（`send_frame`＝mode 0相当）です。先に来たフィールドの行を残し、もう一方を補間します。**フィールド順はストリームから取ります**（下記）。`topFieldFirst`で上書きもできます。
- `doubleRate`で**フィールドごとに1枚**出力（`send_field`＝mode 1相当）になります。`spatialCheck`と組み合わせてyadifの4つのモードすべてに対応します（`send_frame` / `send_field` / それぞれの`nospatial`）。

#### 倍レート（mode 1相当）

インターレースの1フレームには2つの瞬間が入っています。1フレーム1枚だと後から来たほうを捨てることになり、毎秒59.94の動きが29.97になります。`doubleRate`を有効にすると、同じ3枚組を**パリティを入れ替えてもう一度**かけ、残すフィールドを second のものにしたうえで、半フレーム後に表示します。

- シェーダーは変更なしで足ります。補間する行を挟む2枚（`prev2` / `next2`）はパリティから決まるので、`uParity`を反転させるだけで「後のフィールドの瞬間」になります。参照実装の`is_second_field`と同じ分岐です。
- 表示のタイミングは`requestVideoFrameCallback`の`expectedDisplayTime`（要素のフレームが画面に出る時刻）を基準に、そこから**半フレーム後**を狙って`requestAnimationFrame`で出します。実際に描くのは「目標の1/4フレーム手前」を過ぎた最初のtickです。60 Hzのディスプレイで29.97fpsなら、これがちょうど1リフレッシュずつ交互になります。
- フレーム長は`mediaTime`の差から求めます（`playbackRate`で割るので倍速再生でもズレません）。フレームレートを報告してくれるAPIはないので、フレーム自身に言わせています。
- 次のフレームが来たら未実行の2枚目はキャンセルします。一時停止・シーク・末尾では1枚だけ出します（静止画が表すのは1つの瞬間なので）。
- 統計の`fps`は要素が提示したフレームのレート（＝入力側）のままです。`filtered`は2枚とも数え、`frameMs`は2回分の描画を含んだ「映像1フレームあたりの費用」です。
- テクスチャは**コード化サイズ**（例: 1440x1080）で、canvasのCSS上の箱は**表示サイズ**（例: 16:9）に合わせて`#layout`が置きます。この引き伸ばしがSARの反映そのものです。`videoWidth`はSAR適用後の幅なので、これでテクスチャを確保すると右端が埋まらないまま残ります。アップロードされるのは`VideoFrameCallbackMetadata.width/height`のほうです。
- canvasは要素の絵を覆うので、要素自身のコントロールも隠れます。デモページが再生ボタンとシークバーを自前で持っているのはそのためです。
- 同じ絵が再提示されたら（一時停止中・末尾での停止・デコードが間に合っていないとき、コンポジターは表示リフレッシュのたびに提示します）`mediaTime`が動いていないことで見分けて捨てます。捨てないと同じ絵にフレーム1枚分の仕事をかけ続けるうえ、リングに同じ瞬間が2枚入ってyadifがそれを「動き」として読みます。

#### インターレースかどうか・TFFかBFFか

**変換後のH.264からは分かりません。** デコードされてしまえば「2つの瞬間を持つフレーム」も「1つの瞬間のフレーム」も見た目上は同じフレームで、どの行を残すべきかを言うものが残っていません。なのでMPEG-2ヘッダーを読んだ時点の答えを、フラグメントに載せて運びます。

- Rust側は`pictures_interlacing()`が`Interlacing { interlaced, top_field_first }`を返します。フィールドピクチャ（`picture_structure`が`TopField`/`BottomField`）なら構造的にインターレースで、先に符号化されたほうが先のフィールド。フレームピクチャなら`progressive_frame`が2つの瞬間かどうかを、`top_field_first`が順序を言います。1つのGOPに両方が混ざる（局が映画と生カメラを切り替えると起きます）場合は、どれか一つでもインターレースならインターレース扱いです
- `Fragment::Media`に`interlacing`が付き、WASMでは`interlaced` / `topFieldFirst`として出ます。Workerは**変わったときだけ**`scan`通知を送り、プレイヤーが`scan`イベントとして中継しつつ、デインタレーサーの`topFieldFirst`を差し替えます。フィールド順だけは好みではなく事実なので、間違えると1行おきに半フィールドぶん逆へ動きます
- 放送の途中で変わりうるので、1回きりではなく変化のたびに流れます
- **プログレッシブと分かったらフィルターはその場で止まります**（そのフラグメントから。待ちや猶予は入れていません）。直す櫛が無い絵にかけても眠くするだけなので。インターレースに戻ればまたその場でかかります。`deinterlace`は「実際にかかっているか」、`deinterlaceWanted`は「かけろと言われているか」で、ソースが何か分かるまで（ロード直後）は言われたとおりに動きます — インターレースを素通しするほうが目に見える失敗なので

検証は`crates/mpeg2toh264/tests/fixtures.rs`の`reads_the_field_order_of_every_fixture`が6フィクスチャ全部でffprobeの`field_order`と一致することを確認しています（`hd1080i`＝tt、`altscan`＝**bb**、残り4つはprogressive）。ブラウザでも同じ3ケースを通しで確認済みで、BFFのストリームでは`deinterlacer.topFieldFirst`が実際に`false`に切り替わります。

#### 端末が勝手にデインタレースする場合

Androidの実機など、**デコーダーが自前でデインタレースして返してくる**環境があります。そこへyadifをかけると、櫛の無い絵から櫛を探して眠くするだけです。この判定に使えるAPIは無いので、デコードさせて確かめます。

`decoderDeinterlaces()`（1回だけ実行して記憶）が、内蔵の検査用クリップを再生してピクセルを読み、**縦方向の交互パターンがどれだけ残っているか**を返します。想定より欠けていれば「この端末は自前でデインタレースしている」と判断します。既定のしきい値は50%で、`tolerance`で変えられます。

- **検査用クリップ**は`web/src/probe-clip.ts`にdata URLで入っています。1440x1080インターレース（TFF）6フレーム、**3,636バイト**（base64で4.8 KB）。2つのフィールドが明暗まるごと反対で、しかも1フレームごとに入れ替わります。つまり「フレームが持ちうる最大の櫛」かつ「全画素が動いている」ので、どんな方式のデインタレーサーでも必ず何かをします。再生成用のffmpegコマンドはファイルの先頭に書いてあります。
- **解像度が1440x1080なのは意図的**です。デコーダーは中身に応じて経路（HW/SW）を選ぶので、サムネイル大のクリップだと本番と違う経路に行きかねません。これだけ規則的な絵はエンコーダーにとって何でもないので、放送と同じ形のまま5 KBを切ります。
- **読み出しはフィルターと同じ経路**（`<video>`からcanvasへ）です。端末がどこでデインタレースしていようと、これが見るのは「フィルターに渡される画素そのもの」なので、判定と実際にやるべきことが食い違いません。
- 判定は`Mpeg2TsPlayer`の`deinterlace: 'auto'`が中でやります。失敗（デコードできない、canvasが汚染された、時間切れ）は全部`false`＝「フィルターをかける」に倒します。これまでと同じ動作になるほうが安全なので。

実測は両側で取れています。デスクトップChrome（自動デインタレースしない）で残存率**1.00**・判定`false`・所要146 ms、Android実機（デコーダーが自動でデインタレースする）で残存率**0.00**・判定`true`・所要238 ms。参考に、同じ指標をフィールド混合（blend）に通すと0.00、片フィールド倍化（bob）でも0.00です。**1.00対0.00**なので、しきい値の位置はほとんど問題になりません。

判定結果はデモページの「状態」欄に必ず出ます（残存率・所要時間つき、測定できなかった場合はその理由）。実機にデバッガを繋げなくても、`false`が「櫛が残っていた」のか「測れなかった」のか画面で区別できるようにするためです。

#### フレーム落ちの統計

デインタレースは渡されるフレーム次第で、前後が1枚飛ぶだけで動き判定が狂います。`deinterlace`イベント（フレームが来ている間、約1秒ごと）でそこが見えます。

| 項目 | 意味 |
| --- | --- |
| `filtered` | 前後が揃った状態で処理できたフレーム。多いほど良い |
| `missed` | 要素は提示したのにコールバックが呼ばれなかったフレーム（`presentedFrames`の飛びから算出）。前後が実際には2フレーム離れているので、動き判定が誤ります |
| `dropped` | デコードしたが提示せず捨てられたフレーム（要素の`getVideoPlaybackQuality()`）。デインタレースを切っても出るので、こちらはマシンが追いついていない印です |
| `degraded` | 片側の隣接フレームを自分自身で代用したフレーム。ストリームの先頭・シーク直後・停止直前。数個なら正常で、出続けるなら履歴が壊れ続けています |
| `discontinuities` | `mediaTime`の飛びで履歴を捨てた回数。シークとストリーム切り替え |
| `fps` / `frameMs` | 直近1秒の提示レートと、アップロード＋描画がページのスレッドを使った時間 |

8倍速で再生させて確かめたところ、`missed 58` / `dropped 173`（60 Hzのディスプレイに毎秒240枚提示させた場合）と、詰まっている場所がそのまま出ます。等速なら`30.0fps · 0.4ms/フレーム · missed 0`です。

yadifそのもの（`web/src/yadif/shader.ts`）はFFmpegの`vf_yadif_cuda.cu`からの移植なので**LGPL-2.1-or-later**です。ディレクトリを分けてあるのはそのためで、混ぜないでください。WebGLの組み立て・テクスチャ・rVFCのループは`web/src/deinterlace.ts`で、こちらはMITです。

### シーク

サーバーが長さと途中のバイトを返せる入力なら、シークは勝手に効きます。ライブ配信やRangeを断るサーバーでは従来どおり、変換済みの範囲だけが再生対象です。

1. `Content-Length`がない → 生配信として扱い、以降は何もしません。
2. 末尾1 MiBをRangeリクエストで取り、失敗（206以外／取れた範囲が末尾でない）なら生配信のまま。Viteの開発サーバーのように`bytes=-N`を取り違える実装があるので、返ってきた`Content-Range`を見て絶対位置で取り直します。
3. 成功したら、その中の最後のPTSと`Session`が報告する原点との差が動画長です。`MediaSource.duration`に入り、`seekable`が全長になって`seekable`イベントで通知されます。
4. バッファ外へシークされたら、バッファを全消去し、開く位置を**探してから**Rangeリクエストを出し直します。TSに索引はないので、平均ビットレートで見当をつけ、そこから128 KiB読んで`first_pts()`にかけ、「そのバイトは何秒地点か」を得ます。得た点で内挿し直してもう一度——これを誤差0.5秒以内か最大4回まで。実際の録画（552 MB / 369秒）での平均誤差は**推定のみ1.53秒に対し、探索後は0.18秒**（最悪2.4秒→0.36秒）でした。読むのは128〜256 KiBで、変換すれば数秒ぶんのCPUを捨てることになる答えが、それだけで手に入ります。

探索で得た点（バイト, 秒）はロード中ずっと保持するので、2回目以降のシークは前回の結果の間を内挿することになり、さらに当たります。狙いは要求時刻の1秒手前です。GOP境界の切り上げで最大0.5秒ぶん後ろへずれるぶんを見込んでも要求時刻を追い越さないためで、追い越すと視聴者が求めた場面そのものを失います。

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
