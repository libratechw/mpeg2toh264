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

### `capture()` と統計イベント

`capture()` は、その時点で Deinterlacer が表示しているフィールドまたはフィルムフレームを描き直し、`ImageBitmap` として返します。
WebGL の描画バッファーを常時保持する設定には依存しません。

再生中は、`DeinterlaceStats` の同じスナップショットを約1秒ごとに `stats` イベントと `onStats` コールバックへ通知します。
`late` と `maxQueuedFields` はスケジューラーの状態を、`mode`、`match`、`combScore`、`outputFps`、`duplicateScore`、`duplicateRunnerUp` は `autoFilm` の判定状態を表します。
容量確保で待機中のフィールドを破棄した場合は、残った表示予定を詰め、破棄したフィールドの表示時間を空白として残しません。

```ts
deinterlacer.addEventListener("stats", (event) => {
  console.log(event.detail.fps, event.detail.late);
});
const image = await deinterlacer.capture();
```
