# mpeg2toh264

MPEG-2 Videoを完全にデコードせずH.264/AVCへトランスコードする実装

一般的なトランスコードはMPEG-2をデコード→H.264エンコーダーで動き補償からやり直す、という処理を行う一方で、この実装はMPEG-2がすでに持つ量子化係数、マクロブロック種別、動きベクトル、ピクチャ参照関係を読み取り、対応するH.264のビットストリームへ直接変換します。輝度の通常の変換処理には逆DCT、動き補償、参照フレームバッファの処理はありません。

汎用H.264エンコーダーではなく、元の圧縮の構造を再利用しMPEG-2放送映像をブラウザーなどH.264デコーダーを前提とする環境で低い処理負荷で再生するための実装です。

## 変換の仕組み

### 1. 係数を画素にデコードせず変換

MPEG-2の8×8量子化レベルを規格どおり逆量子化し、mismatch controlまで適用すると各値は直交正規化DCT空間上の係数になります。H.264 High Profileの8×8変換も同じ空間に再構成値を持つため、各係数について次を行えば輝度残差を直接変換できます。

1. MPEG-2のレベル、量子化スケール、量子化行列から目標DCT値を求める
2. MPEG-2の非イントラ量子化行列をH.264の8×8スケーリングリストとしてSPS/PPSへ渡す
3. 各位置のH.264逆スケーリング利得で目標値を割り、最も近いH.264レベルへ丸める
4. 係数をCAVLCで符号化する

`--oversample`はH.264側の量子化刻みをMPEG-2より何倍細かくするかを指定します。既定値は2です。1では追加の丸め誤差がMPEG-2自身の誤差と同程度になり、約1.5 dBの損失、2では約0.5 dB、4では約0.13 dBが目安です。値を上げるほど出力は大きくなります。

色差だけは例外で、MPEG-2 4:2:0の色差は1個の8×8 DCTなもののH.264は4個の4×4整数変換と2×2 DC Hadamard変換を使います。係数同士を一対一に対応させられないため、色差ブロックは8×8 IDCTで一度空間領域へ戻し、H.264の4×4基底へ投影します。これによる丸め誤差の蓄積を抑えるため、色差のQPには-6のオフセットを使います。

### 2. MPEG-2の予測をH.264で再現する

MPEG-2の動きベクトルは半画素単位で、半画素は隣接2画素のバイリニア補間です。一方、H.264の通常の半画素補間は6-tapフィルターなので、ベクトルを単純に2倍して1/4画素単位へ直すだけでは同じ予測になりません。

この実装では、整数位置を1画素隔てた2本の予測として参照リスト0と1へ置き、H.264の双方向予測で平均します。これにより、片軸だけが半画素のMPEG-2輝度予測は厳密に再現できます。そのため、元がI/Pピクチャであっても通常の出力にはBスライスを使います。

変換の精度は次のとおりです。

| MPEG-2の位置・予測 | H.264での表現 | 精度 |
| --- | --- | --- |
| 両軸とも整数画素 | 1本の予測 | 輝度・色差とも厳密 |
| 片軸だけ半画素 | 同じ参照画像上の2点を双方向予測 | 輝度は厳密。色差は1/4色差画素ずれる |
| 両軸とも半画素 | 一方をバイリニア補間、他方をH.264補間 | 輝度も近似 |
| MPEG-2の双方向予測 | 前方・後方予測で両方の参照リストを使用 | 平均構造は同じだが小数画素フィルターはH.264側 |

色差のずれは、MPEG-2が輝度ベクトルを0方向へ丸めて半分にする一方、H.264は輝度ベクトルから1/8色差画素精度で導出し、色差だけのベクトルを指定する機能がないためです。

H.264の動きベクトル差分は周囲のブロックから予測されるため、出力済みの4×4ブロック単位の参照インデックスとベクトルを保持し、H.264デコーダーと同じ中央値予測を行って差分を記録します。保持するのは参照画素のフレームバッファではなく、予測状態だけです。

