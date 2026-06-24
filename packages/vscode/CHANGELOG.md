# Changelog

All notable changes to this fork compared to upstream
[`jack21/ClaudeCodeUsage`](https://github.com/jack21/ClaudeCodeUsage) (last
upstream release: 1.0.8). Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

## [2.0.1] - 2026-06-24

### Fixed

- **OAuth token refresh 400 error**: `getValidCredentials()` was caching credentials
  in memory after the first load. When Claude Code CLI rotated the refresh token and
  wrote new credentials to `.credentials.json`, cc-monitor kept using the stale
  in-memory token, causing every subsequent refresh attempt to fail with HTTP 400.
  Fixed by always re-reading from disk so we pick up tokens already refreshed by
  Claude Code itself.

### Changed

- **Per-session status-bar cards.** The model, prompt-cache warmth and Context
  Health % indicators were three separate, machine-global items — when several
  Claude Code sessions ran at once you couldn't tell which session's cache or
  context they reflected (the readout followed whichever session wrote last).
  They are now merged into **one minimal card per active session** (`$(pulse)
  project model 78% $(zap)3:24`), so each card's model / context / cache always
  belong to a single, identifiable session. Cards appear and disappear as
  sessions start and go idle. New settings: `claudeCodeUsage.maxSessionCards`
  (default 5) and `claudeCodeUsage.sessionCardRecencyMinutes` (default 60). The
  global summary item now shows today's total cost; the quota item is unchanged.
  Context-rot notifications are now debounced per session and name the project.
  Each card's hover also shows that session's **opening prompt** (first
  human-typed prompt, ≤100 chars; `isMeta` lines and `/clear`-style slash
  commands skipped) as a quick "which session is this?" cue.

### Added

- **Insights snapshot export** (`claudeCodeUsage.exportInsights`, default true):
  on each full refresh the extension writes its computed aggregates (usage,
  activity, context health, latest quota) to
  `~/.claude/cc-monitor/insights/latest.json` — a local, machine-readable
  interface for the new Claude Code skills. Conversation text (prompts) is
  deliberately excluded from the snapshot.
