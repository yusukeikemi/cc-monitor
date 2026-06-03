# cc-monitor 要件定義書

Claude Code のローカル会話ログを読み取り、トークン消費量と推定コストを
VS Code 上および CLI で可視化するツール。

ステータス: ドラフト（要件定義フェーズ）
最終更新: 2026-06-03

---

## 0. 設計の前提（最重要）

**通信方針: オフライン優先 + クォータのみ Anthropic 公式へオプトイン通信。**
通信先は `api.anthropic.com` **のみ**。それ以外（OSS の中継サーバ等）へは一切通信しない。

| 指標 | 取得方法 | 通信 |
|------|----------|------|
| トークン消費・コスト | ローカル JSONL の `message.usage` ＋ バンドル料金表 | なし |
| コンテキスト総量 | ローカル JSONL の最新 usage | なし |
| 5時間 / 週次クォータの正確な % とリセット | 公式 `api.anthropic.com/api/oauth/usage` | あり（公式のみ・オプトイン・既定オフ） |

理由・根拠：

- Claude Code は会話ログを `~/.claude/projects/<project>/<session>.jsonl` に
  ローカル保存しており、各 assistant 行に **`message.usage` が含まれる**
  （`input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
  `cache_read_input_tokens`）。トークン取得・コスト換算はオフラインで完結する。
- 一方、**プラン上限に対する正確な %（5時間/週次）とリセット時刻**はアカウント単位の
  サーバー権威データで、ローカルログからは算出できない。これは Claude Code 自身が
  公式エンドポイント `api.anthropic.com/api/oauth/usage` から取得している（後述 §1.5）。
  本ツールも**同じ公式エンドポイントのみ**に問い合わせる。

> 参考実装（ccusage / jack21 ClaudeCodeUsage 等）は「ログ形式の解釈・集計方法・
> 公式エンドポイントの呼び出しプロトコル」という**ロジックのみ**参考にし、コードは
> 経由しない。OSS の中継サーバには一切依存せず、サプライチェーン経由の懸念を排除する。

---

## 1. 機能要件

### 1.1 データソースの監視（ログ読み込み）

| ID | 要件 |
|----|------|
| F-1 | Claude Code のログ保存ディレクトリを自動検知する（後述の探索パス順）。 |
| F-2 | 配下の `*.jsonl` を再帰的に列挙し、各行を JSON としてパースする。 |
| F-3 | ファイル更新を監視（watch）し、追記分のみ差分読み込みする（全読み直し禁止）。 |
| F-4 | 破損行・未知スキーマ行はスキップし、処理を継続する（fail-safe）。 |

**ログ探索パス（優先順）**

1. 環境変数 `CLAUDE_CONFIG_DIR`（指定時、`:` 区切りで複数可）配下の `projects/`
2. `~/.claude/projects/`
3. `~/.config/claude/projects/`（XDG 準拠）

### 1.2 トークン・コストの算出

| ID | 要件 |
|----|------|
| F-5 | 各 usage から input / output / cache-write / cache-read トークンを抽出。 |
| F-6 | バンドル料金表（モデル別 $/Mtok）を用いて推定コストを算出。 |
| F-7 | 4 種トークンを個別単価で計算（cache-read は割安、cache-write は割高）。 |
| F-8 | 未知モデルは料金 0 として扱い、トークン数のみ集計（警告ログ）。 |
| F-9 | 表示通貨は USD を基本とし、将来 JPY 換算（固定レート設定）を拡張で対応。 |

### 1.3 重複カウントの防止（ロジック上の肝）

Claude Code のログは再開・リトライ等で **同一 usage が複数行に出現** しうる。

| ID | 要件 |
|----|------|
| F-10 | `message.id` + `requestId` の組をキーに **デデュープ** し、二重計上を防ぐ。 |
| F-11 | キーが欠落した行はユニーク扱い（合成キーで識別）。 |

### 1.4 期間・単位ごとの集計

| ID | 要件 |
|----|------|
| F-12 | 「現在のセッション」「今日」「今週」「今月」の単位で集計。 |
| F-13 | プロジェクト（ワークスペース）別の集計。 |
| F-14 | 課金ブロック（5 時間ウィンドウ）単位の集計。画像の `5h:48m` 表示に対応。 |
| F-15 | 集計はモデル別内訳を保持する。 |
| F-15b | **コンテキスト総量のみ**を最新 usage から表示（例 `28k / 1.0M (3%)`）。カテゴリ別内訳（Messages/System tools/Skills/MCP 等）は Claude Code 内部計算でログに残らないため対象外。 |

### 1.5 クォータ取得（公式 API・オプトイン）

5時間 / 週次クォータの**正確な % とリセット時刻**は、公式エンドポイントから取得する。
**既定オフ**。ユーザーが設定で明示的に有効化した場合のみ通信する。

| ID | 要件 |
|----|------|
| F-16 | OAuth トークンを `~/.claude/.credentials.json` から**読み取り専用**で取得。 |
| F-17 | `GET https://api.anthropic.com/api/oauth/usage` を呼び出す（**他ドメインへは通信禁止**）。 |
| F-18 | 必須ヘッダを付与: `Authorization: Bearer <token>` / `anthropic-beta: oauth-2025-04-20` / `User-Agent: claude-code/<version>` / `Content-Type: application/json`。 |
| F-19 | レスポンスの `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` から `utilization`(%) と `resets_at`(ISO8601) を抽出。`null` はデータ無しとして縮退。 |
| F-20 | **レート制限対策**: ポーリングは最短 180 秒間隔。429 時は指数バックオフ（3→15分）。結果はローカルキャッシュし、UI はキャッシュから更新。 |
| F-21 | **トークンを画面・ログ・ファイルに出力しない**。送信先は公式エンドポイントのみ。 |
| F-22 | クォータ無効時・取得失敗時も、ローカル由来のコスト/トークン表示は常に動作する。 |