### 3. MPEG-2のイントラマクロブロックを一定値予測にする

MPEG-2のイントラマクロブロックをH.264のイントラ予測へそのまま置き換えると、隣接画素から作られる予測を差し引く必要があり、画素の再構成が必要になります。

そこで通常のピクチャでは、イントラマクロブロックも動きベクトル0のインターマクロブロックとして記録します。専用の長期参照インデックスに明示的重み付き予測の重み0、オフセット127を設定すると、参照画像の内容にかかわらず予測値は常に127になります。残差側はDC係数から `8 × 127` を引くだけなので、係数領域のまま処理できます。長期参照ピクチャはインデックスを置くためだけに存在し、画素は参照されません。

### 4. ランダムアクセス点だけは再構成する

デコードを開始するIDRはIスライスであり、一定値予測を置く参照リストがありません。この1枚だけはH.264のDCイントラ予測を使い、デコーダーが次のマクロブロックで参照する画素を得るために逆変換と再構成も行います。

IDRの直後には同じ画像の長期参照用コピーを置き、以後の一定値予測用インデックスを確保します。ストリーミングでは24 GOPごとにこのランダムアクセス点を作ります。open GOP先頭のBピクチャなど、新しいデコード済みピクチャバッファに必要な参照がないピクチャは破棄し、IDRの表示時間を伸ばして元のGOP長と音声同期を保ちます。

### 5. フレーム、フィールド、タイムライン

プログレッシブシーケンスはフレーム符号化で出力します。インターレースシーケンスはMBAFFとして表し、フィールドピクチャは相補的なトップ・ボトムの組を1フレームにまとめます。

元の符号化順と表示順は`temporal_reference`から復元し、H.264のPOCとMP4のcomposition offsetへ反映します。インターレースの有無とフィールド順はデコード後の画素から判別できないため、ストリーミングAPIではMPEG-2ヘッダーから読んだ値を各フラグメントのメタデータとして渡します。

ループフィルターは無効です。MPEG-2にはループ内デブロッキングがなく、有効にすると後続ピクチャが参照する画像まで元映像と変わるためです。出力はHigh Profile、CAVLC、Level 5.1です。

## 入出力

入力はMPEG-2 Video ES、または188バイトパケットのMPEG-TSです。TSではPAT/PMTから同一サービスのMPEG-2 Video（stream type `0x02`）とAAC-LCを選びます。

出力は拡張子で決まります。

- `.h264`: Annex B H.264。TS入力でも映像のみ
- その他（通常は`.mp4`）: fragmented MP4。TS入力ではAAC音声も多重化し、エレメンタリーストリーム入力では映像のみ

```bash
cargo build --release
./target/release/mpeg2toh264 input.ts output.mp4
./target/release/mpeg2toh264 input.m2v output.h264
```

```text
-o, --oversample <n>   H.264量子化刻みの細かさ（既定: 2、正の数）
-q, --quiet            進捗と概要を表示しない
-h, --help             ヘルプを表示
```

AACのスペクトルデータは再符号化しません。通常のステレオと5.1chは保持し、モノラルは同じICSを左右へ複製、デュアルモノは主音声を左右へ複製して、放送途中で構成が変わっても2chトラックを維持します。映像と音声はそれぞれのPESタイムスタンプが示す間隔で配置します。

主な制約は次のとおりです。

- 映像はMPEG-2のI/P/Bピクチャと4:2:0を対象とする
- 逐次変換中の解像度またはプログレッシブ／インターレースシーケンスの変更は不可
- TSの音声はAAC-LC、チャンネルエレメントの組み替えは44.1 kHzまたは48 kHzを対象とする
- 破損スライス、参照が揃わない先頭Bピクチャ、片方だけのフィールドピクチャは読み飛ばす
- 出力は再量子化による非可逆変換であり、小数画素予測には上表の近似がある

