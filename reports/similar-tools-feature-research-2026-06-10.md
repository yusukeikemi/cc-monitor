# 類似ツール機能調査レポート — cc-monitor への示唆

調査日: 2026-06-10
調査方法: Web 検索 + 主要 OSS リポジトリ・公式ドキュメントの実査
目的: Claude Code 周辺の監視・分析ツールが備える有用機能を、
**①コンテキスト整理 ②タスクの成功 ③コスト削減 ④長期的な記憶管理 ⑤ロングランタスクの監視**
の5観点で棚卸しし、cc-monitor（オフライン優先・Anthropic 公式のみ通信）への導入候補を整理する。

---

## エグゼクティブサマリ

- エコシステムは「**事後分析**（ccusage / sniffly）」「**リアルタイム燃料計**（Claude-Code-Usage-Monitor）」「**プロキシ型全数記録**（ccflare）」「**テレメトリ基盤**（OpenTelemetry）」「**記憶レイヤー**（claude-mem / Mem0）」「**オーケストレーター**（claude-squad / Conductor / Vibe Kanban）」の6系統に分化している。
- cc-monitor は「ローカルログ解析 + 公式クォータ + Context Health」という組み合わせで既にユニークな位置にあり、特に **Context Health（rot シグナル10種・キャッシュバスト検出・トークン効率診断）は他ツールにほぼ存在しない差別化機能**。
- 一方で他ツールが持つ有力機能のうち cc-monitor に無いものは:
  **(a) バーンレート予測と枯渇時刻予測（ETA）**、**(b) タスク完了/要対応の通知（hooks 連携）**、
  **(c) エラーパターンの内容分析（どんな失敗が多いか）**、**(d) 予算アラート**、
  **(e) 複数セッション/エージェントの並列監視ビュー**、**(f) 長期記憶の健全性可視化（CLAUDE.md / auto memory のサイズ・鮮度）**。
- これらの大半は**ローカルログ + 既存のクォータ履歴だけで実装可能**であり、「通信ゼロ追加」の方針と矛盾しない（§5 提案参照）。

---

## 1. 調査対象ツールのカタログ

### 1.1 使用量・コスト監視系

