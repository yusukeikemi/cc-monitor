export interface ClaudeUsageRecord {
  timestamp: string;
  version?: string;
  message: {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    model?: string;
    id?: string;
  };
  costUSD?: number;
  requestId?: string;
  isApiErrorMessage?: boolean;
  // --- Fields populated by the loader from each record's source .jsonl file ---
  // (a single .jsonl file == a single Claude Code conversation/session)
  _sessionId?: string;
  // Encoded folder name under <claudeDir>/projects/ that holds the source
  // .jsonl — needed to re-open the file (_projectPath holds the real cwd,
  // which is NOT the on-disk folder name).
  _logDir?: string;
  _projectName?: string;
  _projectPath?: string;
  _gitBranch?: string;
}

export interface UsageData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCost: number;
  // Cost split by token type (the four sum to totalCost).
  costBreakdown: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
  messageCount: number;
  modelBreakdown: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
    count: number;
  }>;
}

export interface SessionData extends UsageData {
  sessionStart: Date;
  sessionEnd: Date;
}

// Per-conversation breakdown: one entry per Claude Code session (.jsonl file).
export interface SessionUsage {
  sessionId: string;
  projectName: string;
  projectPath: string;
  startTime: Date;
  endTime: Date;
  data: UsageData;
  // Largest context window observed in the session
  // (input + cache read + cache creation tokens of a single request).
  peakContextTokens: number;
}

// Per-project breakdown: usage aggregated across every session of a project.
export interface ProjectUsage {
  projectName: string;
  projectPath: string;
  sessionCount: number;
  firstSeen: Date;
  lastSeen: Date;
  data: UsageData;
}

// A group of projects. Projects are grouped by their enclosing git repository
// when one exists, otherwise by their top-level project folder. Projects whose
// paths differ only in case are merged into a single child.
export interface ProjectGroup {
  groupName: string;
  groupPath: string;
  isGitRepo: boolean;
  projectCount: number;
  sessionCount: number;
  firstSeen: Date;
  lastSeen: Date;
  data: UsageData;
  children: ProjectUsage[];
}

// One slice of the content-consumption analysis (a category, or a single tool).
export interface ContentSlice {
  key: string;
  estimatedTokens: number;
  charCount: number;
  count: number;
}

// Estimated breakdown of which conversation content consumes tokens. Token
// figures are estimated from character counts, so treat them as approximate —
// the relative shares are the reliable signal.
export interface ContentAnalysis {
  categories: ContentSlice[];
  toolResultBreakdown: ContentSlice[];
  totalEstimatedTokens: number;
}

// --- Context Health (the live status-bar indicator) ---
// One heuristic "context rot" signal detected in the active session. All signals
// are computed offline from the conversation log — no LLM judgement is involved.
export interface ContextRotSignal {
  kind:
    | 'nearLimit'
    | 'largeToolResult'
    | 'staleContext'
    | 'redundantReads'
    | 'multiTopic'
    | 'cacheBust'
    | 'largeBaseline'
    | 'fullFileReads'
    | 'contextDegradation'
    | 'repeatedCalls'
    | 'largeUserPrompt'
    | 'stuckSession';
  // Contextual numbers for the renderer (a percentage, a count, or minutes,
  // depending on `kind`).
  value?: number;
  // Contextual label for the renderer (e.g. a tool name or file name).
  label?: string;
}

// One cache-bust event with its likely cause, so the renderer (and the
// cc-usage-advice skill) can tell the user *what* broke the cache, not just
// how often it broke.
export interface CacheBustEvent {
  at: string; // ISO timestamp of the turn that re-wrote the prefix
  // ttlExpiry: >5min gap since the previous turn (the prompt cache expired);
  // modelSwitch: the model changed between turns; parallel: requests fired
  // near-simultaneously, each re-writing the prefix before the first response
  // could warm the cache; other: prefix churn (system prompt / tool schema
  // changes) with no obvious trigger.
  cause: 'ttlExpiry' | 'modelSwitch' | 'parallel' | 'other';
  wastedTokens: number; // cache-write tokens of the re-written prefix
}

