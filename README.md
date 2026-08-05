# mpeg2toh264

MPEG-2の係数・動きベクトル構造を保ちながらH.264へ変換するビットストリームトランスコーダーです。

## ブラウザMSEプレイヤー

```bash
npm install
npm run web:dev
```

表示されたURLを開き、MPEG-2映像を含む188-byte MPEG-TSファイル（`.ts`または`.m2ts`など）を選択します。処理はブラウザ内のWeb Workerで行われます。

1. `File.slice()`でTSを1 MiBずつ読み、PAT/PMTとPESを状態付きで逐次解析
2. GOP単位でMPEG-2映像をAnnex B H.264へ変換
3. 各GOPをvideo-only fragmented MP4 fragmentへmux
4. Media Source Extensionsの`SourceBuffer`へ順次append
5. MSE quota到達時はTS読み込みとappendを停止し、再生済み範囲を削除後に再開

AAC-LC音声は再エンコードせず、ADTSヘッダーだけを外してfMP4音声トラックへmuxします。プロダクションビルドは次のコマンドで`dist/`へ生成できます。

```bash
npm run web:build
```

## CLI

```bash
npm run transcode -- input.ts output.h264
```

MPEG-TSとMPEG-2 video elementary streamを自動判別します。オプション一覧は`npm run transcode -- --help`で確認できます。
