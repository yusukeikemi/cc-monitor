# セキュリティ監査レポート: jack21/ClaudeCodeUsage

対象: `jack21/ClaudeCodeUsage`（VS Code 拡張、`--depth 1` クローンで全ソース精査）
監査日: 2026-06-03
コードベース: TypeScript 100% / 約 7,200 行 / 10 ファイル / **ランタイム依存ゼロ**
ライセンス: MIT

## 総合判定

> **マルウェア・テレメトリ・トークン漏洩・任意URL通信・シェルインジェクションは検出されず。**
> 既定で有効な通信は **Anthropic 公式のみ**。第三者通信は2機能のみで、いずれも
> **既定オフ／手動コマンド起動**。Fork してその2機能を除去すれば、ご要件
> 「公式 Anthropic とだけ通信」を厳密に満たせる。

## 1. 通信先の全数調査

ソース内の全 URL を抽出し、実際に呼ばれるものを分類（コメント/ドキュメントURLは除外）。

| エンドポイント | 公式? | 既定 | トリガー | 送信内容 |
|---|---|---|---|---|
| `api.anthropic.com/api/oauth/usage` | ✅ 公式 | **ON** | 自動（`usageLimitTracking=true`） | 認証トークン（クォータ取得） |
| `console.anthropic.com/v1/oauth/token` | ✅ 公式 | ON | トークン期限切れ時のみ | refresh_token（トークン更新） |
| `raw.githubusercontent.com/.../litellm/...` | ❌ 第三者 | **OFF** | **手動コマンド** `refreshPricing` のみ | なし（料金表DLのみ） |
| `api.deepseek.com/chat/completions`（変更可） | ❌ 第三者 | **OFF** | **手動コマンド** `getAdvice` ＋ APIキー必須 | **使用サマリ＋プロンプト見本** |

- 公式クライアント（`claudeApiClient.ts`）の `request()` はハードコードされた上記
  2つの Anthropic URL でしか呼ばれない（`extension`→任意URL注入の経路なし）。

## 2. 要注意点（Fork時に除去・無効化を推奨）

### 🔴 A. AI アドバイス機能（`advisor.ts`）
- **使用サマリと「開発者の実際のプロンプトのサンプル」を第三者LLM（既定DeepSeek）に
  送信**する。プロンプト内容の外部送信であり、プライバシー要件に反する。
- ただし **既定オフ**: `advice.apiKey` が空だと動かず、手動コマンド `getAdvice` 実行時のみ。
- **対応**: Fork では `advisor.ts`・`getAdvice` コマンド・`advice.*` 設定を**完全削除**。

### 🟡 B. 料金表のオンライン更新（`pricing.ts`）
- `raw.githubusercontent.com` の LiteLLM 料金データを取得。第三者ドメイン。
- 既定では使われず、料金表は**バンドル値**。手動コマンド `refreshPricing` 実行時のみ取得。
- **対応**: Fork では `fetchLatestPricing`・`refreshPricing` コマンドを削除し、
  バンドル料金表のみ使用（我々の方針と一致）。

## 3. 良好な点（設計上の安全性）

- **依存ゼロ**: `package.json` の `dependencies` 無し（devは `typescript`/`@types`のみ）。
  `package-lock.json` 確認済み。サプライチェーン攻撃面が構造的に最小。
- **認証情報**: `~/.claude/.credentials.json` を `claudeAiOauth.accessToken` のみ参照。
  期限切れ時に公式 `oauth/token` で更新し**同ファイルに書き戻す**（Claude Code 同等挙動）。
  トークン値はログ・画面・他送信先に出力しない（ログは状態文字列のみ）。
- **curl フォールバック**: fetch が Anthropic の TLS フィンガープリント判定で 403 の時のみ
  `spawn('curl', args, { shell: false })`。**`shell:false` ＋ 配列引数**でシェル
  インジェクション不可。URL は前述の公式2つに限定。
- **コンテンツ分析**（`enableContentAnalysis`, 既定ON）: 会話ログのトークン構成を
  **ローカルでのみ**集計（Content タブ）。ネットワーク送信なし。`getAdvice` を手動で
  叩かない限り外部に出ない。
- **eval / Function コンストラクタ無し**。`webview.ts` の `forEach(function...)` は
  Webview 内DOM操作であり危険コードではない。

## 4. 結論と Fork 方針

1. `jack21/ClaudeCodeUsage` を Fork（MIT、合法）。監査済みコミットに固定。
2. **除去**: `advisor.ts` / `getAdvice` / `advice.*` 設定（🔴A）、
   `fetchLatestPricing` / `refreshPricing`（🟡B）。
3. **維持**: クォータ（公式のみ）、ローカルコスト集計、コンテンツ分析（ローカル）。
4. 除去後は通信先が `api.anthropic.com` ＋ `console.anthropic.com`（=公式）のみとなり、
   ご要件を厳密充足。
5. 将来の upstream 更新は都度マージ監査（依存ゼロのため差分監査が容易）。

> 注: 本監査は静的レビュー。Fork 後、ビルド成果物（.vsix）に対する `grep` での
> 通信先再確認と、ネットワーク遮断下での動作確認を最終ゲートとして推奨。