// Live health of the currently-active session's context window. Estimated
// offline from the single .jsonl of the most recently updated session.
export interface ContextHealth {
  sessionId: string;
  projectName: string;
  model: string;
  contextTokens: number; // current window size (input + cache read + cache write of the latest request)
  peakContextTokens: number;
  contextLimit: number; // approximate model context-window size
  fillRatio: number; // contextTokens / contextLimit (0-1)
  // Estimated composition of what fills the window (userPrompts, assistantText,
  // assistantThinking, toolCalls, toolResults), sorted by token share.
  composition: ContentSlice[];
  // Largest tool-result contributors (top few).
  topToolResults: ContentSlice[];
  signals: ContextRotSignal[];
  // --- Token-efficiency metrics (session-level, computed offline from the
  // usage fields and tool blocks; no LLM judgement involved). ---
  // Share of input-side tokens served cheaply from cache across the session:
  // Σcache_read / Σ(cache_read + cache_creation + input). 0-100.
  cacheHitRate: number;
  // Prefix-break events where an already-cached prefix had to be re-written
  // (e.g. a mid-session model switch or system/tool churn), and the tokens / $
  // those costly re-writes wasted versus keeping the cache warm.
  cacheBustCount: number;
  cacheWastedTokens: number;
  cacheWastedUSD: number;
  // Individual bust events, time-ordered, each attributed to a likely cause.
  cacheBusts: CacheBustEvent[];
  // Estimated total cost of this session (per-turn usage × model pricing) and
  // the share of it wasted on cache re-writes. Research baseline: strategic
  // cache management saves 41-80% on agentic workloads (arXiv:2601.06007).
  sessionCostUSD: number;
  cacheWastePct: number;
  // What-if: input-side tokens (cumulative across every later request, so the
  // figure can far exceed the window size) that would have disappeared if tool
  // outputs older than ~10 assistant turns had been masked, and what they cost
  // at the cache-read rate. Simple observation masking matches LLM
  // summarization at less than half the cost (arXiv:2508.21433), so a large
  // value = cheap savings on the table.
  maskingSavingsTokens: number;
  maskingSavingsUSD: number;
  // Input-side tokens (incl. cache) paid per output token. Agent workloads run
  // 2:1-150:1 (arXiv:2605.09104); an extreme ratio means the session carries
  // far more context than it produces.
  inputOutputRatio: number;
  // Waste accounting (arXiv:2605.09104 splits agent spend into production /
  // communication / waste): tokens spent on failed work — cache re-writes plus
  // the outputs of tool calls that errored.
  errorToolResultTokens: number;
  wasteTokens: number;
  // Per-session startup baseline (system prompt + tool schemas + CLAUDE.md),
  // approximated by the first request's written/processed prefix. A large
  // baseline is paid on every session regardless of the work.
  baselineTokens: number;
  // Tokens reclaimable by truncating oversized individual tool results to a cap.
  reclaimableTokens: number;
  // Read tool calls that dumped a whole file (no offset/limit line range).
  fullFileReads: number;
  // Largest single user-role message in the session (estimated tokens),
  // including harness-injected content (skill bodies, command expansions). A
  // huge value means pasted or injected content entered the window — it then
  // stays billable for every following turn.
  largestUserPromptTokens: number;
  // Quality-aware context-rot proxy: tool-error rate (%) in the lower vs upper
  // half of the context window — a local stand-in for length-driven
  // degradation. -1 when there isn't enough sample to compute.
  errorRateLowCtx: number;
  errorRateHighCtx: number;
  // Snowball / looping: the most-repeated identical (non-Read) tool call in the
  // session, and a readable label (the tool name) for it.
  maxRepeatedCall: number;
  maxRepeatedCallLabel: string;
  status: 'healthy' | 'watch' | 'rot';
  // Down-sampled context-window sizes over the session, oldest→newest (sparkline).
  contextSeries: number[];
  // Recent growth rate and a rough ETA to the model limit at that pace.
  growthTokensPerMin?: number;
  etaToLimitMin?: number;
  // The session split into topics at large prompt gaps, sorted by token weight.
  topics: { label: string; estimatedTokens: number; startTime: string }[];
  // Largest gap between consecutive user prompts — a candidate topic-switch point.
  topicSwitchAt?: string; // ISO timestamp
  topicSwitchGapMin?: number;
}

