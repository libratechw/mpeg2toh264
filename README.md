# mpeg2toh264

[日本語版はこちら](#日本語)

An implementation that transcodes MPEG-2 to H.264/AVC without fully decoding the MPEG-2 video.

Conventional transcoders decode MPEG-2 and encode the result from scratch with an H.264 encoder. This implementation instead reuses the MPEG-2 quantized coefficients, macroblock types, motion vectors, and picture-reference relationships, converting them directly into a corresponding H.264 bitstream without motion compensation or similar processing.

This is neither a general-purpose MPEG-2 decoder nor a general-purpose H.264 encoder. It is designed to reuse the structure of the original compression so that MPEG-2 broadcast video can be played with low processing overhead in environments such as browsers, where an H.264 decoder is available.

## How the conversion works

### 1. Converting coefficients without decoding them to pixels

When MPEG-2 8x8 quantized levels are inverse-quantized according to the specification and mismatch control is applied, the resulting values are coefficients in an orthonormal DCT space. Because the H.264 High Profile 8x8 transform reconstructs values in the same space, luma residuals can be converted directly by processing each coefficient as follows:

1. Calculate the target DCT value from the MPEG-2 level, quantizer scale, and quantization matrix.
2. Supply the MPEG-2 non-intra quantization matrix to the SPS/PPS as the H.264 8x8 scaling list.
3. Divide the target value by the H.264 inverse-scaling gain at that position and round it to the nearest H.264 level.
4. Encode the coefficients with CAVLC.

`--oversample` specifies how many times finer the H.264 quantization step is than the MPEG-2 step (default: 2). A value of 1 adds rounding error comparable to MPEG-2's own error and causes roughly 1.5 dB of loss; typical figures are about 0.5 dB for 2 and 0.13 dB for 4. Higher values produce larger output.

MPEG-2 4:2:0 chroma, however, uses one 8x8 DCT block, whereas H.264 uses four 4x4 integer transforms and a 2x2 DC Hadamard transform. Chroma blocks are therefore returned to the spatial domain once with an IDCT and projected onto the H.264 4x4 basis. A chroma QP offset of -6 is used to limit accumulated rounding error.

### 2. Reproducing MPEG-2 prediction in H.264

MPEG-2 motion vectors use half-pixel units, with half-pixels formed by bilinear interpolation between two adjacent pixels. H.264 normally uses a 6-tap filter for half-pixel interpolation, so simply doubling a vector to convert it to quarter-pixel units does not reproduce the same prediction.

This implementation places two predictions one integer pixel apart into reference lists 0 and 1, then averages them using H.264 bidirectional prediction. This exactly reproduces MPEG-2 luma prediction when only one axis is at a half-pixel position. Consequently, normal output uses B slices even when the source picture is an I or P picture.

Conversion accuracy is as follows:

| MPEG-2 position/prediction | H.264 representation | Accuracy |
| --- | --- | --- |
| Integer pixels on both axes | One prediction | Exact for both luma and chroma |
| Half-pixel on one axis only | Bidirectional prediction from two points in the same reference picture | Exact for luma; chroma is offset by 1/4 chroma pixel |
| Half-pixel on both axes | Bilinear interpolation for one prediction and H.264 interpolation for the other | Luma is also approximate |
| MPEG-2 bidirectional prediction | Both reference lists are used for forward and backward prediction | The averaging structure is the same, but fractional-pixel filtering is performed by H.264 |

The chroma offset occurs because MPEG-2 rounds the luma vector toward zero before halving it, while H.264 derives chroma vectors from luma vectors at 1/8-chroma-pixel precision and has no way to specify a chroma-only vector.

Because H.264 motion-vector differences are predicted from neighboring blocks, the implementation retains reference indices and vectors for previously emitted 4x4 blocks, performs the same median prediction as an H.264 decoder, and records the difference. It stores only prediction state, not a reference-pixel frame buffer.

### 3. Using a constant prediction for MPEG-2 intra macroblocks

Replacing an MPEG-2 intra macroblock directly with H.264 intra prediction would require subtracting a prediction derived from neighboring pixels, which in turn requires pixel reconstruction.

Instead, intra macroblocks in normal pictures are recorded as inter macroblocks with a zero motion vector. Setting explicit weighted prediction to weight 0 and offset 127 for a dedicated long-term reference index makes the predicted value always 127, regardless of the reference picture's contents. The residual can then remain in the coefficient domain: only `8 x 127` needs to be subtracted from the DC coefficient. The long-term reference picture exists only to provide an index; its pixels are never referenced.

### 4. Random access points

An IDR used to begin decoding is an I slice and has no reference list for the constant prediction. It therefore uses H.264 DC intra prediction. Inverse transformation and reconstruction are performed for this picture so that the decoder can obtain pixels referenced by the next macroblock.

I_PCM could avoid all but the inverse transform, but it caused QSV decoding problems at high resolutions and is therefore not used. A solid-gray frame was also considered, but rejected because it flickered in some playback environments.

Immediately after the IDR, a copy of the same image is emitted as a long-term reference to reserve the index used for subsequent constant predictions. Streaming output creates a random access point every 24 GOPs. Pictures whose references are unavailable in the new decoded-picture buffer, such as leading B pictures in an open GOP, are dropped; the IDR display duration is extended to preserve the original GOP length and audio/video synchronization.

### 5. Interlacing

Progressive sequences are output using frame coding. Interlaced sequences are represented with MBAFF, and top and bottom field pictures are combined into one frame.

## Input and output

Input may be an MPEG-2 Video elementary stream or an MPEG transport stream with 188-byte packets. For transport streams, MPEG-2 Video (stream type `0x02`) and AAC-LC from the same service are selected through the PAT/PMT.

Output:

- `.h264`: Annex B H.264
- Other extensions (normally `.mp4`): fragmented MP4; AAC audio is multiplexed for transport-stream input, while elementary-stream input contains video only

```bash
cargo build --release
./target/release/mpeg2toh264 input.ts output.mp4
./target/release/mpeg2toh264 input.m2v output.h264
```

```text
-o, --oversample <n>   H.264 quantization-step granularity (default: 2; positive)
-q, --quiet            Suppress progress and summary output
-h, --help             Show help
```

AAC is not re-encoded. Ordinary stereo and 5.1-channel audio are preserved. Mono duplicates the same ICS to the left and right channels, while dual mono duplicates the primary audio to both channels, keeping the output stereo even if the source configuration changes midstream.

Main limitations:

- Video support covers MPEG-2 I/P/B pictures and 4:2:0 chroma.
- Resolution changes or switches between progressive and interlaced sequences during conversion are not supported.
- Transport-stream audio must be AAC-LC; channel-element rearrangement supports 44.1 kHz and 48 kHz.
- Corrupt slices, leading B pictures without all references, and unpaired field pictures are skipped.
- Output is lossy because of requantization, and fractional-pixel prediction uses the approximations shown in the table above.

Open-GOP limitation:

- By default, a random access point is created every 24 GOPs, so the leading B frames of an open GOP are skipped every 24 GOPs.

Interlaced-video limitations:

- Chrome on Windows may fall back to software decoding.
  - This has been observed on at least Intel systems.
- Firefox on Windows may freeze when frame and field pictures are mixed.
  - A workaround that places top and bottom fields in separate samples is possible, but is not implemented because it may adversely affect other environments.
- Chrome on macOS may fall back to software decoding.

## WebAssembly and MSE player

Docker can run a demo that converts a selected local file or URL in the browser.

```bash
docker build -t mpeg2toh264-demo .
docker run --rm -p 8080:80 mpeg2toh264-demo
# http://localhost:8080
```

A reverse proxy can be configured when reading a transport stream from another HTTP server without CORS configuration.

```bash
docker run --rm -p 8080:80 \
  -e STREAM_UPSTREAM=http://192.168.1.3:40772 \
  mpeg2toh264-demo
```

In this example, requesting `/stream/api/channels/GR/27/stream` forwards to `http://192.168.1.3:40772/api/channels/GR/27/stream`.

Local build:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli  # Match the wasm-bindgen version in Cargo.lock
./tools/build-wasm.sh
npm install
npm run packages:build
npm run web:dev
```

The demo uses <https://github.com/monyone/aribb24.js> to display captions and superimposed text.

## Repository layout

```text
crates/mpeg2toh264/       MPEG-2 parsing, H.264 output, containers, and Session
crates/mpeg2toh264-cli/   CLI
crates/mpeg2toh264-wasm/  wasm-bindgen wrapper for Session
packages/player/          Browser player
packages/yadif/           WebGL yadif
packages/demo/            Browser demo
testdata/                 Test data
tools/                    Table generation, WASM builds, and test-data creation
```

The interface for each library is documented in the README in its directory.

The Rust crate, CLI, and player are licensed under MIT. `packages/yadif` is licensed under LGPL-2.1-or-later because it contains code derived from FFmpeg. The AAC processing approach was inspired by <https://github.com/xtne6f/tsreadex>.

---

## 日本語

MPEG-2を完全にデコードせずH.264/AVCへトランスコードする実装

一般的なトランスコーダーではMPEG-2をデコードしてH.264エンコーダーで1からエンコードするという処理を行いますが、この実装はMPEG-2が持つ量子化係数、マクロブロック種別、動きベクトル、ピクチャ参照関係を再利用し、動き補償などの処理を行わずに対応するH.264のビットストリームへ直接変換します。

汎用MPEG-2デコーダーや汎用H.264エンコーダーの実装ではなく、元の圧縮の構造を再利用してMPEG-2放送映像をブラウザーなどH.264デコーダーを前提とする環境で低い処理負荷で再生するための実装です。

## 変換の仕組み

### 1. 係数を画素にデコードせず変換

MPEG-2の8×8量子化レベルを規格どおり逆量子化し、mismatch controlまで適用すると各値は直交正規化DCT空間上の係数になります。H.264 High Profileの8×8変換も同じ空間に再構成値を持つため、各係数について次の処理を行うと輝度の残差を直接変換できます。

1. MPEG-2のレベル、量子化スケール、量子化行列から目標DCT値を求める
2. MPEG-2の非イントラ量子化行列をH.264の8×8スケーリングリストとしてSPS/PPSへ渡す
3. 各位置のH.264逆スケーリング利得で目標値を割り、最も近いH.264レベルへ丸める
4. 係数をCAVLCで符号化する

`--oversample`はH.264側の量子化刻みをMPEG-2より何倍細かくするかを指定します。(既定値: 2)
1では追加の丸め誤差がMPEG-2自身の誤差と同程度になり約1.5 dBの損失、2では約0.5 dB、4では約0.13 dBが目安で、値を上げるほど出力は大きくなります。

ただし、MPEG-2 4:2:0の色差は1個の8×8 DCTなもののH.264は4個の4×4整数変換と2×2 DC Hadamard変換を使います。このため、色差ブロックはIDCTで一度空間領域へ戻しH.264の4×4基底へ投影します。これによる丸め誤差の蓄積を抑えるため、色差のQPには-6のオフセットを使います。

### 2. MPEG-2の予測をH.264で再現

MPEG-2の動きベクトルは半画素単位で、半画素は隣接2画素のバイリニア補間です。一方、H.264の通常の半画素補間は6-tapフィルターなのでベクトルを単純に2倍して1/4画素単位へ直すだけでは同じ予測になりません。

この実装では整数位置を1画素隔てた2本の予測として参照リスト0と1へ置き、H.264の双方向予測で平均します。これにより、片軸だけが半画素のMPEG-2輝度予測は厳密に再現できます。そのため、元がI/Pピクチャであっても通常の出力にはBスライスを使います。

変換の精度は次のとおりです。

| MPEG-2の位置・予測 | H.264での表現 | 精度 |
| --- | --- | --- |
| 両軸とも整数画素 | 1本の予測 | 輝度・色差とも厳密 |
| 片軸だけ半画素 | 同じ参照画像上の2点を双方向予測 | 輝度は厳密。色差は1/4色差画素ずれる |
| 両軸とも半画素 | 一方をバイリニア補間、他方をH.264補間 | 輝度も近似 |
| MPEG-2の双方向予測 | 前方・後方予測で両方の参照リストを使用 | 平均構造は同じだが小数画素フィルターはH.264側 |

色差のずれはMPEG-2が輝度ベクトルを0方向へ丸めて半分にする一方、H.264は輝度ベクトルから1/8色差画素精度で導出し、色差だけのベクトルを指定する機能がないためです。

H.264の動きベクトル差分は周囲のブロックから予測されるため、出力済みの4×4ブロック単位の参照インデックスとベクトルを保持し、H.264デコーダーと同じ中央値予測を行って差分を記録します。参照画素のフレームバッファを保持せず、予測状態だけ保持します。

### 3. MPEG-2のイントラマクロブロックを一定値予測にする

MPEG-2のイントラマクロブロックをH.264のイントラ予測へそのまま置き換えると、隣接画素から作られる予測を差し引く必要があり、画素の再構成が必要になります。

そこで通常のピクチャでは、イントラマクロブロックも動きベクトル0のインターマクロブロックとして記録します。専用の長期参照インデックスに明示的な重み付き予測の重み0、オフセット127を設定すると、参照画像の内容にかかわらず予測値は常に127になります。残差側はDC係数から8×127を引くだけなので係数領域のまま処理できます。長期参照ピクチャはインデックスを置くためだけに存在し画素は参照されません。

### 4. RAP

デコードを開始するIDRはIスライスであり、一定値予測を置く参照リストがないため、これだけはH.264のDCイントラ予測を使います。そのため、デコーダーが次のマクロブロックで参照する画素を得るために逆変換と再構成も行います。
なお、I_PCMを使うことで逆変換のみにできるものの、解像度が大きくなるとQSVでのデコードに問題が生じたためI_PCMは使用していません。
ほかにはグレー一色のフレームを用意するといった手段も考えられたものの、再生環境によってはちらつくためこれも採用していません。

IDRの直後には同じ画像の長期参照用コピーを置き、以後の一定値予測用インデックスを確保します。ストリーミングでは24 GOPごとにRAPを作ります。オープンGOP先頭のBピクチャなど、新しいデコード済みピクチャバッファに必要な参照がないピクチャは破棄し、IDRの表示時間を伸ばして元のGOP長と音声同期を保ちます。

### 5. インターレース

プログレッシブシーケンスはフレーム符号化で出力します。インターレースシーケンスはMBAFFとして表し、フィールドピクチャはトップ・ボトムの組を1フレームにまとめます。

## 入出力

入力はMPEG-2 Video ES、または188バイトパケットのMPEG-TSです。TSではPAT/PMTから同一サービスのMPEG-2 Video(stream type `0x02`)とAAC-LCを選びます。

出力:

- `.h264`: Annex B H.264
- その他 (通常は`.mp4`): fragmented MP4 TS入力ではAAC音声も多重化しエレメンタリーストリーム入力では映像のみ

```bash
cargo build --release
./target/release/mpeg2toh264 input.ts output.mp4
./target/release/mpeg2toh264 input.m2v output.h264
```

```text
-o, --oversample <n>   H.264量子化刻みの細かさ (既定: 2、正の数)
-q, --quiet            進捗と概要を表示しない
-h, --help             ヘルプを表示
```

AACは再エンコードせず、通常のステレオと5.1chは保持し、モノラルは同じICSを左右へ複製、デュアルモノは主音声を左右へ複製することで途中で構成が変わってもステレオを維持します。

主な制約:

- 映像はMPEG-2のI/P/Bピクチャと4:2:0を対象とする
- 変換中の解像度またはプログレッシブ/インターレースシーケンスの変更は不可
- TSの音声はAAC-LC、チャンネルエレメントの組み替えは44.1 kHzまたは48 kHzを対象とする
- 破損スライス、参照が揃わない先頭Bピクチャ、片方だけのフィールドピクチャは読み飛ばす
- 出力は再量子化による非可逆変換であり、小数画素予測には表の通りの近似がある

オープンGOPの制約:

- デフォルトでは24 GOPごとにRAPを構成するため24 GOPごとにオープンGOPの先頭Bフレームが飛ばされる

インターレースの映像の制約:

- WindowsのChromeではソフトウェアデコーダーにフォールバックされることがある
  - 少なくともIntel環境で確認
- WindowsのFirefoxではフレームピクチャとフィールドピクチャが混合している場合映像がフリーズすることがある
  - top/bottomを別サンプルにするワークアラウンドで回避可能だが他の環境に悪影響がありそうなのため未実装
- MacのChromeではソフトウェアデコーダーにフォールバックされることがある

## WebAssemblyとMSEプレイヤー

Dockerでは選択したローカルファイルまたはURLをブラウザー内で変換するデモを起動できます。

```bash
docker build -t mpeg2toh264-demo .
docker run --rm -p 8080:80 mpeg2toh264-demo
# http://localhost:8080
```

別のHTTPサーバーにあるTSをCORS設定なしで読む場合はリバースプロキシを指定できます。

```bash
docker run --rm -p 8080:80 \
  -e STREAM_UPSTREAM=http://192.168.1.3:40772 \
  mpeg2toh264-demo
```

この場合`/stream/api/channels/GR/27/stream`を指定すると`http://192.168.1.3:40772/api/channels/GR/27/stream`へ転送します。

ローカルビルド:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli  # Cargo.lock内のwasm-bindgenと同じバージョン
./tools/build-wasm.sh
npm install
npm run packages:build
npm run web:dev
```

デモでは <https://github.com/monyone/aribb24.js> を使って字幕と文字スーパーを表示しています。

## 構成

```text
crates/mpeg2toh264/       MPEG-2解析、H.264出力、コンテナー、Session
crates/mpeg2toh264-cli/   CLI
crates/mpeg2toh264-wasm/  Sessionのwasm-bindgenラッパー
packages/player/          ブラウザープレイヤー
packages/yadif/           WebGL yadif
packages/demo/            ブラウザーデモ
testdata/                 テストデータ
tools/                    テーブル生成、WASMビルド、テストデータ作成
```

各ライブラリのインターフェースはそれぞれのディレクトリにあるREADMEに記載しています。

Rustクレート、CLI、プレイヤーはMITライセンスです。`packages/yadif`はFFmpeg由来の部分を含むためLGPL-2.1-or-laterです。
AACの処理の発想は <https://github.com/xtne6f/tsreadex> を参考にしています。
