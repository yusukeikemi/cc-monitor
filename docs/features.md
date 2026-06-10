# cc-monitor 機能一覧（現状調査）

最終更新: 2026-06-10（コードベース実査に基づく）
対象: `packages/vscode/` — VS Code 拡張 "Claude Code Usage" v2.0.0

cc-monitor は、Claude Code のローカル会話ログ（`~/.claude/projects/**/*.jsonl`）を
オフラインで解析し、トークン消費量・推定コスト・公式クォータ（5時間 / 週次）・
コンテキスト健全性を VS Code 上で可視化する拡張機能。
OSS [`jack21/ClaudeCodeUsage`](https://github.com/jack21/ClaudeCodeUsage)（MIT）を
vendoring し、第三者通信機能（AI アドバイス・料金表オンライン更新）を除去したフォーク。

---

## 1. 設計方針とデータソース

| 項目 | 内容 |
|------|------|
| 通信先 | Anthropic 公式のみ: `api.anthropic.com/api/oauth/usage`（クォータ取得）と `console.anthropic.com/v1/oauth/token`（OAuth トークン更新） |
| トークン・コスト | 完全オフライン。ローカル JSONL の `message.usage` をバンドル料金表で換算 |
| ランタイム依存 | ゼロ（npm の runtime dependency なし。devDependencies のみ） |
| ログ探索パス | ① `CLAUDE_CONFIG_DIR` 環境変数（カンマ区切り複数可）→ ② `~/.config/claude/projects/`（XDG）→ ③ `~/.claude/projects/`。設定 `dataDirectory` で明示指定も可 |
| 重複排除 | `message.id` + `requestId` の合成キーでデデュープ（再開・リトライによる二重計上を防止） |
| 異常データ | 破損行・未知スキーマ行・`<synthetic>` モデル・API エラーレコード・全トークン 0 の行はスキップ |

### ソース構成

| ファイル | 役割 |
|---------|------|
| `src/extension.ts` | エントリポイント。コマンド登録・ポーリング・ファイル監視・キャッシュ管理 |
| `src/dataLoader.ts` | JSONL の探索・パース・デデュープ・各種集計・Content/Activity 分析・Context Health 算出 |
| `src/pricing.ts` | モデル別料金表とコスト計算・コンテキスト上限推定 |
| `src/claudeApiClient.ts` | OAuth クォータ API クライアント（fetch → curl フォールバック） |
| `src/quotaHistory.ts` | クォータ利用率スナップショットの永続化（JSONL 追記） |
| `src/statusBar.ts` | ステータスバー 4 アイテムの描画 |
| `src/webview.ts` | ダッシュボード（Webview、全10タブ、サーバーサイド SVG チャート） |
| `src/i18n.ts` | 6言語対応（en / de-DE / zh-TW / zh-CN / ja / ko）と数値・日時フォーマット |
| `src/types.ts` | 型定義 |

---

## 2. ステータスバー（4つのアイテム）

すべて右寄せで常駐し、クリックでダッシュボードを開く。

### 2.1 使用量インジケータ（`$(pulse)`）

- **今日のコスト**を主表示。アクティブセッション（直近5時間以内のレコード）があれば
  **セッションコスト**を `$(history)` 付きで併記。
- ホバーで Markdown テーブルのツールチップ:
  今日 / 現在セッションの「コスト・入出力トークン・キャッシュ作成/読取・メッセージ数」。
- ログ未検出時は「データなし」、エラー時は警告色で縮退表示。

### 2.2 クォータインジケータ（`$(dashboard) 5h:N% wk:N%`）

- 公式 OAuth API から取得した**実際の 5時間 / 週次の利用率**を表示。
- 利用率 **80% 以上で黄色、95% 以上で赤色**の背景に変化。
- ツールチップ: 5時間 / 週次 /（あれば）週次 Opus の利用率・リセットまでのカウントダウン・
  週次はリセット曜日+時刻も表示。
- 未サインイン・取得失敗時は非表示（他機能には影響しない）。

### 2.3 プロンプトキャッシュ余熱カウントダウン（`$(zap) M:SS`）

- 最後の API リクエストからの **5分キャッシュ TTL の残り時間**をカウントダウン表示
  （30秒間隔で独立更新）。
- 残り 1 分を切ると警告色。期限切れ・データなしの場合は非表示。
- ツールチップに最終リクエスト時刻と「各 API コールが TTL をリセットする」旨の説明。

### 2.4 Context Health インジケータ（`$(book) ▰▰▰▱▱ N%`）

- **アクティブセッションのコンテキストウィンドウ充填率**を 5 セグメントゲージ + % で表示。
- 状態は `healthy` / `watch` / `rot` の3段階。`rot` で警告アイコン + 警告色背景になり、
  支配的なツール結果が原因の場合はそのツール名を併記。
- ツールチップ: 窓サイズ（現在/上限）、成長スパークライン、成長ペース（tokens/min）と
  上限到達 ETA、内訳バー（カテゴリ別）、トピック別内訳、検出シグナル一覧、
  トピック切替候補時刻、`/clear` 推奨などのサジェスト。
- 設定 `contextHealthRotNotification`（既定 off）を有効にすると、セッションが初めて
  `rot` になった時に**1回だけトースト通知**（同一セッションは30分の沈黙後に再武装）。

---

## 3. コマンド（コマンドパレット）

| コマンド | 動作 |
|---------|------|
| `Refresh Usage Data` | 手動リフレッシュ |
| `Show Usage Details` | ダッシュボード Webview を開く |
| `Open Settings` | 拡張設定を開く |
| `Show Diagnostic Logs` | 出力チャネル「Claude Code Usage」を表示（API 通信等の診断ログ） |
| `Export Quota History` | クォータ履歴を CSV / JSON でエクスポート（保存ダイアログ） |
| `Open Quota History File` | `~/.claude/cc-monitor/quota-history.jsonl` をエディタで開く |

---

## 4. ダッシュボード（Webview・全10タブ）

クリックまたは `Show Usage Details` で開く。シェル構築後はインナーコンテンツのみ
差し替える方式で、リフレッシュ時の画面フラッシュを回避。

### 4.1 Today（今日）

- サマリカード（コスト・トークン4種・メッセージ数・コスト構成・キャッシュヒット率）。
- **時間別チャート**（積み上げトークン構成 / コスト等のメトリック切替タブ付き、
  Y軸・参照線・バーごとの値ラベルあり）。
- モデル別内訳（モデルごとのトークン・コスト・**$/Mtok 単価のインライン表示**）。

### 4.2 Month(今月) / 4.3 All Time(全期間)

- 月: 日別テーブル + 日別チャート。日をクリックすると**その日の時間別詳細**へドリルダウン。
- 全期間: 月別集計。月をクリックすると**その月の日別詳細**へドリルダウン。
- どちらもメトリック切替（コスト / 入出力 / キャッシュ作成・読取 / メッセージ数）。

### 4.4 Sessions（セッション）

- 1 会話（= 1 `.jsonl`）ごとの行。プロジェクト・期間・**ピークコンテキスト**
  （`/context` 相当の単一リクエスト最大窓サイズ）・コスト等。ソート可能。直近 50 件。
- 行から **Context Health タブへのドリルダウン**（任意のセッションを検査対象にピン留め）が可能。

### 4.5 Projects（プロジェクト）

- ワーキングディレクトリ別の集計。グルーピングは設定 `projectGroupingMode` で切替:
  - `git`（既定）: **囲っている git リポジトリ単位**でグループ化（ファイルシステムを遡上探索、キャッシュ付き）
  - `folder`: トップレベルフォルダのヒューリスティックのみ(fs 走査なし)
  - `flat`: ディレクトリごとに1行
- 大文字小文字のみ異なるパスはマージ。サブフォルダのドリルダウン・ソート対応。
- **キャッシュインサイト**（プロジェクト別のキャッシュヒット率等）も表示。

### 4.6 Content（コンテンツ分析）※`enableContentAnalysis` で無効化可

- **直近30日**を対象に、どの会話コンテンツがトークンを消費しているかを推定:
  ユーザープロンプト / アシスタント本文 / 思考(thinking) / ツール呼び出し / ツール結果。
- ツール結果は**ツール別の内訳**あり。
- トークン数は文字数からの推定（CJK は密度補正）。絶対値より**相対シェアが信頼できる**。

### 4.7 Branches（ブランチ）

- git ブランチ別（プロジェクト × ブランチ）の使用量集計。コスト降順、ソート可能。

### 4.8 Activity（アクティビティ）※Content 分析と同じパスのため `enableContentAnalysis` に連動

直近30日の**正確なカウント**（トークン推定ではなくログ由来の実数）:

- サマリカード: ツール呼び出し総数 / エラー率 / プロンプト数 / **作成 PR 数** /
  編集ファイル数 / 追加・削除行数 / git 操作数 / **ユーザー手直し率**
  （Claude の編集を後から人間が修正した割合）。
- **ツール別テーブル**: 呼び出し数・エラー数・エラー率・平均所要時間。
- **スキル別**バーリスト(Skill ツールの内訳)。
- **サブエージェント別テーブル**: agent type ごとの回数・実トークン・ツール使用数・平均所要時間
  (`toolUseResult` からサブエージェント自身の実コストを取得)。
- ターン結果（stop_reason 別）/ パーミッションモード別の分布。
- **メイン vs サブエージェントの出力トークン分配**バー。
- **トークン効率カード**: ターンあたり平均出力 / thinking シェア / サブエージェント
  トークン合計・平均（サブエージェント ROI の判断材料）。
- **7×24 アクティビティヒートマップ**（曜日×時間のアシスタントターン数）。
- 直近セッションのタイトル一覧（auto-generated title）。

### 4.9 Quota（クォータ履歴）

- 最新値テーブル（5時間 / 週次 / 週次 Opus の利用率とリセット時刻）。
- **時系列ラインチャート**（直近30日、サーバーレンダリング SVG、0–100%）。
- **時間帯別消費ヒートマップ**: 5時間クォータ利用率の正の増分を時刻バケットに集計
  （どの時間帯にクォータを使っているか）。
- 履歴の仕組みは §6 参照。

### 4.10 Context Health ※`enableContextHealth` で無効化可

アクティブセッション（または Sessions タブからピン留めしたセッション）の詳細診断:

- ステータスバッジ（healthy / watch / rot）+ プロジェクト・モデル表示。
- ウィンドウ充填バー(現在トークン / モデル上限・ピーク・成長ペース・上限到達 ETA)。
- **成長チャート**（セッション中のコンテキスト窓サイズ推移、SVG）。
- **構成ドーナツチャート**（カテゴリ別シェア）。
- **トークン効率カード**:
  - キャッシュヒット率（Σcache_read / 入力側合計、バッジ色分け: ≥50% 良 / ≥20% 中 / それ未満 低）
  - **キャッシュバスト検出**: キャッシュ済みプレフィックスの再書き込みイベント数と
    無駄トークン・無駄 USD（書込1.25x と読取0.1x の差額で算出）+ 改善レコメンド
  - **起動ベースライン**（システムプロンプト+ツールスキーマ+CLAUDE.md ≒ 初回リクエストのプレフィックス。25K 超で警告）
  - **回収可能トークン**(8,000 トークン超の個別ツール結果の超過分合計)
  - **全文 Read 回数**（offset/limit なしの Read 呼び出し）
  - **コンテキスト別エラー率**(窓の前半 vs 後半のツールエラー率比較 — 長さ起因の品質劣化の代理指標)
  - **同一呼び出しの最多反復**（ループ/スノーボール検出）
- **トピックタイムライン**: プロンプト間隔 45 分以上のギャップでセッションをトピック分割し、
  トークン加重で表示。最大ギャップ = トピック切替候補時刻。
- **シグナルカード**（検出された context rot シグナル一覧）と `/clear` 等のサジェスト。

#### Context Health のシグナル（全10種、すべてオフラインヒューリスティック）

| シグナル | 条件 |
|---------|------|
| `nearLimit` | 充填率 ≥ 85% |
| `largeToolResult` | 単一ツールの結果がコンテンツの ≥35% かつ >5,000 トークン |
| `staleContext` | 充填率 ≥60% かつ ツール結果+thinking が ≥60%、新規ユーザー入力 ≤10% |
| `redundantReads` | 同一ファイルの Read が 3 回以上 |
| `multiTopic` | プロンプト間に 45 分以上のギャップ |
| `cacheBust` | キャッシュ再書き込みの無駄が ≥20,000 トークン |
| `largeBaseline` | 起動ベースライン ≥25,000 トークン |
| `fullFileReads` | 全文 Read が 5 回以上 |
| `contextDegradation` | 窓後半のエラー率が前半の 1.5 倍以上(かつ ≥10%) |
| `repeatedCalls` | 同一の非 Read ツール呼び出しが 4 回以上 |

**ステータス判定**: 充填率 ≥85%、または `largeToolResult`、または(`multiTopic` かつ充填率 ≥60%)
→ `rot`。充填率 ≥60% またはシグナルが1つ以上 → `watch`。それ以外 → `healthy`。

---

## 5. クォータ取得の仕組み（OAuth）

- Claude Code 自身のサインイン情報を再利用（設定不要）:
  1. `~/.claude/.credentials.json` を読み取り
  2. macOS では **login Keychain**（`Claude Code-credentials`）からも取得可
- トークン期限切れ時は `console.anthropic.com/v1/oauth/token` で自動リフレッシュ。
  Keychain 由来の場合はファイルへ書き戻さずメモリ保持のみ（Claude Code 管理の項目を壊さない）。
- **HTTP 戦略**: まず Node 組み込み `fetch`。Anthropic エッジの TLS フィンガープリント
  (JA3/JA4)拒否で `403 "Request not allowed"` が返る場合は**システムの `curl` バイナリへ
  フォールバック**（以後 curl を優先）。Windows は `curl.exe` を明示。
- レート制限: 429 受信で **5 分間クールダウン**。401 は強制トークンリフレッシュ後に1回だけ再試行。
- 結果は **2 分間メモリキャッシュ**。取得失敗時は最後の既知値を表示し続ける。
- 全ステップを出力チャネル「Claude Code Usage」へ診断ログ出力（トークン自体は出力しない）。

## 6. クォータ履歴の記録

- 取得のたびにタイムスタンプ付きスナップショットを
  `~/.claude/cc-monitor/quota-history.jsonl` へ追記（`recordQuotaHistory`、既定 true）。
- **同一値の連続行はスキップ**（プロセス再起動をまたいでも初回にファイル末尾からシード）。
- 制約: 拡張が動作中のみ蓄積 / API は現在値のみ返すため**過去の遡及記録は不可** /
  粒度は実質数分間隔(API 2分キャッシュ × ポーリング既定60秒)。
- ダッシュボード Quota タブ表示は直近 30 日分に限定（描画コスト対策）。エクスポートは全量。

---

## 7. 料金計算（pricing.ts）

- **Anthropic 公式料金**（2026-05-21 検証済み）をバンドル:
  - Opus 現行 ($5/$25)・Opus レガシー 4/4.1 ($15/$75)・Sonnet ($3/$15)・
    Haiku 4.5 ($1/$5)・Haiku 3.5 ($0.8/$4)
  - キャッシュ書込 = 入力単価の 1.25 倍(5分キャッシュ)、キャッシュ読取 = 0.10 倍
- プロキシ経由で Claude Code に接続しうる**非 Anthropic モデルの参考料金**も同梱:
  OpenAI (GPT-5.x/4.1/4o/o3/o4-mini)・Gemini 2.x・Moonshot Kimi・Zhipu GLM・Alibaba Qwen
  （中国系は RMB 換算の概算）。
- **ファミリー推定フォールバック**: 未知のモデル ID はファミリー（opus/sonnet/haiku/gpt/
  gemini/kimi/glm/qwen）を検出して現行ティアの料金を適用。完全に不明なら Sonnet 料金。
- コストは入力 / 出力 / キャッシュ書込 / キャッシュ読取の**4成分に分解**して集計
  （ダッシュボードのコスト構成表示に使用）。
- **コンテキスト上限の推定**: Claude = 200K、GPT-5 系 = 400K、Gemini = 1M、既定 200K
  （Context Health の充填率算出に使用。1M ベータ等は考慮外のため目安）。
- オンライン料金更新は**意図的に非搭載**(第三者通信排除のため除去済み。
  `runtimePricingOverrides` の器のみ将来用に残置)。

---

## 8. 設定一覧（`claudeCodeUsage.*`）

| 設定 | 既定 | 内容 |
|------|------|------|
| `refreshInterval` | 60 | ポーリング間隔(秒、最小30) |
| `dataDirectory` | "" | Claude データディレクトリの手動指定（空 = 自動検知） |
| `language` | auto | 表示言語（auto / en / zh-TW / zh-CN / ja / ko ※de-DE もコード上対応） |
| `decimalPlaces` | 2 | コスト表示の小数桁(0–4) |
| `compactNumbers` | false | 大きな数を `1.2M` / `345K` 形式で表示 |
| `timezone` | "" | 日付表示用 IANA タイムゾーン（devcontainer 等向け。日境界計算はシステム TZ のまま） |
| `usageLimitTracking` | true | OAuth クォータインジケータの有効/無効 |
| `recordQuotaHistory` | true | クォータ履歴の記録（`usageLimitTracking` 必須） |
| `enableContentAnalysis` | true | Content / Activity タブと CPU 重めのテキスト解析の有効/無効 |
| `enableContextHealth` | true | Context Health インジケータ + タブの有効/無効 |
| `contextHealthRotNotification` | false | `rot` 初回検出時の1回限りトースト通知（オプトイン） |
| `projectGroupingMode` | git | Projects タブのグルーピング（git / folder / flat） |
| `exportInsights` | true | 集計スナップショットを `~/.claude/cc-monitor/insights/latest.json` に書き出し（Claude Code スキル連携用。ローカル書き込みのみ） |

---

## 9. パフォーマンス・安定性の設計

- **アイドル認識リフレッシュ**: 全 `.jsonl` の最新 mtime を見て、前回ロード以降に変更が
  なければ重い再計算をスキップ（クォータ・キャッシュ余熱の独立更新のみ）。
- **ファイル監視**: `fs.watch`（recursive）で `projects/` を監視し、変更を 1.5 秒デバウンス
  して即時リフレッシュ → ステータスバーが新しい使用量を約 1.5 秒で反映
  （recursive watch 非対応環境ではポーリングへ静かにフォールバック）。
- **ノンブロッキングロード**: 25 ファイルごとにイベントループへ yield し、大きな履歴でも
  拡張ホスト（= 同居する Claude Code 拡張）をフリーズさせない。
- Webview は**シェル維持 + 内容差し替え**で更新時のフラッシュなし
  （`retainContextWhenHidden` 有効）。
- 破損行・読めないファイルは警告ログのみで継続（fail-safe）。

## 10. 国際化（i18n）

- 対応言語: 英語 / ドイツ語 / 繁体中文 / 簡体中文 / 日本語 / 韓国語(`auto` で VS Code の表示言語から検出)。
- 数値・日時は選択ロケールで一貫フォーマット（桁区切り・日付順序）。
- 「Today HH:MM」「Yesterday HH:MM」等の読みやすい相対タイムスタンプ。

## 11. Claude Code スキル連携（LLM 分析）

外部 API を使わず、**ユーザー自身の Claude Code セッション（サブスク枠内）**で実行する
LLM 分析。設計は `docs/llm-features-implementation-plan.md` 参照。

- **データインターフェース**: 拡張がリフレッシュごとに集計スナップショットを
  `~/.claude/cc-monitor/insights/latest.json` へアトミック書き込み
  （`exportInsights`、既定 true）。会話本文は含めない。
- **`/cc-usage-advice`**（`.claude/skills/cc-usage-advice/`）: スナップショット +
  クォータ履歴から最適化アドバイスレポートを `reports/` に生成。
- **`/cc-session-review [sessionId|latest]`**（`.claude/skills/cc-session-review/`）:
  `scripts/extract-session.mjs`（zero-dep・読み取り専用・決定的）がセッション JSONL を
  縮約 JSON（エラー一覧・反復呼び出し・大型ツール結果・プロンプト見出し・usage 集計）に
  変換し、LLM が成否判定（completed/partial/abandoned + 根拠）・無駄トークン分析・
  改善提案を執筆。
- 原則: **事実の抽出は決定的コード、解釈・執筆のみ LLM**。書き込みはレポート生成のみで、
  設定や CLAUDE.md の変更は提案に留める。

---

## 12. 既知の注意点・ドキュメントとの差異

調査で見つかった、コード実体と既存ドキュメントの不一致:

1. **`docs/requirements.md` との差異**: 要件ではクォータ取得は「既定オフのオプトイン」
   (F-20 では最短180秒ポーリング)だが、実装は `usageLimitTracking` **既定 true**・
   2分キャッシュ + ポーリング(既定60秒)。また要件のアーキテクチャ
   (`core` / `cli` パッケージのモノレポ)は未実装で、現状は `packages/vscode` のみ
   （要件書 §5 の注記どおり vendoring 方針へ変更され、core/cli は次フェーズの任意課題）。
2. **差分読み込み（F-3）は未実装**: 変更検知時はファイル全読みし直す方式
   （mtime ゲートとデデュープで実害を抑えている）。
3. トークン推定（Content / Context Health の内訳）は文字数ベースの近似であり、
   絶対値ではなく相対シェアを見るのが正しい使い方。
4. `seven_day_sonnet`（要件 F-19 に記載）は現実装ではパース対象外
   (`five_hour` / `seven_day` / `seven_day_opus` のみ)。

> 注: 旧 CHANGELOG に残っていた削除済み機能（AI advice / Refresh Model Pricing）の
> 記載は 2026-06-10 に整理済み — 2.0.0 の「Removed (vendoring security audit)」節を参照。
