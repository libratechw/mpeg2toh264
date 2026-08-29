# @mpeg2toh264/yadif

`@mpeg2toh264/player`へ注入できるWebGL版yadifデインターレーサーです。

```ts
import { Mpeg2TsPlayer } from "@mpeg2toh264/player";
import { Deinterlacer } from "@mpeg2toh264/yadif";

const player = new Mpeg2TsPlayer(video, {
  deinterlace: true,
  deinterlacer: (element) =>
    new Deinterlacer(element, {
      autoFilm: true,
      doubleRate: true,
    }),
});
```

`Deinterlacer` は MPEG-2 由来のインターレース情報を受け取り、プログレッシブ映像では停止し、インターレース映像ではフィールド順に従って処理します。詳細なオプションは `DeinterlacerOptions` を参照してください。

`probeDecoder()`と`decoderDeinterlaces()`は、ブラウザーのデコーダーがすでにデインターレースしているかを確認します。二重処理を避けるため、フィルターの有効化前に利用できます。

### 独自追加機能: `autoFilm`

`autoFilm` を有効にすると、FFmpeg の `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` と `decimate=cycle=5:mixed=1` に相当する判定で、3:2 プルダウン区間を 24000/1001fps で表示します。  
判定用には 160×90 に縮小したフレームだけを読み出し、フル解像度の映像は GPU テクスチャのまま保持します。選択されたフィルム画像は、通常のフィールド出力と同じ presentation queue へ投入します。

重複を含む周期でフィールドマッチが成立した場合だけ、24fps のフィルム区間として扱います。  
フィルム周期として採用されていない区間のフレームと、フィールドマッチ後もインターレースと判定されたフレームは間引かず、通常の YADIF 処理へ渡します。  
`doubleRate` が有効なら 60000/1001fps 相当、無効なら入力フレームレートで表示するため、実写の 60i 区間はフィールドレートの動きを維持します。

`autoFilm` の既定値は `false` です。  
無効時には判定用シェーダーとフレームバッファーを生成せず、通常の YADIF 経路だけを使用します。

`filmCombThreshold` で fieldmatch の comb 判定閾値を変更できます。既定値は FFmpeg の `combpel=80` 相当で、`combScore` がこの値以上のフィールドはインターレースとして扱われます。

field order は `scan` から受け取ります。通常の player 経由では MPEG-2 bitstream から自動的に設定されます。standalone で BFF を指定する場合は、次のように設定します。

```ts
const deinterlacer = new Deinterlacer(video);
deinterlacer.scan = {
  interlaced: true,
  topFieldFirst: false,
};
```

### `capture()` と統計イベント

`capture()` は、その時点で Deinterlacer が表示しているフィールドまたはフィルムフレームを描き直し、`ImageBitmap` として返します。WebGL の描画バッファーを常時保持する設定には依存しません。

再生中は、`DeinterlaceStats` の同じスナップショットを約1秒ごとに `stats` イベントと `onStats` コールバックへ通知します。`late`、`queueResetted`、`maxQueuedFields` はスケジューラーの状態を、`mode`、`match`、`combScore`、`outputFps`、`duplicateScore`、`duplicateRunnerUp` は `autoFilm` の判定状態を表します。

```ts
deinterlacer.addEventListener("stats", (event) => {
  console.log(event.detail.fps, event.detail.late);
});
const image = await deinterlacer.capture();
```
