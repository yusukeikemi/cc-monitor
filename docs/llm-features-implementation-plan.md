# LLM 分析機能 実装計画 — Claude Code 自身をエンジンとして

作成日: 2026-06-10
ステータス: **実装中（スコープ改訂 v2）**
前提レポート: [`reports/similar-tools-feature-research-2026-06-10.md`](../reports/similar-tools-feature-research-2026-06-10.md)

> **スコープ改訂（2026-06-10 決定）: サブスク対話枠内で実行できる機能に限定する。**
> 採用するのは実行形態 **A（スキル / スラッシュコマンド）のみ** — ユーザーが自分の
> Claude Code セッション内で起動するため、通常のサブスク利用の範囲で完結する。
> 形態 **B（フック + ヘッドレス）/ C（拡張からの `claude -p` spawn）は当面見送り**:
> 2026-06-15 以降、ヘッドレス実行はサブスクの対話枠と別の「Agent SDK クレジット」を
> 消費するため、クレジットの残量取得・消費感覚が確立するまで保留する。
> これに伴い Phase 3 の H-1（自動ジャーナル）と Phase 4 全体（C-1〜C-3）は**凍結**。
> S-6（週次レポート）は手動スキルとして存続。H-2（OS 通知）は LLM を使わないため
> 本計画とは独立の別トラックとする。

---

## 0. 方針転換の整理

### これまで

「通信は Anthropic 公式のみ」のセキュリティ制約により、vendoring 時に **LLM を使う機能
（AI アドバイス）を削除**し、すべての分析をオフラインヒューリスティックで実装してきた。

### 今回の再解釈

制約の本質は「**第三者サーバへデータを出さない**」であって「LLM を使わない」ではない。
**Claude Code 自身**（ユーザーの既存認証・既存の課金枠、通信先は Anthropic のみ）に
分析タスクを実行させるなら、セキュリティ境界は一切変わらない:

| 観点 | 従来の外部 API 方式（削除済み） | Claude Code 委譲方式（本計画） |
|------|------------------------------|------------------------------|
| 通信先 | DeepSeek 等の第三者 | **Anthropic のみ（不変）** |
| 認証情報 | 別途 API キーが必要 | ユーザーの既存サインインを Claude Code が管理 |
| 送信データ | プロンプト見本を第三者へ | 会話ログ由来データを Anthropic へ（**元々 Anthropic に送信済みのデータ**） |
| 課金 | 別途従量課金 | 既存プラン枠内（§5 コストガード参照） |

> 注意: 会話ログにはユーザーのプロンプト・コード断片が含まれるが、これらは元の会話で
> 既に Anthropic に送信されたものであり、**新たな開示先は発生しない**。この点を README
> の方針セクションに明文化する（Phase 0）。

### 実行形態は3つ

| 形態 | 起動主体 | 用途 |
|------|---------|------|
| **A. スキル / スラッシュコマンド** | ユーザーが Claude Code 内で `/cc-…` を実行 | オンデマンドの深掘り分析（既定の主力） |
| **B. フック + ヘッドレス** | SessionEnd 等のライフサイクルイベント → `claude -p` | 自動ダイジェスト等（オプトイン） |
| **C. 拡張 → ヘッドレス** | webview のボタン → 拡張が `claude -p` を spawn | ダッシュボード内での「この状態を分析」（オプトイン） |

**設計原則: 「事実の抽出は決定的コード、解釈・要約・命名だけ LLM」。**
生 JSONL を丸ごと LLM に食わせない。既存の dataLoader 相当の抽出ロジック（または
スキル同梱の zero-dep スクリプト）で**縮約された事実 JSON** を作り、LLM には判断だけさせる。
これによりコスト・精度・再現性をすべて確保する。

### ヘッドレス実行の技術前提（2026-06 時点で確認済み）

- `claude -p "<prompt>" --output-format json` は応答に **`total_cost_usd` とモデル別内訳**を
  含むため、呼び出しごとの実コストを記録できる。
- `--model haiku|sonnet` でタスク別にモデルを使い分け可能。`--max-turns` で暴走防止。
- **2026-06-15 以降、サブスクプランの `claude -p` / Agent SDK 利用は対話枠と別の
  「Agent SDK クレジット」から消費**される。ヘッドレス呼び出しが対話の 5h/週次クォータを
  食わない方向の変更であり本計画に追い風だが、クレジット残量の監視が新たに必要
  （§5 参照。将来 `/api/oauth/usage` 相当での取得可否を要調査）。

