# @mpeg2toh264/player

> [!WARNING]
> このbranchは、iOSで録画の画質切替を繰り返した際に発生する`InvalidStateError`の診断専用です。MSE、SourceBuffer、video要素、接続と破棄の直近48イベントをエラーへ追加しますが、不具合を修正するものではなく、branch全体の取り込みは想定していません。

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
- `workerUrl`: モジュール Worker の URL。既定ではパッケージと同時に出力された Worker を使う
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
- `error`: 読み込み中を含むすべてのエラー。再生失敗時の`event.detail.error`は元の`Error`と同じオブジェクトで、診断用の`lifecycleEventId`と`lifecycleTrace`を持つ。再生を継続するdeinterlacer初期化エラーは従来どおり通常の`Error`

## iOS lifecycle診断契約

`lifecycleTrace`は、同じページで画質切替により交代するmpeg2toh264インスタンスをまたぐリングバッファーの凍結snapshotです。各entryの`at`とsnapshotの`frozenAt`は、WindowとWorkerのどちらでも`performance.timeOrigin + performance.now()`を使うため、realmをまたいで時系列に並べられます。MSEの実ownerと実class、内部generation、SourceBufferの操作・queue・epochも各entryに含まれます。event IDは`m2h-<freeze_us_base36>-<mpeg_instance_base36>-<generation_base36>-<failure_sequence_base36>`形式で、最大51文字です。

最初に異常原因の候補として記録されたentryは、後続イベントでリングが回転しても保持します。失敗時は`src` / `srcObject`の解除、Object URLのrevoke、`video.load()`より先にsnapshot全体、entry配列、各entryとdetailを凍結します。完全なsnapshotは`error.lifecycleTrace`だけに置き、画面へ直接表示される`error.message`には最大240文字のevent IDと概要だけを追加します。

DPlayerなどのpage側ownerは`recordDiagnosticLifecycle(event, detail, { at, critical })`で、画質切替世代などを同じ時系列へ追加できます。critical eventが保持枠を取得した場合だけopaque tokenを返し、その操作が成功したときに同じtokenを`resolveDiagnosticLifecycle(token)`へ渡すと、そのentryを通常のリング回転へ戻します。別entryや別snapshotのtokenでは保持枠を解放しません。

eventは英数字と`_.:-`で64文字まで、detailは16項目まで（keyは64文字、string値は256文字まで）で、値は文字列・有限の数値・真偽値・`null`だけを受け取ります。不正または上限超過のevent、timestamp、detail、options、tokenはその診断操作を無視し、再生処理へ例外を返しません。entryの`videoId`はHTMLVideoElementを区別する内部番号であり、録画・番組・配信のIDではありません。利用者向けUIには表示しません。

リングとcritical保持枠は同じJavaScript module内で共有します。このbranchは1つのDPlayerが画質切替でplayerを交代する診断を対象とし、同じmoduleから無関係なplayerを同時に動かすとentryとcritical保持枠も共有されます。
