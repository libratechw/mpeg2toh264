# @mpeg2toh264/yadif

`@mpeg2toh264/player`へ注入できるWebGL版yadifデインターレーサーです。

```ts
import { Mpeg2TsPlayer } from '@mpeg2toh264/player';
import { Deinterlacer } from '@mpeg2toh264/yadif';

const player = new Mpeg2TsPlayer(video, {
  deinterlace: true,
  deinterlacer: (element) => new Deinterlacer(element),
});
```

`Deinterlacer`はMPEG-2由来のインターレース情報を受け取り、プログレッシブ映像では停止し、インターレース映像ではフィールド順に従って処理します。詳細なオプションは`DeinterlacerOptions`を参照してください。

`probeDecoder()`と`decoderDeinterlaces()`は、ブラウザーのデコーダーがすでにデインターレースしているかを確認します。二重処理を避けるため、フィルターの有効化前に利用できます。
