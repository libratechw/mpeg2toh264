# @mpeg2toh264/player

MPEG-2 TSをWorker内でH.264へ変換し、`<video>`で再生するMSEプレイヤーです。取得、変換、バッファー管理、Rangeリクエストによるシークをまとめて扱います。

```ts
import { Mpeg2TsPlayer } from '@mpeg2toh264/player';

const player = new Mpeg2TsPlayer(document.querySelector('video')!);
player.addEventListener('error', (event) => console.error(event.detail.error));
await player.load('https://example.com/video.ts');
```

`load()`はメディアソースが要素へ接続され、最初のデータが入った時点で完了します。変換はその後もWorker内で続きます。`stop()`は現在の読み込みだけを中止し、`destroy()`はWorkerを含めて破棄します。

## オプション

`Mpeg2TsPlayer`の第2引数で次を指定できます。

- `wasmUrl`: WASMファイルのURL
- `mediaSource`: MSEを`worker`と`main`のどちらで動かすか。既定の`auto`はブラウザー機能から選ぶ
- `preferManagedMediaSource`: `MediaSource`と`ManagedMediaSource`の両方があるブラウザーで後者を使う。`MediaSource`がないiPhoneではこの指定によらず`ManagedMediaSource`を使うため、指定は主に他の環境での動作確認用。`requiresManagedMediaSource()`でそのブラウザーに`ManagedMediaSource`しかないかを判定できる
- `oversample`: 変換時の量子化刻み
- `passthrough`: MPEG-2映像を変換せずそのまま再生する。MPEG-2をデコードできるブラウザー (AppleプラットフォームのSafari) のみ。`supportsPassthrough()`で判定できる
- `serviceId`: 複数サービスを含むTSから変換するサービス
- `queueHighWaterMark`: 追加待ちデータの上限
- `maxAheadSeconds`: 再生位置より先に変換して保持する秒数
- `keepBehindSeconds`: 再生済み範囲を保持する秒数
- `deinterlace` / `deinterlacer`: 差し替え可能なデインターレーサー

## イベント

- `statechange`: `idle`、`loading`、`converting`などの状態変化
- `progress`: 取得と変換の進捗
- `stats`: 変換速度などの統計
- `scan`: インターレースの有無とフィールド順
- `services`: TSが含むサービスと現在の選択
- `seekable`: Rangeシーク可能な入力の再生時間
- `private_stream_1` / `private_stream_2`: 選択サービスのprivate PES
- `timing`: 読み込み開始から各段階までの所要時間
- `error`: 読み込み中を含むすべてのエラー
