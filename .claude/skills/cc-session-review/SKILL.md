---
name: cc-session-review
description: 指定した(または直近の)Claude Code セッションをレビューし、タスクの成否判定・無駄トークン分析・ループ検出・改善提案をレポートする。「このセッションを振り返って」「なぜうまくいかなかった?」「/cc-session-review [sessionId|latest]」で使用。
---

# cc-session-review — セッション・レトロスペクティブ

1つのセッション(会話)を題材に、**何が起きたか(事実)→ タスクは成功したか(判定)→
どこでトークンが無駄になったか → 次回どうするか**をレポートする。

事実の抽出は同梱の決定的スクリプトが行う。**生の transcript を直接読まないこと**
(巨大なため)。スクリプトの縮約 JSON だけを判断材料にする。

## 手順

### 1. 事実抽出スクリプトの実行

リポジトリルートの `scripts/extract-session.mjs` を実行する
(このスキルが cc-monitor リポジトリ外で使われている場合は
`~/.claude/cc-monitor/scripts/extract-session.mjs` を試し、無ければユーザーに場所を確認):

```
node scripts/extract-session.mjs                       # 引数なし → 全体の直近セッション
node scripts/extract-session.mjs --session <id>        # セッション ID 指定
node scripts/extract-session.mjs --project <substr>    # プロジェクト名(部分一致)の直近
```

- 引数が渡されていれば `--session` または `--project` に割り当てる(`latest` は引数なしと同じ)。
- 「今のセッション」を頼まれた場合: 現在進行中の会話自身が直近セッションのことが多い。
  その場合は「このレビューは進行中の自分自身を対象にしている」ことをレポートに明記する。

### 2. 補助データ(任意)

`~/.claude/cc-monitor/insights/latest.json` が存在し、`contextHealth.sessionId` が対象と
一致すれば、その signals(rot 判定・キャッシュバスト等)を判定材料に加える。

### 3. 成否判定(固定ルーブリック)

縮約 JSON から **completed / partial / abandoned** のいずれかを判定し、根拠を必ず添える:

| 証拠 | completed 寄り | abandoned 寄り |
|------|---------------|----------------|
| `finalAssistantText` | 完了報告・成果物の要約 | エラー報告・質問のまま終了 |
| `stopReasons` | end_turn で自然終了 | 直近が tool_use のまま途切れ |
| `errors` の時系列 | 終盤に向かい減少 | 終盤に集中・同種エラーの反復 |
| `repeatedCalls` | 少ない | 同一コマンド 4 回以上(ループ徴候) |
| `userPrompts` の末尾 | 承認・軽い追加依頼 | 方針転換・苛立ち・突然の無応答 |
| `promptGapsOver15Min` | — | 大きなギャップ後にトピックが変わり未完で放置 |

partial は「目的は前進したが未解決スレッドが残る」場合。判定に自信がない場合は
confidence(high/medium/low)を併記し、断定しない。

### 4. 無駄トークン分析

- `largeToolResults` 上位: 1 件 8,000 トークン超は「Read の offset/limit・Grep の絞り込みで
  回避できたか」を個別に検討。
- `cacheHitRatePct` が低い(< 50%)場合: セッションの中断・再開やモデル切替を疑う。
- `repeatedCalls`: 同一呼び出しの反復は「結果を保持せず再取得した」兆候。
- `usage.peakContextTokens` がモデル上限(Claude は約 200K)の 85% 超なら、
  どの時点で /clear またはハンドオフすべきだったかを推定する。

### 5. レポート生成

- 出力先: `reports/session-review-<sessionIdの先頭8文字>-YYYY-MM-DD.md`
- **ユーザーの会話言語で書く**。
- 構成:
  1. **判定**: completed / partial / abandoned + confidence + 根拠 3 点
  2. **セッション概要**: 期間・プロンプト数・ターン数・コスト関連数値・使用モデル
  3. **タイムライン narrative**: プロンプト見出しを使い「何を頼まれ→何をして→どう終わったか」を 5〜10 行で
  4. **エラーと迷走**: エラーの種類別整理(原因の意味分類)、ループ箇所
  5. **無駄トークン**: §4 の分析結果と「あったはずの安い代替手段」
  6. **次回への提案**: 3 点以内。プロンプトの書き方・CLAUDE.md への追記案・ツール運用の順で具体的に
- 生成後、判定と提案 3 点をチャットにも表示する。

## 制約

- レビューは読み取り専用。CLAUDE.md への追記等は**提案文面の提示まで**(適用はユーザー指示後)。
- 縮約 JSON に無い事実を補完しない。「ログからは不明」と書く。
- プロンプト原文の引用は判定根拠に必要な最小限(各 1〜2 行)に留める。