## Rust API

一括変換には`transcode`、GOP単位の処理には`IncrementalTranscoder`を使います。

```rust
use mpeg2toh264::{transcode, TranscodeOptions};

let result = transcode(&mpeg2_es, TranscodeOptions::default())?;
std::fs::write("output.h264", result.bitstream)?;
println!("converted: {}, skipped: {}",
         result.pictures_converted, result.pictures_skipped);
```

`Session`はブラウザーとストリーミング処理向けのインターフェースです。TSのチャンクを渡すと、MSEの`SourceBuffer`へ追加できるinitセグメントとGOP単位のfMP4フラグメント、字幕などのprivate PESイベントを返します。demux、GOP分割、変換、AAC処理、mux、PTSのラップアラウンドを含むタイムライン調整は内部で行います。

```rust
let mut session = Session::default();
for chunk in input.chunks(1 << 20) {
    for fragment in session.push(chunk)? {
        match fragment {
            Fragment::Init { data, mime_codec } => open(&mime_codec, data),
            Fragment::Media { data, start, random_access, interlacing, .. } =>
                append(data, start, random_access, interlacing),
            Fragment::PrivateStream { stream_id, pid, data, pts } =>
                dispatch(stream_id, pid, data, pts),
        }
    }
}
for fragment in session.finish()? { /* 同様に処理 */ }
```

ファイルの途中から再開する場合は、最初のセッションの`origin_ticks()`を`Session::anchored`へ渡します。フラグメントの`start`がファイル全体の時刻を維持するため、バイト範囲から読み直したデータを同じMSEタイムラインへ追加できます。`first_pts()`と`last_pts()`は、TSの小さなバイト範囲からシーク位置と再生時間を見積もるためのヘルパーです。

## WebAssemblyとMSEプレイヤー

`crates/mpeg2toh264-wasm`は`Session`の`wasm-bindgen`ラッパーです。`packages/player`は取得、Worker内変換、MSEバッファー管理、範囲指定シークをまとめたMSEプレイヤー、`packages/yadif`はインターレース映像用の差し替え可能なWebGLデインターレーサーです。

Dockerでは動画をサーバーへ送らず、選択したローカルファイルをブラウザー内で変換するデモを起動できます。

```bash
docker build -t mpeg2toh264-demo .
docker run --rm -p 8080:80 mpeg2toh264-demo
# http://localhost:8080
```

ローカルビルド:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli  # Cargo.lock内のwasm-bindgenと同じバージョン
./tools/build-wasm.sh
npm install
npm run packages:build
npm run web:dev
```

プレイヤーは特定のデインターレーサーへ依存しません。デモは`@mpeg2toh264/yadif`を注入し、MPEG-2由来のインターレース情報に従って処理します。private PESはMP4へ入れずイベントとして公開し、デモでは`aribb24.js`へ渡して字幕・文字スーパーを重ねます。

## 構成と検証

```text
crates/mpeg2toh264/       MPEG-2解析、H.264出力、コンテナー、Session
crates/mpeg2toh264-cli/   CLI
crates/mpeg2toh264-wasm/  Sessionのwasm-bindgenラッパー
packages/player/          ブラウザープレイヤー（MIT）
packages/yadif/           WebGL yadif（LGPL-2.1-or-later）
packages/demo/            ブラウザーデモ
testdata/                 テストデータ
tools/                    テーブル生成、WASMビルド、テストデータ作成
```

```bash
cargo test --release
npm run typecheck
```

E2Eは全テストデータのAnnex B出力をハッシュで固定し、SPS/PPSは出力側とは独立したパーサーで読み戻します。フィールド順、TS分離、AACチャンネル構成、フラグメントのタイムライン、途中から再開するセッションも個別に検証しています。

Rustクレート、CLI、プレイヤーはMITライセンスです。`packages/yadif`はFFmpeg由来部分を含むためLGPL-2.1-or-laterです。