---

## 1. ギャップ分析の見直し（LLM 委譲レンズ）

前回レポート §3 の判定を更新する。**太字 = 今回の方針転換で判定が変わった項目**。

### 1.1 「見送り」から「実装可能」に変わるもの

| 旧判定 | 機能 | 新判定と実現方法 |
|--------|------|----------------|
| ❌ 見送り | **AI 使用量アドバイス**（vendoring 時に削除） | ✅ **スキルとして復活**（Phase 1, S-1）。データは Anthropic にしか行かない |
| ❌ 見送り | **claude-mem 型の AI 圧縮記憶** | ✅ **SessionEnd フック + `claude -p --model haiku`** で軽量版を実装可（Phase 3, H-1）。フル claude-mem は導入推奨に留める |
| ❌ 見送り | ccflare 型プロキシ / OTel SaaS 常時送信 | ❌ 引き続き見送り（第三者 or 中間者化のため。判定不変） |

### 1.2 ヒューリスティック実装予定だったものが LLM で質的に向上するもの

| 旧 Gap | 機能 | LLM 化による向上 |
|--------|------|----------------|
| G3 | エラー内容分類 | 文字列パターン分類 → **意味分類**（「存在しないファイルの参照」「権限拒否」「ユーザーの方針転換による中断」を区別）+ 処方箋の生成（Phase 1, S-3） |
| G7 | 記憶の健全性 | サイズ検出のみ → **CLAUDE.md / auto memory の陳腐化・矛盾・重複の検出と修正 diff 提案**（Phase 2, S-5） |
| — | トピックラベル | 現在「プロンプト先頭60文字」 → LLM による命名（Phase 4, C-2） |
| — | rot シグナルの説明 | 定型文サジェスト → セッション固有の**根本原因説明と具体的アクション**（Phase 4, C-1） |

### 1.3 LLM 不要のまま価値が高い項目（前回計画を維持）

G1 クォータ枯渇 ETA / G2 完了・停滞通知 / G4 予算アラート / G5 並列セッション監視 /
G6 5時間ブロックビュー / G11 モデル別週次クォータ — これらは**決定的コードで実装すべき**
であり LLM を使う理由がない。本計画とは独立に進められる（Phase 3 の通知フックのみ
本計画のフック基盤と相乗り）。

### 1.4 新たに可能になる機能（前回レポートに無かったもの）

| ID | 機能 | テーマ対応 |
|----|------|-----------|
| N-1 | **セッション・レトロスペクティブ**（成功/部分/放棄の判定 + 改善提案） | タスクの成功 |
| N-2 | **ハンドオフ生成**（/clear 前にタスク状態を蒸留した引き継ぎ文書） | コンテキスト整理 |
| N-3 | **週次ダイジェスト**（使用傾向・習慣・エラーパターンの変化を文章化） | コスト削減・習慣改善 |
| N-4 | **記憶キュレーション**（CLAUDE.md・auto memory の診断と整理案） | 長期記憶管理 |
| N-5 | **セッション自動ジャーナル**（終了時に1行要約を蓄積） | 長期記憶管理・ロングラン監視 |

---

## 2. アーキテクチャ

```
┌─ VS Code 拡張 (packages/vscode) ──────────────────────────┐
│ dataLoader → 集計/Context Health（既存・決定的）            │
│ insightsExporter（新規）                                    │
│   └→ ~/.claude/cc-monitor/insights/latest.json  ←──┐       │
│ quotaHistory → ~/.claude/cc-monitor/quota-history.jsonl ←┐ │
│ [Phase 4] webview ボタン → claude -p (spawn) → 結果表示  │ │
└──────────────────────────────────────────────────────────┘ │
                                                          読取│
┌─ Claude Code プラグイン (packages/claude-plugin、新規) ────┤
│ skills/  … /cc-usage-advice /cc-session-review            │
│            /cc-error-patterns /cc-handoff /cc-memory-doctor│
│            /cc-weekly-report                               │
│ scripts/ … extract-session.mjs ほか（zero-dep Node、       │
│            生JSONL→縮約事実JSON の決定的変換）              │
│ hooks/   … SessionEnd ジャーナル(オプトイン)、              │
│            Stop/Notification → OS通知(LLM不要)             │
└────────────────────────────────────────────────────────────┘
```

