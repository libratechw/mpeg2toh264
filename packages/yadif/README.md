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

`probeDecoder()`と`decoderDeinterlaces()`は、ブラウザーのデコーダーがすでにデインターレースしているかを確認します。二重処理を避けるため、フィルターの有効化前に利用できます。

### 独自追加機能: `autoFilm`

`autoFilm` を有効にすると、FFmpeg の `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` と `decimate=cycle=5:mixed=1` に相当する判定で、3:2 プルダウン区間を 24000/1001fps で表示します。  
ブラウザーでは映像だけを5フレーム保持すると音声より約 167ms 遅れるため、完了した5フレーム周期で得た重複位相を次の周期へ適用し、現在の差分も FFmpeg の `dupthresh=1.1` を満たす場合だけ間引きます。

重複を含む周期でフィールドマッチが成立した場合だけ、24fps のフィルム区間として扱います。  
フィルム周期として採用されていない区間のフレームと、フィールドマッチ後もインターレースと判定されたフレームは間引かず、通常の YADIF 処理へ渡します。  
`doubleRate` が有効なら 60000/1001fps 相当、無効なら入力フレームレートで表示するため、実写の 60i 区間はフィールドレートの動きを維持します。

`autoFilm` の既定値は `false` です。  
無効時には判定用シェーダーとフレームバッファーを生成せず、通常の YADIF 経路だけを使用します。