**想定レスポンス（参考・実装前に実値で検証）**

```jsonc
{
  "five_hour":        { "utilization": 33.0, "resets_at": "2026-06-03T07:00:00Z" },
  "seven_day":        { "utilization": 13.0, "resets_at": "2026-06-09T00:59:59Z" },
  "seven_day_opus":   null,
  "seven_day_sonnet": { "utilization": 1.0,  "resets_at": "2026-06-08T03:00:00Z" }
}
```

> ⚠️ このエンドポイントは非公開（undocumented）で、`User-Agent: claude-code/<version>`
> が無いと積極的に 429 を返す。仕様変更で壊れる可能性があるため、F-22 のとおり
> 取得失敗時も中核機能が無傷で動くフェイルセーフ設計を必須とする。

---

## 2. UI / UX 要件

### 2.1 VS Code 拡張（MVP）

| ID | 要件 |
|----|------|
| U-1 | `StatusBarItem` を右下に常駐表示。例: `$11.51 \| 5h:48m`。 |
| U-2 | ホバー時に `MarkdownString` ツールチップで内訳を表示。 |
| U-3 | ツールチップ項目: コンテキスト総量 / 現在ブロックの消費 / 今日 / 今週 / プロジェクト別 上位 / （クォータ有効時）5時間・週次の % とリセットまでの残り時間。 |
| U-4 | ローカル表示は既定 5s 間隔で差分更新。**クォータ取得は別系統で最短 180s 間隔**（F-20）。 |
| U-5 | ログ未検出時はエラーにせず「データなし」表示に縮退する。 |

### 2.2 CLI

| ID | 要件 |
|----|------|
| U-6 | `cc-monitor` でデフォルト（直近ブロック+今日）のサマリをテーブル表示。 |
| U-7 | `--json` で機械可読出力。`--since` / `--project` でフィルタ。 |
| U-8 | `--watch` でターミナル常駐表示（任意・MVP後でも可）。 |

### 2.3 将来拡張（MVP対象外）

- ステータスバークリックで Webview ダッシュボード（グラフ・プロジェクト別推移）。
- JPY 換算、予算アラート、週次クォータのプログレスバー表示。

---

## 3. 非機能要件

| ID | 要件 |
|----|------|
| N-1 | **軽量**: JSONL は逐次（ストリーム/差分）読み。巨大化しても UI を阻害しない。 |
| N-2 | **通信の最小化**: 通信先は `api.anthropic.com` のみ（許可リスト方式でハードコード）。クォータ機能は既定オフのオプトイン。それ以外の全機能はオフライン動作。 |
| N-3 | **プライバシー**: 会話本文は読まない／保持しない。usage メタデータのみ扱う。 |
| N-4 | **認証情報の安全な取り扱い**: `.credentials.json` は読み取り専用。トークンはメモリ上のみで保持し、ログ/画面/ファイルに出力せず、公式エンドポイント以外へ送信しない。 |
| N-5 | **クロスプラットフォーム**: macOS / Linux / Windows のパスを考慮。 |
| N-6 | **テスト**: コア（parser / dedup / pricing / aggregate / quota パーサ）に単体テストを用意。クォータ通信はモック化しオフラインでテスト可能にする。 |