// One per-session status-bar card. Each currently-active Claude Code session
// (one .jsonl with recent activity) gets its own card so the model, context
// fill, and prompt-cache warmth shown always belong to a single, identifiable
// session — not a global mix of every session on the machine.
export interface SessionCard {
  sessionId: string;
  projectName: string;
  // ISO timestamp of the session's most recent record — drives the per-card
  // prompt-cache countdown (5-min TTL from this session's last request).
  lastActivity: string;
  // Pretty model id of the session's latest request (e.g. "claude-opus-4-8").
  model: string;
  // The first human-typed prompt of the session (harness-injected/meta lines
  // skipped), trimmed to a short snippet — a quick "ah, this is that session"
  // cue on the card's hover. Empty when none could be extracted.
  firstPrompt: string;
  // Full Context Health for this session, or null when context-health analysis
  // is disabled (the card then shows model + cache only).
  health: ContextHealth | null;
}

// --- Per-session usage within the current 5-hour quota window ---
// Anthropic's quota endpoint only reports the *aggregate* 5-hour utilisation, so
// a true per-session quota % cannot be derived. This is the closest proxy: each
// active session's token volume inside the window and its share of the window's
// total tokens. Treat `share` as an approximation of quota pressure, not an exact
// quota percentage.
export interface WindowSessionShare {
  sessionId: string;
  projectName: string;
  model: string;
  tokens: number; // input + output + cacheCreation + cacheRead inside the window
  cost: number; // estimated USD inside the window
  share: number; // tokens / window total tokens (0-1)
}

// The current 5-hour window plus its per-session token breakdown.
export interface WindowUsage {
  windowStart: string; // ISO start of the window (resets_at - 5h, or now - 5h)
  windowEnd: string | null; // ISO resets_at when known, else null
  // The global 5-hour quota utilisation (0-100) for context; not per-session.
  fiveHourUtilization: number | null;
  totalTokens: number; // sum of all sessions' window tokens
  sessions: WindowSessionShare[]; // sorted by tokens desc
}

// --- Activity analysis (the "Activity" tab) ---
// All figures cover the same recent window as the content analysis (last 30
// days) and are exact counts derived from the raw log — not token estimates.

// One tool, aggregated over the window.
export interface ToolUsageStat {
  name: string;
  count: number; // number of tool_use invocations
  errors: number; // tool_result blocks flagged is_error (includes user rejections)
  totalDurationMs: number; // sum of durationMs samples (only some tools report timing)
  durationSamples: number; // how many invocations contributed a duration
}

// One skill (the Skill tool, broken out by the skill that was invoked).
export interface SkillUsageStat {
  name: string;
  count: number;
}

// One subagent type (the Task/Agent tool, broken out by agent type), with the
// real cost/effort the subagent itself consumed (from its toolUseResult).
export interface SubagentUsageStat {
  agentType: string;
  count: number;
  totalTokens: number;
  totalDurationMs: number;
  totalToolUseCount: number;
}

export interface LabeledCount {
  label: string;
  count: number;
}

export interface ActivityAnalysis {
  windowDays: number;
  totalToolCalls: number;
  toolErrors: number;
  tools: ToolUsageStat[]; // sorted by count desc
  skills: SkillUsageStat[];
  subagents: SubagentUsageStat[];
  promptCount: number; // distinct user prompts
  prCount: number; // pull requests created (pr-link events)
  stopReasons: LabeledCount[]; // assistant turn outcomes (tool_use vs end_turn …)
  permissionModes: LabeledCount[]; // prompts grouped by permission mode
  // Code-change activity (from Edit/Write tool results).
  filesEditedCount: number; // edit/write results applied
  linesAdded: number;
  linesRemoved: number;
  userModifiedCount: number; // edits the user later modified by hand
  editResultCount: number; // denominator for the user-modified rate
  gitOperations: number;
  // Output-token split between the main thread and subagents (sidechains).
  mainOutputTokens: number;
  sidechainOutputTokens: number;
  // Verbosity / thinking-budget view: billable main-thread assistant turns, and
  // estimated thinking vs visible-text tokens the assistant produced (offline
  // estimate from block text, across main + subagent turns).
  assistantTurns: number;
  thinkingTokensEst: number;
  assistantTextTokensEst: number;
  // Thinking blocks seen in the window. Newer Claude Code versions persist
  // thinking blocks with the text redacted (signature only), so when this is
  // >0 while thinkingTokensEst is 0 the share is unknown — not zero.
  thinkingBlocksSeen: number;
  // 7×24 grid of assistant turns by local weekday (0=Sun) and hour.
  heatmap: number[][];
  // Most recent session titles (auto-generated), newest first.
  recentTitles: { title: string; sessionId: string }[];
}

