# @mpeg2toh264/yadif

`@mpeg2toh264/player`へ注入できるWebGL版yadifデインターレーサーです。

```ts
import { Mpeg2TsPlayer } from "@mpeg2toh264/player";
import { Deinterlacer } from "@mpeg2toh264/yadif";

const player = new Mpeg2TsPlayer(video, {
  deinterlace: true,
  deinterlacer: (element) =>
    new Deinterlacer(element, {
      film: true,
      doubleRate: true,
    }),
});
```

`Deinterlacer` は MPEG-2 由来のインターレース情報を受け取り、プログレッシブ映像では停止し、インターレース映像ではフィールド順に従って処理します。詳細なオプションは `DeinterlacerOptions` を参照してください。

### 描画先

既定の `rendering: "main"` では、メインスレッドから WebGL を使って描画します。  
入力画像の Worker への転送待ちがなく、倍速時も各フレームを判定器へ渡せます。  
プレイヤーの変換処理は Worker で実行され、MediaSource の実行先は別の `mediaSource` オプションで指定します。

`rendering: "worker"` を指定すると、YADIF、フィルム判定、WebGL 描画、表示キュー、統計集計を OffscreenCanvas と専用 Worker へ移します。  
フレーム取得と DOM レイアウトはメインスレッドに残ります。  
`rendering: "auto"` も Worker を優先しますが、必要な API を初期化できない場合はメインスレッド描画へ戻ります。  
Worker への画像転送が追いつかない環境では入力が欠けるため、特に倍速時の品質はメインスレッド描画で確認してください。

パッケージへ同梱した Worker の代わりに別のファイルを読み込む場合は、`workerUrl` へ URL を指定してください。

Firefox では再生速度にかかわらず `mozPaintedFrames` の増加から新しいフレームを取得し、フィールド間隔もカウンターと描画時刻から計測します。  
他のブラウザーでは、通常速度でネイティブの `requestVideoFrameCallback()` を使用します。

### 倍速再生

Firefox は倍速時も描画済みフレーム数を使い、追加のデコーダーを起動せずに動画要素から画像を取得します。  
以下は Firefox 以外のブラウザーでの動作です。

1倍を超えて 1.25 倍以下の再生では、`VideoFrame(video)` で短周期に画像を取得し、表示通知の間で変わる入力も保持します。  
追加のデコーダーは起動せず、画像の時刻から重複と欠落を区別します。

1.25 倍を超える再生では、プレイヤーが生成した H.264 の圧縮映像を WebCodecs の `VideoDecoder` にも渡します。  
ブラウザーの表示段階で間引かれる前の画像を取得し、音声を再生する動画要素の時刻に合わせて表示します。  
圧縮データの保持範囲は MediaSource のバッファーに合わせ、シーク・速度変更・停止時には追加デコーダーと未表示画像を解放します。

この追加デコードは `Mpeg2TsPlayer` と組み合わせた H.264 変換経路で利用できます。  
単体の動画要素、MPEG-2 パススルー、WebCodecs のデコードに非対応の環境では、動画要素から画像を取得します。  
その経路で画像の取得が追いつかない速度では、フィルム判定が外れることがあります。  
出力の表示回数は画面のリフレッシュレートが上限で、60Hz の画面に 60i 映像を 1.5 倍で表示する場合は、復元した毎秒約90枚から表示時刻に合う画像を選びます。

`probeDecoder()`と`decoderDeinterlaces()`は、ブラウザーのデコーダーがすでにデインターレースしているかを確認します。二重処理を避けるため、フィルターの有効化前に利用できます。

### `autoFilm`

`autoFilm` を有効にすると、FFmpeg の `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` を移植したフィールド選択と、縮小画像上で `decimate=cycle=5:mixed=1` と同じ重複閾値を使うライブ向け周期判定により、3:2 プルダウン区間を 24000/1001fps で表示します。  
FFmpeg の `decimate` は5フレームを保持してから同じ周期内の最小差分を選びますが、この実装は音声に対する映像遅延を増やさないよう、完了した周期の位相を次の周期へ適用します。

重複を含む周期でフィールドマッチが成立した場合だけ、24fps のフィルム区間として扱います。  
フィルム周期として採用されていない区間は通常の YADIF 処理へ渡します。  
フィールドマッチ後もインターレースと判定されたフレームは間引かず、YADIF で処理します。  
`doubleRate` が有効なら 60000/1001fps 相当、無効なら入力フレームレートで表示するため、実写の 60i 区間はフィールドレートの動きを維持します。

