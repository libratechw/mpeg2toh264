# mpeg2toh264-wasm

`mpeg2toh264::Session`をブラウザーから使うための`wasm-bindgen`ラッパーです。変換処理とタイムライン計算はコアクレートにあり、このクレートはJavaScriptとの値の受け渡しだけを行います。

```ts
import init, { Session } from './mpeg2toh264_wasm.js';

await init({
  module_or_path: new URL('./mpeg2toh264_wasm_bg.wasm', import.meta.url),
});

const session = new Session();
for (const fragment of session.push(chunk)) {
  if (fragment.kind === 'init') {
    openSourceBuffer(fragment.mimeCodec, fragment.data);
  } else if (fragment.kind === 'media') {
    append(fragment.data, fragment.start, fragment.randomAccess);
  } else {
    handlePrivateStream(fragment.streamId, fragment.pid, fragment.data, fragment.pts);
  }
}
for (const fragment of session.finish()) {
  // 同様に処理
}
```

`Session`のコンストラクターは`oversample`、`originTicks`、`serviceId`、`recoveryInterval`、`splitFieldSamples`、`passthrough`を省略可能な引数として受け取ります。`passthrough`はMPEG-2映像を変換せずそのまま格納するモードで、`mimeCodec`は`video/mp4; codecs="mp4v.61"`になります。返されるフラグメントは通常のJavaScriptオブジェクトで、明示的な`free()`は不要です。

`firstTimestamp(data)`と`lastTimestamp(data)`は、TS断片内のPESタイムスタンプを90 kHz単位で返します。

ビルドには`Cargo.lock`内のcrateと同じバージョンの`wasm-bindgen-cli`が必要です。

```bash
./tools/build-wasm.sh
```
