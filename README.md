# mpeg2toh264

MPEG-2の係数・動きベクトル構造を保ちながらH.264へ変換するビットストリームトランスコーダーです。動き補償も参照フレームバッファも持たず、MPEG-2の量子化レベルを直交DCT値へ逆量子化してH.264のレベルへ再量子化します。

例外はランダムアクセス点を開くピクチャで、ここだけはIスライスに参照リストがないため、フラット予測に代わってH.264自身のイントラ予測（DCモード）で符号化します。予測値をデコーダが再構成する画素から読む必要があるので、この1枚だけは逆変換と再構成も行います。

実装はRustです。将来ブラウザ向けにWASMを載せる前提で、次の構成になっています。

```
Cargo.toml            # Cargoワークスペース
crates/
  mpeg2toh264/        # コアライブラリ（mpeg2 / h264 / container / session）
  mpeg2toh264-cli/    # CLI
  mpeg2toh264-wasm/   # Sessionのwasm-bindgenラッパー
testdata/             # 合成MPEG-2テストストリーム
tools/                # テーブル生成・解析スクリプト（Python）
packages/
  player/             # ブラウザプレイヤー（MIT）
  demo/               # プレイヤーのデモアプリ
  yadif/              # FFmpeg由来のyadifシェーダー（LGPL-2.1-or-later）
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

`Session`がWASM/ブラウザ向けの入口です。TSのチャンクを渡すと、そのまま`SourceBuffer`へappendできるfMP4フラグメントが返ります。demux・GOP分割・変換・mux・2トラックのタイムライン調整はこの中で完結し、呼び出し側はファイルの読み出しとMSEへの追加を担当します。

```rust
let mut session = Session::default();
for chunk in stream.chunks(1 << 20) {
    for fragment in session.push(chunk)? {
        match fragment {
            Fragment::Init { data, mime_codec } => open_source_buffer(&mime_codec, &data),
            Fragment::Media { data, start, random_access, .. } => append(&data, start, random_access),
            Fragment::PrivateStream { .. } => { /* subtitle/data event */ }
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
./tools/build-wasm.sh            # packages/player/wasm/ へ出力
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
  else if (fragment.kind === 'media') append(fragment.data, fragment.start, fragment.randomAccess);
  else handlePrivateStream(fragment.streamId, fragment.pid, fragment.data, fragment.pts);
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

`packages/player/`が、URLと`<video>`を渡すだけのライブラリです。ページ側に残るのはメディア要素だけで、取得・変換・（可能なら）MSEはすべてWorker内で完結します。

```ts
import { Mpeg2TsPlayer } from '@mpeg2toh264/player';

const player = new Mpeg2TsPlayer(video);
player.addEventListener('statechange', (e) => console.log(e.detail.state));
player.addEventListener('stats', (e) => console.log(e.detail.instantFps));
await player.load('https://example.com/video.ts');
```

`load()`はソースが要素に付いて最初のバイトが入った時点でresolveします。変換はその先も続き、`progress`・`stats`・`statechange`・`seekable`で報告されます。失敗は必ず`error`イベントになり、まだresolveしていない`load()`はあわせてrejectされます。`stop()`で現在のロードを中断（プレイヤーは再利用可）、`destroy()`でWorkerごと破棄します。

選択サービスのprivate PESはfMP4へ入れず、`private_stream_1`（stream_id `0xbd`）または`private_stream_2`（`0xbf`）イベントで通知します。`event.detail`は`{ pid, data, pts }`で、`data`はPESヘッダーを除いた`ArrayBuffer`、`pts`は動画の時刻原点に合わせた秒です。文字スーパー自身にPTSがない場合は、同じサービスの直前の音声PTS（音声がなければ映像PTS）で補います。利用できる時刻がなければ`null`になります。デモは`aribb24.js`の`MPEGTSFeeder`へこのpayloadを渡し、`SVGDOMRenderer`で字幕（data_identifier `0x80`）と文字スーパー（`0x81`）を映像上へ重ねます。

オプションは`wasmUrl` / `mediaSource` / `oversample` / `queueHighWaterMark` / `keepBehindSeconds` / `deinterlace` / `deinterlacer`。`deinterlacer`には`PlayerDeinterlacer`を返すfactoryを渡します。player自身は特定の方式に依存せず、`enabled`とストリームの`scan`情報を実装へ渡します。ローカルファイルを再生したいときは`URL.createObjectURL(file)`で得たblob URLを渡します（`packages/demo/src/demo.ts`がそうしています）。ファイルはページの外へ出ません。

### デインタレース

放送のTSはインターレースで、変換後のH.264もそのままなので、`<video>`が出す絵は動いた場所が櫛状になります。デモは`@mpeg2toh264/yadif`の`Deinterlacer`をplayerへ注入し、要素の上に重ねた`<canvas>`へフィルター結果を表示します。`player.deinterlace = true/false`で再生中に切り替えられ、別方式も`PlayerDeinterlacer`インターフェースで差し替えられます。

- フレームの取得には`requestVideoFrameCallback`を使います。yadifは前後1枚ずつを参照するため、映像は次のフレームが届くまでの約33 ms遅れて表示されます。この遅延により、動き検出に必要な3つの尺度を利用できます。シークやストリームの切り替わりは`mediaTime`の不連続として検出し、保持しているフレームを破棄します。
- 既定は1フレームあたり1枚出力（`send_frame`＝mode 0相当）です。先に来たフィールドの行を残し、もう一方を補間します。フィールド順はストリームから取得し、`topFieldFirst`で上書きできます。
- `doubleRate`でフィールドごとに1枚出力（`send_field`＝mode 1相当）になります。`spatialCheck`と組み合わせてyadifの4つのモードすべてに対応します（`send_frame` / `send_field` / それぞれの`nospatial`）。

#### 倍レート（mode 1相当）

インターレースの1フレームには2つの瞬間が入っています。1フレーム1枚だと後から来たほうを捨てることになり、毎秒59.94の動きが29.97になります。`doubleRate`を有効にすると、同じ3枚組へパリティを入れ替えてもう一度フィルターをかけ、残すフィールドをsecondのものにしたうえで、半フレーム後に表示します。

- シェーダーの変更は不要です。補間する行を挟む2枚（`prev2` / `next2`）はパリティから決まるため、`uParity`を反転すると後続フィールドの時刻を表せます。参照実装の`is_second_field`と同じ分岐です。
- 表示のタイミングは`requestVideoFrameCallback`の`expectedDisplayTime`（要素のフレームが画面に出る時刻）を基準に、そこから半フレーム後を狙って`requestAnimationFrame`で出します。実際に描くのは「目標の1/4フレーム手前」を過ぎた最初のtickです。60 Hzのディスプレイで29.97fpsなら、これがちょうど1リフレッシュずつ交互になります。
- フレーム長は`mediaTime`の差を`playbackRate`で割って求めます。これにより、再生速度を変更した場合も表示時刻を補正できます。
- 次のフレームが来たら未実行の2枚目はキャンセルします。一時停止・シーク・末尾では1枚だけ出します（静止画が表すのは1つの瞬間なので）。
- 統計の`fps`は要素が提示したフレームのレート（＝入力側）のままです。`filtered`は2枚とも数え、`frameMs`は2回分の描画を含んだ「映像1フレームあたりの費用」です。
- テクスチャはコード化サイズ（例: 1440x1080）で確保し、canvasのCSS上の領域は表示サイズ（例: 16:9）に合わせて`#layout`が配置します。この引き伸ばしによってSARを反映します。`videoWidth`はSAR適用後の幅なので、テクスチャの確保に使うと右端が埋まりません。アップロードされるサイズには`VideoFrameCallbackMetadata.width/height`を使います。
- canvasは要素の絵を覆うので、要素自身のコントロールも隠れます。デモページが再生ボタンとシークバーを自前で持っているのはそのためです。
- 一時停止、終端、デコード遅延などで同じフレームが再提示された場合は、`mediaTime`が変化していないことを確認して破棄します。同じフレームを履歴へ重複して追加すると、不要な処理が発生し、yadifが重複を動きとして扱う可能性があります。

#### インターレースかどうか・TFFかBFFか

変換後のH.264からは判別できません。デコード後は「2つの瞬間を持つフレーム」も「1つの瞬間のフレーム」も同じフレームとして見え、残すべき行を示す情報もありません。そのため、MPEG-2ヘッダーから読み取った情報をフラグメントに載せて渡します。

- Rust側は`pictures_interlacing()`が`Interlacing { interlaced, top_field_first }`を返します。フィールドピクチャ（`picture_structure`が`TopField`/`BottomField`）なら構造的にインターレースで、先に符号化されたほうが先のフィールド。フレームピクチャなら`progressive_frame`が2つの瞬間かどうかを、`top_field_first`が順序を言います。1つのGOPに両方が混ざる（局が映画と生カメラを切り替えると起きます）場合は、どれか一つでもインターレースならインターレース扱いです
- `Fragment::Media`に`interlacing`が付き、WASMでは`interlaced` / `topFieldFirst`として出ます。Workerは値が変わったときだけ`scan`通知を送り、プレイヤーが`scan`イベントとして中継しながらデインタレーサーへ渡します。フィールド順を誤ると、1行おきに半フィールドぶん逆方向へ動きます。
- 放送の途中で変わりうるので、1回きりではなく変化のたびに流れます
- プログレッシブと判明した時点でフィルターを停止し、インターレースに戻った時点で再開します。ソースの走査方式が判明するまでは、指定された有効状態に従います。

検証は`crates/mpeg2toh264/tests/fixtures.rs`の`reads_the_field_order_of_every_fixture`が6フィクスチャすべてでffprobeの`field_order`と一致することを確認しています（`hd1080i`＝tt、`altscan`＝bb、残り4つはprogressive）。ブラウザでも同じ3ケースを確認済みで、BFFのストリームでは`deinterlacer.topFieldFirst`が`false`に切り替わります。

#### デコーダーがデインタレースする場合

Android端末など、デコーダーがデインタレース済みのフレームを返す環境があります。そのフレームへさらにyadifをかけると、不要なフィルター処理によって画質が低下します。この動作を判定するAPIはないため、検査用クリップをデコードして確認します。

`decoderDeinterlaces()`は一度だけ検査用クリップを再生してピクセルを読み、縦方向の交互パターンが残っている割合を返します。結果は記憶され、2回目以降の呼び出しで再検査は行いません。残存率がしきい値を下回る場合は、デコーダーがデインタレースしていると判断します。既定のしきい値は50%で、`tolerance`で変更できます。

- 検査用クリップは`packages/yadif/src/probe-clip.ts`にdata URLとして格納しています。1440x1080インターレース（TFF）の6フレームで、サイズは3,221バイト（base64で4.3 KB）です。2つのフィールドは明暗が反転し、フレームごとに入れ替わります。AVC Level 4.1のDPB制限内に収めたfragmented MP4で、本編と同じMSE経路からデコーダーへ渡します。再生成用のffmpegコマンドはファイルの先頭に記載しています。
- 解像度を1440x1080にしているのは、実際の放送映像と同じデコード経路を使わせるためです。小さいクリップでは、デコーダーが異なるHW/SW経路を選ぶ可能性があります。
- ピクセルはフィルターと同じく`<video>`からcanvasへ描画して読み出します。判定対象とフィルターへ渡される画素が同じ経路を通るため、デインタレース処理が行われる位置に左右されません。
- デモは`probeDecoder()`の結果に応じてplayerの`deinterlace`を切り替えます。デコード失敗、canvasの読み出し失敗、タイムアウトの場合は、未処理のインターレース映像を避けるためフィルターを有効のままにします。

デスクトップChrome（自動デインタレースなし）では残存率1.00・判定`false`・所要146 ms、Android端末（自動デインタレースあり）では残存率0.00・判定`true`・所要238 msでした。同じ指標をフィールド混合（blend）または片フィールド倍化（bob）へ適用した場合も0.00です。測定値がしきい値から十分離れているため、既定値の50%で判別できます。

判定結果はデモページの「状態」欄に必ず出ます（残存率・所要時間つき、測定できなかった場合はその理由）。実機にデバッガを繋げなくても、`false`が「櫛が残っていた」のか「測れなかった」のか画面で区別できるようにするためです。

#### フレーム落ちの統計

デインタレースは渡されるフレーム次第で、前後が1枚飛ぶだけで動き判定が狂います。`deinterlace`イベント（フレームが来ている間、約1秒ごと）でそこが見えます。

| 項目 | 意味 |
| --- | --- |
| `filtered` | 前後が揃った状態で処理できたフレーム。多いほど良い |
| `missed` | 要素は提示したのにコールバックが呼ばれなかったフレーム（`presentedFrames`の飛びから算出）。前後が実際には2フレーム離れているので、動き判定が誤ります |
| `dropped` | デコード後に提示されなかったフレーム（要素の`getVideoPlaybackQuality()`）。デインタレースを無効にした場合も発生するため、デコード処理の遅延を示します |
| `degraded` | 片側の隣接フレームを自分自身で代用したフレーム。ストリームの先頭・シーク直後・停止直前。数個なら正常で、出続けるなら履歴が壊れ続けています |
| `discontinuities` | `mediaTime`の不連続によって履歴を破棄した回数。シークとストリーム切り替えを含みます |
| `fps` / `frameMs` | 直近1秒の提示レートと、アップロード＋描画がページのスレッドを使った時間 |

8倍速で再生させて確かめたところ、`missed 58` / `dropped 173`（60 Hzのディスプレイに毎秒240枚提示させた場合）と、詰まっている場所がそのまま出ます。等速なら`30.0fps · 0.4ms/フレーム · missed 0`です。

`packages/yadif`はFFmpegの`vf_yadif_cuda.cu`から移植したシェーダーと、WebGLの組み立て・テクスチャ・rVFCのループをまとめたLGPL-2.1-or-laterの独立パッケージです。MITのplayerはこれをimportせず、デモが実装を選んで注入します。

### シーク

サーバーがコンテンツ長と任意位置のバイト列を返せる場合は、シークを利用できます。ライブ配信やRangeリクエストに対応しないサーバーでは、変換済みの範囲だけが再生対象です。

1. `Content-Length`がない場合は生配信として扱い、ファイル長の取得とシーク位置の探索を行いません。
2. 末尾1 MiBをRangeリクエストで取り、失敗（206以外／取れた範囲が末尾でない）なら生配信のまま。Viteの開発サーバーのように`bytes=-N`を取り違える実装があるので、返ってきた`Content-Range`を見て絶対位置で取り直します。
3. 成功したら、その中の最後のPTSと`Session`が報告する原点との差が動画長です。`MediaSource.duration`に入り、`seekable`が全長になって`seekable`イベントで通知されます。
4. バッファ外へシークされたら、バッファを全消去し、開始位置を探索してからRangeリクエストを出し直します。TSに索引はないため、平均ビットレートから位置を推定し、そこから128 KiBを読んで`first_pts()`に渡します。得られた時刻で位置を再計算し、誤差0.5秒以内になるか4回に達するまで繰り返します。実際の録画（552 MB / 369秒）では、平均誤差が推定のみの1.53秒から探索後の0.18秒へ減少しました（最大誤差は2.4秒から0.36秒）。読み出す量は128〜256 KiBです。

探索で得た点（バイト, 秒）はロード中に保持します。2回目以降のシークでは過去の探索結果を使って内挿するため、推定精度が向上します。探索の目標は要求時刻の1秒前です。GOP境界によって開始位置が最大0.5秒後方へ移動しても要求時刻を超えないようにしています。

肝は`Session::anchored`です。ふつうのセッションは自分が読み始めた場所を時刻0にしますが、シーク後のセッションには最初のセッションが報告した原点（`origin_ticks`）を渡します。フラグメントはファイル全体の中での本当の時刻を持って出てくるので、appendした先がそのまま`currentTime`と一致します。33ビットで一周するPTSの折り返しも原点からの差で吸収します。

### MediaSourceの置き場所

`MediaSource`はWorker側とページ側のどちらでも動きます。既定の`mediaSource: 'auto'`は`MediaSource.canConstructInDedicatedWorker`を見て決めます。

- Worker（MSE in Workers）— `MediaSource`をWorker内に作り、`handle`をtransferしてページが`video.srcObject`へ設定します。フラグメントはWorker内で処理され、ページ側は再生位置を200 msごとに通知します。現状ではChromium系ブラウザーのみ対応しています。
- メインスレッド — フラグメントをtransferでページへ送り、ページの`MseSink`がappendします。FirefoxとSafariではこの方式を使います。

バッファ管理は`packages/player/src/mse.ts`の`MseSink`ひとつで、どちらの経路も同じコードを通ります。メディア要素に触る2箇所（再生ヘッドの読み書き）だけがコールバックです。溢れたときの破棄は、`Session`が24 GOPごとに置くIDRを境界に使います。

背圧はメッセージを持ちません。Workerの読み出しループが「sinkに置き場所ができるまで待ってから次のスライスを読む」ので、`ReadyGate`ひとつで表現できます。

### ビルド

```bash
./tools/build-wasm.sh    # 先にWASMを生成しておく
npm install
npm run packages:build    # playerとyadifの配布用ファイルを生成
npm run web:dev          # 開発サーバー
npm run web:build        # dist/ へ出力
npm run typecheck        # ページ側とWorker側の2プログラム
```

`packages/player/wasm/`はビルド生成物なのでgit管理外です。`build-wasm.sh`を通していないと`npm run typecheck`もvite buildもimportを解決できません。

`@mpeg2toh264/player`と`@mpeg2toh264/yadif`の`exports`は、それぞれの`dist/`に生成したJavaScriptと型定義を参照します。playerのdistにはworkerとWASMも含まれ、workerのURLは`import.meta.url`を基準に解決されます。このため、利用側でViteによるTypeScriptやWorkerの変換は必要ありません。`npm pack`と`npm publish`では`prepack`が配布用ビルドを実行します。

`packages/player/src/mse.ts`は両方のプログラムに属します。ページ側は`lib.dom`のMSE宣言を使い、Worker側は`packages/player/src/worker-mse.d.ts`を使います（`lib.webworker.d.ts`は`MediaSourceHandle`しか宣言していないため）。tsconfigの`include`を明示しているのはこの衝突を避けるためです。

## 残作業

- CLIの`.mp4`出力はvideo-onlyのままです。音声が要るなら`Session`を通す必要があります
- `tools/gen-*.py`はまだTypeScriptを出力するので、テーブルを再生成するにはエミッタ側の移植が必要です
