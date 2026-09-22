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

### `film`

`film` を有効にすると、GPU 上で 2:3 プルダウンの周期とフィールドの組み合わせを検出し、フィルム区間を 24000/1001fps 相当で表示します。  
フィルム判定が確定していない区間は YADIF で処理します。  
`doubleRate` が有効なら 60000/1001fps 相当、無効なら入力フレームレートで表示するため、実写の 60i 区間はフィールドレートの動きを維持します。

`film` の既定値は `false` です。  
有効時には WebGL2 と `EXT_color_buffer_float` が必要で、無効時にはフィルム検出器を生成しません。

```ts
const deinterlacer = new Deinterlacer(video, {
  doubleRate: true,
  film: true,
});
```

統計の `film` は検出器の判定が確定している場合に `true` 、それ以外は `false` となります。  
設定の `film` はフィルム検出の有効・無効を指定するため、現在の映像がフィルムかどうかは統計側で確認してください。

フィールド順は `scan` から受け取ります。  
通常のプレイヤー経由では MPEG-2 ビットストリームから自動的に設定されます。  
単体でボトムフィールドを先に表示する場合は、次のように設定してください。

```ts
const deinterlacer = new Deinterlacer(video);
deinterlacer.scan = {
  interlaced: true,
  topFieldFirst: false,
};
deinterlacer.enabled = true;
```

### 障害時の契約

`film: true` での構築時に WebGL2 や `EXT_color_buffer_float` が利用できない場合、または検出器を作成できない場合は、同期例外として呼び出し側へ返します。

実行中の検出器の障害や、構築後の `film` 設定変更で検出器を作成できない場合は、通常の YADIF 処理へ戻ります。  
`failure` イベント、`onFailure` コールバック、統計の `filmError` で理由を通知し、設定の `film` は維持します。  
この間も WebGL コンテキストが健全で `doubleRate` が有効なら、フィールドごとのデインターレースを継続します。

`start()` 、`scan` の変化、映像サイズの変化、明示的な `film = true` の再設定で復旧を試み、再び失敗した場合は通知します。  
WebGL コンテキスト喪失や Worker 再起動後の再失敗は、元の動画要素の表示への切り替え、または描画停止を伴います。

### `capture()` と統計イベント

`capture()` は、その時点で Deinterlacer が表示しているフィールドまたはフィルムフレームを描き直し、`ImageBitmap` として返します。
WebGL の描画バッファーを常時保持する設定には依存しません。

再生中は、`DeinterlaceStats` の同じスナップショットを約1秒ごとに `stats` イベントと `onStats` コールバックへ通知します。
`late` と `maxQueuedFields` は表示予定の状態、`frameMs` は入力1枚あたりの描画スレッドでの平均処理時間、`film` と `outputFps` はフィルム判定と出力頻度を表します。  
`resynced` は、シークや停止、周期の変化などで表示予定を時計に合わせ直した回数です。  
`gpuMs` は GPU の計時に対応している場合の平均処理時間で、非対応時は `undefined` となります。  
任意プロパティの `filmError` は、検出器が停止している理由、または正常時の `null` を返します。

Worker へは `expectedDisplayTime` と取得側の `timeOrigin` を渡し、描画側の時計へ変換した表示予定を使用します（無効または不自然な予定値の場合は取り込み時刻へフォールバックします）。容量確保で待機中のフィールドを破棄した場合は、残った表示予定を詰め、破棄したフィールドの表示時間を空白として残しません。
`requestVideoFrameCallback()` が 250ms 以上止まっても映像自体が進んでいる場合は、`requestAnimationFrame()` が復号フレーム数と再生時刻を監視して同じデインタレース処理を継続します。

```ts
deinterlacer.addEventListener("stats", (event) => {
  console.log(event.detail.fps, event.detail.late);
});
const image = await deinterlacer.capture();
```
