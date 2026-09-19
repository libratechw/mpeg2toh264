# 上流取込候補の記録 (upstream-take-20260920)

tsukumijima/main `faf1464` へ otya128/main `12d8dec` を選択的に取り込んだ
候補 branch の記録。PR・上流 push・通常配備はしない。

## 概要

otya128 側の更新 20 件 (`d5df08b..12d8dec`) のうち、tsukumijima 側の既存機能
(`capture()`・worker 描画・`autoFilm`/CPU-IVTC 経路・公開 API) を壊さない範囲を
取り込んだ。KonomiTV 側の移行変更は不要で、依存 pin の差し替えのみで成立する。

## 対象範囲

- pinned: otya128/main `12d8dec` (fetch で前進を確認、tsukumijima 未取込を確認)
- 取込: Rust decoder/MBAFF/perf 全件、字幕保持修正 (PMT 再開処理へ適応)、
  Firefox VideoFrames 取得 (watchdog/worker 機構へ適応)、新規内部ファイル
- 不採用: otya の GPU film 配線 (`film`/`debug` オプションと demo UI)。
  全面取り込みは `capture()`・worker 描画・`autoFilm` を消すため見送った。

## 検証結果

- `cargo test` (debug・release): 249 pass。`tools/test-video-frames.cjs`: 9 pass。
- yadif `tsc` (main・worker): clean。`npm run typecheck`: clean。
- `packages:build` 後 dist を定型コミットで分離。ffmpeg framemd5 で書換え
  2 fixture (altscan 8 枚・hd1080i 15 枚) を復号エラーなしで確認。
- 公式 KonomiTV master に依存差替えのみで install (解決 tarball 確認)・
  typecheck・build が通り、隔離配信で Original が連続再生した。
- 体感品質の合格主張はしない。全端末・全 counter ゼロも要求しない。

## 未確認事項

- Firefox 実機での動作、VideoToolbox/Safari での新規ビットストリーム受容、
  MBAFF 表の行単位照合。

## 上流への判断依頼

- `film` (otya・GPU 検出) と `autoFilm` (tsukumijima・CPU IVTC) の対応。
  代替手段: (a) 両立 (film 二重実装の重複あり)、(b) GPU 側へ一本化
  (`capture()`・worker 経路の再配線が必要)、(c) 現状維持。
  本候補は (c) の上で (a)/(b) の判断を待つ。KonomiTV の 24fps モードは
  `film` を渡すが、本候補では無視される (従来どおり、退行ではない)。