---

## 4. アーキテクチャ

モノレポ（pnpm workspaces）。ロジックは `core` に集約し UI から再利用する。

```
cc-monitor/
├── packages/
│   ├── core/      @cc-monitor/core  … 探索・パース・dedup・料金・集計・watch
│   ├── vscode/    VS Code 拡張       … StatusBar + Hover（core を利用）
│   └── cli/       CLI                … テーブル/JSON 出力（core を利用）
├── docs/requirements.md
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### 4.1 core モジュール責務

- **discovery**: ログディレクトリ探索（探索パス順）。
- **parser**: JSONL 差分読み込み、usage 抽出、破損行スキップ。
- **dedup**: `message.id`+`requestId` による重複排除。
- **pricing**: バンドル料金表（モデル別 4 単価）とコスト計算。
- **aggregate**: セッション/日/週/月/ブロック/プロジェクト別集計。
- **watch**: `fs.watch` + デバウンス + ファイル別オフセット管理（差分読み）。
- **quota**（オプトイン）: `.credentials.json` 読取 → 公式 `oauth/usage` 呼出 →
  キャッシュ + 180s ポーリング + 429 バックオフ。無効・失敗時は他機能に影響させない。

### 4.2 想定データモデル（JSONL 1 行・assistant）

```jsonc
{
  "type": "assistant",
  "sessionId": "…",
  "requestId": "req_…",          // dedup キー
  "timestamp": "2026-06-03T…Z",
  "cwd": "/path/to/project",      // プロジェクト識別
  "message": {
    "id": "msg_…",               // dedup キー
    "model": "claude-opus-4-8",
    "usage": {
      "input_tokens": 123,
      "output_tokens": 456,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 789
    }
  }
}
```

> 注: 実際のフィールド名・ネストは Claude Code のバージョンで揺れる可能性がある。
> 実装前に手元の `~/.claude/projects/` の実ログ 1 件をサンプリングして確定する
> （TODO: スキーマ検証タスク）。

---

## 5. MVP スコープと進め方

決定済み（本要件定義時点）:

- 配信形態: 共通コア + VS Code 拡張 + CLI
- 通信方針: オフライン優先 + クォータのみ公式 `api.anthropic.com` へオプトイン通信
- コンテキスト表示: 総量のみ（内訳は対象外）
- MVP: ステータスバー + ホバー詳細まで（Webview は次フェーズ）

実装順（提案）:

1. モノレポ雛形（pnpm workspaces + TS 設定）
2. `core`: discovery → parser → dedup → pricing → aggregate（+ 単体テスト）
3. `core`: watch（差分読み）
4. `vscode`: StatusBar + Hover（core 利用、ローカル指標のみ）
5. `cli`: サマリ/JSON 出力
6. `core`: quota モジュール（公式 API・オプトイン）＋ UI 連携
7. （次フェーズ）Webview ダッシュボード / JPY 換算 / クォータ プログレスバー

---

## 6. 未確定事項（要確認）

- [ ] 実ログのスキーマ確定（フィールド名・usage の位置）。
- [ ] `~/.claude/.credentials.json` の実構造確認（トークンのキー名・更新方式）。
- [ ] `oauth/usage` の実レスポンス検証（§1.5 の想定どおりか、`User-Agent` の version 値）。
- [ ] バンドル料金表の初期値（対象モデルと単価）と更新運用。
- [ ] パッケージング（VS Code Marketplace 公開 or VSIX 手動配布、CLI は npm or 単体バイナリ）。

> セキュリティ注記: `oauth/usage` は Anthropic の非公開エンドポイント。利用は本ツールが
> 既存の Claude Code 認証情報を読むだけで完結するが、規約・仕様変更リスクがあるため
> 既定オフのオプトインとし、フェイルセーフ（取得失敗でも中核機能は無傷）を徹底する。