### 2.1 データインターフェース（insights snapshot）

拡張は全量リフレッシュのたびに、計算済みの集計を機械可読 JSON として書き出す:

- パス: `~/.claude/cc-monitor/insights/latest.json`（アトミック書き込み・スキーマバージョン付き）
- 内容: today/month/allTime 集計、Activity 分析、Context Health、セッション上位、
  プロジェクト別上位、最新クォータ
- 目的: スキルが**拡張の計算結果を再利用**でき、二重実装と LLM への生データ投入を防ぐ
- 拡張が動いていない環境（CLI のみ等）では、スキル同梱スクリプトが JSONL から
  必要最小限を直接抽出するフォールバックを持つ

### 2.2 配布形態

- リポジトリ内 `.claude/skills/` で**まず dogfood**（このリポジトリで作業する Claude Code が即利用可能）
- 安定後、**Claude Code プラグイン**（skills + hooks + commands のバンドル）として
  `packages/claude-plugin/` に整理し、marketplace 経由または手動インストールで配布
- VS Code 拡張とプラグインは**疎結合**: どちらか片方だけでも動作する（snapshot が無ければ
  スクリプトでフォールバック）

---

## 3. 機能仕様（Phase 別）

### Phase 0: 基盤（拡張 + リポジトリ整備）

| ID | 内容 | 主な変更 |
|----|------|---------|
| P0-1 | **insightsExporter**: リフレッシュ時に `insights/latest.json` を書き出し | `src/insightsExporter.ts` 新規、`extension.ts` から呼出、設定 `exportInsights`(既定 true・ローカル書き込みのみ) |
| P0-2 | **extract-session.mjs**: sessionId（または latest）を受け、JSONL から縮約事実 JSON を出力。エラー本文・反復呼び出し・大型ツール結果・タイムライン・usage 集計を含む。**zero-dep / Node 単体** | `packages/claude-plugin/scripts/` 新規 |
| P0-3 | README の方針セクション更新（「LLM 分析は Claude Code 自身に委譲。通信先は Anthropic のみで不変」） | `README.md` |
| P0-4 | `.claude/skills/` の雛形とスキル共通ガイド（出力先規約 `reports/`、コストガード手順） | リポジトリ直下 |

### Phase 1: オンデマンド分析スキル（読み取り専用・ユーザー起動）

| ID | スキル | 入力 | LLM への指示（要旨） | 出力 |
|----|--------|------|---------------------|------|
| S-1 | `/cc-usage-advice` | insights/latest.json + quota-history 末尾 | 使用パターンから最適化アドバイス（モデル選択・キャッシュ・/clear 習慣・サブエージェント活用）を UI 言語で生成 | Markdown レポート（`reports/usage-advice-<日付>.md`） |
| S-2 | `/cc-session-review [sessionId\|latest]` | extract-session.mjs の縮約 JSON | ①タスクの**成否判定**（completed / partial / abandoned + 根拠）②無駄トークンの内訳と原因 ③ループ・迷走の narrative ④次回への改善提案3点 | Markdown レビュー |
| S-3 | `/cc-error-patterns [days=30]` | スクリプトで is_error 本文を正規化・頻度集計した上位パターン | パターンの**意味分類と命名**、最頻パターンへの処方箋（CLAUDE.md への追記案を含む） | Markdown + 任意で CLAUDE.md 追記の提案 diff |

実装ポイント:
- スキルは「スクリプト実行 → 縮約 JSON を読み込み → 判断・執筆」の手順を SKILL.md に明記
- S-2 の成否判定はテーマ「タスクの成功」への直接回答。判定基準（最終ターンの
  stop_reason、エラー率の推移、ユーザーの最終発話のトーン、PR/commit の有無）を
  スキル内にルーブリックとして固定し、再現性を持たせる

### Phase 2: コンテキスト整理・記憶管理スキル