export interface ExtensionConfig {
  refreshInterval: number;
  dataDirectory: string;
  language: string;
  decimalPlaces: number;
  compactNumbers: boolean;
  // IANA timezone name (e.g. "Asia/Hong_Kong") used for date display, or ''
  // to use the system timezone. Useful for users in devcontainers or
  // sandboxes whose system zone doesn't match their actual zone.
  timezone: string;
  // Fetch real 5-hour / weekly limit utilisation via Claude Code's OAuth session.
  usageLimitTracking: boolean;
  // Append a timestamped snapshot of the fetched quota utilisation to
  // ~/.claude/cc-monitor/quota-history.jsonl on each refresh, for the Quota tab
  // and CSV/JSON export. No effect when usageLimitTracking is off.
  recordQuotaHistory: boolean;
  // Run the (CPU-heavy) content/prompt-token analysis. When false the Content
  // tab is hidden and the analysis is skipped during refresh.
  enableContentAnalysis: boolean;
  // Show the live Context Health indicator in the status bar. When false the
  // indicator is hidden and its (per-session) analysis is skipped during refresh.
  enableContextHealth: boolean;
  // A session is shown as its own status-bar card while its most recent record
  // is within this many minutes; older sessions drop off. Default 60.
  sessionCardRecencyMinutes: number;
  // Cap on the number of per-session cards in the status bar, so a machine with
  // many parallel sessions does not overflow the bar. Default 5.
  maxSessionCards: number;
  // Pop a one-time (debounced) toast when the active session first turns "rot".
  // Opt-in (default false). No effect when enableContextHealth is off.
  contextHealthRotNotification: boolean;
  // Pop a warning toast when the 5-hour quota crosses 80% (and again at 95%),
  // so heavy work can be paused before the window is exhausted. Re-armed when
  // the quota resets. No effect when usageLimitTracking is off.
  quotaThresholdNotification: boolean;
  // How the Projects tab groups working directories:
  //   - 'git'    group by enclosing git repository (default; current behaviour)
  //   - 'folder' group by the heuristic top-level project folder only
  //   - 'flat'   no grouping; every working directory is its own row
  projectGroupingMode: 'git' | 'folder' | 'flat';
  // Write a machine-readable snapshot of the computed analysis to
  // ~/.claude/cc-monitor/insights/latest.json on each full refresh, for the
  // cc-monitor Claude Code skills. Local file only — nothing is transmitted.
  exportInsights: boolean;
}

export interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
}

export type SupportedLanguage = 'en' | "de-DE" | 'zh-TW' | 'zh-CN' | 'ja' | 'ko';

// Per-git-branch usage aggregate.
export interface BranchUsage {
  branch: string;
  projectName: string;
  projectPath: string;
  sessionCount: number;
  lastSeen: Date;
  data: UsageData;
}

// OAuth credentials written by Claude Code at ~/.claude/.credentials.json.
export interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

// One limit window from api.anthropic.com/api/oauth/usage.
export interface ClaudeUsageLimit {
  utilization: number; // 0-100
  resets_at: string; // ISO timestamp
}

// Response from the OAuth usage endpoint (mirrors what /usage shows).
export interface ClaudeApiUsageResponse {
  five_hour?: ClaudeUsageLimit;
  seven_day?: ClaudeUsageLimit;
  seven_day_opus?: ClaudeUsageLimit;
}