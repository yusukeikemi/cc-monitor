---
name: cc-usage-advice
description: Claude Code の使用状況データ(cc-monitor の insights スナップショット)から、コスト・トークン効率・クォータ運用の最適化アドバイスをレポートとして生成する。「使用量のアドバイスが欲しい」「コストを下げたい」「/cc-usage-advice」で使用。
---

# cc-usage-advice — 使用状況の最適化アドバイス

cc-monitor が出力したローカル集計を読み、使用パターンの診断と具体的な改善アドバイスを
Markdown レポートとして生成する。**LLM 呼び出しはこの会話自体のみ**(追加の API・
ヘッドレス実行は行わない)。データはすべてローカルファイルから読む。

## 手順

### 1. データ読み込み

以下を読む(存在しないものはスキップし、レポートに「データなし」と明記):

1. `~/.claude/cc-monitor/insights/latest.json` — cc-monitor VS Code 拡張が出力する集計
   スナップショット(today / thisMonth / allTime、セッション・プロジェクト上位、
   Activity 分析、Context Health、最新クォータ)。
   - **無い場合**: VS Code で cc-monitor 拡張を一度起動すると生成される旨を案内し、
     以降のステップは quota-history のみで縮退実行する。
   - `generatedAt` が 24 時間より古い場合はその旨をレポート冒頭に注記する。
2. `~/.claude/cc-monitor/quota-history.jsonl` — 末尾 200 行程度で十分
   (PowerShell: `Get-Content <path> -Tail 200`)。

### 2. 診断(このルーブリックに沿って事実から導く)

データにある数値だけを根拠にする。推測で数値を作らない。

| 観点 | 見るもの | 改善アドバイスの例 |
|------|---------|------------------|
| モデルミックス | `modelBreakdown` のコスト構成 | 分類・整形・単純作業が Opus/Sonnet に流れていれば Haiku/サブエージェント委譲を提案 |
| キャッシュ効率 | cacheRead vs cacheCreation の比率、costBreakdown.cacheWrite | 書込比率が高ければセッションの細切れ化・モデル切替頻発を疑う |
| コンテキスト運用 | `contextHealth`(fillRatio, signals, baselineTokens, reclaimableTokens) | largeBaseline → CLAUDE.md 等の肥大化指摘 / reclaimable 大 → ツール出力の絞り込み(offset/limit 付き Read など) |
| ツール・エラー | `activity.tools` のエラー率上位、`toolErrors`/`totalToolCalls` | エラー率が高いツールの使い方改善 |
| 思考・出力配分 | `thinkingTokensEst` vs `assistantTextTokensEst`、`mainOutputTokens` vs `sidechainOutputTokens` | サブエージェント比率が低く重作業が多ければ並列委譲を提案 |
| クォータ圧力 | quota-history の推移(時間帯ごとの増分、80%超の頻度) | 逼迫時間帯の把握、重いタスクをリセット直後に回す等の運用提案 |
| セッション習慣 | `sessions` の peakContextTokens 分布、1セッションの長さ | 200K 近くまで使い切る癖があれば早めの /clear・ハンドオフを提案 |

### 3. レポート生成

- 出力先: カレントプロジェクトの `reports/usage-advice-YYYY-MM-DD.md`
  (`reports/` が無ければ作成。同名があれば `-2` を付ける)。
- **ユーザーの会話言語で書く**。
- 構成:
  1. **TL;DR** — 最も効果の大きい改善 3 点(推定インパクト順)
  2. **現状サマリ** — 今日/今月のコスト、モデル構成、キャッシュヒット率、クォータ状況(数値は出典フィールド名を併記)
  3. **診断詳細** — 上のルーブリック観点ごとに「観測事実 → 解釈 → アクション」
  4. **やらなくていいこと** — 数値上すでに健全な点(過剰最適化の防止)
  5. **データの注記** — スナップショット生成時刻、欠損データ、トークン推定値の限界
- 生成後、レポートのパスと TL;DR をチャットにも表示する。

## 制約

- レポート作成以外のファイル変更・設定変更はしない(提案に留める)。
- 会話ログの本文(プロンプト原文)は insights に含まれていない。原文が必要な深掘りは
  `/cc-session-review` を案内する。