| ID | スキル | 内容 |
|----|--------|------|
| S-4 | `/cc-handoff` | アクティブセッションの縮約 JSON から**引き継ぎ文書**（目的 / 現在地 / 決定事項 / 未解決 / 関連ファイル地図）を生成し `.claude/handoff-<ts>.md` に保存 → 「/clear して続きはこのファイルを読んで再開」を案内。**先回り /compact 問題（50%推奨）への cc-monitor 的回答** |
| S-5 | `/cc-memory-doctor` | CLAUDE.md（プロジェクト/ユーザー）・auto memory・rules 類をスクリプトでトークン計測 → LLM が陳腐化・矛盾・重複・肥大化を診断し、**修正 diff を提案（自動適用しない）**。拡張の `largeBaseline` シグナルと連動（§Phase 4） |
| P2-1 | （拡張側）ベースライン内訳: 初回リクエストの create と、CLAUDE.md 等ローカルファイルの実測トークンを突き合わせて Context Health に内訳表示。`largeBaseline` 検出時のレコメンド文言を「/cc-memory-doctor を実行」へ変更 | 

### Phase 3: 自動化（フック + 定期実行、すべてオプトイン）

| ID | 内容 |
|----|------|
| H-1 | **セッションジャーナル**: SessionEnd フックで `claude -p --model haiku --max-turns 1` により1〜3行のセッション要約を生成し `~/.claude/cc-monitor/journal.jsonl` へ追記。拡張の Activity タブ「Recent topics」を ai-title からジャーナルベースに強化。**claude-mem の軽量代替**（検索・注入はしない。履歴の人間可読化に特化） |
| H-2 | **完了・要対応通知**（LLM 不要、G2）: Stop / Notification フックで OS 通知。プラグインにスクリプト同梱。ロングラン監視の最小実装 |
| S-6 | `/cc-weekly-report`: insights + journal + quota-history の7日分から週次ダイジェスト（コスト推移・クォータ逼迫時間帯・エラーパターンの変化・習慣提案）を生成し `reports/weekly/` へ保存。Claude Code の schedule 機能での定期実行手順をドキュメント化 |

### Phase 4: 拡張 ⇔ ヘッドレス統合（ダッシュボード内 LLM）

| ID | 内容 |
|----|------|
| C-1 | Context Health タブに **「Explain（この状態を分析）」ボタン**: 拡張が health JSON を `claude -p --model sonnet --output-format json` に渡し、根本原因の説明と具体アクションを webview に表示。応答の `total_cost_usd` を表示・記録 |
| C-2 | トピックタイムラインの **LLM ラベリング**ボタン（haiku、結果はセッション単位でキャッシュ） |
| C-3 | Activity タブのエラー内訳に **「分類を更新」**ボタン（S-3 と同じ縮約データを拡張から直接実行） |

実装ポイント:
- 新設定 `claudeCodeUsage.enableLlmAnalysis`（**既定 false**）。off の間はボタン自体を非表示
- `claude` CLI の存在検出（`claude --version`）。無ければ機能を隠す
- すべての spawn は出力チャネルへコマンド・所要時間・コストをログ（監査性）

---

## 4. テーマ別カバレッジ（本計画でどこまで埋まるか）

| テーマ | 対応機能 | 残ギャップ |
|--------|---------|-----------|
| コンテキスト整理 | S-4 ハンドオフ、C-1 Explain、P2-1 ベースライン内訳 | 自動圧縮そのもの（Claude Code 本体の /compact に委ねる） |
| タスクの成功 | S-2 成否判定付きレビュー、S-3 エラー意味分類、C-3 | チーム横断の成功率トレンド（OTel 領域、スコープ外） |
| コスト削減 | S-1 アドバイス復活、S-6 週次、既存キャッシュ診断との連動 | 予算アラート（G4、LLM 不要なので別トラック） |
| 長期的な記憶管理 | S-5 memory-doctor、H-1 ジャーナル、P2-1 | ベクトル検索付きフル記憶（claude-mem 併用を案内） |
| ロングランタスク監視 | H-2 通知、H-1 ジャーナル | 並列セッション一覧（G5、LLM 不要なので別トラック） |

---

## 5. ガードレール

1. **通信境界（不変）**: LLM 呼び出しはすべて Claude Code / `claude -p` 経由。
   拡張・スキル・フックが Anthropic 以外と直接通信するコードは引き続き禁止。
2. **自動実行は既定オフ**: Phase 1–2 のスキルは性質上ユーザー起動。Phase 3 のフック、
   Phase 4 の拡張内ボタンは設定でのオプトイン必須。
