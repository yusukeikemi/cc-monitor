# 論文ベース調査: cc-monitor に導入できる技術 (2026-06-10)

Claude Code を「コンテキストをクリーンに保ちながら、ロングランのタスクを、より observable に」使うための
最新研究(主に 2025〜2026 の arXiv)を調査し、cc-monitor への導入可能性をマッピングした。
前回実施済みの既存ツール調査は対象外とし、今回は論文ベースに限定している。

cc-monitor の制約を前提に評価した:

- **オフライン解析**: 拡張本体は transcript `.jsonl` のヒューリスティック解析のみ(LLM 呼び出しなし)
- **スキル層**: `/cc-usage-advice`・`/cc-session-review` は会話内 LLM を使えるため、LLM 前提の手法はここに置ける
- **観測対象**: Claude Code 本体の挙動は変えられない。「測って・警告して・助言する」のが cc-monitor の役割

---

## TL;DR — 導入価値の高い技術トップ 5

| # | 技術 | 出典 | cc-monitor への落とし込み | 実装層 |
|---|------|------|--------------------------|--------|
| 1 | **Observation Masking の節約効果シミュレーション** | The Complexity Trap (JetBrains, NeurIPS 2025 WS) | 「古いツール出力をマスクしていたら今セッションは何ドル安かったか」の what-if 指標。要約より単純マスクで十分という実証が根拠 | 拡張(オフライン) |
| 2 | **キャッシュ完全活用時との差分コスト(cache waste %)** | Don't Break the Cache (2026) | 実測 41–80% 削減が達成可能というベンチマークを基準線に、「理想キャッシュとの乖離額」を常時表示 | 拡張(オフライン) |
| 3 | **コンテキスト長による性能劣化(context rot)警告の根拠強化** | Classifier Context Rot (2026) / Lost in the Middle 理論 | fillRatio 閾値警告を「劣化は実測で 2–30 倍」という定量根拠付きに。長尺セッションでは「目的の再掲(periodic reminder)」を助言 | 拡張+スキル |
| 4 | **MAST 失敗分類の /cc-session-review への組み込み** | Why Do Multi-Agent LLM Systems Fail? (MAST, 2025) | 14 失敗モード・3 カテゴリの taxonomy をセッションレビューのルーブリックに採用(LLM-as-judge、κ=0.88 で人手と一致) | スキル |
| 5 | **意味的ループ検出(embedding ベース)** | Unsupervised Cycle Detection (2025) / TrajAD (2026) | 現行の文字列ベースのループ検出を、ローカル埋め込みモデルによる意味的類似度比較に拡張 | 拡張(要ローカルモデル) |

---

## テーマ 1: コンテキスト圧縮・整理(クリーンなコンテキスト)

### 主要論文

