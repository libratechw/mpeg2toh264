# @mpeg2toh264/yadif

`@mpeg2toh264/player`へ注入できるWebGL版yadifデインターレーサーです。

```ts
import { Mpeg2TsPlayer } from '@mpeg2toh264/player';
import { Deinterlacer } from '@mpeg2toh264/yadif';

const player = new Mpeg2TsPlayer(video, {
  deinterlace: true,
  deinterlacer: (element) => new Deinterlacer(element, {
    autoFilm: true,
    doubleRate: true,
  }),
});
```

`Deinterlacer` は MPEG-2 由来のインターレース情報を受け取り、プログレッシブ映像では停止し、インターレース映像ではフィールド順に従って処理します。詳細なオプションは `DeinterlacerOptions` を参照してください。

`autoFilm` を有効にすると、3:2 プルダウンの重複位相が2周期にわたって確認できた区間を 24000/1001fps で表示します。実インターレースへ切り替わると現在のフレームから YADIF へ戻り、`doubleRate` も有効な場合は 60000/1001fps 相当、無効な場合は入力フレームレートで表示します。`autoFilm` の既定値は `false` であり、無効時には判定用シェーダーとフレームバッファーを生成しません。

`probeDecoder()`と`decoderDeinterlaces()`は、ブラウザーのデコーダーがすでにデインターレースしているかを確認します。二重処理を避けるため、フィルターの有効化前に利用できます。
