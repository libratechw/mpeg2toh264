# mpeg2toh264

MPEG-2の係数・動きベクトル構造を保ちながらH.264へ変換するビットストリームトランスコーダーです。

## ブラウザMSEプレイヤー

```bash
npm install
npm run web:dev
```

表示されたURLを開き、MPEG-2映像を含む188-byte MPEG-TSファイルを選択します。処理はブラウザ内のWeb Workerで行われます。

1. PAT/PMTを解析してMPEG-2 Video PESを抽出
2. MPEG-2映像をAnnex B H.264へ変換
3. SPS/PPSと各access unitをvideo-only fragmented MP4へmux
4. Media Source Extensionsの`SourceBuffer`へinit segmentとmedia segmentをappend

音声にはまだ対応していません。プロダクションビルドは次のコマンドで`dist/`へ生成できます。

```bash
npm run web:build
```

## CLI

```bash
npm run transcode -- input.ts output.h264
```

MPEG-TSとMPEG-2 video elementary streamを自動判別します。オプション一覧は`npm run transcode -- --help`で確認できます。
