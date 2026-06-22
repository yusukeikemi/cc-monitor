# CC Monitor

Claude Code のローカル会話ログからトークン消費量・推定コスト・公式クォータ（5時間 / 週次）を VS Code 上でリアルタイムに可視化する拡張機能です。

> **thinkcyte 社内フォーク** — OSS [`jack21/ClaudeCodeUsage`](https://github.com/jack21/ClaudeCodeUsage)（MIT）を vendoring し、第三者通信機能（AI アドバイス・料金表オンライン更新）を除去したものです。詳細は [セキュリティ方針](#セキュリティ方針) を参照してください。

---

## 機能概要

### ステータスバー（サマリ + クォータ + セッションごとのカード）

| インジケータ | 表示内容 |
|---|---|
| `$(pulse) $N.NN` サマリ | 今日の総コスト（グローバル）。ホバーで今日 / 現在セッションの内訳 |
| `$(dashboard) 5h:N% wk:N%` クォータ | 実際の 5時間・週次クォータ利用率（80%以上で黄・95%以上で赤） |
| `$(pulse) プロジェクト名 モデル N% $(zap)M:SS` セッションカード | **アクティブなセッションごとに1枚**。そのセッションのモデル・コンテキスト充填率・プロンプトキャッシュ残りをまとめて表示 |

複数の Claude Code を並行実行すると、セッションカードがその数だけ増減します。各カードの
ホバーには、そのセッションの**最初のプロンプト（100字以内）**が出るので「どのセッションか」を
すぐ判別できます。表示対象は `sessionCardRecencyMinutes`（既定60分）以内のセッションで、
最大 `maxSessionCards`（既定5枚）まで。クリックするとダッシュボードが開きます。

### ダッシュボード（10 タブ）

| タブ | 内容 |
|---|---|
| **Today** | 今日のコスト・トークン・モデル別内訳・時間別チャート |
| **Month** | 日別テーブル＋チャート。行クリックで時間別詳細へドリルダウン |
| **All Time** | 月別集計。行クリックで日別詳細へドリルダウン |
| **Sessions** | 会話ファイル（`.jsonl`）単位の一覧。ピークコンテキスト・コスト等 |
| **Projects** | git リポジトリ / フォルダ別の集計（グルーピングモード切替可） |
| **Content** | どのコンテンツ種別（プロンプト / ツール結果 / thinking 等）がトークンを消費しているか |
| **Branches** | git ブランチ別の使用量集計 |
| **Activity** | ツール呼び出し・エラー率・PR 数・編集行数・ヒートマップ等 |
| **Quota** | クォータ利用率の時系列チャート・時間帯別消費ヒートマップ |
| **Context Health** | コンテキスト劣化の詳細診断（シグナル一覧・構成内訳・/clear サジェスト） |

---

## セキュリティ方針

- **通信先は Anthropic 公式のみ**: `api.anthropic.com`（クォータ取得）と `console.anthropic.com`（OAuth トークン更新）のみ。第三者サーバには一切通信しません。
- **コスト・トークンはオフライン算出**: `~/.claude/projects/**/*.jsonl` をローカルで解析し、バンドル済み料金表で換算します（ネットワーク不要）。
- **ランタイム依存ゼロ**: npm の runtime dependency はありません。

除去された上流機能:
- ❌ AI アドバイス（使用量サマリとプロンプトを DeepSeek 等へ送信していた機能）
- ❌ 料金表のオンライン更新（LiteLLM / GitHub から取得していた機能）

---

## インストール

このリポジトリから `.vsix` をビルドしてインストールします:

```bash
cd packages/vscode
npm run compile
npx @vscode/vsce package --no-dependencies
code --install-extension cc-monitor-2.0.0.vsix
```

または VS Code の拡張機能パネルから `.vsix` ファイルを直接インストール（「VSIX からインストール...」）。

---

## 設定

VS Code の設定（`claudeCodeUsage.*`）から変更できます。

| 設定 | 既定 | 内容 |
|---|---|---|
| `refreshInterval` | 60 | ポーリング間隔（秒、最小 30） |
| `dataDirectory` | `""` | Claude データディレクトリの手動指定（空 = 自動検知） |
| `language` | `auto` | 表示言語（`auto` / `en` / `ja` / `zh-TW` / `zh-CN` / `ko`） |
| `decimalPlaces` | 2 | コスト表示の小数桁（0–4） |
| `compactNumbers` | false | 大きな数を `1.2M` / `345K` 形式で表示 |
| `timezone` | `""` | 日付表示用 IANA タイムゾーン（devcontainer 等向け） |
| `usageLimitTracking` | true | クォータインジケータの有効/無効 |
| `recordQuotaHistory` | true | クォータ利用率の履歴記録 |
| `enableContentAnalysis` | true | Content / Activity タブと解析の有効/無効 |
| `enableContextHealth` | true | セッションカードのコンテキスト充填率 + Context Health タブの有効/無効 |
| `contextHealthRotNotification` | false | Context rot 検出時のトースト通知（オプトイン、セッションごと） |
| `sessionCardRecencyMinutes` | 60 | この分数以内に書き込みのあったセッションをカード表示 |
| `maxSessionCards` | 5 | 同時表示するセッションカードの最大数（最新順） |
| `quotaThresholdNotification` | true | クォータ 80% / 95% 到達時の警告通知 |
| `projectGroupingMode` | `git` | Projects タブのグルーピング（`git` / `folder` / `flat`） |
| `exportInsights` | true | 集計スナップショットをローカルファイルに書き出し（Claude Code スキル連携用） |

---

## Claude Code スキル連携

`exportInsights`（既定 on）が有効な場合、リフレッシュごとに集計スナップショットを
`~/.claude/cc-monitor/insights/latest.json` へ書き出します。このファイルを使って
Claude Code のスキルが LLM 分析を実行できます（追加通信・API キー不要）:

- **`/cc-usage-advice`** — コスト・トークン効率・クォータ運用の最適化アドバイスを生成
- **`/cc-session-review`** — セッションの成否判定・無駄トークン分析・改善提案を生成

---

## コマンド

コマンドパレット（`Ctrl+Shift+P`）から実行できます:

| コマンド | 動作 |
|---|---|
| `CC Monitor: Refresh Usage Data` | 手動リフレッシュ |
| `CC Monitor: Show Usage Details` | ダッシュボードを開く |
| `CC Monitor: Open Settings` | 拡張設定を開く |
| `CC Monitor: Show Diagnostic Logs` | 診断ログを表示 |
| `CC Monitor: Export Quota History` | クォータ履歴を CSV / JSON で書き出し |
| `CC Monitor: Open Quota History File` | クォータ履歴ファイルをエディタで開く |

---

## ライセンス

MIT License — 元の [`jack21/ClaudeCodeUsage`](https://github.com/jack21/ClaudeCodeUsage) の著作権表示は `LICENSE` ファイルに保持しています。
