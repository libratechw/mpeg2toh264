# mpeg2toh264 の変換速度と配信経路の設計

## この文書の位置付け

この文書は、mpeg2toh264 の変換処理について、過去の計測、最適化仮説、実装前の
停止条件をまとめた**実験計画兼設計記録**である。採用済みの設計、速度改善の証明、
全提案の実装指示ではない。読み手は、この実装と MPEG-2 / H.264 の符号化構造を
理解している実装者と root maintainer とする。

元の計測対象は libratechw/mpeg2toh264 `7e917a6` だった。2026-09-08 に確認した
tsukumijima/mpeg2toh264 `main` は `faf1464e66693133fc9f4b8618992b0f557f0bc3` で、
両revision間の変更はYADIF関連だけであり、codec coreは同じだった。この実験workspaceは
`faf1464`を基点とする。upstreamが進んだ場合は、実装前に差分を確認し、過去の計測値を
新しいtreeの結果として扱わない。

計測は本文書のためにスクラッチ領域へ複製したソースで行い、リポジトリの
作業ツリーは変更していない。KonomiTV調査側の
[`docs/MEASUREMENT.md`](https://github.com/libratechw/konomitv-training-ok/blob/main/docs/MEASUREMENT.md)
が定める端末再生の測定契約は、ここでのhost上の変換速度計測には適用していない。以下の数値は
その測定条件に固定された記録であり、今後の実験結果は条件と成果物を特定して別に記録する。

## 視聴品質を維持する追加最適化の評価契約（2026-09-09）

この節は提案A stage 1の既存gateを完了した後の追加探索に適用する。
以下の旧結論・実験順序・測定値は、その当時の基準と結果の記録として維持し、現在の候補順序はこの節で定める。
提案A stage 1などの完全一致を目的とする経路には従来のdigest条件を残す。
意図的な数値近似・量子化・符号化方式の変更は、この節の別評価対象とし、hash不一致だけでは棄却しない。
goalは既存のスレッドのgoal管理を使い、ここには比較・採否の契約を置く。

### 固定した比較基準と初期候補

追加探索の比較基準Bは、`experiment/quant-raster-autovec@33a1018df914404c22cb8447e15d516cb4fc32af`
（tree `ca6db58532174878928f9cd16c737bd3f0e865ee`）、`oversample=2`、その他の設定は同commitの既定値とする。
2026-09-09のfetch時にworking treeはclean、tracking branchとの差は0/0だった。
従来の固定比較基準`upstream/main@faf1464e66693133fc9f4b8618992b0f557f0bc3`はBの祖先であり、fetch後も不変である。
Bは既存bit-exact最適化を含むが、未commitのProposal B scratchは含まない。以後の候補や組合せでもBを更新しない。

初期native Bはrustc `1.93.0 (254b59607 2026-01-19)`、Cargo `1.93.0`、workspace release設定
（`opt-level=3`、`lto=thin`、`codegen-units=1`）、追加target指定なしの隔離buildを使う。
既存binaryのSHA-256は`b0d86ab93272383564f3478f5766c569783419afdda9d6398fa16e95b81a665a`、
`Cargo.lock`は`ca917562dd96023cacf34a51e586316183c985d52205b50ad1d85b34a35ab0d8`である。
これらのhashは再開時に照合済み。WASM/browserはそれぞれ実行するbuildとengineを別に固定し、nativeの結果を転用しない。
入力hash、コマンド、compiler/engine、候補差分とbinary hash、出力hashは各測定成果物に記録する。

初期優先順位は、既存試作を再利用できるpair適応MBAFF（提案B）、既存`oversample`の段階比較、
新しい負荷内訳で裏付けられた演算削減の順とする。提案Bは不要なframe→field変換と係数の密化を減らす狙いで、
画質低下そのものを目的にしない。oversampleは2 / 1.75 / 1.5 / 1.25 / 1を個別に比較する。
第4章でnativeの利益を分離できず棄却した色差融合は、同じ実装を新しい根拠なしに繰り返さない。
過去のprofileは対象commitの記録であり、その割合をBの現在値として扱わない。

### 品質の対応付けと判定

Rは元MPEG-2の復号、Bは固定基準の出力、Cは候補の出力とする。R対B、R対C、B対Cを確認する。
PTSと元pictureの対応を使い、追加IDR・参照用コピー・display orderを考慮して整列する。
フレーム番号の一致や内容の近さだけでは正式な対応付けの証拠にしない。色特性・レンジ・表示形状・前処理を揃え、
interlaced素材のfield時間情報を保持する。raw interlacedの成分別評価と、同じbob処理後のVMAFを区別する。
モデル、version、前処理、評価区間、集約方法は測定前に固定する。

| 暫定上限 | 視覚的同等を狙う候補 | 小さな劣化を許容する候補 |
| --- | ---: | ---: |
| クリップ平均の追加VMAF低下 | 0.5 | 2 |
| 最悪の連続1秒間の平均追加VMAF低下 | 1 | 4 |
| クリップの輝度PSNR低下 | 0.1 dB | 0.5 dB |
| Cb・CrそれぞれのPSNR低下 | 0.2 dB | 1.0 dB |

追加VMAF低下は各対応時刻の`max(0, VMAF(R,B) - VMAF(R,C))`を集約する。
改善区間で悪化区間を相殺しない。PSNRは各成分のMSEをクリップ内で集約してから算出する。
平均dBの差や全素材一括平均で合否を決めない。上限は探索用の暫定基準であり、普遍的な知覚限界ではない。
最悪区間を時刻付きで保存し、候補を通すために素材・区間・閾値を後から変更しない。

少数素材で絞った後、ニュース・スポーツ・アニメ・顔・暗部・粒状感・スクロール文字を含む既存素材と、
選定に未使用の素材へ広げる。参照画像を変える変更は複数GOPと長時間の予測連鎖を評価する。
テロップの可読性、肌、色境界、暗部、動き、ちらつきを確認し、気になるブロックノイズ・色にじみ・階調段差・
残像・フレーム間の質感変動があれば、指標が良くても不採用とする。人間の確認用R/B/C動画と問題区間を置き、
確認前は「視聴確認待ち」とする。数値だけで知覚不能と断定しない。

### 性能・互換性・採否

同一入力でB/Cを交互に反復し、意図した変更以外の設定・build条件を揃え、起動直後と定常状態を分ける。
oversample比較ではBを常に2に固定し、Cの値だけを個別候補として変える。各ペアの設定はmanifestに保存する。
映像1秒当たりのwall/CPU時間、GOP完了時間の中央値とp95、ばらつき、出力サイズを記録する。
性能測定中に同一端末でbuild、復号、別測定などの高負荷処理を競合させない。
外部負荷が重なったrunは無効とし、終了検知の監視間隔をwall時間へ加算しない。
native、Node WASM、対象browser WASM、デコード・描画・受け渡しを含む実機視聴は別の結果とする。
起動・シーク、長時間の停止・遅延蓄積を実機で確認するまで、視聴上の改善を主張しない。

完全一致の改善、視覚的同等を狙う改善、知覚可能な小さな劣化を伴う改善を区別する。
視覚的同等の候補は再現性のある利益と実装コストで判断し、出力差だけで15%を要求しない。
知覚可能な劣化を採る場合は主対象の処理時間15%以上削減を原則の目安とし、それ未満なら実際の処理落ち・
遅延蓄積の解消など明確な視聴利益を必要とする。各案を独立に比較し、有効な組合せを最初のBに対して再評価する。

解像度、frame/field時間情報、表示順序、A/V同期、入力pictureの受理・欠落方針、異常入力対応、
参照関係、decoder互換性、既存の運用・ライセンス制約は維持する。追加欠落・停止・シーク退行を画質との交換にしない。
非参照限定を採るならslice名ではなく実際の参照関係で保証する。
core、並列/deferred、異常入力、FFmpeg、VideoToolbox、Safari/MSEの試験を影響範囲に応じて行い、未実施環境は未検証とする。
既存golden hashは変更せず、旧品質へ戻せる経路を残し、未検証の候補は既定で無効にする。
利益または品質条件が成立しない案は採用せず、試した実装・結果・不採用理由と残る課題を保存する。

既存Proposal Bの品質成果物は`.opencode/eval/proposal-b/`にある。
旧runnerのframe番号中心の整列とクリップ平均値だけでは本節の正式合格を証明できないため、
PTS対応・非相殺VMAF・最悪1秒を補って再評価する。既存のnative速度試行は外部負荷と測定手順の問題で無効であり、
その値から性能改善は主張しない。

### 初期native比較と証拠の訂正（2026-09-09）

固定Bと保存した提案B build（native SHA-256
`c5b45d873d23fa7c7e506508d8fb039d183dcb015a38959a7c636156a2dde538`）を、
`hd1080i-x40.m2v`の600 pictures・20.02秒で比較した。入力SHA-256は
`88b48841b5e9e7644e54f44c66e09b9bcc3b932283467216dfc25c9b9cf4e645`。
Linux AMD Ryzen AI Max+ 395、既存release設定、1 thread、raw Annex B出力で、CLIの起動・入力処理・出力書込みを含む。

`.opencode/bench/quality-screen.py`で各buildのwarmupを除き、先行順を交互にして有効8組を集めた。
同時build/復号は禁止し、既知の高負荷processを0.2秒ごとに確認する。
`/proc/stat`のbusy CPU差から子processと監視処理のCPU時間を引いた外部負荷推定が平均1 coreを超える組は、
A/B両方を除外する。elapsed値では選別しない。上限は定常24組・warmup4組で、無効試行も保存する。
提案Bは定常9組中1組を除外、oversample比較は8組すべて有効だった。
これは予定した処理の競合を避けたscreenであり、一時的なscheduler/I/O noiseの不存在を保証しない。

| 個別候補 | B平均 → C平均 | 時間短縮率 | 各組の短縮時間の95% t区間 | 出力bytes削減率 | 次の判断 |
| --- | --- | ---: | --- | ---: | --- |
| 適応MBAFF、oversample=2 | 2.362050 → 2.279193 s | 3.508% | 68.560〜97.155 ms | 12.456% | 8/8組で短縮。画質・WASM検証を優先 |
| Bのoversampleだけ1.75 | 2.364442 → 2.357848 s | 0.279% | −5.941〜19.130 ms | 3.327% | 利益をばらつきから分離できず、現時点では不採用 |

映像1秒当たりのwall/CPU秒は、提案B比較のBが0.117985 / 0.117965、Cが0.113846 / 0.113828。
全runのbuild別出力hashは安定したが、B/Cのhashは意図的に異なる。
生記録は`/data/ssd/mpeg2-quality-screen-pb-paired-20260909/results.json`と
`/data/ssd/mpeg2-quality-screen-o175-paired-20260909/results.json`で、入力・runner・binary hashと全コマンドを含む。
これらはnativeの初期screenであり、GOP p95、browser、実機の起動・シークや視聴改善、画質合格の証拠ではない。
1.5以下のoversample候補は未測定で、1.75の結果から全段階を不採用とは決めない。

検証中、baseline名のtarget directoryへscratch checkoutからbuildした生成物を、基準Bと誤認した。
この生成物による「基準Bでもgolden不一致」「720iの基準Bと候補が同じ出力」の報告は撤回する。
真の隔離Bは上記固定binary hashと一致し、6 fixtureの既存goldenを含む267テストが成功した。
親セッションの再実行ログは`/data/ssd/mpeg2toh264-proposal-b-artifacts/baseline-full-tests-20260909.log`に保存した。
一方、scratchの既定経路で`split_frame_mb`の処理を落としていた不一致は実在したため、feature無効時の旧経路を復元した。
復元後は既存goldenと追加したgeometry回帰を含む269テストが成功した。feature有効時は、既存golden比較1件だけを
除外して281テストが成功した。goldenの値・テスト本体は変更していない。
ログは同artifact directoryの`candidate-restored-default-tests-v2-20260909.log`と
`candidate-restored-feature-tests-20260909.log`にある。
以後のCargo呼出しは絶対workdir・`--manifest-path`・隔離targetを明示し、stdout/stderrを保存する。
経緯は`/data/ssd/mpeg2toh264-proposal-b-artifacts/provenance-incident.md`に残す。

別の正しさの問題として、真のBは1280×720 interlaced入力（45 source MB rows）でpanicした。
H.264側を46 MB rowsへpaddingし16 linesをcropする修正は、適応MBAFFとは別の修正単位とする。
根拠はITU-T H.264 (02/2014) §7.4.2.1.1の式(7-18)、(7-22)である。
`frame_mbs_only_flag=0`ではframe高はmap unit高の2倍、4:2:0の`CropUnitY`は4になる。
入力の時間情報・picture受理方針を変えず、既存出力hashの更新で不一致を隠さない。

実装はgeometry修正`2a8a564`と、既定で無効な適応MBAFF `202cdff`に分けてcommitした。
有効化はCargoの`--features mpeg2toh264/experimental-adaptive-mbaff`を使う。指定しなければ旧量子化・符号化経路へ戻る
（独立したgeometry修正は残る）。上記の初期性能値は復元前の保存buildであり、最終commitの再測定とは区別する。

Node WASMの20.02秒入力では、`session.rs`の既存`MAX_RECOVERY_BYTES = 32 * 1024 * 1024`により
B/Cの再開ポイント位置が変わった。小さい候補出力では32 MiBに達する時点が遅くなるためであり、
当該runはsample timing・再開位置の同一性gateで停止し、速度を採用していない。
この制約を変更せず、同じTSの先頭から次のGOPの`restartOffset=15187580`までの180 source frames
（6.006秒、32 MiB上限未到達）で、同じ既定設定の処理を分離した。
初期buildのNode v24.19.0、wasm-bindgen 0.2.126では8組すべて短縮し、平均908.509 → 864.757 ms、
4.816%短縮だった。初回実行は除外し、181 output samples、init bytes、fragment metadata、
MP4のsample durations/composition offsets/flagsの一致とbuild別出力hashの安定を確認した。
生記録は`/data/ssd/mpeg2-quality-wasm-pb-short-20260909/results.json`。
これはbrowser再生の証拠ではなく、長区間の再開間隔の変化によるシーク影響も未確認である。

### 最終commitの再測定（2026-09-09）

geometry修正と適応MBAFFを実験branchへ取り込んだcommitは、それぞれ`5a2f90f`、`b0617d6`である。
`b0617d6`の`crates/`は測定したscratch commit `202cdff0dad5be314e89729950c99bac5eced484`と差分なし。
buildとsourceの対応は`/data/ssd/mpeg2toh264-proposal-b-artifacts/build-manifest-202cdff.json`に固定した。
native候補binaryのSHA-256は`c6327f729f3b9847dedd794b12c0730513e867bc8aa3c14f66e3d08ba869113f`、
候補raw WASMは`e94bc50f1ee256e4d6d266dc5429bd5e8d1ac60e2d998304024f19e4e98e754f`。
Bのraw WASMは`741b99933f425331d7c220b41365f9713a4f7045c241bf5eb280b2d663cc8111`である。
同じ固定B・既定設定・前節の交互測定と負荷除外規則を使い、各8組を測定した。

| 環境・入力 | B平均 → C平均 | 時間短縮率 | 短縮時間の95% paired t区間 | 短縮した組 |
| --- | --- | ---: | --- | ---: |
| native、hd1080i-x40（20.02秒） | 2.332564 → 2.312412 s | 0.864% | 8.589〜31.715 ms | 7/8 |
| Node WASM、同TSの短区間（6.006秒） | 899.557 → 863.348 ms | 4.025% | 31.765〜40.653 ms | 8/8 |
| native、実放送素材E全体（59.692967秒） | 10.505159 → 10.048377 s | 4.348% | 435.991〜477.573 ms | 8/8 |
| native、実放送素材B全体（59.726333秒） | 11.784370 → 13.297375 s | −12.839% | −1578.902〜−1447.110 ms | 0/8 |
| native、実放送素材F全体（60.026633秒） | 12.124264 → 12.918079 s | −6.547% | −829.895〜−757.734 ms | 0/8 |

native hd1080iの初期3.508%から最終0.864%への差は無視できないため、初期値を最終実装の利益として使わない。
この差の原因をsource変更・code layout・host変動のいずれかへ特定した証拠はない。
最終nativeの標準偏差はhd1080iでB/C 12.371/5.768 ms、Eで15.162/16.654 ms。
Nodeでは3.357/2.616 ms、除外した初回実行は929.852/892.967 msである。
いずれもGOP完了時間の分布や実機視聴時間を測った値ではない。

Eの入力は`/home/akio/src/mpeg2toh264-pair-profile-gMA6GX/segments/E.ts`、97,101,436 bytes、
SHA-256 `eb17129e54d245c4b7ffcbd2f10347ae032f0909ae7695562bba56c2b26d874f`。
1,789 source表示frames、30000/1001 fpsから映像時間を求めた。
映像1秒当たりのwall/CPU秒はBが0.175987/0.175954、Cが0.168334/0.168307。
全編の出力は234,361,894 → 184,731,333 bytes（21.177%減）、全runでbuild別hashが安定した。
この入力はvideo-onlyであり、音声やA/V同期の検証には使わない。

生記録は`/data/ssd/mpeg2-quality-native-final-202cdff-20260909/results.json`、
`/data/ssd/mpeg2-quality-wasm-final-202cdff-20260909/results.json`、
`/data/ssd/mpeg2-quality-native-E-202cdff-20260909/results.json`にある。
測定runnerのsnapshotは`/data/ssd/mpeg2toh264-proposal-b-artifacts/performance-runners-20260909.tar.gz`。
WASM短区間では181 output samples、init bytes、fragment metadata、sample timing/flagsの一致を再確認した。
nativeとWASMは入力形式・区間・計時範囲が異なるため、短縮率の直接比較や乗算はしない。

素材B/Fの追加測定では全8組が遅くなったため、`202cdff`の適応MBAFFを全素材向けの性能改善としては採用しない。
優先順位は、この退行の内訳確認と小さな処理削減の比較、利益が成立した候補の品質・互換性確認、追加候補の順へ変更する。
Eの短縮だけでは素材Bの12.839%増・Fの6.547%増を正当化できない。いずれも出力は小さくなったが、処理時間の改善ではない。
B/Fの出力bytesはそれぞれ259,609,856 → 237,090,640（8.674%減）、245,751,546 → 216,484,059（11.909%減）。
入力は既存`mpeg2toh264-pair-profile-gMA6GX/segments/{B,F}.ts`で、source表示framesは1,790/1,799、30000/1001 fps。
生記録は`/data/ssd/mpeg2-quality-native-B-202cdff-20260909/results.json`と
`/data/ssd/mpeg2-quality-native-F-202cdff-20260909/results.json`で、全試行・入力hash・実行buildを固定している。
これらは全編のnative速度結果であり、B/Fの旧局所品質指標は下記の理由でまだ使えない。
既定化・PR候補への昇格は行わない。browser WASM、実機の起動・シーク、長時間再生の利益は未確認であり、
Nodeの32 MiB再開ポイントの変化も別gateとして残る。

### 適応MBAFFの近傍計算を減らす試作C2（2026-09-09）

C1を上記`202cdff`、C2を`CoeffCountMap::mixed_n_c()`の同一macroblock内参照だけを直接化した試作と呼ぶ。
frame/field間の境界は既存`MbaffModes::neighbour_with_size()`を使い、量子化・走査・係数数の意味は変えない。
C2はC1との完全一致を要求する。固定比較基準BをC1へ更新するものではない。

素材Bで交互8組を再測定すると、固定B平均11.925387秒に対しC2は12.839804秒で、まだ7.668%遅かった。
各組の短縮時間はすべて負、95% paired t区間は−989.111〜−839.724 ms。C1の試行とは同時の三者比較ではないため、
別run間の平均差をC2単独の確定短縮量とは扱わない。C2も全素材向けの採用条件を満たしていない。
生記録は`/data/ssd/mpeg2-quality-native-B-c2-neighbour-20260909/results.json`、build・全core source hash・
基点commitに対する差分は`/data/ssd/mpeg2toh264-proposal-b-artifacts/build-manifest-c2-neighbour.json`にある。
native binaryのSHA-256は`b129698c83a5c2eb1d624c09a10ef6c432a237755ae48ac86fec733e19db7c97`。

nativeの素材B全8組、およびE/Fの全編再生成はC1の原H.264と完全一致した。
`tools/compare-wasm.cjs`でも素材B全編のC1/C2を交互2周し、1,809 video samplesを含む完全フラグメントdigestが一致した。
この2周は機能確認であり、warmup・負荷除外を備えた正式性能比較には数えない。
raw WASM SHA-256は`f4a7f3e8d0512e93ca52c8fb9e19342c295c3e7fb33e6492d5f967bf1ce145f6`。
ログはartifact directoryの`c2-neighbour-{feature,default}-tests.log`、`c2-neighbour-wasm-B-equality.log`、
native E/F出力は`/data/ssd/mpeg2-quality-c2-native-equality-20260909/`に置く。
既定経路269テスト、feature有効時282テストが成功し、旧goldenは値を変えずfeature有効時だけ該当1件を除外した。
追加回帰は輝度・色差、64通りのpair mode、全block位置、未符号化−1と0〜16の係数数を既存の汎用座標導出と照合する。
これは省略前後の同値性検査であり、座標導出自体の規格適合を独立に証明するテストではない。
独立したテキスト差分レビューでも、この範囲に修正必須の問題は見つからなかった。

既存`tools/profile-wasm.cjs`をNode v24.19.0の`--cpu-prof-interval=1000`で実行した素材Bの診断では、
C2の`CoeffCountMap::n_c`と`MbaffModes::neighbour_with_size`の自己時間が合計10.830%だった。
各buildは初回を含む2回を別processで測ったサンプリングであり、定常性能差やnative内訳の証拠にはしない。
生profileは`/data/ssd/mpeg2-quality-wasm-profile-B-20260909/{baseline,c1,c2}.cpuprofile`。
native C2の逆アセンブルでも`n_c`内に動的除算が残ることを確認したため、次は既知の2/4 block幅を使う座標計算の削減を個別に試す。
ネイティブのハードウェア・サンプリングは権限不足で未実施であり、権限設定は変更していない。

### 素材EのPTS付き局所品質と評価手順の修正（2026-09-09）

最新の結果は`.opencode/eval/proposal-b/E-pts-evaluated-v4/manifest.json`。
Rは上記E.ts、B/Cは同じ固定binaryから再生成した原H.264で、全編のSHA-256はそれぞれ
`5c69e6b5ef08b0ae271689e16bc53575b70cc8ca9be17e5372e8f378b480582d`、
`53d145812c0599379c837b387383e8447470adc96a35537f5a048d045c791cb1`である。
sourceのPTS 2.756356〜12.766356秒（終端除外）、300 frames・10.010秒を固定窓とした。
品質の対象はこの窓だけであり、全編の速度・出力サイズの測定範囲とは異なる。

原H.264をcoreの`mpeg2_video_timeline`・`h264_to_fmp4`で包装し、1,789 retained source picturesの
実PES PTSとMP4の1,790 AUsのpacket PTS/DTSをdecode順でも照合した。
先頭lead-in AU0を除き、reference clone AU1をsource picture 0へ対応付ける。
単なるframe番号合わせではない。包装前後の全NAL payloadと順序が一致し、Annex Bの3/4-byte start code差だけを除外する。
この包装は評価用であり、Sessionの追加RAPや実機A/V同期を検証したものではない。

1440×1080、yuv420p、SAR 4:3・DAR 16:9、source由来のTFF・limited-range BT.709を揃えた。
B/Cで欠ける色タグは評価時だけsourceの明示値で補う。`setparams`によるmetadata設定であり、
codec出力の色タグや実機の表示処理を変更したものではない。
主指標はdeinterlaceしない成分別MSEをclip内で集約して算出するPSNR。
補助VMAFは同じ`bwdif=send_field:parity=tff:deint=all`、前後1 frameのcontext、
60000/1001 fps・600 fields、FFmpeg 8.1.2、`vmaf_v0.6.1`を使った。fps補間・拡大縮小はしない。

| 指標 | R対B | R対C | 追加劣化の判定に使う値 |
| --- | ---: | ---: | --- |
| raw Y PSNR | 43.898290 dB | 44.301632 dB | 低下なし（B−C = −0.403342 dB） |
| raw Cb PSNR | 46.207081 dB | 46.439842 dB | 低下なし（−0.232761 dB） |
| raw Cr PSNR | 45.084965 dB | 45.399710 dB | 低下なし（−0.314745 dB） |
| bob VMAF平均 | 98.233779 | 98.689267 | 各時刻の非負損失平均 0.000136、最悪連続1秒 0.000553 |

B/C直接のraw PSNRはY/Cb/Cr 49.974583/56.101382/55.062266 dBであり、出力差は実在する。
直接差は補助記録とし、R対B/Cの追加劣化判定を置き換えない。
VMAF最悪1秒は比較動画の3.020683〜4.020683秒、元TS PTSの5.777039〜6.777039秒。
各field区間内のscoreを一定として積分し、frame境界と「境界−1秒」の両方を窓の候補に含めた。
PSNRログのframe別MSEはFFmpeg出力の小数2桁精度に制限されるため、それ以上の精度を測ったとは扱わない。
この窓は「視覚的同等を狙う候補」の暫定数値gateを満たしたが、知覚的同等・全編画質・採用の判定ではない。

旧`E-candidate-eval`との数値差は、旧FFmpeg graphがsource側だけに
`auto_scale`（BT.709 → unknown）を挿入していたことによる。
旧新の入力hash・区間・FFmpeg version・timebaseは同じで、新graphでは色解釈を揃えることで自動変換がなくなった。
raw/bobの短いverbose診断を`/data/ssd/mpeg2toh264-proposal-b-artifacts/quality-color-negotiation-audit-20260909.json`
へ保存した。metadata-onlyの根拠は[FFmpeg 8.1.2のsetparams実装](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavfilter/vf_setparams.c)。
旧B/F/Eの指標は現契約の品質証拠から外し、生ログだけを履歴として残す。閾値・素材・窓を候補に合わせて変更したものではない。

独立レビューで見つかった再集計の弱い合否条件、provenance sidecarの未固定、SAR/DAR未検証、
B/C直接比較の不足はrunnerで修正した。同じAU/PTS・NAL判定をevaluate/reaggregateで使い、
実際に解析したsidecar bytesをhashとともに保存する。selftest、再集計、v4の全再実行と再レビューで確認した。
runnerのSHA-256は`41d0c8e5808d3583ce152419af3d139f0cf4ab25376d63cb4918c6a999ba7a9f`。
検証途中の失敗記録とv3は上書きせず、評価用sourceはartifact directoryの
`quality-evaluator-v4-20260909.tar.gz`へarchiveした。
比較動画と再実行手順は`.opencode/eval/proposal-b/README.md`。**視聴確認待ち**である。

### WASMの機能確認範囲（2026-09-09）

最終buildのWASM短区間出力はB/CともFFmpeg `-v error -xerror`で復号できた。
通常/deferred比較は、video-onlyのEでの一致を音声gateに数えず、hd1080i TSへ48 kHz stereo AACの
合成無音をmuxした入力で`tools/compare-deferred.cjs`を1往復ずつ独立に3回実行し、各回の完全フラグメントdigestの一致を確認した。
同一process内の分離確認であり、並列worker性能・実録画の多音声・実機同期の試験ではない。
このrun中の時間値は機能検査の付随出力で、性能実績には使わない。
入力SHA-256は`b528174471757095eb0c915da757730ef830bfb3d13b363026f0dfdbbda03d94`、
出力に939 AAC framesが含まれることを確認し、video/audioともFFmpegで復号できた。
null出力の時刻丸めによる警告を避けるため、`-fps_mode:v passthrough -enc_time_base:v demux`で
元の1/90000 time baseを維持した。失敗した既定time baseの診断も保存し、出力PTSを作り直して隠してはいない。
生成・再実行手順とログはartifact directoryの`compatibility-202cdff.json`にある。

## 用語

| 語 | 意味 |
| --- | --- |
| ピクチャ | 1枚の frame picture。1440x1080 では 90x68 = 6120 macroblock、3060 pair |
| pair | MBAFF の macroblock pair（垂直に隣接する2 macroblock） |
| **符号化済み pair** | 2つのうち少なくとも1つが skip でない pair |
| frame 対 / field 対 | その pair の `mb_field_decoding_flag` が 0 / 1 であること |
| frame 化可能 | 両方の macroblock が frame-DCT かつ frame 動き（または intra、または未符号化） |
| unit | `IncrementalTranscoder` が1回で扱う入力。この実装では MPEG-2 の1 GOP |
| `--oversample` | H.264 の量子化刻みを MPEG-2 の刻みの何分の1にするか。2 なら半分 |
| 非零レベル | 量子化された係数のうち0でないものの個数。MPEG-2 側も H.264 側も同じ意味で使う |

## 結論

**最初に実装する価値があるのは提案Aのstage 1だけである。** 提案Bは統計と
受け入れ条件の準備まで、提案CはAの結果が出るまで保留する。

| | 提案 | 対象が占める encode 時間 | 現在の判断 | ビットストリーム | 前提条件 | 作業量 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 量子化ループを走査順の間接参照から外す | **27.4%**（native計装build） | stage 1を実装して測る | stage 1は完全一致を必須とする | native / WASMの反復比較 | 小 |
| B | MBAFF の frame/field を pair 単位で source に合わせる | 30.7% と `mb_write` の一部 | 実装せず、複数素材の統計を先に取る | 変わる | 実放送素材のpair統計と受け入れ条件 | **大** |
| C | 色差変換を1個の定数行列へ融合する | 3.8% | Aの後まで保留 | 演算順序により変わりうる | 許容する数値差の決定 | 小 |

**3つの「対象」は重なるので、割合を足さないこと。** `fp_luma_q` の 13.6% は A と B の
両方に入っている。A はそのループを速くし、B はそこへ入る係数を減らす。
色差の量子化ループは A と C の両方の説明に現れるが、C が置き換えるのは変換部分だけである。

**A を先に置いたのは、native計測で対象が最も大きく、stage 1を出力完全一致の
小さな比較にできるため。** 27.4%はWASMのprofileではなく、実際の短縮量も未測定なので、
WASMや実機への効果をこの割合から推定しない。B は効果本体になりうるが、H.264 の
mixed MBAFF 近傍導出というこの実装で最も込み入った部分の実装を要し、着手前に
実放送素材での統計確認がいる。
C は当初 14.1% を見込んだが、内訳を測ると変換そのものは 3.8% で、
色差費用の大半は A と同じ量子化ループだった。

**GOP をまたぐパイプライン（第6章）と scaling list による帯域調整（第7章）は
この3つに入れていない。** 前者は合算スループットではなく単一ストリームの遅延にしか
効かないため、後者は未測定の仮説であるため。

**サーバー側でこのアルゴリズムを使う経路は、速度と帯域を理由には正当化できない。**
同一 host・同一素材の1スレッド比較で、x264 ultrafast は mpeg2toh264 より
**2.1倍速く、出力は 2.8倍小さく、輝度 +3.0 dB・色差 +9.1 dB（U）/ +14.1 dB（V）良い**。
サーバー側配置が意味を持つのは別の目的、すなわち「WASM 経路を維持できない
クライアントの肩代わり」「Original 品質の意味の保持」「録画の GOP 単位キャッシュ」
の3つに限られる。詳細は第8章に書く。

## 測定条件

| 項目 | 値 |
| --- | --- |
| host | Linux x86-64、32 論理コア |
| build | `cargo build --release`（rustc 1.93.0、`opt-level=3`、`lto=thin`） |
| 短尺入力 | `testdata/hd1080i.m2v`（1440x1080i、15 ピクチャ、1,234,721 バイト） |
| 長尺入力 | 上記を40回連結した 600 ピクチャ、49,388,840 バイト |
| 既定オプション | `--oversample 2`、`--open-gop idr` |

速度と出力サイズは無計装 build、内訳は `rdtsc` を使う区間計測付き build で測った。
**区間計測は build ごとに総時間が 1〜3% 変わるので、割合は同じ build の中でだけ比較できる。**
第1章の表は1つの build から、第4章の色差内訳は別の build から取った。

PSNR は MPEG-2 を ffmpeg で復号した YUV を参照とし、H.264 側は先頭 IDR 直後の
long-term 複製ピクチャ（`write_reference_clone` が出す、一定値予測用の索引を確保するための
同一画像の複製）を除いて整列させた。

実放送に由来する素材は `testdata/hd1080i.m2v` の1本だけである。
放送素材一般の統計として扱わず、内容依存の幅は第3章の「内容による差」に別途示す。

## 1. 時間の内訳

無計装 build の1スレッド速度は **197.6〜198.5 fps**（3回、長尺入力、
MPEG-2 ES から Annex B H.264 へ）。出力は短尺入力で入力の **1.71倍**である。

`PictureEncoder::encode` を 100% とした内訳。字下げは入れ子を表す。

| 区間 | 割合 | 内容 |
| --- | --- | --- |
| `es_parse` | 1.0% | ヘッダー走査 |
| `mb_decode` | 12.9% | MPEG-2 スライスの VLC 復号 |
| `mb_body` | **85.0%** | マクロブロックのループ全体 |
| &nbsp;&nbsp;`mb_write` | 33.3% | CAVLC とマクロブロック構文の出力 |
| &nbsp;&nbsp;`fp_setup` | 17.1% | field 対の逆量子化、frame→field 基底変換、色差変換 |
| &nbsp;&nbsp;&nbsp;&nbsp;`chroma` | 14.1% | 上記の内側。色差の逆量子化・変換・量子化の全体 |
| &nbsp;&nbsp;`fp_luma_q` | 13.6% | field 対の輝度4ブロックの量子化 |
| &nbsp;&nbsp;`mv_all` | 6.2% | 動きベクトル予測と分割の構築 |
| &nbsp;&nbsp;`luma_quant` | 4.1% | frame 経路の輝度の量子化 |
| &nbsp;&nbsp;`luma_dequant` | 1.1% | frame 経路の輝度の逆量子化 |

`mb_body` のうち約 9.7% は上表に現れない位置計算と分岐である。
`fp_setup` は本文中の名前で、実装のローカル変数名は `fp_luma_dq` だが、
表のとおり内側に色差変換を含むので、輝度だけを指す名前では誤解を招く。
**`fp_setup` の 17.1% のうち 14.1% は色差なので、輝度側は約 3% である。**

係数の統計は次のとおり。長尺入力での値で、母数を明示する。

| 母数 | ブロック数 | 平均非零レベル |
| --- | --- | --- |
| MPEG-2 の符号化済み輝度ブロック | 1,995,560 | **16.62 / 64** |
| MPEG-2 の符号化済み色差ブロック | 1,147,000 | 21.57 / 64 |
| H.264 が量子化した輝度 8x8 ブロック | 2,219,840 | **25.56 / 64** |

H.264 側のブロック数が MPEG-2 側より 22 万個多いのは、frame→field 基底変換が
2つの source ブロックを混ぜるため、source が符号化しなかったブロックにも
係数が現れるからである。これも第3章で述べる密化の一部である。

## 2. 提案 A: 量子化ループから走査順の間接参照を外す

### 対象

同じ形のループが3か所にあり、合計で encode 時間の **27.4%** を占める。

| 区間 | 割合 | 実装 |
| --- | --- | --- |
| `fp_luma_q` | 13.6% | `Quantiser8x8::scanned_levels_for`（field 経路） |
| `luma_quant` | 4.1% | 同上（frame 経路） |
| 色差の量子化 | 約 9.7% | `spatial_to_chroma_levels` から順変換を除いた部分 |

色差の 9.7% は第4章の内訳測定から導いた（`chroma_quant` 11.10% から
`chroma_fwd4x4` 1.41% を引いた値）。

### なぜ遅いか

`scanned_levels_for` の本体はこうなっている。

    for k in 0..64 {
        let pos = scan[k];
        let level = round_half_up_i32(targets[pos] * reciprocal_gains[pos]);
        out[k] = level;
    }

演算そのものは1係数あたり1乗算と1丸めだが、**`scan[k]` による間接参照が
ベクトル化を妨げる。** 実測は `fp_luma_q` が1呼び出し（4ブロック、256 係数）
あたり 373 サイクル、すなわち1係数あたり 1.46 サイクルで、これはスカラー実行の水準である。

色差側の `spatial_to_chroma_levels` も同じ形で、`scan[k]` で 60 個の AC 係数を引いている。

### 現行実装の契約

本節は、提案A stage 1の実装前に現行コードの入出力契約を固定するための記録である。
調査対象は `760dfaee6c14333c568f9dc4a66d6b6356ed08bc` で、その親は固定済み比較基準
`upstream/main@faf1464e66693133fc9f4b8618992b0f557f0bc3` である。2026-09-08の
`git fetch upstream` 後も `upstream/main` は同じcommitだった。本節は性能を測定しておらず、
stage 1の改善を示すものではない。

#### コードから確認できる現在の挙動

輝度の係数は次の順に流れる。配列の添字の意味を変えず、浮動小数点演算と走査順への
並べ替えの間だけを分けることがstage 1で許される変更である。

1. `mpeg2::macroblock::decode_block()` はMPEG-2のrun/levelを
   `out[scan[n]]`へ書く。`scan`はMPEG-2ヘッダーの`alternate_scan`により
   `ZIGZAG_SCAN`または`ALTERNATE_SCAN`になるが、出力`[i16; 64]`はどちらの場合も
   `pos = y * 8 + x`の**ラスタ順**である。`Macroblock::blocks`もこの順序を契約としている。
2. `intra_targets()`、`inter_targets()`、`field_dct_to_frame_targets()`、
   `frame_dct_to_field_targets()`の`[f32; 64]`もラスタ順である。
   `Quantiser8x8::gain`と`reciprocal_gain`は`qp * 64 + pos`で同じ位置に対応する。
3. `Quantiser8x8::scanned_levels_for()`は、callerが渡したH.264の`scan`について、
   64要素をすべて次の式で上書きする。`g32`への変換、逆数、乗算、丸めはすべて現行どおり
   `f32`で行う必要がある。

       g64(qp, pos) = BASE_GAIN_8X8[qp % 6][pos >> 3][pos & 7]
                      * weight_scale[pos] * 2^(qp / 6)
       g32(qp, pos) = g64(qp, pos) as f32
       reciprocal_gain[qp, pos] = 1.0f32 / g32(qp, pos)
       out[k] = round_half_up_i32(targets[scan[k]]
                                  * reciprocal_gain[qp, scan[k]])

   これは`level_for()`の`target / gain`とは同じ式ではない。`quant.rs`のコメントが明記する
   とおり、逆数との乗算は厳密なhalf-stepで除算と異なる丸め結果を取りうる。stage 1では
   除算へ戻したり、逆数を`f64`で再計算したりしない。
4. `scanned_levels_for()`の`out`は**H.264のcoding scan順**であり、戻り値は
   64要素のうち1つでも非零なら`true`である。callerはこの値から`Option<&[i32; 64]>`と
   coded block patternを作るため、配列が同じでもboolが変わればbitstreamが変わる。
5. `write_luma_residual_8x8()`はscan順の64要素から
   `block[4 * i + i4x4]`を取り、4個の16要素CAVLC blockへ分ける。
   `write_residual_levels()`と`write_masked_levels()`は受け取った配列を低周波側からの
   coding scan順として扱い、末尾側から`TrailingOnes`と残りのlevelを符号化する。

`round_half_up_i32(value)`は`(value + 0.5).floor() as i32`である。有限で`i32`に収まる
内部入力について、最寄り整数へ丸め、ちょうど半分なら正の無限大側を選ぶ。
例えば`1.5 -> 2`、`-1.5 -> -1`、`-0.5 -> 0`である。Rustの`f32::round()`は
負のtieを0から遠ざけるため代用できない。関数自体は有限性や範囲を検査しないが、現在の経路では
`qp`は`0..=51`、scaling listの値は正、MPEG-2の逆量子化結果はsaturation後に
`-2048..=2047`となる内部値を起点とする。stage 1はこの前提を広げる変更ではない。

色差では`spatial_to_chroma_levels()`が4個の4x4 blockをラスタ位置から変換する。
各`coeff4`はラスタ順で、ACは`k = 1..15`について
`out.ac[b][k - 1] = round_half_up_i32(coeff4[scan[k]] * ac_reciprocal[scan[k]])`
と書かれる。したがって`out.ac[b]`はDCを除いた4x4 coding scan順である。
`ChromaBlockLevels::dc`だけは4個の4x4 sub-blockのラスタ順を入力として2x2変換した
4要素で、`write_chroma_residual()`が専用のchroma DC CAVLC blockとして先に渡す。

H.264側のscanは、MPEG-2の`alternate_scan`やsourceの`dct_type`ではなく、**出力する
H.264 macroblockがframeかfieldか**で決まる。

- frame macroblockでは輝度に`ZIGZAG_8X8`、色差ACに`ZIGZAG_4X4`を使う。
- `paired_field.is_some()`のfield picture経路では`direct_field_pair`が真となり、輝度に
  `FIELD_SCAN_8X8`、色差ACに`FIELD_SCAN_4X4`を使う。
- MBAFFの非I pictureでは`picture_field_pairs`が真となり、現在は全pairをfield pairとして
  符号化する。輝度は`FIELD_SCAN_8X8`、`convert_field_chroma_pair()`は
  `field_scan = true`を使い、`mb_field_decoding_flag`も真で出力する。
- MBAFFのI pictureはframe pairとして処理し、`mb_field_decoding_flag`を偽で出力する。
  sourceがfield-DCTなら先にframe基底へ変換するが、その後のCAVLC入力はframe scanである。

native CLIとWASM frontendは、どちらもcore crateの`Session`と`PictureEncoder`を呼ぶ。
したがって上記の配列順、量子化式、丸め、bool、scan選択、CAVLC入力は両buildで共有する契約である。
ただし`frame_dct_to_field_targets()`にはnative版とWASM SIMD版があり、現行テストは
nativeとWASMの相互digest一致を直接は保証していない。stage 1の比較は、各targetでcandidateを
同じtargetの固定baselineと比較し、target間の同一性を未確認のまま主張しない。

#### 規格上維持すべき要件

- [ITU-T H.262 (02/2000)](https://www.itu.int/rec/T-REC-H.262-200002-S/en)
  7.3節とFigure 7-2/7-3は、bitstream上の一次元`QFS[n]`を`alternate_scan`に従って
  二次元`QF[v][u]`へinverse scanする。`decode_block()`がMPEG-2側のscanを使って
  ラスタ位置へ書くのはこの要件に対応する。7.4.1、7.4.2.3、7.4.3、7.4.4節は、
  intra DC、その他の係数、saturation、mismatch controlの順と算術を定める。
- [ITU-T H.264 (V16) (06/2026)](https://www.itu.int/rec/T-REC-H.264-202606-I/en)
  8.5.6節とTable 8-13は4x4、8.5.7節とTable 8-14は8x8について、frame macroblockには
  inverse zig-zag scan、field macroblockにはinverse field scanを使うと定める。
  7.3.5.3.1節は8x8 transformとCAVLCの組合せを4個の4x4 listとして符号化し、
  `level8x8[i8x8][4 * i + i4x4]`へ再構成する対応を定める。
  7.3.5.3.2節と9.2節は、そのscan上のlevel列をCAVLCで符号化する構文と過程を定める。
- `reciprocal_gain`の事前計算、`f32`での丸め、`round_half_up_i32()`のtie規則は
  encoderがどのlevelを選ぶかという**現行実装の契約**であり、H.264が要求する丸め規則ではない。
  規格適合だけなら別levelも符号化できるが、それではstage 1の「挙動を変えない」という
  比較条件を満たさない。

#### 既存テストで保証されている範囲

- `crates/mpeg2toh264/tests/fixtures.rs::transcodes_every_fixture_to_the_expected_bitstream`
  は6 fixtureの変換picture数、Annex B byte数、FNV-1aを固定する。量子化、scan、CAVLCの
  どれかが最終出力を変えれば検出できるが、個々の契約を独立に特定するテストではない。
- `h264::mb`の`field_scan_visits_the_positions_table_8_14_names`と`h264::chroma`の
  `field_scan_visits_the_positions_table_8_13_names`は、field scan表を規格の座標列から
  独立に照合する。`field_scan_serialises_raster_coefficients_in_field_order`と
  `an_all_zero_block_reports_nothing_to_code`は`to_zigzag_8x8()`の並べ替えとboolを確認するが、
  `scanned_levels_for()`を呼んではいない。`to_zigzag_8x8()`自体も現在のproduction経路では
  呼ばれていないため、このテストを量子化経路全体の保証とはみなさない。
- `h264::quant`のテストはQP選択、`level_for()`の誤差、MPEG-2逆量子化、saturation、
  mismatch controlを確認する。`scanned_levels_for()`の逆数乗算やhalf-stepは直接確認しない。
- `crates/mpeg2toh264/tests/parallel.rs`は、分離した`PictureEncoder`、逆順実行、4 thread、
  deferred sessionでもnativeのbitstreamまたはfragment列が逐次経路と一致することを確認する。
- `tools/compare-wasm.cjs`は複数の`--target nodejs` buildをroundごとに交互実行し、各buildの
  再実行が安定することと、全`fragment.data`を順に連結して計算したSHA-256がbuild間で一致する
  ことを検査する。これは通常の`cargo test`には含まれず、比較対象buildと入力を明示して別途走らせる。

#### 不足していた回帰テストと未確認事項

実装前の調査時点では次のテストがなく、stage 1の実装で追加した。この節は
実装前の状態の記録を兼ねる。

- `round_half_up_i32()`の正負の値、`-0.5`、正負のhalf-stepを直接固定するテストは
  `lib.rs`の`round_half_up_i32_breaks_f32_ties_toward_positive_infinity`ほかで追加した。
- `scanned_levels_for()`のframe/field両scanでの64要素全上書き、全零で偽・1要素でも非零で真、
  逆数との`f32`乗算とhalf-stepの結果を固定する直接テストは`h264::quant`の
  `raster_levels_are_what_the_scanned_levels_reorder`、
  `an_all_zero_block_reports_nothing_for_either_scan_and_writes_zeros`、
  `a_half_step_rounds_against_the_reciprocal_product_not_the_division`で追加した。
- `ZIGZAG_8X8`の規格の座標列からの独立照合は`h264::params`の
  `zigzag_8x8_visits_the_positions_table_8_14_names`で追加した。
- 規格照合により、`h264/params.rs`の`ZIGZAG_8X8`コメントがTable 8-13、
  `h264/chroma.rs`の`FIELD_SCAN_4X4`コメントがTable 8-14を参照しており、正しい表番号と逆で
  あることを確認した。配列値とfield scanの独立テストは正しい。実装前の調査は文書変更だけに
  限定したが、stage 1の実装でこの2つのコメント番号を修正した。

stage 1後も次は未確認のままである。

- 色差ACにはfield scan表のテストはあるが、`spatial_to_chroma_levels()`の量子化結果と
  `any_ac`をframe/fieldで直接比較するテストがない。
- `ZIGZAG_4X4`には、規格の座標列から独立に全要素を照合するテストがない。
  配列値はH.264 Table 8-13と照合したが、現状はレビュー時の確認に留まる。
- nativeとWASMの同一入力に対するcross-target bitstream一致は未確認である。
  target別のbaseline/candidate一致とは別の主張として扱う。
- `tools/compare-wasm.cjs`のdigestは全`fragment.data`の連結bytesを覆うが、fragment境界、
  `kind`、`start`、`randomAccess`、`videoSamples`、`audioSamples`自体はhashへ入れない。
  nativeの逐次/deferred比較はこれらをfragment単位で確認するが、WASMのbaseline/candidate比較で
  同じ範囲まで保証するには追加の回帰検査が必要である。

stage 2（色差AC量子化、第4章の結果節）で、上記のうち2つを追加した。

- `spatial_to_chroma_levels()`の量子化結果と`any_ac`をframe/field両scanで直接比較する
  参照実装テスト（`h264::chroma`の`the_raster_reorder_path_is_identical_to_the_gather_loop`）と、
  全零・非零を両scanで確認する`an_all_zero_block_stays_empty_and_a_nonzero_one_reports_ac_for_either_scan`。
- `ZIGZAG_4X4`の規格の座標列からの独立照合は`h264::params`の
  `zigzag_4x4_visits_the_positions_table_8_13_names`で追加した。

stage 1は上記の不足を「同じはず」という推測で埋めない。少なくとも既存fixtureのAnnex Bと
WASM比較の全出力bytesが固定baselineと完全一致しなければ、同値な最適化ではない。
量子化levelが1個でも変わるとCAVLCの`TotalCoeff`、`TrailingOnes`、level、run、後続blockの
`nC`が変わりうる。さらにpictureの符号化結果はfMP4のsample内容になるため、bitstream差を
decoderが受理することや画が似ていることでは、stage 1の等価性を証明できない。

### 設計

最初の実験を**stage 1**とし、走査順の並べ替えを浮動小数点の演算から分離する。

1. ラスタ順で `targets[pos] * reciprocal_gains[pos]` を計算し、丸めてラスタ順の配列へ書く。
   この段階は連続アクセスになるため、compilerの自動ベクトル化や既存方針に沿った
   target別SIMDの余地が生まれる。ただし、`unsafe_code`や新しい依存を前提にしない。
2. 走査順への並べ替えを別パスで行う。整数のコピーだけで浮動小数点演算を含まない。

並べ替えパスを足しても割に合うかは、実装して測る必要がある。
割に合わない場合の代替は、CAVLC 側がラスタ順のレベルと走査表を受け取る形へ変えることで、
並べ替え自体をなくす方法である。ただしこれはstage 1とは別の変更として扱い、
stage 1が有効で並べ替え費用が支配的だと確認できた場合だけ検討する。

**非零位置のビットマスクはstage 1に含めない。** これは`Macroblock`へ新しい状態を持たせ、
量子化の走査順分離とは異なる変更理由と検証条件を持つ。stage 1の後に独立して判断する。
輝度側では零レベルを飛ばせる可能性がある。MPEG-2 の符号化済み輝度ブロックの
非零レベルは平均 16.62/64 で、残り 47 個の入力は零である。
`decode_block` は非零位置を既に知っているので、非零位置のビットマスクを
`Macroblock` へ持たせれば追加の走査は要らない。ただし条件が2つある。

- **mismatch control** はsaturation後の64係数の総和が偶数なら、位置63のLSBを反転して
  総和を奇数にする。そのためsourceの位置63が零でも非零になり、この場合の補正値は`+1`である。
  非零位置を別途保持する案では、この条件付き更新を落としてはならない。
- **frame→field 基底変換を通ったブロック**は密になる（非零レベル 43.82/64）ので、
  疎性は使えない。提案 B が入れば、この経路を通る符号化済み pair は 18% まで減る。

色差側は空間領域を経由するため入力が密で、疎性は使えない。SIMD 化だけが効く。

### 検証

stage 1では、各係数に対する`f32`の乗算と`round_half_up_i32`を変えず、係数間の
処理順と出力の並べ替えだけを変える。そのため、**既存fixtureとWASM比較の出力hashが
完全一致することを合格条件にする。** 差が出た場合は同値な実装ではないので停止し、
速度値を採用しない。

明示的なSIMD命令などにより丸めや変換の意味を変える案はstage 1と分ける。その場合は
「ビットストリーム不変」とは呼ばず、許容する差と品質評価を先に決める。

### stage 1の結果（実験扱い）

2026-09-08に、この文書の「設計」どおりの2パス実装（ラスタ順の量子化と整数の並べ替え）を
`experiment/quant-raster-autovec`で測った。**この節は計測記録であり、採用の判断でも
速度改善の証明でもない。** 比較対象は固定基準`faf1464e66693133fc9f4b8618992b0f557f0bc3`の
作業ツリーを実装前の状態（調査対象`760dfaee6c14333c568f9dc4a66d6b6356ed08bc`の内容）へ
戻したbaselineと、同じtreeにstage 1を適用したcandidateで、source、compiler、build option、
入力、runnerを固定した。

| 経路 | 条件 | baseline | candidate | 差 |
| --- | --- | --- | --- | --- |
| native | raw Annex B、1 thread、6回交互実行 | 平均 3.126667 s | 平均 3.083333 s | 約 1.4% 短縮 |
| native確認測定 | 同じ条件、10組の交互実行 | 平均 3135.471 ms | 平均 3086.996 ms | 1.55% 短縮 |
| WASM | `tools/compare-wasm.cjs`、6回交互実行 | 平均 3436 ms・best 3424 ms | 平均 3333 ms・best 3327 ms | 3.0% 短縮 |

- 環境はrustc 1.93.0。入力は`testdata/hd1080i.m2v`を40回連結した長尺ES
  （49,388,840バイト、600 source picture）で、nativeはこれをraw Annex Bへ1 threadで変換した。
- nativeの最終出力は全バイトのSHA-256が一致した:
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`。
- nativeの確認測定ではcandidateが10組すべてでbaselineより短かった。組ごとの差は平均
  48.475 ms、標本標準偏差20.654 ms、t分布による平均差の95%信頼区間は
  33.701–63.249 msだった。この入力と実行環境では、差をrun間のばらつきから分離できた。
- WASMは同じESを再エンコードせずremuxした50,624,640バイトのMPEG-TSを入力に、
  Node v24.19.0、wasm-bindgen 0.2.126で実行した。compare-wasmは全fragmentのdigest一致を
  検査し、prefix `d98c963f47d54e498029929724e7571b`を出力した。報告されたvideo sampleは607個。
- 参考: ES直接をWASMへ渡す最初の実行はvideo sampleが0個・digestが空になり、
  このrunは誤りとして棄却した。計測には上記のTS remux経路だけを使う。
- nativeの短縮量は1.4–1.55%と小さいが、追加の10組でも再現した。**この結果は上記の
  入力とhostに限る測定記録であり、採用の主張や他の素材・端末での改善保証ではない。**

### stage 3: 量子化の丸めからfloorf呼び出しを外す（2026-09-08）

stage 2確定後のHEAD（`e983fdd770a7ed8065e65a012fe73fdef4630e49`）で、bit-exact候補を
絞るための区間計測と生成assemblyを行った。`perf_event_paranoid=4`のため`perf`は使えず、
`rdtsc`区間計測付きbuildをscratch worktreeで再現した（呼び出し数はコード構造と一致する
ことを確認してからworktreeを削除。生データは`.opencode/bench/stage3-profile-head.txt`）。

**計測事実（e983fdd、長尺ES）:**

| 区間 | 割合 | 呼び出し |
| --- | --- | --- |
| `mb_write`（inter+intra） | 32.2% | 3,672,000（= 600ピクチャ×6120 MB） |
| `luma_quant`（`scanned_levels_for`） | 15.1% | 2,219,840 |
| `decode_picture`（MPEG-2 VLC復号） | 14.2% | 600 |
| `chroma_quant`（`spatial_to_chroma_levels`） | 8.6% | 1,297,200 |
| `dequant`（`intra_targets`＋`inter_targets`） | 4.8% | 3,142,560 |
| `chroma_xform`（`idct8`） | 2.3% | 1,147,000 |
| `mv_pred` | 0.07% | 238,680 |

**assembly上の事実:** release buildで`raster_levels_for`を単体シンボル化して逆アセンブル
すると、ループは完全スカラーで、**1係数ごとにlibm `floorf`への間接呼び出し**
（`movq floorf@GOTPCREL`＋`call *%r12`）を挟んでいた。原因は
`round_half_up_i32`の`(value + 0.5).floor() as i32`が、SSE4.1を持たない既定ターゲットで
floorf呼び出しへ降下することである。同じ関数は輝度ラスタ量子化・色差AC・色差DC Hadamardの
全ての量子化経路で使われる。

**最初の実装（共有）とその棄却:** まず`round_half_up_i32`のfloorを、切り捨てを使う等価計算へ
全ターゲット共通で置き換えた。`x = value + 0.5`を切り捨てて`t`とし、`t > x`のときだけ
`t - 1`を選ぶ。nativeではfloorf呼び出しが消えて11.66%の短縮（8組、t = −18.49、hash完全一致）
を得たが、**WASMでは2セッションともcandidateが全12 roundでbaselineより遅く、約1.5–2%の
一貫した退行が観測された。** 両経路を改善するという目的に合わないため、共有実装は棄却した。

**最終実装（ターゲット別、採用候補）:** `round_half_up_i32`をcfgで2定義に分けた。
wasm32は、共有の切り捨て式が計測したWASM環境で一貫して遅かったため従来どおり
`(value + 0.5).floor() as i32`を維持する（遅い理由の正確な機構は未確定）。非wasm32は
切り捨てベースの等価式で、nativeで係数ごとのlibm `floorf`呼び出しを除く（ベクトル化の
有無は最終assemblyでは確認していない）。両ターゲットが同じhalf-up丸め（tieは正の
無限大側）を返す契約をコメントで明記し、テスト（後述）で固定する。非wasm32式の正確性の
範囲は**`|x| < 2^24`**（f32整数が常にexactなのはそこまで）で、codecの到達域はその範囲内。
到達域の保守的な上限は**約1.31e6**である（導出: 逆量子化のclamp ±2048、intra予測調整
`FLAT_PREDICTION_DC`−8×予測値（clip済みサンプル平均≦255）でtargetの大きさは約3072以内、
field/frame基底変換は最大×16（正規直交8点変換2回、各パスの基底行和≦4）、最大の逆数は
`1/(0.0385049076×1)`≈25.97（`BASE_GAIN_8X8`の最小要素×scaling weight 1）→
3072×16×25.97≈1.28e6に変換後の調整を足して約1.31e6。色差AC・DCはこれより低い:
ACは4x4順変換出力（≦36×32,896）×ac逆数（≦0.4、`CHROMA_AC_GAIN_4X4`使用位置の最小値2.5）
≈0.47e6、DCは(Σf)/4 ≦ 約0.42e6）。2^24≈16.78e6より一桁以上小さい。
tie規則と`+0.5`は不変で、public API・CAVLC入力契約・scan・bitstream・unsafe・依存は全て不変。

- 回帰テスト: 等価性テストはhost上で**非wasm32実装だけを**実行し、wasm32側の実装式と
  同一表現のtest内参照`(value + 0.5).floor() as i32`と比較する（全half-integer
  ±2,000,000、決定性疑似乱数1,000,000点（±符号）、境界値（2^24、2^25、±4,000,000など）で
  完全一致を確認する`round_half_up_i32_matches_the_floor_formulation_everywhere_in_range`）。
  **WASM側のエンドツーエンド証拠は`tools/compare-wasm.cjs`のdigest比較であり、
  このテストではない。**
- 検証: `cargo test --release`全通過（fixtureのAnnex B hash不変）。

**最終計測（cfg修正後のbinary、baselineは固定したe983fddの無計装build、
長尺ES・raw Annex B・1 thread）:**

| 経路 | baseline | candidate | 差 |
| --- | --- | --- | --- |
| native（8組交互、再測定） | 平均 3.029652 s | 平均 2.713007 s | **10.45% 短縮** |
| WASM（6回交互） | 平均 3416 ms・best 3306 ms | 平均 3441 ms・best 3337 ms | roundごとの勝敗3対3で方向交錯（noise） |

- nativeは8組すべてでcandidateが短く、差の平均 −316.645 ms・標本標準偏差40.797 ms、
  対応のあるt統計量 −21.95（df=7）。出力SHA-256は全16回とも
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`で一致した。
- WASMのdigest prefixはbaseline・candidateとも`d98c963f47d54e498029929724e7571b`で一致し、
  video sampleは607個だった。wasm32はbaselineと同じ丸め式なので同等が期待値で、roundの
  勝敗は交錯して共有実装の一貫した退行（12/12）は消えた。平均 −0.7%はこのセッションの
  noiseの範囲とみなし、WASMの性能主張はしない。
- 共有実装の測定値（native 11.66%）は棄却された実装の記録であり、**採用候補は最終実装の
  上記の値だけである。** この結果は上記の入力とhostに限る測定記録であり、採用の主張ではない。

### stage 4: CAVLC書き込みのマスク省略パス `u_fitted`（2026-09-08）

stage 3確定後のHEAD（`5bba2b231caf97425c5b5d969b6845e5e155f7f1`）をbaselineとして、
CAVLC/mb_writeに絞って区間計測と生成assemblyを行った。`perf_event_paranoid=4`のため
`perf`は使えず、`rdtsc`区間計測付きbuildをscratch worktreeで再現した（呼び出し数は
コード構造と一致することを確認してから削除。生データは
`.opencode/bench/stage4-profile-head.txt`）。

**計測事実（5bba2b2、長尺ES）:**

| 区間 | 計測割合 | 呼び出し |
| --- | --- | --- |
| `mb_write`（inter+intra） | 39.7% | 3,672,000（= 600ピクチャ×6120 MB） |
| `cavlc_core`（`write_masked_levels`＋`write_residual_levels`） | 38.9%（**重複あり**: 後者は前者を呼ぶ。ガード分も上振れ） | 18,599,092 |
| `luma_residual`（`write_luma_residual_8x8`、`mb_write`の内側） | 20.6% | 650,751 |
| `decode_picture`（MPEG-2 VLC復号） | 15.0% | 600 |
| `luma_quant`（`scanned_levels_for`） | 8.2% | 2,219,840 |
| `chroma_quant` | 5.5% | 1,297,200 |
| `dequant` | 5.0% | 3,142,560 |
| `chroma_xform`（`idct8`） | 2.7% | 1,147,000 |

参考観察として、stage 3前後の別々の計装buildでは`luma_quant`の割合が15.1%から8.2%へ
低下した。これは同一buildの統制比較ではない。stage 4の計装buildで最大だった残区間は
CAVLC書き込み経路である。
`cavlc_core`は係数ごとの`BitWriter::u()`呼び出しで構成され、assembly上、共通パスの約13命令の
うち**約6命令が値のマスク**（`(value as u64) & (u64::MAX >> (64-n))`の`negb`＋2シフト降下）に
使われる。これは`ue`/`se`/ヘッダーを含む全`u()`呼び出しに掛かる。

**実装した変更:** `BitWriter::u`の公開契約（「valueの下位nビットを書く」＝上位ビットの
マスク）は**変更しない**。代わりに内部専用（`pub(crate)`）の`u_fitted`を追加し、
マスクを省いた本体だけを実行する（`n == 32`のときシフトを短絡し、`n == 0`を安全に処理する
debug_assert付き）。**CAVLC writer（`h264/cavlc.rs`）の3箇所だけ**が`u_fitted`を使う:

- `write_code`（coeff_token・total_zeros・run_before）: 生成テーブルの`code.bits`は
  `code.len`ビットの符号語の値そのものなので `< 2^len` が構造的に保証される。
- `write_level`の共通パス: 値は`(1 << suffix_bits) | suffix`で `< 2^(suffix_bits+1)`、
  `codeword_bits = prefix+1+suffix_bits`（`prefix >= 0`）なので収まる。escape経路の
  `u(prefix+1, 1)`と`u(suffix_bits, suffix)`も各フィールド幅に構築済み。
- trailing sign: 1 trailing oneごとに1ビットずつシフトした値なので `< 2^trailing_ones`。

他の全呼び出し元（`ue`/`se`/`flag`/ヘッダー書き込み/テスト）は`u`のまま。
**棄却した代替案:** 当初、`u()`本体からマスクを除去する設計を試したが、公開契約
（任意の上位ビットをマスクする）を変えるためレビューで棄却した。`u`は下位nビット契約を
維持し、`u_masks_upper_bits_of_the_value`テストで固定する。

- 追加テスト: `u_masks_upper_bits_of_the_value`（公開`u`が上位ビットをマスクすること）、
  `u_fitted_matches_u_for_fitted_values_across_widths_and_flushes`（n = 0, 1, 4, 13, 17, 31, 32で
  適合値についてflush境界をまたいで`u_fitted`と`u`が完全一致すること）。
- 検証: **debug** `cargo test`（debug_assert有効）と`cargo test --release`の両方で全通過
  （fixtureのAnnex B hash不変）。

**計測結果（baselineは固定した5bba2b2の無計装build、長尺ES・raw Annex B・1 thread）:**

| 経路 | baseline | candidate | 差 |
| --- | --- | --- | --- |
| native（8組交互） | 平均 2.668659 s | 平均 2.631079 s | **1.41% 短縮** |
| WASM（6回交互） | 平均 3284 ms・best 3248 ms | 平均 3235 ms・best 3222 ms | 1.5% 速い方向（gate外） |

- nativeは8組すべてでcandidateが短く、差の平均 −37.580 ms・標本標準偏差15.432 ms、
  対応のあるt統計量 −6.89（df=7）。出力SHA-256は全16回とも
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`で一致した。
- WASMは`tools/compare-wasm.cjs`が全fragmentのデータを順に入力したSHA-256 digestの
  **全64桁**を内部比較し、baseline・candidateで一致した。表示された共通prefixは
  `d98c963f47d54e498029929724e7571b`、video sampleは607個だった。WASM性能はgateではなく、
  今回のセッションでは1.5%速い方向で退行はなかった。
- **この結果は上記の入力とhostに限る測定記録であり、採用の主張ではない。** nativeの
  短縮量は約1.4%と小さく、反復確認と公開レビューを経て初めて実験の範囲を出る。

### stage 7: 輝度CAVLC入力の連続読み出し（実装前の採否基準、2026-09-08）

stage 4後の`write_luma_residual_8x8()`は、1個の8x8 level配列から4個のCAVLC 4x4
サブブロックを順に取り出す。現行ループは各サブブロックについて16個の
`block[4 * i + i4x4]`を読むため、x86-64のrelease codegenでは4回合計64個のscalar loadに
なる。4要素を連続して読み、`sub[i4x4][i]`へde-interleaveする試案では、scratchの同形
ループが16回の128-bit loadとshuffleへvectorizeされた。ただしこれは単独ループのcodegen
観察であり、実関数の短縮やWASMの改善を示す測定ではない。両方式が読むsource範囲は同じ
256 byte（一般的な64 byte cache lineなら4本）であり、cache削減は根拠にしない。

試す場合もCAVLC API、level配列の意味、4サブブロックの書き込み順、`n_c()`参照と
`counts.set()`の順序は変えない。写像は各位置で
`sub[i4x4][i] = block[4 * i + i4x4]`のままなので、整数値、非零mask、bitstreamを完全一致で
維持できる。追加スタックは現行の64 byte一時配列に対して192 byteである。

採否基準は実装前に次で固定する。

- 旧gatherをtest内参照実装として残し、決定的な入力と全16 `cbp_luma` patternで、4個の
  サブブロックとmaskが完全一致することを確認する。`n_c`へ影響する左・上近傍を持つ
  2x2 coded blockについても、生成bit列と係数数の更新結果を比較する。
- debug `cargo test`と`cargo test --release`を通し、6 fixtureのgolden Annex B hash、長尺
  native出力のSHA-256
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`、WASMの
  full-fragment digest（既知prefix `d98c963f47d54e498029929724e7571b`、607 samples）を
  baselineと完全一致させる。
- nativeは同一入力・1 thread・交互8組で全組candidateが速く、平均削減0.5%以上、対応のある
  t値が`t <= -2.365`（df=7）のときだけ残す。いずれかを満たさなければコードをrevertし、
  棄却記録だけを残す。
- WASMはdigest一致を必須とするが、この候補では性能を採否条件にも性能主張にも使わない。
  `compare-wasm.cjs`は平均とbestしか出さず、対応差の不確実性を判定できないためである。

実装baselineはこの節を固定するcommitとする。現時点では実装・性能向上の主張はない。

#### stage 7の実装結果（2026-09-08、全採否基準を満たしコードを保持）

この節を固定するcommit（`90f15023e70cd94103011f845a9d11676ae3c877`）の作業ツリーを
baseline、同じtreeにde-interleaveを適用したものをcandidateとした。実装は
`write_luma_residual_8x8`（`crates/mpeg2toh264/src/h264/mb.rs`）だけである。

- 変更は、符号化された各i8x8について、`block[4 * i + i4x4]`の4要素を位置iのグループで
  まとめて読み、4個の`sub[i4x4][i]`とmaskを同時に組み立ててから、書き込みを従来と
  同一のi4x4順（0..4）で行う形。`counts.n_c()`参照と`counts.set()`の順序は不変で、
  CAVLC API・level配列の意味・cbp・bitstream契約は変えていない。依存追加も
  `unsafe`もない。追加スタックは計画どおり192 byte（一時配列64 → 256 byte）。
- **cache削減は主張しない。** 両方式が読むsource範囲は同じ256 byte、すなわち
  一般的な64 byte cache lineなら4本であり、方式間でbyte単位のcache占有は変わらない。
  また要素ごとのaddress演算の有無を性能根拠にしない（4連続loadとshuffleへ
  並べ替えるだけで、要素数の削減ではない）。

- 追加テスト（`h264::mb`のtest module）:
  - 旧gatherをtest内参照実装`reference_write_luma_residual_8x8`として保持。
  - `the_deinterleaved_write_matches_the_reference_gather_for_every_cbp`: 決定的な
    8x8ブロックと全16 `cbp_luma` pattern、左・上近傍をseedした`CoeffCountMap`で、
    生成bit列（bit長＋padding後のbytes）と係数数更新結果（counts map全体）を参照実装と
    完全一致させる。
  - `a_coded_8x8_reads_left_and_upper_neighbours_into_n_c_in_the_same_order`:
    seedした左=5・上=3によりnCが0→4へ変わりcoeff_token表が変わることを、bit列が
    実際に変わることで観測し、同じseedでは参照実装と完全一致することを確認する。
    書き込み順が変われば後続4x4のnCが変わるため、この比較は順序を観測する。
- 検証: debug `cargo test`と`cargo test --release`を両方とも全通過（262テスト、
  うちfixtureのAnnex B golden hash不変）。`cargo fmt --check`通過。

| 経路 | baseline | candidate | 差 |
| --- | --- | --- | --- |
| native（raw Annex B、1 thread、8組交互） | 平均 2630.734 ms | 平均 2611.167 ms | **0.7438% 短縮** |
| WASM（`compare-wasm.cjs`、6回交互） | 平均 3334 ms・best 3234 ms | 平均 3316 ms・best 3229 ms | 0.6% 速い方向（gate外） |

- nativeは8組すべてでcandidateが短く、差（candidate − baseline）の平均 −19.568 ms・
  標本標準偏差10.822 ms、対応のあるt統計量 −5.11（df=7）。8組の計測後に保存された
  baseline・candidateの最終出力は、SHA-256
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`で一致した。
- WASMは`tools/compare-wasm.cjs`が全fragmentのdataを順に入力したSHA-256 digestの
  全64桁を内部比較し、baseline・candidateで一致した。共通prefixは
  `d98c963f47d54e498029929724e7571b`、video sampleは607個だった。
- 採否判定: 「出力完全一致」「全8組でcandidateが速い」「平均削減0.5%以上」
  「t ≤ −2.365」をすべて満たしたため、**コードとテストを保持する**。
  WASMは性能を採否条件・性能主張に使わない（`compare-wasm.cjs`は対応差の不確実性を
  判定できないため）。
- **この結果は上記の入力とhostに限る測定記録であり、採用の主張や他の素材・端末での
  改善保証ではない。** 生タイミングは`.opencode/bench/native-times-stage7.tsv`、
  baseline/candidateの出力は`.opencode/bench/stage7-{baseline,candidate}`に固定している。

### stage 8: MPEG-2係数VLC復号の高速パス（実装前の採否基準、2026-09-08）

stage 4の長尺計装buildでは、まだ変更していないMPEG-2側の`decode_picture`が全体の
14.95%だった。`decode_block()`（`crates/mpeg2toh264/src/mpeg2/macroblock.rs`）の係数
run/levelループは、通常係数ごとに`VlcTable::decode()`から`lookup()`を呼び、続けて
`BitReader::flag()`で符号bitを読む。現行x86-64 release codegenではこの2段が実関数呼び出し
として残る。次の実験では、係数VLCを消費せずsymbolとcode長を得る高速パスを
`crates/mpeg2toh264/src/mpeg2/vlc.rs`へ置き、通常係数のcodeと符号を
`BitReader::u(len + 1)`で一体に読む。依存、`unsafe`、H.264 CAVLC API、level配列の配置は
変更しない。

保存する現行契約は次のとおりである。

- `decode_block()`の`out.fill(0)`、intra DC、inter先頭係数の1-bit特例は変更しない。
  係数は従来どおりrunを加算し、`n > 63`を検査してから`out[scan[n]]`へ置く。
- 通常係数では、現行の`decode()`によるcode長`len`の消費と直後の`flag()`による符号bitの
  消費を、同じ開始位置からの`u(len + 1)`へ置き換える。`BitReader`のreservoir/refill境界を
  またいでも、消費するbit列、最終`bit_pos()`、levelの符号を一致させる。
- `EOB`はcode長だけを消費して終了し、`ESCAPE`はcode長を消費してからrun 6 bitとlevel
  12 bitを読む。両sentinelへ符号bitを追加してはならない。
- invalid VLCは入力を消費せず、table名、`max_len`幅のbit pattern、code先頭のbit位置を含む
  現行エラー文字列を完全一致させる。`n > 63`のエラー文言と発生時点も変えない。
- B.14/B.15の係数表はいずれも最長16 bitなので、通常係数の`len + 1`は最大17で、
  `BitReader::u()`の`n <= 32`という前提内にある。他のVLC表と
  `decode()`／`decode_or_zero_stuffing()`の挙動は変更しない。

実装では、既存の未使用`VlcTable::peek_symbol()`を、symbolとcode長を返す新しい内部APIへ
置き換え、dead codeを併存させない。`lookup()`を含む高速パスはhot loopへ確実に展開される
inline指定とし、invalid-codeのエラー生成だけをcold pathへ分ける。係数run/levelループは、
参照比較の対称性とinliningを制御できる実ロジック単位としてprivate helperへ切り出す。
test専用に代入だけのhelperを本番コードへ追加するものではなく、旧実装の参照ループは
test module内だけに置く。

採否基準は実装前に次で固定する。

- 実際のB.14/B.15表を使う決定的なstreamで、通常係数（複数run、level、正負）、`EOB`、
  `ESCAPE`について、旧ループと新ループの64要素出力と最終`bit_pos()`を完全一致させる。
  `n > 63`とinvalid-codeも両ループで発生させ、エラー文字列全体と`bit_pos()`を比較する。
- 新しいsymbol/code長APIは、B.14とB.15の有効codeについて、現行`decode()`とsymbol、code長、
  消費後のbit位置を照合する。片方だけを網羅する場合は、両表のcode構造が同じで値だけが
  異なることをtestまたは文書で実コードから示す。
- debug `cargo test`と`cargo test --release`、`cargo fmt --check`を通し、6 fixtureのgolden
  Annex B hash、長尺native出力のSHA-256
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`、WASMの
  full-fragment digest（既知prefix `d98c963f47d54e498029929724e7571b`、607 samples）を
  baselineと完全一致させる。
- nativeは同一の長尺入力・1 thread・交互8組で全組candidateが速く、平均削減0.5%以上、
  対応のあるt値が`t <= -2.365`（df=7）のときだけ残す。いずれかを満たさなければコードを
  revertし、棄却記録だけを残す。生timingと比較出力は`.opencode/bench`へ固定する。
- WASMはdigest一致を必須とするが、性能は採否条件にも性能主張にも使わない。

scratch worktreeでの実装可能性確認では、`lookup()`が呼び出しとして残る形は7/8勝・平均
1.157%短縮、完全にinline化した形は別々の2回の交互8組で各8/8勝・平均2.87%および2.34%
短縮となり、各runの出力hashは一致した。ただしhost負荷によりbaselineの絶対時間が
約2.6秒から約3.8秒へ変動している。これらは候補を実装実験へ進める根拠であって、最終treeの
性能結果でも採用の主張でもない。実装baselineはこの節を固定するcommitとし、最終treeで
上記gateを再測定する。

#### stage 8の実装結果（2026-09-08、全採否基準を満たしコードを保持）

実装baselineはこの節を固定するcommit（`f0c419e336d6281e39339b2b12f982d7580c61c1`）の
作業ツリー、candidateは同じtreeへ下記を適用した最終treeである。上記scratchの実装可能性確認
とは別に、最終treeでgateを再測定した。

- 変更は`crates/mpeg2toh264/src/mpeg2/vlc.rs`と`crates/mpeg2toh264/src/mpeg2/macroblock.rs`だけ。
  `VlcTable::lookup`を`#[inline(always)]`とし、未使用だった`peek_symbol()`を、symbolとcode長を
  消費せず返す`peek_symbol_and_len()`と、cold pathの`invalid_code()`（`decode`と同一のエラー
  文字列・bit位置）へ置き換えた。係数run/levelループは`decode_block`からprivate
  `decode_coefficient_run()`へ切り出し、通常係数のcode+符号を`BitReader::u(len+1)`で一体に読む。
  EOB/ESCAPE・intra DC・inter先頭係数の特例・`n > 63`の文言と時点・scan配置・他VLC表の挙動は
  不変。依存追加・`unsafe`・CAVLC API・level配列の配置は変更していない。
- 追加テスト（5本、debug/releaseとも全通過。既存262本と合わせ267本）:
  - `macroblock.rs`: 実B.14/B.15のcodeで符号化した決定的stream（複数run、level、正負、EOB、
    ESCAPE）を旧ループ参照実装と新ループで復号し、64要素出力と最終`bit_pos()`を完全一致。
    `n > 63`とinvalid-code（16 bit zero）も両ループで発生させ、エラー文字列全体と`bit_pos()`
    を比較。
  - `vlc.rs`: 両表の全有効codeについて`peek_symbol_and_len`と`decode`のsymbol・code長・消費後
    `bit_pos()`を照合し、invalid-codeのエラー文字列と`bit_pos()`を`decode`と完全一致。
- codegen（release buildを逆アセンブル）: 係数ループのper-symbol呼び出しが消え、
  `lookup`/`peek_symbol_and_len`/`decode_coefficient_run`がhot loopへ展開された
  （バイナリ中にシンボルなし）。`invalid_code`のみcold関数として残る。productionの
  `decode`呼び出し8箇所は係数表以外のVLC表（V_MB_ADDR/V_MB_TYPE/V_CBP/V_DMV/V_DC_*等）で、
  test内の旧係数ループ参照実装に1箇所残る。

| 経路 | baseline | candidate | 差 |
| --- | --- | --- | --- |
| native（raw Annex B、1 thread、8組交互） | 平均 2715.922 ms | 平均 2600.996 ms | **4.2315% 短縮** |
| WASM（`compare-wasm.cjs`、6回交互） | 平均 3276 ms・best 3225 ms | 平均 3164 ms・best 3096 ms | 3.4% 速い方向（gate外） |

- nativeは8組すべてでcandidateが短く、差（candidate − baseline）の平均 −114.925 ms・
  標本標準偏差36.734 ms、対応のあるt統計量 −8.85（df=7）。出力SHA-256は全16回とも
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`で一致した。
- WASMは`tools/compare-wasm.cjs`が全fragmentのdataを順に入力したSHA-256 digestの
  全64桁を内部比較し、baseline・candidateで一致した。共通prefixは
  `d98c963f47d54e498029929724e7571b`、video sampleは607個だった。
- 採否判定: 「出力完全一致」「全8組でcandidateが速い」「平均削減0.5%以上」
  「t ≤ −2.365」をすべて満たしたため、**コードとテストを保持する**。
  WASMは性能を採否条件・性能主張に使わない。
- **この結果は上記の入力とhostに限る測定記録であり、採用の主張や他の素材・端末での
  改善保証ではない。** 生timingは`.opencode/bench/native-times-stage8.tsv`、
  baseline/candidateの出力は`.opencode/bench/stage8-{baseline,candidate}`に固定している。

### stage 9: native丸めループのベクトル化（実装前の採否基準、2026-09-08）

stage 8確定後のHEAD（`a0e317718b8a2efaed24981f6fea50a7705756c0`）を調べると、
非wasm32版`round_half_up_i32()`の切り捨て式は、release binaryの実量子化ループで
`cvttss2si`と`cvtsi2ss`を使うスカラーcodegenのままだった。次の実験では、同じ値を返す
比較ベースの整数式へ書き換え、コンパイラが量子化ループをSIMD化できるかを試す。
wasm32版の`(value + 0.5).floor() as i32`、関数の呼び出し元、量子化式、scan、CAVLC入力は
変更しない。

候補式は次のとおりとする。単純な`truncated - i32::from(x < truncated as f32)`では、
`x <= -2^31`（`-inf`を含む）の飽和cast後に`i32::MIN - 1`となり、debugではpanic、
releaseではwrapして現行式と異なる。このため`i32::MIN`を明示的にマスクする。

```rust
let x = value + 0.5;
let truncated = x as i32;
let correction = i32::from(x < truncated as f32) & i32::from(truncated != i32::MIN);
truncated - correction
```

この式はcodecの現在の到達域だけでなく、全`f32`入力について現行の
`(value + 0.5).floor() as i32`と同じ結果を返す必要がある。`|x| < 2^24`では、正数と整数は
切り捨てがfloorと一致し、負の非整数だけ比較が真になって1を引く。`2^24 <= |x| < 2^31`では
表現可能な`f32`が整数なので切り捨てとの往復は恒等である。`x <= -2^31`と`-inf`はmaskにより
`i32::MIN`、正側の飽和域と`+inf`は`i32::MAX`、NaNは0となり、いずれも現行のfloor式からの
飽和castと一致する。この場合分けを実装コメントにも残し、codec到達域だけを根拠に契約外の
入力差を許容しない。

scratch worktreeでMIN mask前の同形ループを調べた範囲では、SSE2の`cmpps`等を使う
ベクトル化が起き、合成マイクロベンチは1要素あたり1.32 nsから0.54 nsになった。実際の
長尺ESでも別々の交互8組を3回行い、全組candidateが速く、平均短縮は4.49%、5.24%、
6.55%だった。ただしこれはMIN mask前の試案による実装可能性確認であり、最終treeの結果でも
採用・性能向上の主張でもない。MIN maskを含む最終式でcodegenと性能を再確認する。
コンパイラの将来版でも同じcodegenになるとは主張しない。

同じ探索で、stage 8後に残るMPEG-2 VLC呼び出しもinline化する案は、`decode_slice`が
11.6 KiBから17 KiBへ46%肥大し、交互8組中candidateが速かったのは1組、平均では1.63%遅かった。
命令cache上の不利と推定できるが原因は確定していない。この案は**棄却済み**であり、stage 9の
実装対象へ混ぜない。

#### 入力スクリーニングと適用範囲

`.opencode/bench/stage9-screen`の一時的な計装buildで、13本についてcoded 8x8 block当たりの
非零密度、MPEG-2係数symbol中のESCAPE率、frame picture内のfield-DCT率、5 bitの
`quantiser_scale_code`分布を数えた。全入力でmalformed sliceは0だった。正規gateに使える
根拠が確認済みの入力は次の3本に限定する。

| 役割 | 入力とSHA-256 | スクリーニング結果 | gateでの用途 |
| --- | --- | --- | --- |
| 実放送1080i | `gr061-sid2072-smoke-fixture.ts`、`1895e4b38464a43ea689eb82d13f507231e9e170b68b0eba5fdf2bf5db9c81c8` | 351 picture、非零密度0.0622、ESCAPE 0.8334%、field-DCT 58.52%、qscale 4–22（平均13.33） | native/WASM等価性 |
| 検証済み3:2 | `kazuhunkan-no-yell-wo-autofilm-23.976.ts`、`829290158323b01116145ace9bd1a7e7789522578384025f5cbbbeaa3a99e1f8` | 1584 picture、非零密度0.0615、ESCAPE 2.5152%、field-DCT 66.33%、qscale 3–14（平均3.52） | native/WASM等価性と既存の3:2検証 |
| 合成progressive | `fixture.ts`、`1d5472f7a59f2e360add21cc9e90180d9b25307ae4ba8baf980991557f647e91` | 720p30、1080 picture、非零密度0.1952、ESCAPE 1.2598%、field-DCT 0% | progressive経路のsmokeだけ |

スクリーニング上の暫定候補は、高密度の`nogizaka-video-control-200-260.ts`（0.0726）、
低密度の`madder-e05-3to2.ts`（0.0405）、field-DCT率の高い
`iruma-autofilm-23.976.ts`（79.55%）だった。ただし入力の正常性を正規gate相当には確認して
いないため、今回の合否には使わない。13本はすべてframe pictureで`field_picture_mbs = 0`、
SD入力もなかった。したがって、この入力集合はfield-picture経路とSDを保証しない。この不足を
実入力のdigest一致で埋まったものとして扱わない。

採否基準は実装前に次で固定する。

- 非wasm32版だけを候補式へ変え、wasm32版、public API、依存、`unsafe`、量子化演算の入力、
  CAVLC入力とbitstream契約は変更しない。MIN mask込みの最終release binaryで、実際の
  輝度・色差量子化ループがSIMD化されたことを逆アセンブルで確認する。codegenが変わらない
  場合は、性能gateだけで判断し、ベクトル化を事実として記録しない。
- host上の単体回帰では、既存の到達域比較に`f32::NEG_INFINITY`、`f32::INFINITY`、
  `f32::NAN`、`-2_147_483_648.0`、`-2_147_483_904.0`、`2_147_483_648.0`、
  `2_147_483_904.0`を加え、floor参照式と完全一致させる。debug `cargo test`、
  `cargo test --release`、`cargo fmt --check`を通し、6 fixtureのgolden Annex B hashを維持する。
- 長尺ESのnative出力SHA-256
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`、WASMの
  full-fragment digest（既知prefix `d98c963f47d54e498029929724e7571b`、607 samples）を
  baselineと完全一致させる。
- `gr061`と`kazuhunkan`は、入力ごとにnative出力SHA-256と
  `tools/compare-wasm.cjs`の**全64桁**full-fragment digestをbaseline/candidateで完全一致
  させる。後者は既存証拠のanomaly 0/316 complete cycle、combed 0、映像・音声PTS gap 0、
  decode warning 0も維持する。合成`fixture.ts`はnative/WASMのprogressive smoke一致だけに
  使う。これらの短尺TSから性能を主張しない。
- 性能採否は既存の同一長尺ES・raw Annex B・1 thread・交互8組だけで行う。全組candidateが
  速く、平均削減0.5%以上、対応のあるt値が`t <= -2.365`（df=7）のときだけコードを残す。
  いずれかを満たさなければrevertし、棄却記録だけを残す。WASM性能は採否条件にも性能主張にも
  使わない。

実装baselineはこの節を固定するcommitとする。現時点では実装・性能向上の主張はない。

#### stage 9の実装結果（2026-09-08、全採否基準を満たしコードを保持）

実装baselineはこの節を固定するcommit（`44d6844a38dee94976ceb35e4daba90557609e50`）の
作業ツリー、candidateは同じtreeへ下記を適用した最終treeである。上記scratchの実装可能性確認
（MIN mask前の試案、4.49–6.55%）とは別に、**MIN mask込みの最終式**でgateを再測定した。

- 変更は`crates/mpeg2toh264/src/lib.rs`の非wasm32版`round_half_up_i32()`だけ。
  `let x = value + 0.5; let truncated = x as i32;
   let correction = i32::from(x < truncated as f32) & i32::from(truncated != i32::MIN);
   truncated - correction`へ置き換え、全`f32`入力の完全な場合分け証明をコメントへ書いた。
  wasm32版`(value + 0.5).floor() as i32`、public API、依存、`unsafe`、量子化演算入力、
  CAVLC入力・bitstream契約は不変。将来のLLVMのcodegenを主張しない。
- 等価性テストは、既存の到達域比較に`f32::NEG_INFINITY`、`f32::INFINITY`、`f32::NAN`、
  `-2_147_483_648.0`（-2^31 = i32::MIN）、`-2_147_483_904.0`（-2^31-256）、
  `2_147_483_648.0`（2^31）、`2_147_483_904.0`（2^31+256）を加え、
  `(value + 0.5).floor() as i32`と完全一致。乱数filterは±infと大値有限を除き、NaNは
  `NaN > 4e6`が偽で通るため乱数でも検査され、境界リストが除外ケースを覆うことをコメントで
  明記。debug `cargo test`と`cargo test --release`は267本全通過、6 fixtureのgolden
  Annex B hashは不変。
- **codegen（release binaryを逆アセンブル）**: baselineも乗算・加算とfloor補正の比較までは
  4-wide SSE2だったが、補正後の`f32`を`i32`へ戻すため、4要素ごとに2回目のスカラー飽和castを
  行っていた。candidateでは`write_picture`内の9個所の量子化ループが、要素ごとの最初のcast後、
  `cvtdq2ps`（truncated as f32）→`cmpltps`（x < truncated）→`pcmpgtd`
  （truncated > i32::MIN、到達可能な整数では`!=`と同値）→`pand`（2条件のAND）→`paddd`
  （truncated - correction。真の比較maskが-1なので加算になる）→`movdqu`（4要素整数store）を
  使う。飽和する最初の`x as i32`は、SSE2の`cvttps2dq`だけではRustの飽和意味論を実装できない
  ため、従来どおり要素ごとのスカラー`cvttss2si`と上限・NaN処理のままである。
  `write_picture`シンボル内の`cvttss2si`はbaseline 74個からcandidate 38個へ36個減り、これは
  9ループから4要素ごとの第2castが1回ずつ消えた数と一致する。したがって確認できた変化は、
  丸め全体の完全SIMD化ではなく、**既存の部分ベクトル化を保ったまま第2scalar castを除いたこと**
  である。命令数はループ範囲の切り方に依存するため採否根拠に使わない。

| 経路 | baseline | candidate | 差 |
| --- | --- | --- | --- |
| native（raw Annex B、1 thread、8組交互） | 平均 2504.211 ms | 平均 2361.682 ms | **5.6916% 短縮** |
| WASM（長尺TS、`compare-wasm.cjs`、6回交互） | 平均 3082 ms | 平均 3080 ms | 0.1%（gate外） |

- nativeは8組すべてでcandidateが短く、差（candidate − baseline）の平均 −142.529 ms・
  標本標準偏差21.294 ms、対応のあるt統計量 −18.93（df=7）。出力SHA-256は全16回とも
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`で一致した。
- 長尺WASMは全fragment内部digest完全一致（prefix `d98c963f47d54e498029929724e7571b`、
  607 samples）。WASM性能は採否条件・性能主張に使わない。
- **多様化等価性gate（実入力）**: `gr061-sid2072-smoke-fixture.ts`（SHA-256
  `1895e4b3…`、351 picture、密度0.0622）と`kazuhunkan-no-yell-wo-autofilm-23.976.ts`
  （SHA-256 `82929015…`、1584 picture、密度0.0615）について、native出力SHA-256が
  baseline/candidateで一致（gr061 `26c145bf…`、kazuhunkan `4a75b743…`）し、
  `tools/compare-wasm.cjs`の**全64桁**full-fragment digestも一致（"output identical"）。
  合成`fixture.ts`（`1d5472f7…`）はnative（`8464cb71…`）・WASMとも一致のsmokeのみ。
  これらの短尺TSから性能は主張しない。正常性が正規gate相当に確認されていない暫定候補
  （nogizaka/madder-e05/iruma等）は合否に使わない。
- 採否判定: 「出力完全一致」「全8組でcandidateが速い」「平均削減0.5%以上」
  「t ≤ −2.365」をすべて満たしたため、**コードとテストを保持する**。
- **この結果は上記の入力とhostに限る測定記録であり、採用の主張や他の素材・端末での
  改善保証ではない。** 生timingは`.opencode/bench/native-times-stage9.tsv`、
  baseline/candidateは`.opencode/bench/stage9-{baseline,candidate}`に固定している。

## 3. 提案 B: MBAFF を pair 単位で適応させる

### 何が起きているか

`write_picture` は、MBAFF かつ I 以外のピクチャで全 pair を field 対として符号化する。
実装の意図はコメントにあるとおり、近傍を同じ座標系に揃えて pair 分離スライスを
不要にすることである。

その結果、frame-DCT の source macroblock は `frame_dct_to_field_targets` により
field 基底へ変換される。1回の呼び出しは 8 個の水平周波数それぞれに 16x16 の定数写像を
適用する密な演算で 2048 回の積和を要し、macroblock の幅 16 画素には 8x8 ブロックが
2つ並ぶので、**1 macroblock あたり 2 回・4096 回の積和**になる。係数の疎性は使えない。

測定した素材では、この変換が **必要な pair はごく少ない**。

| 指標 | 母数 | 値 |
| --- | --- | --- |
| `dct_type` が frame の macroblock | field 経路を通った符号化済み macroblock 567,440 個 | 99.5%（564,880 個） |
| frame 動きの macroblock | 同上 | 86.8%（492,720 個） |
| **frame 化可能な符号化済み pair** | **符号化済み pair 341,560 個** | **82.0%** |
| frame 化可能な pair（空も含む） | pair 1,713,600 個 | 96.4% |

**費用が発生するのは符号化済み pair だけなので、判断に使う値は 82.0% である。**
96.4% は空の pair（全体の 80.1%）を分母と分子に含んだ値で、比較には使えない。

pair の総数 1,713,600 が macroblock 数 567,440 より多いのは、
pair の 80.1% が空で符号化済み macroblock を1つも含まないためである。
また 1,713,600 = 3060 pair × 560 で、600 ピクチャのうち I ピクチャ 40 枚は
frame 経路を通るのでこの母数に入らない。

field 動きに加えて dual-prime 動きも field 予測を導出するため frame 対では表現できない。
上表の 82.0% は dual-prime も除外して数えたもので、
測定した2本の interlaced 素材ではどちらも dual-prime の macroblock は 0 個だった。
B ピクチャを持つ放送素材では dual-prime は使われない。

### 変換は疎性を壊す

基底変換を通ったブロックは、source の非零レベル 25.04 個から
H.264 の非零レベル **43.82 個**になる。この増加には `--oversample 2` による
量子化刻みの細分も含まれるので、変換だけの寄与を分けるには対照がいる。
対照は下記の probe で、**同じ `--oversample 2` のまま基底変換を省くと、
H.264 輝度ブロックの非零レベルは全ブロック平均 25.56 個から 13.87 個へ下がった。**

CAVLC の費用は非零係数の個数にほぼ比例するので、`mb_write` の 33.3% にも
出力サイズにも、この膨張が効いている。

### 効果の上限

全 pair を強制的に frame 符号化する probe を作り、同一 build・同一入力で比較した。

| | 速度（長尺） | 出力（長尺） | Y-PSNR（短尺） |
| --- | --- | --- | --- |
| 現状（全 pair を field 対） | 197.6〜198.5 fps | 90,565,868 バイト | 46.44 dB |
| probe（全 pair を frame 対） | 222.8〜227.0 fps | 79,265,384 バイト | 40.02 dB |
| 差 | **+13.7%** | **−12.5%** | −6.42 dB |

速度の +13.7% は各群の中央値（198.0 と 225.9）の比である。

**この probe は正しい実装ではない。** field 動きの macroblock（13.2%）は
frame 符号化した pair では表現できず、予測が誤るため 6.42 dB を失っている。

したがって、**速度の +13.7% は上限として読めるが、サイズの −12.5% は読めない。**
サイズは Y-PSNR が 6.42 dB 低い動作点での値で、等品質での比較ではないからである。
等品質でのサイズ削減は、係数個数（基底変換を通ったブロックの 25.04 → 43.82 の解消分）から
別途見積もるか、実装後に測る必要がある。

### 設計

pair ごとに `mb_field_decoding_flag` を source から決める。
frame 化可能なら frame 対、それ以外は現在どおり field 対とする。

実装に必要なのは、H.264 が定める mixed MBAFF の近傍導出である。

1. CAVLC の `nC` を、frame 対と field 対が隣接する境界で導出する（clause 9.2.1、6.4.11.4）
2. 動きベクトル予測で、近傍が異なる符号化モードのとき垂直成分を 2倍・1/2倍する（clause 8.4.1.3.2）
3. 同じ境界で `ref_idx` を 2倍・1/2倍する

現在の `CoeffCountMap` と `mvmap` は単一座標系を前提にしているため、
pair ごとの符号化モードを保持し、参照時に換算する形へ広げる必要がある。
**この提案の作業量とリスクはほぼ全てここにある。**

### 復号画像への影響

**field 対のまま残る pair の復号画像は変わらない。** 根拠は2点ある。

- 上記 1〜3 が変えるのは `mvd`（動きベクトル差分）と `nC`（CAVLC の文脈）だけで、
  どちらも符号化側の表現であり、復号されるベクトルとレベルは変わらない。
- スライスヘッダーが `disable_deblocking_filter_idc: 1` を出しているので、
  混在境界でデブロッキングの境界強度が変わることもない。

**符号量は変わりうる。** 近傍モードが変われば予測子が変わり、`mvd` の大きさも
`nC` が選ぶ符号表も変わるためである。したがって「復号画像は悪化しないが、
符号量は pair ごとに増減しうる」が正確な記述で、
全体としてどうなるかは実装後の測定でしか決まらない。

### 段階分けの検討結果

**ピクチャ単位でモードを選ぶ中間段階は成立しない。**
1ピクチャあたり平均 102 個の pair が field を要し、それが全ピクチャに散っている。
ピクチャ単位の切り替えでは、大半のピクチャで probe と同じ品質低下が起きる。

基底変換そのものを安くする案も再検証したが、現時点では実装対象にしない。
`frame_dct_to_field_targets()` は、1水平周波数について16入力から16出力への
定数写像として表せる。しかし、その合成行列を実コードの `DCT8_BASIS` から再計算して
各行を比較すると、下側8行のいずれも上側8行の同一行または符号反転ではなかった。
従来記載していた「出力の下半分は上半分から符号反転で得られる」は誤りである。
別の融合行列へ組み替えれば対称性を利用できる可能性はあるが、現行2段計算の f32 演算順序を
変えるため、ビットストリーム不変とはまだ確認できない。

入力が全て零の水平周波数列なら出力も零になること自体は、線形写像から確認できる。
ただし現在の1回の呼び出しは `upper` と `lower` の2ブロックを混ぜるため、省略できるのは
**両ブロックの同じ列がともに零の場合だけ**である。従来の非零列平均 6.59/8 は
1ブロック単位の統計なので、そこから「約18%削減」とは結論できない。両ブロックを組にした
零列率、判定自体の費用、native/WASM別の時間を測っておらず、これは不足している測定である。
しかも対象は `fp_setup` の輝度側 約 3% に限られる。したがって零列判定も実装せず、
**効果本体は pair 単位の適応にある**という優先順位だけを維持する。

### 内容による差

frame 化可能な符号化済み pair の割合は素材に依存する。

| 素材 | frame 化可能な符号化済み pair |
| --- | --- |
| `testdata/hd1080i.m2v`（放送由来、1440x1080i） | 82.0%（実測） |
| 合成・中程度の動き（`testsrc2` を 1440x1080i へ、16 Mb/s） | 約 69%（推定） |
| 合成・強いノイズと高速な動き（`mandelbrot` + `noise`、1440x1080i、16 Mb/s） | 約 3%（推定） |

合成2本の値は、空を含む割合（93.3% と 6.8%）と空の割合（78.5% と 3.7%）から
`(x − 空) / (1 − 空)` で導いた推定で、直接は測っていない。
最後の1本は毎画素の時間ノイズにより encoder が 88% の macroblock で field DCT を選んだ
極端な例で、放送素材を代表しない。

**適応方式はこの場合でも現状より復号画像が悪くならず、得られる効果が小さくなるだけである。**

## 4. 提案 C: 色差変換の融合

### 対象は当初の見込みより小さい

第1章の `chroma` 14.1% を内訳へ分解した（別 build のため、その build の総時間に対する割合）。

| 区間 | 割合 | 内容 |
| --- | --- | --- |
| `chroma_dequant` | 1.72% | MPEG-2 の逆量子化 |
| `chroma_xform` | 2.34% | `idct8` |
| `chroma_quant` | 11.10% | `spatial_to_chroma_levels` の全体 |
| &nbsp;&nbsp;`chroma_fwd4x4` | 1.41% | 上記の内側。4 個の 4x4 順変換 |

**変換そのもの（`idct8` + 順変換）は 3.75% で、色差費用の大半 約 9.7% は量子化ループである。**
`chroma_fwd4x4` は 519 万回の呼び出しに `rdtsc` を挟んだ測定なので、1.41% は上振れしている。

したがって色差の主目標は提案 A（量子化ループ）であり、
この提案 C はそれとは別に、残る 3.75% の変換部分を減らすものである。

### 融合の内容

`idct8` と4個の 4x4 順変換はどちらも線形かつ分離可能なので、合成は単一の 8x8 行列で書ける。

    M = T · C8ᵀ        T = blkdiag(Cf4, Cf4)、Cf4 は H.264 のコア 4x4 整数変換
                       C8 は正規直交 DCT 行列
    Y = M · X · Mᵀ     X は MPEG-2 の逆量子化済み 8x8 係数

**2x2 DC Hadamard は M に含まれない。** 現行どおり、Y の各 4x4 部分ブロックの
DC を取り出した後に別途適用する。M が置き換えるのは `idct8` と `forward4x4` だけである。

等価性は数値で確認した。値域 ±400 の係数を低周波 4x4 内に 1〜9 個だけ持つ
合成ブロック 200 個について、現行実装と `M·X·Mᵀ` の**絶対値差の最大は 1.4e-12** だった。
これは数式の等価性を確かめる検算であって、適合テストの代わりにはならない。
実データでの確認と適合テストは別に必要である。

得られる性質は3つある。

1. **積和が 1536 回から 1024 回へ減る。** 中間の画素バッファも不要になる。
2. **M の 64 要素のうち 20 個が厳密に零。** 構造として省略できる。
3. **M の下半分は上半分から得られる。**
   `M[4:8,:] = diag(1,−1,1,−1) · M[0:4,:] · diag((−1)^k)` が厳密に成り立つ
   （絶対値差の最大 7.8e-16）。第1パスは 4 行だけ計算すればよい。

入力 X の非零行だけを第1パスで処理すれば費用はさらに下がるが、
色差ブロックだけの周波数分布は測っていないので、この上乗せ分は見積もれていない。

1536回から1024回への積和削減だけを処理時間へ比例させても、encode全体に対する
短縮余地は約1.25ポイントである。これは命令数からの粗い上限推定で、
実測値ではない。定数の零や対称性による追加効果はありうるが、Aの後まで保留する。

提案Cは浮動小数点の演算順序を変えるため、出力完全一致を必須とした提案A stage 1とは
検証条件が異なる。実装前に、許容する係数差、画質、decoder適合性の基準を決める。

#### 受け入れ計画（prospective、実装前に合意する基準）

融合の実装に先立ち、以下の受け入れ計画を定める。この節は**計画の記録であり、
結果の主張ではない**。基準は実装後にこの節と結果節で照合する。

- **決定論的合成比較**: 現行2段階計算（`idct8`＋`forward4x4`）と融合計算を、frame/field
  両scan、代表的なQP、intra/interおよびfield-pair入口経路で比較する。量子化係数の
  整数差は**最大1**とし、差の個数と分布を報告する。完全一致が達成できた場合は通常の
  digest一致を合格条件とする。
- **実fixture品質**: 各fixtureで復号輝度はbaselineと**バイト一致**。Cb・Crそれぞれの
  candidate対baseline PSNRは**70 dB以上**。source参照のCb/Cr PSNRはfixtureごとに
  **0.01 dB以上の低下なし**。フレーム数・ジオメトリ・タイミング/sample数・fragment構造は
  不変とする。
- **native採否**: 交互8組で**全組がcandidate側が速く**、平均削減**0.5%以上**、
  対応のあるt値が **t <= -2.365（df=7）**。
- **WASM**: 確立した`compare-wasm.cjs`交互方式で**統計的に支持される退行なし**。
  best-of-Nではなく不確実性を報告する。
- **decoder適合性**: ffmpeg復号に加え、macOSのVideoToolbox（`tools/vtdec.swift`、
  hardware/software）とAVStreamDataParser（`tools/sdpdec.m`）が期待したフレーム数・
  sample数で失敗ゼロで完了する。macOS gateはparentが実行する。

#### 融合の実装結果（2026-09-08、native採否基準不達によりコードはrevert）

融合（M = T·C8ᵀ、Y = M·X·Mᵀ、定数は`C8`＝`COS_PI_OVER_16`由来）を
`convert_chroma_block`と`convert_intra_chroma_block`へ試験実装し、上記の受け入れ計画に
照合した。`convert_field_chroma_pair`はfield sampleの行インターリーブを含む別の変換を
導出する必要があるため現行2段階計算のままとし、融合候補の比較対象には含めなかった。
比較baselineは`601b7045ea366a8df604db10b9c54ddb53497bcb`である。

- **合成比較（実装した経路は合格、field-pairは未評価）**: 両scan・QP 0/13/26/39・
  intra/inter＋intra予測の各入口・対抗的ブロック
  12,000個で768,000レベルを比較し、**28レベルが±1移動（最大1）**、ブロック内移動数分布は
  [0: 11,972, 1: 28, 2+: 0]。実装した経路は係数基準（最大1）を満たしたが、受け入れ計画が
  要求したfield-pair入口の融合比較は不足している。
- **実入力の完全一致（合格、最良の場合）**: 6 fixtureのAnnex B hashが不変、長尺入力の
  native SHA-256（`12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`）と
  WASM full-fragment digest（`d98c963f…`、607 samples）がbaselineと**完全一致**。
  復号画質gate（輝度バイト一致・Cb/Cr PSNR 70 dB以上・source参照の0.01 dB以内）は
  bitstream一致により自明に満たす。
- **native性能（不達）**: 交互8組でbaseline平均2.783357sに対しcandidate平均2.758679s、
  差 −24.678 ms（名目0.89%）だが、**速い組は5/8**・paired t = −1.23（df=7）で、
  「全組速い・t ≤ −2.365」の採否基準を満たさず、noiseから分離できない。
- **WASM（未判定）**: 交互6 roundの平均はbaseline 3,244 ms、candidate 3,253 ms
  （candidateが名目0.3%遅い）でdigestは一致した。`compare-wasm.cjs`の出力には対応差の
  分散や検定値がないため、「統計的に支持される退行なし」は確認できていない。
- **判定**: 実装した経路の係数基準と実入力の完全一致は達成したが、field-pair比較が不足し、
  native採否基準も満たさなかったため、
  受け入れ計画に従い**コードはrevert**した（この節の結果は棄却記録）。macOS gate
  （`vtdec.swift`・`sdpdec.m`）は未実施（parent境界）。再測定・基準変更・別実装形での
  再評価は、この記録を前提に判断できる。

### A後の再評価（2026-09-08、stage 2）

提案A stage 1の確定後、提案Cの対象区間を現在のHEAD（`155886748c7d66d9989aff907275f6cb3b6fc58d`、
stage 1実装込み）で測り直した。このhostのカーネル設定（`perf_event_paranoid=4`）により
`perf`は使えず、第1章と同じ方式（`rdtsc`区間計測付きbuild）をscratch worktreeで再現した。
計測後にworktreeは削除したため、保存した数値から正確な計測ガードの挿入位置を再検証する
ことはできない。

計測ガードの挿入は2パスで行ったため、1行署名の関数（`idct8`、`forward4x4`）ではガードが
2重に計上された可能性が高い。呼び出し数の算術がこれを裏付ける。`forward4x4`は
`spatial_to_chroma_levels`の呼び出し1回につき4回呼ばれるので、`chroma_quant`の1,297,200回に
対する期待値は5,188,800回だが、計測値はちょうど2倍の10,377,600回だった。`idct8`は
符号化済み色差ブロック1個につき1回呼ばれる（単独経路とpair経路の合計で`chroma_dequant`の
1,147,000回に一致するはず）が、計測値はちょうど2倍の2,294,000回だった。一方、複数行署名の
関数（`dequant_chroma`、`spatial_to_chroma_levels`）と`scanned_levels_for`の呼び出し数
（それぞれ1,147,000、1,297,200、2,219,840）はコード構造と一致する。したがって
`chroma_xform`と`chroma_fwd4x4`の割合は、1回分のガード費用を余分に含む**上限**として読む。
**以下はstage 2の計測記録であり、第4章冒頭の古い割合を現状の内訳として扱うこともしない。**

| 区間 | 計測割合 | 呼び出し | 内容 |
| --- | --- | --- | --- |
| `chroma_dequant` | 1.749% | 1,147,000 | 色差の逆量子化 |
| `chroma_xform` | 4.726%（上限） | 2,294,000（2倍計上） | `idct8` |
| `chroma_fwd4x4` | 5.396%（上限） | 10,377,600（2倍計上） | `chroma_quant`の内側。4x4順変換 |
| `chroma_quant` | 12.937% | 1,297,200 | `spatial_to_chroma_levels` の全体 |
| `luma_quant` | 14.903% | 2,219,840 | stage 1後の `scanned_levels_for` |

cycles/callは計測したが、区間計測buildごとにガード位置とbuildが異なるため、第2章の
旧実装の「1係数あたり1.46サイクル」と直接比較できない。本節では呼び出し数と割合だけを
記録する。`chroma_quant`から`chroma_fwd4x4`の計測値を差し引いた7.54%は、AC量子化ループと
DC Hadamardの費用の**下界**である（`chroma_fwd4x4`が上振れのため、実際の順変換費用は
計測値より小さく、ループ側はこれより大きい）。AC量子化ループは輝度stage 1と同じ形
（`scan[k]`の間接参照を挟む乗算と丸め）であり、輝度で1.4–1.55%の短縮を得た並べ替えを
色差ACへも適用できる。逆に`idct8`＋順変換の融合（この章の当初案）はbit-exactではなく、
下記の理由でstage 2では採用しない。

#### 融合（当初案）を採用しない判断

`M·X·Mᵀ`融合はf32の演算順序を変えるため、量子化levelが丸め境界で変化しうる。
その場合は許容する係数差・画質・decoder適合性の基準を先に決める必要がある。
decoder適合性の基準には`tools/vtdec.swift`（VideoToolbox）と`tools/sdpdec.m`
（AVStreamDataParser経由のMSE相当）が含まれるが、どちらもmacOS専用で、このLinux hostでは
実行できない。ffmpeg復号だけでは十分な証拠にならないため、このstage 2時点では
**融合の実装を停止し、下記のbit-exact候補だけを実装した。** 後に受け入れ計画を固定して
部分実装を評価した結果は、この章の「融合の実装結果」に記録している。macOSで受け入れ計画を
実行できる環境では、
実装前に係数差の測定、PSNRの基準、両harnessでの復号を計画として確定する必要がある。

また融合の積和削減見積もり（1536→1024）は4x4順変換を行列積として数えたもので、
実装の`forward4x4`はbutterflyで1ブロックあたり16乗算に過ぎない。融合の実質的な対象は
`idct8`と順変換で、その計測割合は上表のとおり`chroma_xform` 4.7%・`chroma_fwd4x4` 5.4%
（どちらも上限）であり、第4章の「約1.25ポイント」は命令数からの上限推定であって実測ではない。

#### 実装した候補: 色差AC量子化のラスタ順計算と並べ替え（bit-exact）

`spatial_to_chroma_levels()`のAC量子化ループを、輝度stage 1と同じ2パスに分けた。
各levelは`round_half_up_i32(coeff4[pos] * ac_reciprocal[pos])`をラスタ順（`pos = 1..15`）で
計算してから、`scan[k]`で整数のコピーだけを並べ替える。演算は1要素ごとに完全に同じなので
出力はbit-exactであり、`any_ac`の意味、DC Hadamard、frame/field scan、field pair、intraの
各契約は変わらない。実装は`h264/chroma.rs`の`ac_levels_for()`で、CAVLC APIと
`ChromaBlockLevels`は不変。

- 追加テスト: 旧ワンパスをtest内の参照実装として保持し、両scan・複数QP・決定性疑似乱数
  ブロックで完全一致を確認する`the_raster_reorder_path_is_identical_to_the_gather_loop`、
  全零で空・非零で`any_ac`を両scanで確認する
  `an_all_zero_block_stays_empty_and_a_nonzero_one_reports_ac_for_either_scan`、
  Table 8-13の座標列からの独立照合`zigzag_4x4_visits_the_positions_table_8_13_names`。
- 検証: `cargo test --release`全通過（fixtureのAnnex B hash不変）、native出力のSHA-256が
  baselineと一致、`tools/compare-wasm.cjs`の全fragment digestが一致しvideo sample 607個。

計測（入力と実行手順はstage 1と同じ長尺ES・交互実行だが、baselineはstage 1実装込みの
HEAD `1558867`の無計装buildであり、固定基準`faf1464`との直接比較ではない）:

| 経路 | baseline | candidate | 差 |
| --- | --- | --- | --- |
| native（raw Annex B、1 thread、8組交互） | 平均 3.052371 s | 平均 3.001425 s | 1.67% 短縮 |
| WASM（`compare-wasm.cjs`、6回交互） | 平均 3882 ms・best 3343 ms | 平均 3604 ms・best 3244 ms | n=6では性能差を結論できない |

- nativeは8組すべてでcandidateが短く、差（candidate − baseline）の平均 −50.946 ms・
  標本標準偏差21.505 ms、対応のあるt統計量 −6.70（df=7）。出力SHA-256は全16回とも
  `12e1392c12d53b25d53534afa9618c09ab971c3c8ddc3853c83d0e49b06a03c1`で一致した。
- WASMのdigest prefixはbaseline・candidateとも`d98c963f47d54e498029929724e7571b`
  （stage 1の記録と同じ）で一致し、video sampleは607個だった。WASM時間はばらつきが大きく
  （baseline 3343–4503 ms）、n=6では性能差を結論できない。確実なのはdigest一致と
  video sample数だけである。ES直接の実行はstage 1と同様にvideo sample 0個になるため
  使っていない。
- **この結果は上記の入力とhostに限る測定記録であり、採用の主張や他の素材・端末での
  改善保証ではない。** nativeの短縮量は約1.7%と小さく、反復確認を経て初めて実験の範囲を
  出る。融合は後に通常・intra経路だけを試験実装したが、field-pair比較の不足とnative採否基準
  不達によりrevertした（この章の「融合の実装結果」）。

## 5. CAVLC 出力について

`mb_write` の 33.3% は単一では最大の区間だが、独立した提案にはしていない。
実装は既に非零位置のビットマスクを持ち、prefix と suffix を1回の書き込みにまとめており、
費用は非零係数の個数にほぼ比例する構造になっている。
**したがってここを縮める主な手段は係数を減らすことで、それは提案 B の効果である。**

符号化効率だけを見れば CABAC のほうが CAVLC より小さくなるが、符号化側の費用は増える。
この実装が CAVLC を選んでいる理由と合わせて、別途評価する対象とする。

## 6. GOP をまたぐパイプライン

`-j` によるピクチャ並列は 8 スレッドで頭打ちになる。
**この表は MPEG-TS から fMP4 への経路で測ったもので、第1章の 197.6 fps
（MPEG-2 ES から Annex B H.264）とは入出力形式が違う。**
`-j 1` の 184.6 fps と 197.6 fps の差はこの経路差による。

| `-j` | 1 | 2 | 4 | 8 | 16 | 32 |
| --- | --- | --- | --- | --- | --- | --- |
| fps | 184.6 | 338.3 | 547.5 | 789.3 | 750.3 | 722.6 |
| `-j 1` に対する倍率 | 1.00 | 1.83 | 2.97 | **4.28** | 4.07 | 3.91 |

飽和の原因は `IncrementalTranscoder` の `in_flight: Option<InFlight>` にある。
同時に処理中の unit は常に1個で、unit ごとに全ワーカーが合流する。
1 unit が 15 ピクチャしかないのに直列部分（ヘッダー走査、計画、結合、多重化）が残るため、
倍率が 4.28 で止まる。これは直列部分が約 23% であることに相当する。
**8 を超えて低下する（789.3 → 750.3 → 722.6）のは Amdahl では説明できず、
合流点での同期費用か資源競合が別にある。原因は特定していない。**

`plan_unit` はスライスを復号せずヘッダーだけで次の状態を決められるので、計画は先行できる。
`in_flight` を複数 unit のキューにすれば合流点がなくなる。
結合と出力は unit の順序で行う必要があるが、これは並べ替えバッファで足りる。
修正後にどこまで伸びるかは見積もっていない。

**この変更が効くのは単一ストリームの遅延（録画のシークや追いつき再生）に限られる。**
視聴者ごとにプロセスやスレッドを割り当てる運用で合算スループットが線形に伸びるかは、
複数プロセスを並走させた測定をしていないので未確認である。

## 7. 帯域の設計余地

`--oversample` は現状で唯一の速度・品質・帯域の調整点だが、輝度にしか効かない。
短尺入力での測定値を示す。

| `--oversample` | 出力（バイト） | 入力比 | Y (dB) | U (dB) | V (dB) |
| --- | --- | --- | --- | --- | --- |
| 1 | 1,676,190 | 1.36 | 45.62 | 38.43 | 33.51 |
| 2（既定） | 2,106,380 | 1.71 | 46.44 | 38.50 | 33.53 |
| 3 | 2,408,587 | 1.95 | 46.63 | 38.52 | 33.53 |
| 4 | 2,591,837 | 2.10 | 46.72 | 38.52 | 33.54 |

長尺入力（40連結）では同じ `--oversample 2` で入力比が 1.83 になる。
**7% の差の理由は特定していない。** 連結によりランダムアクセス点の配置が変わることが
関係していると考えられるが、確認していない。素材本来の比は短尺の 1.71 のほうである。

**色差 PSNR は `--oversample` にほとんど反応しない。**
`--oversample` は H.264 側の量子化刻みを細かくするだけであり、
色差の誤差は空間領域を経由する射影の丸めと `CHROMA_QP_OFFSET = -6` が決めているためである。
V が 33.5 dB にとどまることが、この実装の品質の上限を作っている。

まだ使われていない調整点が1つある。**PPS の 8x8 scaling list は現在 MPEG-2 の
non-intra 行列そのものだが、これは仕様上の要請ではない。** 行列を位置ごとに
定数倍すれば、H.264 側の刻みを低周波では細かく、高周波では粗くできる。
H.264 側の非零レベルは走査順の平均最終位置が 33.31 で低周波だけに収まってはいないので、
高周波の刻みを粗くすれば出力を縮められる可能性がある。

**これは仮説であり、測定していない。** `Quantiser8x8` は既に位置ごとの利得で
除算しているので実装の変更は小さいが、`choose_qp` は
「1ブロックに1つの QP でよい」ことの根拠として
「位置による利得比の広がりは約 2.7%」を使っている。行列を変えるとこの広がりが増え、
ブロック内で最適な QP が位置ごとにずれる。どこまで広げても実害がないかは、
`--oversample` の曲線と同じ条件でサイズと PSNR を測って決める。

## 8. サーバー側経路

### まず、速度と帯域では正当化できない

同一 host・1スレッドでの比較。速度は長尺入力、出力サイズと PSNR は短尺入力で測った。
9.5 Mb/s は KonomiTV の `1080p` 画質プリセットが指定する映像ビットレートである。

| 実装 | 速度 | 出力（短尺） | Y | U | V |
| --- | --- | --- | --- | --- | --- |
| mpeg2toh264 `-o 2` | 197 fps | 2,106,380 バイト | 46.44 | 38.50 | 33.53 |
| ffmpeg 復号 + x264 `ultrafast` 9.5 Mb/s | **414 fps** | **742,272 バイト** | **49.43** | **47.57** | **47.65** |
| ffmpeg 復号 + x264 `veryfast` 9.5 Mb/s | 93 fps | 589,736 バイト | 48.79 | 46.92 | 46.86 |
| MPEG-2 復号のみ（再エンコードが必ず払う下限） | 約 1220 fps | — | — | — | — |

**x264 ultrafast は、この host では mpeg2toh264 より 2.1倍速く、2.8倍小さく、
輝度で 3.0 dB、U で 9.1 dB、V で 14.1 dB 良い。** 「完全に復号しない」ことは、
この CPU 上では速度上の優位になっていない。動き探索を省く代わりに、
密な基底変換と、輝度の非零レベルを 16.62 個から 25.56 個へ増やす再量子化と、
その CAVLC 出力を払っているためである。

この比較には注意点が2つある。

- **短尺入力（15 ピクチャ、約 0.5 秒）はレート制御が落ち着くには短い。**
  ultrafast の 742,272 バイトは約 11.9 Mb/s で、指定した 9.5 Mb/s を超えている
  （veryfast は約 9.4 Mb/s でほぼ一致する）。サイズ比 2.8倍はこの動作点での値である。
- 比較したのは1つの動作点だけで、レート歪み曲線全体ではない。

それでも、**速度が 2.1倍違い、その動作点で品質も x264 が上回っている**以上、
「サーバー側の変換を mpeg2toh264 に置き換えて速くする」が成立しないという結論は変わらない。
QSV / NVENC を持つ host では差がさらに開くと考えられるが、測定していない。

最大常駐メモリは mpeg2toh264 が 26 MB（`-j 8` で 106 MB）、
x264 ultrafast が 78 MB、x264 veryfast が 170 MB だった。

### では、どこに置く価値があるか

3つある。いずれも速度ではなく、このアルゴリズムの構造的な性質に由来する。

**(1) Original の意味を保つ。** KonomiTV の `original` 画質は「放送そのまま」を意味する。
x264 での再エンコードは、どのビットレートでも source とは別の符号化判断を持つ映像になる。
mpeg2toh264 は source の量子化係数・マクロブロック種別・動きベクトルを保つ表現変換である。

ただし、**mpeg2toh264 の出力も source と同一ではない**。上表のとおり
Y 46.4 dB / V 33.5 dB で、特に色差の劣化は小さくない。
したがってこの論点は「同一かどうか」ではなく「どの誤差が許容できるか」であり、
`original` に対して何を約束するのかを先に決めない限り、
この項目だけではサーバー側配置を決められない。

**(2) GOP 単位のキャッシュ。** 変換結果は
（unit のバイト列、`TranscoderState`、オプション）の純関数である。
`plan_unit` も `PictureEncoder::encode` も、引数以外の状態を出力に持ち込まない。
ランダムアクセス点では `TranscoderState::restarted` が
`initialized` と `description` を除く全てを初期値へ戻す。
その2つは unit 自身のシーケンスヘッダーから決まるので、
**ランダムアクセス点で始まる unit に限れば、キャッシュ鍵は unit のハッシュとオプションで足りる。**
録画の再生・シーク・別クライアントからの再視聴で、変換を1回に減らせる。

x264 ではこれができない。レート制御が過去に依存するため、
GOP 単位で切り出した出力を再利用しても同じストリームにならない。
**キャッシュ可能性は、このアルゴリズムが x264 に対して持つ数少ない構造的な優位である。**

**(3) クライアントとサーバーの間で変換位置を切り替える。**
`job.rs` は「1つのピクチャを、ストリームを走査している場所以外で変換する」ために
`PictureJob` のバイト表現を既に持っている。これは web worker のために作られたものだが、
**同じ形式がネットワーク越しにもそのまま使える。**

したがって、サーバーは TS の分離とヘッダー走査だけを常に行い、
クライアントごとに次のどちらかを返す設計が取れる。
ヘッダー走査は encode 時間の 1.0% にあたるが、TS 分離の費用は別途測る必要がある。

- 追いつけているクライアントには MPEG-2 TS を返す（サーバーの変換費用は 0）
- 追いつけないクライアントには変換済みの fMP4 断片を返す（1ストリームあたり約 0.15 コア）

切り替えは unit 境界で行える。`Session` が返す `Fragment` は既に MSE 用の
fMP4 断片であり、プレイヤーは自前の worker から受け取るか
ネットワークから受け取るかの違いしかない。

この設計が直接効くのは `STATUS.md` の優先事項である
「TV ライブ再生のフレーム落ち」と「iOS/iPad の Original 切り替えエラー」で、
どちらもクライアント側の実行能力に起因する問題である。
参考として、この host の Node 上での WASM 実行は **167.2 fps**（ネイティブの 84%）だった。
デスクトップ級の CPU では十分な余裕があるが、
テレビや低消費電力端末での実測値は未確認である。

### 実装上の不足

CLI は入出力にファイルパスしか受け付けない。
KonomiTV はチューナー出力をプロセス間でパイプするので、
サーバー側経路を作るなら標準入出力でのストリーミングが最初に必要になる。

## 9. 実験の順序と停止条件

1. `upstream/main`をfetchし、基点とcodec coreの差分を確認する。基点が変わっていれば、
   この文書の過去値を新しいtreeの測定値として使わない。
2. 提案A stage 1だけを実装する。非零ビットマスク、CAVLC API変更、提案B、提案Cを
   同じ差分へ入れない。
3. baselineとcandidateを交互に複数回走らせ、nativeとWASMを別々に評価する。
   source、compiler、build option、入力、runnerを固定する。
4. 既存fixture testに加え、`tools/compare-wasm.cjs`で全fragmentのdigest一致を確認する。
   digestが異なる、同一build内の結果が安定しない、または改善が測定noiseから分離できない
   場合はstage 1を採用せず停止する。
5. WASMで再現性のある改善が得られた場合だけ、端末再生の同一条件A/Bへ進む。
   host上の短縮をGalaxy、POCO、iPhone、iPadの再生改善として扱わない。
6. Aの結果を確定した後にCを再評価する。Bは複数の実放送素材でpair統計を取得し、
   mixed MBAFFの適合性、複数decoder、VideoToolbox、AVStreamDataParserを含む受け入れ条件を
   合意するまで実装しない。

## 10. 未確認事項

- **実放送に由来する素材が1本しかない。** frame 化可能な符号化済み pair の 82.0% は
  `testdata/hd1080i.m2v` の統計であり、実放送の統計ではない。
  提案 B に着手する前に、実放送の録画を複数本で同じ統計を取ることを勧める。
  **判断が変わる境界は、符号化済み pair 基準で概ね 50% を下回るあたりにある。**
- **提案 A stage 1 と、その色差AC版（stage 2）の削減量はnativeで測った。** stage 1は
  native 1.4–1.55%・WASM 3.0%、stage 2
  （色差ACのラスタ順計算と並べ替え、bit-exact）はnative 1.67%の短縮で、出力は完全一致
  だった。stage 2のWASMはn=6で分散が大きく性能差は結論できず、digest一致のみ確認した。
  融合（`M·X·Mᵀ`）は受け入れ計画を固定して通常・intra経路を試験実装したが、field-pairは
  未評価で、native採否基準にも届かずrevertした。WASMの統計的な非回帰とmacOS専用harness
  （`vtdec.swift`、`sdpdec.m`）も未確認である（第4章の結果節）。
- **stage 3（丸めからのfloorf除去）は、共有実装のWASM退行（2セッションで全12 round遅い）を
  棄却し、ターゲット別実装（wasm32は従来のfloor、非wasm32は切り捨て等価式）を採用候補とした。**
  最終実装はnative 10.45%の短縮（8組、t = −21.95、hash完全一致）、WASMはdigest一致で
  性能はroundごとに方向が交錯するnoiseとなり、共有実装の一貫した退行は消えた。
  両ターゲットが同じround-half-up結果を返す契約はコメントと等価性テストで固定した
  （第2章の結果節）。
- **提案 B の作業量を見積もっていない。** mixed MBAFF の近傍導出は
  仕様上は完全に定義されているが、`CoeffCountMap` と `mvmap` の
  座標系変更がどこまで波及するかは、実際に触るまで分からない。
- **提案 B の受け入れ基準を決めていない。** ビットストリームが変わる変更なので、
  適合性（複数デコーダーでの再生確認）と符号量の許容範囲を先に決める必要がある。
- **scaling list による周波数別の刻み（第7章）は仮説で、測定していない。**
- **長尺入力で入力比が 1.71 から 1.83 へ変わる理由を特定していない。**
- **8 スレッドを超えたときの性能低下の原因を特定していない。**
- **ARM や低消費電力 CPU での x264 との比較をしていない。**
  第8章の比較はこの x86 host 上の1点である。
- **色差 V が 33.5 dB にとどまる理由を切り分けていない。**
  射影による丸め、`CHROMA_QP_OFFSET`、README が述べる 1/4 色差画素のずれの
  どれが支配的かは未確認である。品質の上限がここにあり、
  第8章 (1) の判断もここに掛かるので、切り分ける価値は高い。
