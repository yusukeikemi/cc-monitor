# 実行手順書（Runbook）: cc-monitor 拡張のローカル導入と検証

対象実行者: **自律エージェント**（ユーザーのローカルマシン上で動作すること）
目的: `packages/vscode` の拡張をビルド・セキュリティ再検証・パッケージング・インストールし、
公式 Anthropic 以外へ通信しないことを確認する。

> ⚠️ 実行環境の前提（最重要）: 本手順は **ユーザーが普段 Claude Code を使っている
> ローカルマシン**で実行すること。リモートコンテナや CI には `~/.claude/` が無いため
> データ表示の確認はできない（ビルド・パッケージングまでは可能）。
> 各ステップの **GATE（合否判定）** を満たさない場合は次に進まず、原因を報告して停止する。

---

## STEP 0: 前提環境の確認

```bash
node -v        # v18 以上であること
npm -v
code -v 2>/dev/null || cursor -v 2>/dev/null   # VS Code/Cursor の CLI が PATH にあること
ls -d "$HOME/.claude" 2>/dev/null && echo "claude dir: OK" || echo "claude dir: MISSING"
ls "$HOME/.claude/projects"/*/*.jsonl >/dev/null 2>&1 && echo "logs: present" || echo "logs: none"
ls "$HOME/.claude/.credentials.json" >/dev/null 2>&1 && echo "creds: present" || echo "creds: none"
```

- **GATE 0-1**: `node -v` が 18 以上。満たさなければ中断し「Node 18+ が必要」と報告。
- **GATE 0-2**: `code`（または `cursor`）CLI が存在。無ければ STEP 5 を「手動インストール案内」に切替。
- 参考情報（中断しない）: `logs: none` の場合、表示確認はできない旨を最終報告に明記。
  `creds: none` の場合、クォータ表示は出ない旨を明記。

---

## STEP 1: コード取得

既にローカルに clone 済みならそのディレクトリへ。無ければ取得する。

```bash
# 未取得の場合のみ
git clone -b claude/blissful-knuth-tYZbb \
  https://github.com/yuzuponikemi/cc-monitor.git
cd cc-monitor/packages/vscode
```
既存の場合:
```bash
cd <repo>/packages/vscode
git fetch origin claude/blissful-knuth-tYZbb
git checkout claude/blissful-knuth-tYZbb
git pull origin claude/blissful-knuth-tYZbb
```
- **GATE 1**: カレントが `.../packages/vscode` で、`package.json` と `src/` が存在すること。

---

## STEP 2: ビルド

```bash
npm install
npm run compile
ls out/extension.js
```
- **GATE 2**: `npm run compile` が exit 0、かつ `out/extension.js` が生成されていること。
  失敗時は tsc のエラー全文を報告して中断。

---

## STEP 3: セキュリティ再検証（必須ゲート・最重要）

公式 Anthropic 以外への通信が混入していないことを、ソースとコンパイル後の両方で確認する。

```bash
rm -rf out && npm run compile     # クリーンビルドし直してから検査

echo "== forbidden domains (期待: 出力なし) =="
grep -rniE 'deepseek|litellm|githubusercontent|openai\.com|ai\.google\.dev' src out
echo "forbidden grep exit=$?   # 1 = 検出なし=OK / 0 = 検出あり=NG"

echo "== referenced hosts (期待: anthropic 公式のみ) =="
grep -rhoiE 'https?://[a-z0-9._/-]+' src out | sort -u

echo "== actual egress files (期待: claudeApiClient のみ) =="
grep -rlE 'fetch\(|https?\.get\(|https?\.request\(|child_process' out
```
- **GATE 3-1**: forbidden grep が **exit 1（検出ゼロ）**。1件でも出たら **即中断**し、該当箇所を報告。
- **GATE 3-2**: host 一覧が次のみであること（`platform.claude.com` はコメント内の出典記載で通信ではない → 許容）:
  - `https://api.anthropic.com/...`
  - `https://console.anthropic.com/...`
  - （許容）`https://platform.claude.com/docs/...`（`pricing.ts` のコメント）
  上記以外のホストが出たら **即中断**して報告。