3. **コストガード**:
   - 縮約スクリプトを必ず経由し、LLM 入力を概ね 10–30K トークン以内に抑える
   - 分類・命名・ジャーナルは `--model haiku`、執筆系は `--model sonnet`。`--max-turns` を常に指定
   - 自動実行（H-1）は、quota-history の最新値で **5h 利用率 ≥80% のときスキップ**
     （既にローカルにあるデータで判定可能。閾値は設定化）
   - `--output-format json` の `total_cost_usd` を毎回記録し、Activity タブに
     「cc-monitor 自身の LLM 消費」を自己申告表示（監視ツール自身が監視対象になる）
   - 2026-06-15 以降の **Agent SDK クレジット別枠化**を踏まえ、消費が対話枠か別枠かを
     リリースノートで確認し、ドキュメントに反映（要調査タスク）
4. **書き込み安全**: S-3 / S-5 の CLAUDE.md・メモリ修正は**diff 提案のみ**。適用は
   ユーザーが明示的に指示した場合に限る。生成物は `reports/` / `.claude/handoff-*` /
   `journal.jsonl` の追記に限定。
5. **プライバシー明文化**: 会話ログ由来データを LLM に渡すことを README・各スキルの
   説明に明記（送信先は Anthropic のみで、元会話と同一の開示範囲であること）。

---

## 6. 実装順序とマイルストーン

| マイルストーン | 含むもの | 規模感 | 依存 |
|---------------|---------|--------|------|
| **M1: 基盤** | P0-1〜P0-4 | 小（1–2日） | なし |
| **M2: 最初の価値** | S-1（アドバイス復活）+ S-2（セッションレビュー） | 中（スキル設計が本体） | M1 |
| **M3: テーマ拡充** | S-3 + S-4 + S-5 + S-6（手動スキル）+ P2-1 | 中 | M1（S-3 は extract スクリプト拡張） |
| ~~M4: 自動化~~ | ~~H-1 + S-6 定期実行~~ → **凍結**（Agent SDK クレジット枠のため）。H-2（OS 通知・LLM 不要）は別トラックへ | — | — |
| ~~M5: ダッシュボード統合~~ | ~~C-1〜C-3~~ → **凍結**（同上） | — | — |
| **M4': プラグイン化** | skills + scripts を `packages/claude-plugin/` にバンドルし配布形態を整える | 小 | M2〜M3 の安定 |

推奨着手順: M1 → M2。M2 の S-2（セッションレビュー）が最も検証しやすく
（このリポジトリでの作業セッション自体を題材にできる）、スキル設計の
プロトタイプとして他機能の雛形になる。

### 検証方法

- 各スキルはこのリポジトリの実セッションログで dogfood（毎セッションが試験データになる）
- extract-session.mjs は決定的なので単体テスト（破損行・巨大ファイル・空セッション）
- S-2 の成否判定は、結末が既知のセッション数件に対してルーブリックの一致を人手確認

---

## 7. 未決事項

- [ ] Agent SDK クレジット（2026-06-15〜）の残量をプログラムから取得できるか
      （`/api/oauth/usage` の拡張 or 新エンドポイント）。取得できればクォータタブに統合
- [ ] プラグインの配布チャネル（marketplace 申請 or リポジトリ直 install）
- [ ] insights snapshot のスキーマ確定（拡張バージョンとの互換ポリシー）
- [ ] H-1 ジャーナルのフックが Claude Code の SessionEnd で安定動作するか
      （タイムアウト・並行セッション時の挙動）を実機検証
- [ ] S-5 が auto memory（`~/.claude/projects/<dir>/memory/`）を読む際の
      対象範囲（プロジェクト単位か全体か）

## 主要ソース

- [公式: Run Claude Code programmatically（headless / `-p` / `--output-format json`）](https://code.claude.com/docs/en/headless)
- [Claude Code Headless ガイド（amux, 2026）](https://amux.io/guides/claude-code-headless/)
- [公式: スキル / メモリ / フックのドキュメント](https://code.claude.com/docs/en/memory)
- 前提調査: [`reports/similar-tools-feature-research-2026-06-10.md`](../reports/similar-tools-feature-research-2026-06-10.md)
