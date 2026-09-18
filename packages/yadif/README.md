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

Firefoxでは`moz*Frames`を`requestAnimationFrame`で監視する内部polyfillを使い、`mozPaintedFrames`の増加で新しいフレームを取り込みます。フィールド間隔もカウンターと描画時刻から計測するため、`requestVideoFrameCallback`や`currentTime`の更新間隔に依存しません。`currentTime`はソースの走査方式・サイズを選ぶ用途にのみ使います。他のブラウザーではネイティブの`requestVideoFrameCallback`を使用します。

`probeDecoder()`と`decoderDeinterlaces()`は、ブラウザーのデコーダーがすでにデインターレースしているかを確認します。二重処理を避けるため、フィルターの有効化前に利用できます。
