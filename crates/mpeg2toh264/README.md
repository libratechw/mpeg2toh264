# mpeg2toh264 core

MPEG-2 VideoからH.264/AVCへの変換、MPEG-TSの分離、AAC-LCの処理、fragmented MP4の生成を行うコアクレートです。

## 一括変換

`transcode`はMPEG-2 VideoエレメンタリーストリームをAnnex B H.264へ変換します。

```rust
use mpeg2toh264::{transcode, TranscodeOptions};

let result = transcode(&mpeg2_es, TranscodeOptions::default())?;
std::fs::write("output.h264", result.bitstream)?;

println!(
    "converted: {}, skipped: {}",
    result.pictures_converted,
    result.pictures_skipped,
);
```

GOP単位で状態を維持して変換する場合は`IncrementalTranscoder`を使います。`request_random_access_point()`を呼ぶと、次に変換可能なIピクチャから新しいIDR区間を開始します。

`Session`は`recovery_interval`ごとにnon-IDRのリカバリーポイントを生成します。DPBをフラッシュしないため、連続再生ではOpen GOPのleading Bピクチャも表示されます。その位置から再生を開始する場合はleading Bを捨て、Iピクチャ以降から復旧します。

## ストリーミング

`Session`はMPEG-TSのチャンクを受け取り、MSEへ追加できるfragmented MP4を返します。分離、GOP分割、映像変換、AAC処理、多重化、音声と映像のタイムライン調整を内部で行います。

```rust
use mpeg2toh264::{Fragment, Session};

let mut session = Session::default();
for chunk in input.chunks(1 << 20) {
    for fragment in session.push(chunk)? {
        match fragment {
            Fragment::Init { data, mime_codec } => open(&mime_codec, data),
            Fragment::Media { data, start, random_access, interlacing, .. } =>
                append(data, start, random_access, interlacing),
            Fragment::PrivateStream { stream_id, pid, data, pts } =>
                dispatch(stream_id, pid, data, pts),
        }
    }
}
for fragment in session.finish()? {
    // 同様に処理
}
```

ファイルの途中から再開するときは、最初のセッションが返した`origin_ticks()`を`Session::anchored`へ渡します。`first_pts()`と`last_pts()`は、TSの一部分からシーク位置や再生時間を見積もるためのヘルパーです。

複数サービスを含むTSからサービスを指定する場合は`Session::for_service`を使います。

## コンテナー関数

- `extract_mpeg2_video_es`: MPEG-TSからMPEG-2 Videoを取り出す
- `mpeg2_video_timeline`: MPEG-2の表示順と各サンプルの時刻を復元する
- `h264_to_fmp4`: 一括変換したAnnex B H.264をfragmented MP4に格納する
- `h264_gop_to_fmp4`: GOP単位のH.264とAACをMSE向けフラグメントにする
- `first_pts` / `last_pts`: TS断片の先頭・末尾のPESタイムスタンプを読む

詳細な型とエラー条件は公開項目のrustdocを参照してください。