- **[The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization](https://arxiv.org/abs/2508.21433)** (JetBrains Research / TUM, NeurIPS 2025 DL4Code WS)
  SWE-bench Verified × 5 モデル構成で、**古い観測(ツール出力)を単純にマスクするだけで、LLM 要約と同等以上の性能をコスト半分以下**で達成。ハイブリッド(マスク+要約)でさらに 7–11% 削減。[データセット](https://huggingface.co/datasets/JetBrains-Research/the-complexity-trap)・[コード](https://github.com/JetBrains-Research/the-complexity-trap)公開。
- **[ACON: Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/abs/2510.00615)** (2025)
  観測と履歴の両方を自然言語の「圧縮ガイドライン」で圧縮。ピークトークン 26–54% 削減、小型モデルの長期タスク性能を最大 46% 改善。ガイドラインは失敗分析から反復改善される。
- **[Scaling Long-Horizon LLM Agent via Context-Folding](https://arxiv.org/abs/2510.11967)** (2025)
  サブタスクへ「分岐→完了時に折りたたみ(要約のみ残す)」する設計で、**アクティブコンテキストを ReAct 比 1/10** にしつつ同等以上の性能。要約ベースの履歴管理を有意に上回る。続報に [FoldAct](https://arxiv.org/pdf/2512.22733)(2025)。
- **[ContextBudget: Budget-Aware Context Management for Long-Horizon Search Agents](https://arxiv.org/pdf/2604.01664)** (2026)
  タスク進捗・記憶の関連度・行動の ROI をシグナルに、トークン予算を動的配分・強制する枠組み。
- 周辺: [Active Context Compression](https://arxiv.org/abs/2601.07190)(エージェント自身が記憶管理)、[Everything is Context: Agentic File System Abstraction](https://arxiv.org/pdf/2512.05470)(コンテキストをファイルシステムとして抽象化)、[Demand Paging for LLM Context Windows](https://arxiv.org/pdf/2603.09023)(OS 的ページング)

### cc-monitor への導入案

1. **マスキング節約シミュレーター**(優先度: 高 / オフラインで可)
   既存の `reclaimableTokens` を一歩進め、「閾値より古いツール出力を全部マスクした場合の各ターンの input 削減量」を transcript から再計算し、**セッション合計の節約見込み額**を Context Health カードに出す。Complexity Trap の「コスト半減」が外部根拠になる。
2. **「折りたたみ候補スパン」検出**(優先度: 中)
   Context-Folding の知見の観測版。「ツール呼び出しが連続する長い区間で、その後一切参照されていないもの」をヒューリスティックに検出し、「この区間はサブエージェント委譲(分岐→折りたたみ)できた」と提示。既存の subagent-ROI 指標と接続できる。
3. **要約 vs /clear の助言ロジック更新**(優先度: 高 / スキルのみ)
   `/cc-usage-advice` のルーブリックに「コンパクション(LLM 要約)はそれ自体が高コスト。Complexity Trap によれば古い出力の切り捨てで十分なことが多い → 早めの /clear・新セッション開始を推奨」を追加。

---

## テーマ 2: プロンプトキャッシュ経済(コスト効率)

### 主要論文

- **[Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks](https://arxiv.org/abs/2601.06007)** (2026)
  OpenAI / Anthropic / Google の 3 プロバイダ × 500+ セッションで実測。戦略的キャッシュ管理で**コスト 41–80% 削減、TTFT 13–31% 改善**。壊すパターンは ①無戦略な全文キャッシュ ②動的なツール結果のキャッシュ混入 ③キャッシュ済みプレフィックスへの動的 function 定義の混入。
- **[Token Economics for LLM Agents: A Dual-View Study](https://arxiv.org/html/2605.09104v1)** (2026)
  トークンを production / communication / **waste** / external に分解する会計モデル。エージェント作業は **input:output 比が 2:1〜150:1** に達し、SWE タスクではレビュー・検証が 59% を消費。**同一タスクでも消費が最大 30 倍ぶれる**ため、ステージ別分解と input/output 比のトラッキングを推奨。
- 周辺: [ContextPilot](https://arxiv.org/pdf/2511.03475)(コンテキスト再利用)、[Test-Time Plan Caching](https://arxiv.org/html/2506.14852v1)(計画のキャッシュ)、[TokenDance](https://arxiv.org/pdf/2604.03143)(マルチエージェント KV 共有)

### cc-monitor への導入案

1. **Cache Waste % とベンチマーク比較**(優先度: 高)
   今回実装した `cacheBusts[]`(原因別)を集計し、「理想的にキャッシュが効いた場合のコスト」を再計算して**乖離率**を出す。「研究実測では 41–80% 削減が標準的に可能」という基準線を Webview に併記し、自分のセッションがどこにいるかを示す。
2. **input:output 比の時系列**(優先度: 中)
   Token Economics の推奨指標。セッション/日単位で input:output 比を出し、極端な比率(>100:1 など)を「コンテキスト持ち回りすぎ」のシグナルにする。
3. **waste トークン勘定**(優先度: 中)
   既存メトリクスの再ラベリングで実現可能: キャッシュバスト浪費 + エラーになったツール呼び出しの入出力 + ループ検出区間 = `wasteTokens` として 1 つの数字に統合。「今日の waste は $X(全体の Y%)」は最も伝わる KPI。

---

## テーマ 3: コンテキスト劣化(context rot)の定量化

### 主要論文

- **[Classifier Context Rot: Monitor Performance Degrades with Context Length](https://arxiv.org/abs/2605.12366)** (2026)
  フロンティアモデル(Opus 4.6 / GPT 5.4 / Gemini 3.1)が、**800K トークンの無害な活動の後では危険行動を 2〜30 倍見逃す**ことを実証。緩和策として「transcript 中への定期的なリマインダー挿入」が有効。
- **[Lost in the Middle at Birth: An Exact Theory of Transformer Position Bias](https://arxiv.org/pdf/2603.10123)** (2026)
  中間位置の情報で精度が 30%+ 落ちる U 字劣化の理論的説明(RoPE の長距離減衰)。
- **[Context Discipline and Performance Correlation](https://arxiv.org/html/2601.11564v1)** (2026)
  コンテキスト長と品質劣化の相関を体系測定。

### cc-monitor への導入案

1. **劣化警告に定量根拠を付与**(優先度: 高 / 文言変更のみ)
   現状の `contextDegradation` シグナルや fillRatio 警告に「長コンテキストでの見逃しは実測 2〜30 倍(Classifier Context Rot)」の説明を付け、警告の説得力を上げる。
2. **「目的の再掲」リコメンド**(優先度: 高 / スキルのみ)
   論文の緩和策をそのまま助言に: 長尺セッションでは節目ごとにゴール・制約を再記述する(または CLAUDE.md に固定する)ことを `/cc-usage-advice` が提案する。
3. **重要情報の位置追跡**(優先度: 低 / 発展)
   「タスク定義(最初のユーザープロンプト)が現在コンテキストのどの深さに沈んでいるか」を推定し、中間帯(U 字の谷)に入ったら通知。Lost in the Middle の観測版。

---

## テーマ 4: エージェント可観測性(observability)の標準化

### 主要論文

- **[AgentTrace: A Structured Logging Framework for Agent System Observability](https://arxiv.org/pdf/2602.10133)** (2026)
  エージェント専用のイベントスキーマ(初期化 / ツール呼び出し / モデル呼び出し / 中間推論 / 最終出力、親子 span 関係)。OpenTelemetry と同じ設計思想で、**汎用 observability ではトークン使用量・モデル選択・推論トレースが捕捉できない**ことを指摘。
- **[AI Observability for LLM Systems: A Multi-Layer Analysis](https://arxiv.org/html/2604.26152v1)** (2026)
  信頼度キャリブレーションからインフラトレーシングまでの多層モニタリング整理。「分散トレーシング・トークン会計・自動 eval・人間フィードバック」が 2025 年時点のベースライン要件。
- 周辺: [LumiMAS](https://arxiv.org/pdf/2508.12412)(マルチエージェントのリアルタイム監視)、[View-oriented Conversation Compiler](https://arxiv.org/pdf/2603.29678)(トレースを目的別ビューにコンパイル)、[Auditable Agents](https://arxiv.org/pdf/2604.05485)

### cc-monitor への導入案

1. **OTel 互換エクスポート**(優先度: 中)
   insights を OpenTelemetry スパン形式(OTLP/JSON)でもエクスポートし、Grafana / Jaeger 等の既存基盤に流せるようにする。AgentTrace のフィールド設計(span 親子 = メインチェーン/サイドチェーン、属性 = model・tokens・cost)が雛形になる。チーム利用への布石。
2. **「ビュー」概念の採用**(優先度: 低)
   View-oriented Compiler の発想で、同じ transcript から「コストビュー」「エラービュー」「コンテキストビュー」を切り替えて表示する UI 整理。現行タブ構成の発展形。

---

## テーマ 5: 失敗分類・セッション診断

### 主要論文

- **[Why Do Multi-Agent LLM Systems Fail? (MAST)](https://arxiv.org/abs/2503.13657)** (2025, Berkeley ほか)
  1600+ の注釈付きトレースから **14 失敗モード × 3 カテゴリ(仕様問題 / エージェント間不整合 / タスク検証)** の taxonomy を構築。人手アノテーションと κ=0.88 で一致する **LLM-as-a-Judge パイプラインを公開**([GitHub](https://github.com/multi-agent-systems-failure-taxonomy/MAST))。
- **[TRAIL: Trace Reasoning and Agentic Issue Localization](https://arxiv.org/abs/2505.08638)** (2025)
  トレース中の問題箇所の特定タスク化。
- **[Willful Disobedience: Automatically Detecting Failures in Agentic Traces](https://arxiv.org/pdf/2603.23806)** (2026)
  指示逸脱の自動検出。

### cc-monitor への導入案

1. **/cc-session-review に MAST taxonomy を採用**(優先度: 高 / スキルのみ)
   セッションレビューの失敗判定を独自基準から MAST の 14 モードに置き換え(または対応付け)る。「仕様が曖昧だった」「検証不足」など、ユーザーが直せる軸で集計でき、レビュー間の比較可能性も生まれる。LLM-as-judge は会話内 LLM で実行できるためスキルの制約に適合。
2. **失敗モード別の統計**(優先度: 中)
   レビュー結果を `~/.claude/cc-monitor/reviews/` に蓄積し、「自分の失敗は仕様問題が多いのか検証不足が多いのか」の傾向を insights に反映する。

---

## テーマ 6: ループ・異常軌跡の検出

### 主要論文

- **[Unsupervised Cycle Detection in Agentic Applications](https://arxiv.org/pdf/2511.10650)** (2025)
  メッセージを埋め込みベクトル化し、過去のメッセージ対との意味的類似度でサイクルを教師なし検出。**オフラインのトレース解析として実装可能**(トレース抽出 → 埋め込み → 類似度行列 → 閾値超えをフラグ)。
- **[TrajAD: Trajectory Anomaly Detection for Trustworthy LLM Agents](https://arxiv.org/pdf/2602.06443)** (2026)
  「局所的には妥当だが大局的に無駄な行動」(無効パラメータ・無限ループ・冗長アクション)の実行時検出。
- **[Trajectory Guard](https://arxiv.org/pdf/2601.00516)** (2026)
  軽量な Siamese Recurrent Autoencoder で軌跡異常を実時間検出、F1 0.88–0.94。
- **[Agents of Chaos](https://arxiv.org/pdf/2602.20021)** (2026)
  ループの発生機序(難しい正解行動への忌避、自己強化的な注意の循環)の分析。

### cc-monitor への導入案

1. **意味的ループ検出への拡張**(優先度: 中 / 要ローカル埋め込み)
   現行のループ検出(同一ツール+類似引数の繰り返し)を、ローカル埋め込みモデル(transformers.js / ONNX の MiniLM 級)による意味類似に拡張。「微妙に違う引数で同じ失敗を繰り返す」パターンを捕捉できる。外部 API 不要でプライバシー制約も守れる。
2. **早期警告としての「行き詰まりスコア」**(優先度: 中)
   [EET: Experience-Driven Early Termination](https://arxiv.org/pdf/2601.05777)(2026)は軌跡の中間特徴から「このランは成功しそうにない」を予測して早期打ち切りし、成功率をほぼ保ったままコスト削減できることを示した。cc-monitor 版: エラー率の上昇傾向・ループスコア・「N ターン編集なし」などを合成した **stuck-session シグナル**をステータスバーに出す(打ち切り判断はユーザーに委ねる)。既存の quality-rot 指標の発展形。

---

## テーマ 7: トークン効率の評価指標

### 主要論文

- **[Efficient Agents: Building Effective Agents While Reducing Cost](https://arxiv.org/html/2508.02694v1)** (2025)
  **cost-of-pass(正解 1 つを得るための期待コスト)** を効率指標として採用。
- **[OckBench: Measuring the Efficiency of LLM Reasoning](https://arxiv.org/abs/2511.05722)** (2025)、**[CostBench](https://arxiv.org/pdf/2511.02734)** (2025)
  精度だけでなくトークン効率を一級指標として評価する流れ。
- Token Economics(テーマ 2 参照): ステージ別分解・30 倍の分散・O(N²) の通信税。

### cc-monitor への導入案

1. **cost-of-pass 風の「タスク単価」**(優先度: 中)
   セッションをタスク単位(/clear や明確な区切りで分割)に分け、「1 タスクあたりコスト」の分布を表示。30 倍の分散があるからこそ、平均でなく分布・外れ値を見せる意味がある。
2. **効率トレンド**(優先度: 低)
   週次で cost/session・cache hit 率・waste% の推移を出し、ユーザーの運用改善が数字に表れるようにする(advice レポートの効果測定にもなる)。

---

## テーマ 8: エージェントメモリ(セッション間の知識持ち越し)

### 主要論文

- **[Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers](https://arxiv.org/html/2603.07670v1)** (2026 サーベイ)
  2022〜2026 の記憶機構を体系化。
- **[Mem0](https://arxiv.org/pdf/2504.19413)** (2025): user/session/agent の 3 層管理。**[A-Mem](https://arxiv.org/pdf/2502.12110)** (2025): 原子的ノート+リンクで自己進化するメモリ。
- **[Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects](https://arxiv.org/pdf/2512.12818)** (2025)

### cc-monitor への導入案

1. **「再説明の検出」→ メモリ化提案**(優先度: 中)
   セッション横断で類似トピック・類似の長い説明プロンプトが繰り返されていることを検出し、「CLAUDE.md / auto-memory に固定すべき知識」として提案する。Claude Code には既にメモリ機構があるため、cc-monitor の役割は**メモリに昇格すべき内容の発見**。
2. **CLAUDE.md の ROI 測定**(優先度: 低)
   baselineTokens(常駐コスト)に対し、CLAUDE.md があることで節約されている再説明分を推定し、「常駐させる価値があるか」を示す。

---

## テーマ 9: 近接ツール研究(ポジショニング確認)

- **[Tokalator: A Context Engineering Toolkit for AI Coding Assistants](https://arxiv.org/pdf/2604.08290)** (2026)
  cc-monitor と最も近い学術発の VS Code 拡張。トークン数・コンテキスト残量・**ファイル別のコンテキスト消費内訳**・コスト見積もりを提供。「開発者は不要なコンテキストを入れすぎる」と結論。
  → cc-monitor が未着手の **「コンテキスト組成の内訳(システムプロンプト / CLAUDE.md / スキル注入 / ツール出力 / 貼り付け)」の円グラフ的表示**は、今回発見した isMeta スキル注入 104K のような事象を一目で見せられる差別化機能になる。`largestUserPromptTokens` の一般化として実装可能。

---

## 導入ロードマップ(推奨)

### フェーズ 1: オフラインヒューリスティックの追加(拡張本体・低コスト)

1. コンテキスト組成内訳(システム/CLAUDE.md/スキル注入/ツール出力/会話)— Tokalator 対抗、isMeta 実装の一般化
2. マスキング節約シミュレーション(Complexity Trap)
3. cache waste % + 研究ベンチマーク基準線(Don't Break the Cache)
4. waste トークン統合勘定 + input:output 比(Token Economics)
5. stuck-session シグナル(EET の観測版、quality-rot の発展)

### フェーズ 2: スキルの強化(LLM 使用可・実装コスト最小)

6. `/cc-session-review` に MAST taxonomy(14 モード)を採用
7. `/cc-usage-advice` に context-rot 定量根拠・periodic reminder 助言・「要約より /clear」助言を追加

### フェーズ 3: 発展(要追加技術)

8. ローカル埋め込みによる意味的ループ検出(Unsupervised Cycle Detection)
9. OTel 互換エクスポート(AgentTrace)
10. セッション横断の再説明検出 → メモリ化提案

---

## データの注記

- 検索実施日: 2026-06-10。arXiv ID が 2601〜2605 のものは 2026 年 1〜5 月公開の最新論文。
- 各論文の数値は abstract / 本文要約からの引用。導入判断の前に該当論文の本文精読を推奨(特に ACON の圧縮ガイドライン、Don't Break the Cache のプロバイダ別差異)。
- WebFetch の要約には小型モデルを使用しているため、細部の数値は原文と要照合。