| ツール | 形態 | 特徴 |
|--------|------|------|
| [ccusage](https://github.com/ryoppippi/ccusage) | CLI | 事実上の標準。日/週/月/セッション/**5時間ブロック**レポート、**statusline 統合(Beta)**、JSON 出力、`--since/--until` フィルタ、タイムゾーン設定、カスタム料金オーバーライド。**15以上のエージェント CLI**（Codex / Gemini CLI / Copilot CLI 等）に対応 |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | TUI 常駐 | **ML ベース P90 分析**で実際のトークン上限を推定（過去192時間の実績から個人化）。**バーンレート**（直近1時間の消費速度）と**枯渇時刻予測**、プラン自動判定（Pro→Max5→Max20）、多段階警告、1–60秒更新 |
| [ccflare](https://github.com/snipeship/ccflare) | プロキシ + Web UI | API 呼び出しを**全数記録**(ミリ秒精度のレイテンシ・成功率・エラートレース)。複数 OAuth アカウントの**ロードバランス/フェイルオーバー**、アカウント別レート制限・優先度 |
| [sniffly](https://github.com/chiphuyen/sniffly) | ローカル Web ダッシュボード | 使用統計に加え**エラー内容の分類分析**(最多は「Content Not Found」= 存在しないファイル/関数の参照で20–30%)。プロジェクト別インサイト、**共有可能なダッシュボード** |
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | statusline + hooks | hooks でセッション・ツール呼び出し・コストを **SQLite に記録**し、ASCII チャートのダッシュボードを提供 |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) ほか statusline 系 | Claude Code statusline | モデル/ブランチ/トークン/コストの表示、テーマ、**Sonnet と Opus の週次バケット別ウィジェット**（/usage のモデル分割に対応） |

### 1.2 コンテキスト管理系

| ツール | 形態 | 特徴 |
|--------|------|------|
| Claude Code 本体 [/context](https://code.claude.com/docs/en/context-window) | 内蔵 | カテゴリ別（Messages / System tools / MCP 等）のカラーグリッド表示と最適化サジェスト |
| [Claude Context Bar](https://marketplace.visualstudio.com/items?itemName=ezoosk.claude-context-bar) | VS Code 拡張 | JSONL からトークン算出しステータスバーに色分け警告表示。モデル自動検出でコンテキスト上限を調整（cc-monitor の Context Health と最も近い競合） |
| [Tokalator](https://github.com/vfaraji89/tokalator) | VS Code 拡張 | サイドバーで**コンテキスト予算**(LOW/MEDIUM/HIGH)表示。ファイル/システムプロンプト/会話/出力予約の内訳 |
| [Cline Auto Compact](https://docs.cline.bot/prompting/understanding-context-management) | VS Code 拡張内蔵 | 使用率 ~80% で**自動要約圧縮**（決定事項・コード変更を保存しつつ圧縮） |
| [Roo Code Intelligent Context Condensing](https://docs.roocode.com/features/intelligent-context-condensing) | VS Code 拡張内蔵 | **閾値スライダー**(例80%)で自動圧縮をトリガー。ContextWindowProgress バーで現使用量/出力予約/残量を可視化 |
| [context-mode (MCP)](https://www.mindstudio.ai/blog/prompt-caching-cut-token-costs-claude-dynamic-workflows) | MCP プラグイン | **ツール出力を会話に流さずサンドボックス KB へ索引化**し、要約のみ注入 + 必要時検索。MCP 由来トークンを 50–90% 削減 |
| [Anthropic Cookbook: compaction / tool clearing](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools) | 手法 | サーバーサイド自動圧縮、古いツール結果のクリア等のリファレンス実装 |

### 1.3 記憶管理系

| ツール | 形態 | 特徴 |
|--------|------|------|
| [claude-mem](https://github.com/thedotmack/claude-mem)（[docs](https://docs.claude-mem.ai/introduction)） | hooks + MCP | **5つのライフサイクルフック**(SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd)で観察を自動収集→ AI 圧縮要約→ **SQLite + FTS5 + Chroma ベクトル検索**に保存、次セッションへ自動注入。3層検索ツール(search/timeline/get_observations)で取得トークンを約 1/10 に。全データローカル（~/.claude-mem/）。46K スター超 |
| [Mem0](https://mem0.ai/blog/claude-code-memory) | MCP | 汎用メモリレイヤー。Claude Code へ5分で永続記憶を追加 |
| Claude Code 内蔵 [memory](https://code.claude.com/docs/en/memory) | 内蔵 | **CLAUDE.md**(ユーザー記述の永続指示)+ **auto memory**(Claude が自分で書く修正・好みのメモ、既定オン) |
| [Memory tool (API)](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | 公式 API | ファイルベースのメモリディレクトリをモデル自身が CRUD する公式ツール |

### 1.4 ロングランタスク監視・通知系

| ツール | 形態 | 特徴 |
|--------|------|------|
| [Claude Code OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability) | 内蔵 | `claude_code.token.usage` / `cost.usage` 等の**メトリクス**、`api_request` / `tool_result` 等の**イベント**、リクエスト/ツール実行の**スパン**を OTLP エクスポート。[SigNoz](https://signoz.io/docs/claude-code-monitoring/) / Datadog / Grafana でダッシュボード・アラート構築可。[claude-code-otel](https://github.com/ColeMurray/claude-code-otel) は構築済みスタック |
| [claude_telemetry](https://github.com/TechNickAI/claude_telemetry) | ラッパー CLI | `claude` を `claudia` に置換するだけでツール呼び出し・トークン・コスト・トレースを Logfire/Sentry/Honeycomb/Datadog へ |
| 公式 [Remote Control](https://code.claude.com/docs/en/remote-control) | 内蔵 | ローカルセッションをスマホ/ブラウザから継続。**長時間タスク完了時・要判断時にプッシュ通知** |
| [Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) | hooks | **メール / Discord / Telegram に完了通知**、返信で次のコマンド投入 |
| [Happy](https://nimbalyst.com/blog/best-mobile-apps-for-claude-code-2026/) / [Tactic Remote](https://www.clauderc.com/) | モバイルアプリ | セッション監視・プッシュ通知・プロンプト承認をスマホから |
| [claude-squad](https://github.com/smtg-ai/claude-squad) / [ccmanager](https://github.com/kbwo/ccmanager) | TUI | 複数エージェントを別ワークスペース(git worktree)で並列管理 |
| [Conductor](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/) / [Crystal→Nimbalyst](https://github.com/stravu/crystal) | デスクトップ | 並列エージェントのダッシュボード・diff レビュー・マージ管理 |
| [Vibe Kanban](https://vibekanban.com/) | Web | エージェントタスクの**かんばん管理**(To Do/In Progress/Done)、UI 内コードレビュー(現在はコミュニティ管理へ移行) |
| 公式 [Agent Teams](https://code.claude.com/docs/en/agent-teams) | 内蔵(実験的) | リードセッションが複数 Claude Code を調整・タスク割当・結果統合 |

---

## 2. テーマ別: 有用機能の分析

### 2.1 コンテキスト整理

他ツールで確立されたパターン:

1. **充填率の常時可視化と色分け警告**(Claude Context Bar / Roo の ContextWindowProgress / Copilot Chat の fill indicator)— cc-monitor は実装済み。さらに「出力予約(output reserve)を差し引いた実効残量」を出す Tokalator / Roo の方式は未実装で有用。
2. **閾値ベースの自動圧縮**（Cline 80% Auto Compact、Roo の閾値スライダー）— cc-monitor は監視ツールなので圧縮自体は範囲外だが、「**何%で /compact すべきか**」のガイダンス表示は対応可能。コミュニティのベストプラクティスは「[~50% での先回り /compact](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management)」で、85% 警告だけでは遅いという知見が定着しつつある。
3. **タイムライン型の可視化**: [Developers Digest の Context Window Visualization](https://www.developersdigest.tech/guides/context-window-visualization) は「各ターン・ツール呼び出し・ファイル読込をトークン量に比例したブロックで時系列表示し、**どこで compaction が発生し何が落ちたか**を見せる」。cc-monitor のトピックタイムラインの発展形として参考になる。
4. **ツール出力のオフロード**（context-mode MCP）: 巨大なツール結果を会話に入れず索引化する手法。cc-monitor の `reclaimableTokens`(8K 超過分)検出はこの問題の検知側であり、レコメンドとして context-mode 的な解決策を提示できる。

### 2.2 タスクの成功（品質・成果の計測）

このカテゴリは意外に手薄で、参考になるのは:

1. **sniffly のエラー内容分類**: エラー率だけでなく「**どんな種類の失敗か**」を分類(Content Not Found / 構文エラー / 権限拒否など)し、最頻パターンを提示。「存在しないファイルを探す」が 20–30% という知見はプロンプト改善に直結する。cc-monitor はツール別エラー率までは持つが**エラーの中身分類は未実装**。
2. **公式 OTel のイベント**: `tool_result` の成否・所要時間・`api_request` 単位の成功率を時系列で取れるため、「セッションの成功率トレンド」をダッシュボード化できる。
3. **cc-monitor 既存の独自指標**: ユーザー手直し率(user-modified rate)・PR 数・stop_reason 分布は、調査した範囲で**他ツールに存在しない先行機能**。これに「タスク単位の成否」(例: 1プロンプト→N ツール→エラーで終了 or end_turn で完了)のファネル分析を足すと差別化が深まる。
4. **Vibe Kanban / Conductor 系のレビューワークフロー**: タスクの成功を「人間のレビュー通過」で定義し、diff レビュー・マージ管理まで UI で繋ぐ。監視ツールの範囲外だが、「成功」の定義として参考になる。

### 2.3 コスト削減

確立されたプラクティスとツール側の支援機能（[公式 costs ガイド](https://code.claude.com/docs/en/costs)、[systemprompt.io](https://systemprompt.io/guides/claude-code-cost-optimisation)、[SitePoint](https://www.sitepoint.com/claude-api-token-optimization/) 等）:

| 手法 | 効果の目安 | ツール側の支援機能 |
|------|-----------|------------------|
| プロンプトキャッシング維持 | 入力の繰り返し分が約 1/10 | cc-monitor の**キャッシュ余熱カウントダウン + キャッシュバスト検出は既に最先端**(他ツールに同等機能なし) |
| モデルルーティング(安いモデルへ振り分け) | 残リクエストの~60%を下位ティアへ | ccusage / statusline 系は**モデル別・週次バケット別の消費表示**で意思決定を支援 |
| `/clear` の規律(タスク切替時にリセット) | 古いコンテキストの再送を排除 | cc-monitor の multiTopic シグナルが対応。「切替候補時刻」表示も既存 |
| ツール出力の抑制・オフロード | MCP 由来 50–90% 削減 | context-mode。cc-monitor は reclaimable 検出で問題提起側 |
| 出力の簡潔化 | 重いワークフローで出力削減 | [claude-token-efficient](https://github.com/drona23/claude-token-efficient)(CLAUDE.md 1枚で応答を簡潔化) |
| **予算管理・アラート** | 超過防止 | OTel + Grafana/SigNoz のアラート、Claude-Code-Usage-Monitor の多段階警告。**cc-monitor 未実装**（日次/月次予算の設定と到達警告） |

### 2.4 長期的な記憶管理

- **claude-mem が事実上の標準**(46K スター): hooks による自動収集 → AI 圧縮 → ローカル DB → 次セッション注入、という「無操作で貯まる記憶」パターン。検索を3層に分けて**記憶の取得自体のトークンコストを 1/10** にする設計が特徴的。
- 公式側も **auto memory が既定オン**になり、CLAUDE.md と合わせて二層構造が標準化した。
- **監視ツールにとっての示唆**: 記憶を「作る」のは他ツールに任せ、cc-monitor は**記憶の健全性を監視**できる立場にある。具体的には:
  - CLAUDE.md / auto memory / ルール類のサイズ → 既に `baselineTokens`（起動ベースライン）として総量検出済み。**内訳**（CLAUDE.md 何トークン、ツールスキーマ何トークン）まで分解すると実用度が上がる。
  - 記憶ファイルの肥大化・陳腐化（最終更新からの経過、セッション数に対する参照率）の検出は未開拓領域。

### 2.5 ロングランタスクの監視

- **通知が最重要機能**: 公式 Remote Control・Happy・Tactic Remote・Claude-Code-Remote が解決しているのは共通して「**完了 / 要承認 / エラーで止まった**を人間に即時に伝える」こと。cc-monitor はトースト通知(rot 時)を持つが、「**タスク完了 / 長時間停滞**」の通知は未実装。ローカルログの追記停止検出（例: アクティブセッションが N 分間更新なし = 完了 or 停滞）で**通信ゼロのまま実装可能**。
- **エンタープライズ向けは OTel が標準**: 長時間自律実行の監視は「メトリクス(トークン/コスト) + イベント(ツール結果) + アラート」の三点セットに収斂。個人向けローカルツールがこれを簡易再現する余地がある（cc-monitor の Activity タブは既にイベント集計の一部を実装）。
- **並列エージェント時代への対応**: claude-squad / Conductor / Agent Teams の普及で「同時に複数セッションが走る」のが常態化。cc-monitor の Context Health は「最新の1セッション」前提のため、**並走中の全アクティブセッションを一覧表示するビュー**（各セッションの充填率・最終更新・ステータス）が次の自然な拡張。
- **バーンレートと枯渇予測**: Claude-Code-Usage-Monitor の中核価値。「今のペースだとあと X 分で 5h クォータが尽きる」。cc-monitor は**クォータ履歴 JSONL を既に持っている**ため、直近の増加率から枯渇 ETA を出すのは小さな追加で済む(コンテキスト成長 ETA は実装済みで、同じパターンをクォータへ適用するだけ)。

---

## 3. ギャップ分析: cc-monitor が既に持つもの / 持たないもの

### 既に競合優位にある機能（他ツールにほぼ無い）

- Context Health の **rot シグナル10種**(キャッシュバスト・全文Read・コンテキスト別エラー率・反復呼び出し等)
- **キャッシュ余熱カウントダウン**(5分 TTL の可視化)と**キャッシュバストの無駄 USD 換算**
- **ユーザー手直し率**・PR 数・パーミッションモード分布などの Activity 指標
- 公式 OAuth クォータの**履歴記録と時間帯別消費ヒートマップ**
- サブエージェントの実コスト(toolUseResult 由来)集計

### 他ツールにあって cc-monitor に無い主要機能

| # | 機能 | 出典ツール | 通信ゼロで実装可? |
|---|------|-----------|------------------|
| G1 | クォータ**バーンレート + 枯渇 ETA**(「あと X 分で 5h 上限」) | Claude-Code-Usage-Monitor | ✅ 既存のクォータ履歴から算出 |
| G2 | **タスク完了 / 停滞 / 要対応の通知**(OS 通知) | Remote Control / Claude-Code-Remote / Happy | ✅ ログ追記の停止・停止理由の検出で可 |
| G3 | **エラー内容の分類**(Content Not Found 等のパターン別集計) | sniffly | ✅ tool_result の is_error テキストを分類 |
| G4 | **予算アラート**(日次/月次 $ 上限の設定と警告) | OTel + Grafana / 各種 monitor | ✅ 設定 + 既存集計の比較のみ |
| G5 | **並列セッションの一覧監視**（全アクティブセッションの充填率・状態） | claude-squad / Conductor / ccmanager | ✅ 複数 .jsonl の並行解析(既存ロジック流用) |
| G6 | 5時間**課金ブロック単位のレポート**(ブロック開始/残り時間と紐づく消費) | ccusage blocks | ✅ ローカル集計のみ(要件 F-14 とも一致) |
| G7 | **ベースライン内訳**(CLAUDE.md / ツールスキーマ / メモリの各トークン)と記憶の肥大化検出 | (未開拓領域) | ✅ 初回リクエストとローカルファイルの解析 |
| G8 | 出力予約を考慮した**実効コンテキスト残量**表示 | Roo Code / Tokalator | ✅ 表示ロジックのみ |
| G9 | **statusline 連携**(VS Code 外の Claude Code statusline への出力) | ccusage statusline / ccstatusline | ✅ ローカルプロセスのみ |
| G10 | 他エージェント CLI(Codex / Gemini CLI 等)のログ対応 | ccusage | ✅ パーサ追加のみ(ただしスコープ拡大) |
| G11 | 週次クォータの**モデル別バケット表示**(Sonnet/Opus 分割) | ccstatusline | △ API レスポンスの `seven_day_opus` は取得済み・`seven_day_sonnet` のパース追加 |
| G12 | P90 ベースの個人化上限推定 | Claude-Code-Usage-Monitor | ✅ ローカル履歴から統計算出 |

### 方針と相反するため見送るべきもの

- ccflare 型のプロキシ化・マルチアカウント切替(中間者化はセキュリティ方針に反する)
- 外部 SaaS への OTel エクスポート常時送信(オプトインの域を超える)
- claude-mem 型の AI 圧縮(LLM 呼び出しが発生し「オフライン算出」原則に反する)

---

## 4. cc-monitor への導入提案（優先度順）

### 優先度 高 — 小さい実装で大きい価値、方針と完全整合

1. **クォータ枯渇 ETA（G1）**: クォータ履歴の直近増分から「現在のペースで 5h / 週次が 100% に達する予測時刻」をステータスバーとQuotaタブに表示。コンテキスト成長 ETA(実装済み)と同一パターン。
2. **タスク完了 / 停滞通知（G2）**: アクティブセッションの「ログ追記が止まった」(完了 or 入力待ち)、「最後のターンが permission 待ちらしい」を検出して VS Code 通知。ロングラン監視ニーズの最小実装。
3. **5時間ブロックビュー（G6）**: 要件定義書 F-14 に既に記載があり未実装。ccusage blocks 相当を Today タブに追加。
4. **週次クォータのモデル別表示（G11）**: `seven_day_sonnet` のパース追加 + Quota タブ/ツールチップへ1行追加。

### 優先度 中 — 差別化を深める

5. **エラー内容分類（G3）**: sniffly の知見(Content Not Found が最多)に倣い、is_error の tool_result 本文をパターン分類して Activity タブに「エラー内訳」を追加。プロンプト改善への示唆として表示。
6. **予算アラート（G4）**: `dailyBudgetUSD` / `monthlyBudgetUSD` 設定 + 到達時のステータスバー色変化・通知。
7. **並列セッション監視ビュー（G5）**: 「直近 N 分にレコードがある全セッション」の充填率・ステータス・最終更新を一覧するタブ or Sessions タブ拡張。マルチエージェント運用の標準化に先回り。
8. **ベースライン内訳と記憶健全性（G7）**: baselineTokens を CLAUDE.md 実ファイルサイズ等と突き合わせて内訳推定し、「CLAUDE.md が肥大化しています」級のレコメンドを Context Health に追加。長期記憶管理テーマへの cc-monitor らしい回答。

### 優先度 低 — 価値はあるがスコープ判断が必要

9. **実効残量表示（G8）** と **50% での先回り /compact 推奨**(watch 閾値の見直し)。
10. **statusline 出力(G9)**: VS Code 外の Claude Code 本体 statusline へ同じ指標を出すローカルコマンド。
11. **P90 個人化上限(G12)** / **他エージェント CLI 対応(G10)**: 後者はリポジトリのスコープ(Claude Code 特化)を変える判断が必要。

---

## 5. 主要ソース

### 使用量・コスト監視
- [ccusage (GitHub)](https://github.com/ryoppippi/ccusage) / [ccusage.com](https://ccusage.com/)
- [Claude-Code-Usage-Monitor (GitHub)](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
- [ccflare (GitHub)](https://github.com/snipeship/ccflare) / [ccflare.com](https://ccflare.com/)
- [sniffly (GitHub)](https://github.com/chiphuyen/sniffly)
- [claude-code-analytics (GitHub)](https://github.com/spences10/claude-code-analytics)
- [ccstatusline (GitHub)](https://github.com/sirmalloc/ccstatusline)
- [Claude Code Usage Monitor 比較記事 (claudefa.st)](https://claudefa.st/blog/tools/monitors/claude-code-usage-monitor)
- [オープンソース監視ツールまとめ (apidog)](https://apidog.com/blog/open-source-tools-to-monitor-claude-code-usages/)
- [公式: Claude Code usage analytics](https://support.claude.com/en/articles/12157520-claude-code-usage-analytics)

### コンテキスト管理
- [公式: Explore the context window](https://code.claude.com/docs/en/context-window)
- [公式 Cookbook: Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)
- [公式 Cookbook: Context engineering tools](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
- [Claude Context Bar (Marketplace)](https://marketplace.visualstudio.com/items?itemName=ezoosk.claude-context-bar)
- [Tokalator (GitHub)](https://github.com/vfaraji89/tokalator)
- [Cline: Context Management](https://docs.cline.bot/prompting/understanding-context-management)
- [Roo Code: Intelligent Context Condensing](https://docs.roocode.com/features/intelligent-context-condensing)
- [/compact ベストプラクティス (MindStudio)](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management)
- [Context Window Visualization (Developers Digest)](https://www.developersdigest.tech/guides/context-window-visualization)

### 記憶管理
- [claude-mem (GitHub)](https://github.com/thedotmack/claude-mem) / [docs.claude-mem.ai](https://docs.claude-mem.ai/introduction)
- [claude-mem 解説 (Augment Code)](https://www.augmentcode.com/learn/claude-mem-46k-stars-persistent-memory-claude-code)
- [Mem0 for Claude Code](https://mem0.ai/blog/claude-code-memory)
- [公式: How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [公式: Memory tool (API)](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

### ロングラン監視・通知・オーケストレーション
- [公式: Observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability)
- [SigNoz: Claude Code Monitoring](https://signoz.io/docs/claude-code-monitoring/)
- [claude-code-otel (GitHub)](https://github.com/ColeMurray/claude-code-otel)
- [claude_telemetry (GitHub)](https://github.com/TechNickAI/claude_telemetry)
- [公式: Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude-Code-Remote (GitHub)](https://github.com/JessyTsui/Claude-Code-Remote)
- [Tactic Remote](https://www.clauderc.com/) / [モバイルアプリ比較 (Nimbalyst)](https://nimbalyst.com/blog/best-mobile-apps-for-claude-code-2026/)
- [claude-squad (GitHub)](https://github.com/smtg-ai/claude-squad) / [ccmanager (GitHub)](https://github.com/kbwo/ccmanager)
- [Crystal→Nimbalyst (GitHub)](https://github.com/stravu/crystal) / [Conductor 解説 (madewithlove)](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)
- [Vibe Kanban](https://vibekanban.com/) / [公式: Agent Teams](https://code.claude.com/docs/en/agent-teams)

### コスト削減
- [公式: Manage costs effectively](https://code.claude.com/docs/en/costs)
- [公式: Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [コスト最適化4習慣 (systemprompt.io)](https://systemprompt.io/guides/claude-code-cost-optimisation)
- [Claude API Token Optimization (SitePoint)](https://www.sitepoint.com/claude-api-token-optimization/)
- [Prompt Caching 活用 (MindStudio)](https://www.mindstudio.ai/blog/prompt-caching-cut-token-costs-claude-dynamic-workflows)
- [claude-token-efficient (GitHub)](https://github.com/drona23/claude-token-efficient)