- **GATE 3-3**: 実通信を含むファイルが `out/claudeApiClient.js` のみであること。

> このゲートを通らない限り STEP 4 以降に進まないこと。

---

## STEP 4: VSIX パッケージング

`@vscode/vsce` でパッケージする。`repository` / `README` 欠如の対話プロンプトを避けるため、
非対話で実行する。

```bash
# 対話プロンプト回避: repository 欠如を許容しつつ y を自動応答
printf 'y\ny\n' | npx --yes @vscode/vsce package 2>&1 | tee /tmp/vsce.log
ls -1 *.vsix
```
- 警告（repository/README が無い等）は許容。エラーで失敗した場合は `/tmp/vsce.log` を報告。
- **GATE 4**: `claude-code-usage-2.0.0.vsix`（または `*.vsix`）が生成されること。
  生成ファイル名を変数化して以降で使用:
  ```bash
  VSIX=$(ls -1t *.vsix | head -1); echo "VSIX=$VSIX"
  ```

---

## STEP 5: インストール

`code` CLI がある場合:
```bash
code --install-extension "$VSIX" --force
code --list-extensions | grep -i 'claude-code-usage' && echo "installed: OK"
```
Cursor の場合は `code` を `cursor` に置換。
- **GATE 5**: `--list-extensions` に `GrowthJack.claude-code-usage`（publisher.name）が出ること。
- `code`/`cursor` CLI が無い場合（GATE 0-2 不成立）: インストールは行わず、
  「VS Code の拡張パネル → … → VSIX からのインストール → `$VSIX` を選択」という
  **手動手順をユーザーに提示**して、このステップを skip と記録。

---

## STEP 6: 起動後の動作確認（可能な範囲）

エージェントは GUI 操作（ステータスバー目視）はできないため、確認できる範囲を実施する。

```bash
# 拡張ファイルが配置されたか
ls "$HOME/.vscode/extensions/"*claude-code-usage* 2>/dev/null \
  || ls "$HOME/.cursor/extensions/"*claude-code-usage* 2>/dev/null
```
- VS Code を再起動（または「ウィンドウの再読み込み」）すると `onStartupFinished` で起動し、
  右下ステータスバーにコスト等が表示される旨を報告に記載。
- データ表示の最終確認（ステータスバー/ツールチップ/クォータ%）は **人間の目視が必要** な旨を明記。

---

## STEP 7: ネットワーク最終確認（任意・推奨）

可能なら実通信先が公式のみであることを実環境で確認する（OS により方法が異なる）。
```bash
# macOS/Linux 例: VS Code 起動中に anthropic 以外への接続が無いか観察
# （Little Snitch / lsof -i / ss -tnp 等。環境に応じて実施し結果を報告）
```
公式（`*.anthropic.com`）以外への接続が観測されたら**重大所見として報告**。

---

## 報告フォーマット（実行後に必ず出す）

1. STEP 0 の前提結果（node/code/logs/creds の有無）
2. 各 GATE の合否（0〜5、可能なら 7）
3. STEP 3 の grep 実出力（forbidden=0件か、host 一覧）
4. 生成した `.vsix` 名、インストール結果
5. 表示確認が人間待ちなら、その旨と次にユーザーがやること
6. 異常・中断があればその箇所と原因

---

## 補足: 開発ホスト（F5）で試す場合（人間向け・任意）

VSIX を使わず一時的に試すなら、`packages/vscode` を VS Code で開き F5（Run Extension）。
これには `.vscode/launch.json` が必要。無ければ以下を作成する:

```json
// packages/vscode/.vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"],
      "preLaunchTask": "npm: compile"
    }
  ]
}
```
F5 は対話操作のためエージェントの自動検証には使わない（VSIX 経路を正とする）。
