# cc-monitor 要件定義書

Claude Code のローカル会話ログを読み取り、トークン消費量と推定コストを
VS Code 上および CLI で可視化するツール。

ステータス: ドラフト（要件定義フェーズ）
最終更新: 2026-06-03

---

## 0. 設計の前提（最重要）

このツールは **外部・Anthropic を含む一切のネットワーク通信を行わない**（完全オフライン）。

理由：

- Claude Code は会話ログを `~/.claude/projects/<project>/<session>.jsonl` に
  ローカル保存している。
- その JSONL の各 assistant メッセージ行には **`message.usage` が既に含まれて
  おり**、`input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
  `cache_read_input_tokens` が記録済み。
- したがって **トークン数の取得に API 通信は不要**。コスト換算に必要な料金単価も
  本ツールに **バンドル** する。

> ccusage 等の OSS は「ログ形式の解釈・集計方法」という**ロジックのみ**参考にし、
> コードは経由しない。これによりサプライチェーン経由のセキュリティ懸念を排除する。

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

---

## 2. UI / UX 要件

### 2.1 VS Code 拡張（MVP）

| ID | 要件 |
|----|------|
| U-1 | `StatusBarItem` を右下に常駐表示。例: `$11.51 \| 5h:48m`。 |
| U-2 | ホバー時に `MarkdownString` ツールチップで内訳を表示。 |
| U-3 | ツールチップ項目: 現在ブロックの消費 / 今日 / 今週 / 次回ブロックリセットまでの残り時間 / プロジェクト別 上位。 |
| U-4 | 一定間隔（既定 5s、設定可）で表示を更新。負荷を避け差分のみ反映。 |
| U-5 | ログ未検出時はエラーにせず「データなし」表示に縮退する。 |

### 2.2 CLI

| ID | 要件 |
|----|------|
| U-6 | `cc-monitor` でデフォルト（直近ブロック+今日）のサマリをテーブル表示。 |
| U-7 | `--json` で機械可読出力。`--since` / `--project` でフィルタ。 |
| U-8 | `--watch` でターミナル常駐表示（任意・MVP後でも可）。 |

### 2.3 将来拡張（MVP対象外）

- ステータスバークリックで Webview ダッシュボード（グラフ・プロジェクト別推移）。
- JPY 換算、予算アラート、週次クォータのプログレス表示。

---

## 3. 非機能要件

| ID | 要件 |
|----|------|
| N-1 | **軽量**: JSONL は逐次（ストリーム/差分）読み。巨大化しても UI を阻害しない。 |
| N-2 | **オフライン**: ネットワーク呼び出しコードを含めない（依存も net 不要なもののみ）。 |
| N-3 | **プライバシー**: 会話本文は読まない／保持しない。usage メタデータのみ扱う。 |
| N-4 | **クロスプラットフォーム**: macOS / Linux / Windows のパスを考慮。 |
| N-5 | **テスト**: コア（parser / dedup / pricing / aggregate）に単体テストを用意。 |

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
- 通信方針: 完全オフライン（料金表バンドル）
- MVP: ステータスバー + ホバー詳細まで（Webview は次フェーズ）

実装順（提案）:

1. モノレポ雛形（pnpm workspaces + TS 設定）
2. `core`: discovery → parser → dedup → pricing → aggregate（+ 単体テスト）
3. `core`: watch（差分読み）
4. `vscode`: StatusBar + Hover（core 利用）
5. `cli`: サマリ/JSON 出力
6. （次フェーズ）Webview ダッシュボード / JPY 換算 / クォータ表示

---

## 6. 未確定事項（要確認）

- [ ] 実ログのスキーマ確定（フィールド名・usage の位置）。
- [ ] バンドル料金表の初期値（対象モデルと単価）と更新運用。
- [ ] 「週次クォータ上限」の値の出所（公式に固定値がない場合は設定値とするか）。
- [ ] パッケージング（VS Code Marketplace 公開 or VSIX 手動配布、CLI は npm or 単体バイナリ）。