`autoFilm` の既定値は `false` です。  
無効時には判定用シェーダーとフレームバッファーを生成せず、通常の YADIF 経路だけを使用します。

`filmCombThreshold` で fieldmatch の comb 判定閾値を変更できます。
既定値は FFmpeg の `combpel=80` 相当で、`combScore` がこの値以上のフィールドはインターレースとして扱われます。

field order は `scan` から受け取ります。
通常の player 経由では MPEG-2 bitstream から自動的に設定されます。
standalone で BFF を指定する場合は、次のように設定します。

```ts
const deinterlacer = new Deinterlacer(video);
deinterlacer.scan = {
  interlaced: true,
  topFieldFirst: false,
};
deinterlacer.enabled = true;
```

### `film`

`film` を有効にすると、GPU 上で 2:3 プルダウン位相を検出し、フィルム区間を 24fps で表示します。CPU 側の `autoFilm` とは別の検出器です。両方が `true` の場合は CPU 優先となり、GPU 検出器は生成されません。CPU 優先中は GPU 専用の `EXT_color_buffer_float` は不要ですが、WebGL2 は常に必要です。

GPU 専用経路の構築時に拡張不足や検出器の作成不能がある場合は同期例外となります。構築後の `film` setter で作成不能となった場合は例外とせず、plain YADIF へ退避（degrade）し、`failure` イベント / `onFailure` コールバックおよび統計の `filmError` で通知します（option は意図として残ります）。

```ts
const deinterlacer = new Deinterlacer(video, {
  doubleRate: true,
  film: true,
});
```

統計の `mode` は、選択中の検出器がフィルム区間と判定している場合に `"film"` 、それ以外は `"video"` となります。  
統計の `film` は GPU 検出器の確定状態を表します。  
新規の利用では GPU 上で判定する `film` を推奨し、CPU へ縮小画像を読み戻す `autoFilm` は既存の比較・明示選択用として保持しています。

### 障害時の契約

`film` / `autoFilm` は 24fps 再構成の意図であり、GPU 資源の確保を約束しません。GPU 専用経路の構築時（WebGL2 不在、`EXT_color_buffer_float` 不足、検出器作成不能）は同期例外として呼び出し側へ返します。

実行中に GPU 検出器のみに障害が発生し WebGL コンテキストが健全な場合は、plain YADIF へ退避（degrade）し、`failure` イベント、`onFailure` オプション、統計の `filmError` で通知します。ライブラリが `film` や `autoFilm` オプションを黙って書き換えることはありません。CPU 側へフォールバックするかは呼び出し側の明示判断です（例: GPU 検出失敗を受けて `film = false` を先に設定してから `autoFilm = true` を設定）。CPU 自身の障害や WebGL コンテキスト喪失に対して無限再試行は行いません。

復旧は資源の再確保契機（start、scan 変化、resize、明示的な option 再設定）で再試行し、再失敗は新しい episode として再通知します。なお、WebGL コンテキスト喪失や Worker 再起動後の再失敗は、plain YADIF の継続が保証されるものではなく、元 video 表示への退避または停止を伴う描画障害となります。

### `capture()` と統計イベント

`capture()` は、その時点で Deinterlacer が表示しているフィールドまたはフィルムフレームを描き直し、`ImageBitmap` として返します。
WebGL の描画バッファーを常時保持する設定には依存しません。

再生中は、`DeinterlaceStats` の同じスナップショットを約1秒ごとに `stats` イベントと `onStats` コールバックへ通知します。
`late` と `maxQueuedFields` は表示予定の状態、`frameMs` は入力1枚あたりの描画スレッドでの平均処理時間、`mode` と `outputFps` は選択中の描画経路の判定と出力頻度を表します。  
`match`、`combScore`、`duplicateScore`、`duplicateRunnerUp` は `autoFilm` 用の値です。  
`resynced`、`gpuMs`、`film`、`filmError` は任意プロパティとして定義されています。

Worker へは `expectedDisplayTime` と取得側の `timeOrigin` を渡し、描画側の時計へ変換した表示予定を使用します（無効または不自然な予定値の場合は取り込み時刻へフォールバックします）。容量確保で待機中のフィールドを破棄した場合は、残った表示予定を詰め、破棄したフィールドの表示時間を空白として残しません。
`requestVideoFrameCallback()` が 250ms 以上止まっても映像自体が進んでいる場合は、`requestAnimationFrame()` が復号フレーム数と再生時刻を監視して同じデインタレース処理を継続します。

```ts
deinterlacer.addEventListener("stats", (event) => {
  console.log(event.detail.fps, event.detail.late);
});
const image = await deinterlacer.capture();
```