- **Claude Code skills** (repo-level, subscription-scope LLM analysis — no
  external APIs, no headless `claude -p`):
  - `/cc-usage-advice` — usage/cost/quota optimisation advice generated from
    the insights snapshot (secure revival of the removed upstream AI-advice
    feature; data goes to Anthropic only, via the user's own session).
  - `/cc-session-review` — per-session retrospective with a success verdict
    (completed / partial / abandoned), wasted-token analysis, loop detection
    and improvement suggestions, fed by the deterministic
    `scripts/extract-session.mjs` extractor (zero-dep, read-only).

### Fixed

- **Context Health silently broken when logs carry `cwd`** (i.e. always, on
  current Claude Code): `getContextHealth` joined the record's real working
  directory under `~/.claude/projects/`, producing an invalid path, so the
  indicator/tab/snapshot returned null. Records now carry the encoded on-disk
  log folder (`_logDir`) and the lookup uses it. Surfaced by the insights
  snapshot verification.
- **Claude Fable 5 pricing**: was falling back to Sonnet rates ($3/$15);
  added the real tier ($10/$50, cache write $12.50, cache read $1.00 per
  MTok) plus a `fable` family fallback. Historical cost figures for Fable
  sessions were under-reported ~3.3x and will correct on next refresh.
- **1M context windows**: Fable 5, Opus 4.6/4.7/4.8 and Sonnet 4.6 now use a
  1,000,000-token window for the Context Health fill ratio (previously all
  Claude models were assumed 200K, producing >100% fill). The observed peak
  also clamps the limit as a lower bound for unknown models.
- **Context Health picked up `<synthetic>` records as the latest window
  state**: when the most recent assistant line was a synthetic/error record
  (zero usage), the indicator reported model `<synthetic>` and 0% fill.
  Synthetic, error and zero-token records are now skipped, mirroring
  calculateUsageData.

## [2.0.0] — 2026-05-26

### Removed (vendoring security audit)

Two upstream features that communicate with third-party (non-Anthropic) servers
were removed when this codebase was vendored (see
[`docs/security-audit-jack21.md`](../../docs/security-audit-jack21.md)):

- **AI advice** (`Get AI Usage Advice` command, `advisor.ts`, `advice.*`
  settings) — sent usage summaries and samples of the user's actual prompts to
  an OpenAI-compatible endpoint (DeepSeek by default).
- **Online pricing refresh** (`Refresh Model Pricing` command) — fetched the
  LiteLLM pricing dataset from `raw.githubusercontent.com`. Only the bundled
  pricing table is used now.

As a result, the extension communicates with official Anthropic domains only.

### Added

#### Pricing accuracy
- **Opus 4.6 / 4.7 / Sonnet 4.5 / Sonnet 4.6 / Haiku 4.5** added to the pricing
  table (verified against the official Anthropic pricing page).
- Reference pricing for common non-Anthropic models that may appear in proxied
  Claude Code setups: **OpenAI** (GPT-5.x, 4.1.x, 4o, o3, o4-mini), **Google
  Gemini** (2.5 Pro/Flash, 2.0 Flash), **Moonshot Kimi** (K2 / K2.5 / K2.6),
  **Zhipu GLM** (4.5 / 4.5-Air / 4.6) and **Alibaba Qwen** (Max / Plus /
  Turbo / Long).
- **Family-aware pricing fallback**: unknown model snapshots are now priced
  against the current tier of their detected family (Opus / Sonnet / Haiku /
  GPT / Gemini / Kimi / GLM / Qwen) instead of always falling back
  to Sonnet 4.
- **Per-model rates** displayed inline in the model breakdown section.

#### Quota tracking (real `/usage` data)
- **5-hour and weekly limit utilisation** + reset times fetched via Claude
  Code's own OAuth session at `~/.claude/.credentials.json` →
  `api.anthropic.com/api/oauth/usage`. Zero configuration. _Approach adapted
  from upstream [PR #9](https://github.com/jack21/ClaudeCodeUsage/pull/9) by
  [@Dobidop](https://github.com/Dobidop)._
- Dedicated, quieter status-bar item shows `5h:N% wk:N%`; warns yellow at
  ≥80%, red at ≥95%.
- Tooltip is a Markdown table with utilisation, reset countdown and weekly
  reset weekday/time.

#### Usage insights
- **Sessions tab** — usage per conversation (one row per `.jsonl` file), with
  project, peak context window, duration and a session-id tooltip. Sortable.
- **Projects tab** — usage aggregated per working directory. Paths that differ
  only in case are merged. Projects are grouped (configurably) by their
  enclosing git repository with sub-folder drill-down. Sortable.
- **Content tab** — estimated breakdown of which conversation content consumes
  tokens (your prompts vs. tool results by tool vs. assistant output /
  thinking), scoped to the last 30 days.
- **Branches tab** — usage aggregated per git branch.
- **Stacked token-composition chart** on the daily / monthly / hourly views,
  with Y-axis and reference lines.
- **Today's hourly chart** now has a Y-axis, two dashed reference lines and a
  value label on every bar; tooltip no longer repeats the hour.
- **Cost composition** in the usage summary: how much of the cost comes from
  input / output / cache-write / cache-read tokens.
- **Cache hit rate** metric in the usage summary.
- **Peak context** column on the Sessions tab, mirroring what `/context`
  reports for a single request.

#### Quality-of-life
- **Status-bar tooltip** is now an aligned Markdown table.
- Status bar also shows the **current-session cost** next to today's cost.
- **Compact number format** option (`1.2M` / `345K`).
- **Reading-friendly timestamps** ("Today HH:MM", "Yesterday HH:MM",
  "MM-DD HH:MM", "YYYY-MM-DD").
- **Sortable columns** on Sessions / Projects / Branches tabs.

#### Settings (all opt-in)
- `enableContentAnalysis` — toggle the Content tab + analysis pipeline.
- `projectGroupingMode` — `git` (default), `folder` (no fs walk) or `flat`.
- `compactNumbers` — toggle `1.2M`/`345K` formatting.
- `usageLimitTracking` — enable/disable the OAuth quota indicator.

### Changed

- **OAuth usage API calls now go through the system `curl` binary** instead
  of Node's `fetch` / `https`. Reason: Anthropic's edge now rejects
  requests whose TLS ClientHello (JA3/JA4) does not match a real CLI
  client — Node's openssl handshake gets `403 "Request not allowed"` from
  both the usage and token-refresh endpoints, while the same bearer token
  works fine through `curl`. `curl.exe` ships with Windows 10+ (2018) and
  is universally available on macOS / Linux, so this is portable. If
  `curl` is missing the quota indicator just stays hidden, like before.

### Fixed

- **Opus 4.5** 5-minute cache-write rate: was `$6.00 / MTok`, corrected to
  `$6.25 / MTok` (= 1.25× the input rate).
- **Haiku 3.5** 5-minute cache-write rate: was `$1.60 / MTok` (that's the
  1-hour rate), corrected to `$1.00 / MTok`.
- `claudeCodeUsage.decimalPlaces` setting was ignored by `formatCurrency` —
  now respected throughout the UI.
- Cache metrics renamed to **"Input Cache (Miss/Hit)"** for clarity.
- **Hard-coded Traditional Chinese strings** in the drill-down views
  (`renderHourlyData`, `renderDailyData`, `renderDailyChart`) replaced with
  proper i18n — non-zh-TW users no longer see Chinese in the daily/hourly
  detail panels. Affected closing upstream **PR #8** in spirit.
- **Light theme tab visibility**: tab labels inherited a white foreground
  on light themes and became unreadable. Fixed by setting an explicit
  `color: var(--vscode-foreground)` on `.tab`. **Closes upstream #11.**
- All `toLocaleString` / `toLocaleDateString` calls now pass the user's
  selected locale explicitly, so thousands-separators and date order match
  the UI language (German `.`, English `,`, etc.). Aligned with upstream
  **PR #8**'s locale-aware approach.

### Personalisation

- `enableContentAnalysis` (default true) — toggle the Content tab + analysis pipeline.
- `projectGroupingMode` — `git` (default), `folder` (no fs walk) or `flat`.
- `timezone` — IANA timezone name for date display (e.g. `Asia/Hong_Kong`,
  `UTC`). Useful inside sandboxes / devcontainers whose system timezone
  doesn't match the user's actual zone. **Closes upstream #10.**
- `compactNumbers` — toggle `1.2M`/`345K` formatting.
- `usageLimitTracking` — enable/disable the OAuth quota indicator.

### Issues closed by this release

- **#7** Phantom `ccusageIntegration.js` in published `.vsix` — this release
  is built from clean source; the file does not exist. `.claude/**` and
  `.github/**` added to `.vscodeignore` as a belt-and-braces measure.
- **#10** Preferred timezone configuration — see `timezone` setting above.
- **#11** Display anomaly under light theme — fixed.
- **#13** "Feature request: % used" — fulfilled by the real OAuth quota
  indicator described above.

### Performance & stability

- **Idle-aware refresh**: when no log file has changed since the last load,
  the refresh skips the recompute and only updates the (independent) quota
  indicator. Idle ticks now do near-zero work.
- **Non-blocking refresh**: the loader yields to the event loop every 25
  files so a large history no longer freezes the extension host (and the
  Claude Code extension that shares it).
- Refresh uses an `mtime`-based check instead of a fixed 1-minute cache age.

### Acknowledgements

Based on [`jack21/ClaudeCodeUsage`](https://github.com/jack21/ClaudeCodeUsage)
MIT-licensed. Significant inspiration / patches from upstream
PRs:

- [#9](https://github.com/jack21/ClaudeCodeUsage/pull/9) — Real 5-hour and
  weekly usage limit tracking via the Anthropic OAuth API, by
  [@Dobidop](https://github.com/Dobidop). The OAuth approach in this fork is
  adapted from that PR.

Many code changes in this fork were drafted with assistance from
[Claude Code](https://claude.com/claude-code) (commits credit
`Co-Authored-By: Claude <noreply@anthropic.com>`).

---

## Pre-2.0 history (upstream 1.0.x)

Released under [`jack21/ClaudeCodeUsage`](https://github.com/jack21/ClaudeCodeUsage)
before the 2.0 fork.

## [1.0.8] — 2025-11-28

- Converted all code comments from Traditional Chinese to English.
- Improved code internationalisation standards.
- Pricing: added Opus 4.5 / Haiku 4.5 rates (thanks to
  [@mxzinke](https://github.com/mxzinke)).
- Added German (de-DE) translation support (thanks to
  [@mxzinke](https://github.com/mxzinke)).

## [1.0.7] — 2025-11-28

- Multilingual translation support for hourly usage labels.
- Removed hardcoded Chinese text from code; replaced with i18n
  translation system.

## [1.0.6] — 2025-08-10

- Added support for Claude Opus 4.1 model pricing
  (`claude-opus-4-1-20250805` / `claude-opus-4-1`).
- Pricing matches Opus 4 ($15 / $75 per MTok).

## [1.0.5] — 2025-01

- Hourly usage statistics and visualisation.
- Dashboard hourly breakdown.

## [1.0.4] — 2025-01

- All-time data calculation.
- "All Time" translations across supported languages.

## [1.0.3] — 2025-01

- GitHub repository URL migration.
- README image-link fixes.

## [1.0.0] — 2025-01

- Initial complete release.
- Status-bar usage monitoring.
- Multi-language support (en / zh-TW / zh-CN / ja / ko).
- Analytics dashboard with charts and tables.
- Theme integration and responsive design.
