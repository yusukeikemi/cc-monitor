---
name: cc-monitor-deploy
description: cc-monitor VSCode 拡張機能をビルドして、この PC の VSCode にインストール/更新する。バージョン採番・変更履歴更新・パッケージ化(VSIX)・確実な再インストール・反映確認まで。「拡張機能をビルドして入れて」「更新して」「デプロイして」「/cc-monitor-deploy」で使用。
---

# cc-monitor-deploy — 拡張機能のビルド & ローカル配備

cc-monitor VSCode 拡張機能を **ビルド → VSIX 化 → ローカル VSCode に確実にインストール**
するためのスキル。ハマりどころ(下記)を回避した手順で、毎回確実に新しいコードが反映される
ようにする。

対象ディレクトリ: リポジトリ内の `packages/vscode`(ソースとビルド設定はすべてここ)。

## 重要な落とし穴(必ず守る)

1. **git bash の `code` コマンドは効かない。** 出力が空のまま成功したように見えて、
   実際にはインストール/アンインストールが実行されない。**必ず PowerShell の
   `code.cmd` をフルパスで呼ぶ**:
   `C:\Users\<user>\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`
2. **同一バージョンへの `--install-extension --force` は上書きされない。** VSCode 起動中に
   同じ version 文字列(例 `2.0.0`)を再インストールしても、既存の展開フォルダが
   そのまま残り、古いコードが動き続ける。回避策は次の 2 系統:
   - **正式リリース系**: `package.json` の `version` を上げる(推奨。確実かつ追跡可能)。
   - **クイック再配備系**: 先に `--uninstall-extension` してから `--install-extension`。

## 前提確認

```
node -v                 # Node が入っているか
ls packages/vscode/node_modules   # 無ければ packages/vscode で npm install
```

PowerShell で CLI 動作確認(以降この `$code` を使う):

```powershell
$code = "C:\Users\thinkcyte\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"
& $code --list-extensions | Select-String "thinkcyte"   # 現在の導入状況
```

> ユーザー名が `thinkcyte` 以外の環境では `$env:USERPROFILE` からパスを組み立て直すこと。

## 手順 A: 正式リリース(コード変更を配る / 既定)

ソースを変更してリリースする場合はこちら。バージョンを上げることで上書き問題を完全回避する。

1. **バージョン採番**: `packages/vscode/package.json` の `version` を SemVer で上げる
   (バグ修正=patch, 機能追加=minor)。
2. **変更履歴**: `packages/vscode/changelog.md`(Keep a Changelog 形式)の
   `## [Unreleased]` を新バージョン見出しに繰り上げ、内容を整理する。
   - 注意: `*.md` はレビュー対象外だが、リリース時の更新は手順の一部として行う。
3. **ビルド & パッケージ**(`packages/vscode` で実行):
   ```
   npm run package   # = tsc コンパイル → @vscode/vsce で cc-monitor.vsix 生成
   ```
4. **インストール**(PowerShell):
   ```powershell
   & $code --install-extension "C:\Users\thinkcyte\source\repos\cc-monitor\packages\vscode\cc-monitor.vsix" --force
   ```
5. 手順 D で反映を確認 → 手順 E のリロードを案内。

## 手順 B: クイック再配備(同一バージョンのまま入れ替え)

開発中でバージョンを上げたくない / 上げ忘れた状態で確実に入れ替えたいとき。

1. **ビルド & パッケージ**(`packages/vscode`):
   ```
   npm run package
   ```
2. **アンインストール → インストール**(PowerShell。順番厳守):
   ```powershell
   & $code --uninstall-extension thinkcyte.cc-monitor
   & $code --install-extension "C:\Users\thinkcyte\source\repos\cc-monitor\packages\vscode\cc-monitor.vsix" --force
   ```
   - VSCode 起動中はアンインストール後も展開フォルダが残ることがあるが、続けて
     インストールすれば中身は新しいものに置き換わる(手順 D で必ず検証する)。

## 手順 C: package.json の npm スクリプト(参考)

`packages/vscode/package.json` には以下が定義済み:

- `npm run compile` — `tsc -p ./`(TypeScript コンパイルのみ)
- `npm run package` — VSIX 生成(prepublish で compile も走る)
- `npm run reinstall` — `package` + `code --install-extension --force`

> `reinstall` は **git bash から実行すると `code` が効かず失敗する**(落とし穴 1)。
> ローカル配備は本スキルの PowerShell 手順を使うこと。

## 手順 D: 反映確認(必須・スキップ禁止)

「成功しました」表示を信用せず、**展開後のファイルが新しいか**を必ず確認する。
ビルド成果物 (`packages/vscode/out/`) と導入済みコピーの新しさ・内容を突き合わせる。

```powershell
$dst = "$env:USERPROFILE\.vscode\extensions\thinkcyte.cc-monitor-<version>\out\statusBar.js"
"installed mtime: $((Get-Item $dst).LastWriteTime)"   # 直近ビルド日時と一致するか
```

- 導入済み `out/*.js` の更新日時が、今ビルドした `packages/vscode/out/*.js` と
  一致していれば OK。古い日付なら上書き失敗 → 手順 B でやり直す。
- 特定機能の有無を見たいときは、その機能のキーワードを導入済み `out/` 内で grep して
  件数が 0 でないことを確認する(例: セッションカードなら `sessionCard`)。

## 手順 E: 反映(ユーザーに案内)

拡張機能はインストールしても **メモリ上の旧バージョンが動き続ける**。ユーザーに
ウィンドウ再読み込みを案内する:

- `Ctrl+Shift+P` → **`Developer: Reload Window`**

> セッションカード等の表示は設定 `claudeCodeUsage.sessionCardRecencyMinutes`
> (既定 60 分)以内に活動したセッションのみ対象。直近セッションが無いと出ないため、
> Claude Code を動かした直後に確認するよう伝える。

## レポート(完了報告)

ビルド/インストールしたバージョン、手順 D の検証結果(導入済み mtime と一致したか)、
リロードの要否を簡潔に報告する。失敗していた場合は原因(落とし穴 1/2 のどちらか)を明記する。
