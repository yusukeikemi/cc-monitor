# cc-monitor

Claude Code のローカル会話ログからトークン消費量・推定コスト、および公式クォータ
（5時間 / 週次）を可視化する VS Code 拡張。

## 方針

- **通信は Anthropic 公式のみ**: `api.anthropic.com`（クォータ取得）と
  `console.anthropic.com`（OAuth トークン更新）のみ。第三者サーバには通信しない。
- **コスト/トークンはオフライン算出**: `~/.claude/projects/**/*.jsonl` の `message.usage`
  をローカルで集計し、バンドル料金表で換算（ネットワーク不要）。
- **依存ゼロ**: ランタイム npm 依存なし。

## 由来（vendoring）と監査

`packages/vscode/` は OSS の
[`jack21/ClaudeCodeUsage`](https://github.com/jack21/ClaudeCodeUsage)（MIT License）を
**vendoring** したもの。原著作権表示は `packages/vscode/LICENSE` に保持。

取り込みにあたり全ソースをセキュリティ監査し（→ `docs/security-audit-jack21.md`）、
**第三者通信を行う2機能を除去**した：

- ❌ AI アドバイス機能（ユーザーのプロンプトを DeepSeek 等へ送信）→ 削除
- ❌ 料金表のオンライン更新（LiteLLM/GitHub から取得）→ 削除（バンドル値のみ使用）

これにより通信先は公式 Anthropic ドメインのみとなる。

## クォータ履歴（Quota タブ）

実際の 5時間 / 週次クォータ utilization% を取得のたびにタイムスタンプ付きで
`~/.claude/cc-monitor/quota-history.jsonl` に追記し、ダッシュボードの **Quota** タブで
時系列グラフ・時間帯別の消費・直近のリセット情報として可視化する。
`Export Quota History` コマンドで CSV/JSON として書き出せる。

注意:
- 記録は**拡張機能が動作している間のみ**蓄積される（VS Code を閉じている間は記録されない）。
- API は現在値のみを返すため、**過去にさかのぼった記録はできない**（導入後から貯まる）。
- 粒度は実質**数分間隔**（API は2分キャッシュ、ポーリング既定60秒）。同一値の連続行は記録しない。
- `claudeCodeUsage.recordQuotaHistory`（既定 true）で記録の有無を切り替え可能。
  `usageLimitTracking` が無効の場合はそもそも記録されない。

## ドキュメント

- `docs/requirements.md` … 要件定義
- `docs/security-audit-jack21.md` … 取り込み元のセキュリティ監査レポート

## ライセンス

本リポジトリの派生部分は元の MIT License に従う。`packages/vscode/LICENSE` を参照。
