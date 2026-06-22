import * as vscode from 'vscode';
import { ClaudeApiUsageResponse, ClaudeUsageLimit, ContextHealth, ContextRotSignal, SessionCard, SessionData, UsageData } from './types';
import { I18n } from './i18n';
import { QuotaSnapshot } from './quotaHistory';

const CACHE_TTL_MS = 5 * 60 * 1000;
// Status-bar priority of the first session card. Cards sit to the right of the
// global summary (100) and quota (99) items, newest-created leftmost.
const FIRST_CARD_PRIORITY = 98;

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private quotaItem: vscode.StatusBarItem;
  // One status-bar item per active session, keyed by sessionId. Created when a
  // session first appears and disposed when it goes idle, so the count grows
  // and shrinks with the number of running Claude Code sessions.
  private sessionItems: Map<string, vscode.StatusBarItem> = new Map();
  // Last-rendered card payload per session, so the 1-second cache tick can
  // re-render each card's countdown without a full data refresh.
  private cardData: Map<string, SessionCard> = new Map();
  private nextCardPriority: number = FIRST_CARD_PRIORITY;
  private isLoading: boolean = false;
  // Last-known data so independent update paths can re-render the summary item.
  private lastToday: UsageData | null = null;
  private lastSession: SessionData | null = null;
  private lastQuotaHistory: QuotaSnapshot[] = [];
  // Last quota payload actually rendered, so transient main-data errors can
  // re-render the indicator instead of hiding a still-valid quota figure.
  private lastUsageLimits: ClaudeApiUsageResponse | null = null;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'claudeCodeUsage.showDetails';
    this.statusBarItem.show();

    // A second, quieter item for the real usage-limit indicator.
    this.quotaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.quotaItem.command = 'claudeCodeUsage.showDetails';

    this.updateStatusBar();
  }

  setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.updateStatusBar();
  }

  updateUsageData(
    todayData: UsageData | null,
    sessionData?: SessionData | null,
    error?: string,
    usageLimits?: ClaudeApiUsageResponse | null,
    quotaHistory?: QuotaSnapshot[]
  ): void {
    this.isLoading = false;

    if (error) {
      this.showError(error);
      // The error is about transcript data, not the quota — keep the last-known
      // quota visible (updateQuota hides only when there is genuinely nothing).
      this.updateQuota(this.lastUsageLimits);
      return;
    }

    if (!todayData) {
      this.showNoData();
      this.updateQuota(this.lastUsageLimits);
      return;
    }

    this.lastToday = todayData;
    this.lastSession = sessionData ?? null;
    this.showTodayData(todayData, sessionData ?? null);
    this.updateQuota(usageLimits ?? null, quotaHistory);
  }

  private updateStatusBar(): void {
    if (this.isLoading) {
      this.statusBarItem.text = `$(sync~spin) ${I18n.t.statusBar.loading}`;
      this.statusBarItem.tooltip = I18n.t.statusBar.loading;
      return;
    }
  }

  private showTodayData(todayData: UsageData, sessionData: SessionData | null): void {
    // The summary item is global (every session combined), so it carries the
    // genuinely-global figure — today's total cost — while per-session details
    // (model / context / cache) live on the individual session cards.
    this.statusBarItem.text = `$(pulse) ${I18n.formatCurrency(todayData.totalCost)}`;
    this.statusBarItem.tooltip = this.createTooltip(todayData, sessionData);
    this.statusBarItem.backgroundColor = undefined;
  }

  /** "claude-opus-4-8" → "Opus 4.8", "claude-fable-5[1m]" → "Fable 5",
   * "claude-3-5-sonnet-20241022" → "Sonnet 3.5". Unknown shapes pass through. */
  private prettyModel(id: string): string {
    const segs = id
      .replace(/\[.*?\]$/, '')
      .replace(/^claude-/, '')
      .split('-')
      .filter((p) => p !== '' && !/^\d{8}$/.test(p)); // drop date segments
    const alpha = segs.find((p) => /[a-zA-Z]/.test(p));
    if (!alpha) {
      return id;
    }
    const name = alpha.charAt(0).toUpperCase() + alpha.slice(1);
    const version = segs.filter((p) => /^\d+$/.test(p)).join('.');
    return version ? `${name} ${version}` : name;
  }

  /**
   * Update the quota indicator with real 5-hour / weekly utilisation from the
   * OAuth usage API. Hidden when the data is unavailable (e.g. not signed in).
   * Public so it can be refreshed on its own while the rest of the UI is idle.
   */
  updateQuota(usageLimits: ClaudeApiUsageResponse | null, quotaHistory?: QuotaSnapshot[]): void {
    if (quotaHistory && quotaHistory.length > 0) {
      this.lastQuotaHistory = quotaHistory;
    }
    const fiveHour = usageLimits?.five_hour;
    const weekly = usageLimits?.seven_day;
    if (!fiveHour && !weekly) {
      this.quotaItem.hide();
      return;
    }
    this.lastUsageLimits = usageLimits;

    const parts: string[] = [];
    let worstPct = 0;
    if (fiveHour) {
      worstPct = Math.max(worstPct, fiveHour.utilization);
      parts.push(`5h:${Math.round(fiveHour.utilization)}%`);
    }
    if (weekly) {
      worstPct = Math.max(worstPct, weekly.utilization);
      parts.push(`wk:${Math.round(weekly.utilization)}%`);
    }

    this.quotaItem.text = `$(dashboard) ${parts.join(' ')}`;

    // Stay quiet until usage actually gets high.
    if (worstPct >= 95) {
      this.quotaItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (worstPct >= 80) {
      this.quotaItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.quotaItem.backgroundColor = undefined;
    }

    this.quotaItem.tooltip = this.createQuotaTooltip(usageLimits as ClaudeApiUsageResponse);
    this.quotaItem.show();
  }

  /**
   * Render one status-bar card per active session, each combining that
   * session's model, context fill, and prompt-cache warmth into a single
   * minimal item. Items are created on first sight of a session and disposed
   * when a session drops out of the active set, so the number of cards tracks
   * the number of running Claude Code sessions.
   */
  renderSessionCards(cards: SessionCard[]): void {
    const seen = new Set<string>();
    for (const card of cards) {
      seen.add(card.sessionId);
      let item = this.sessionItems.get(card.sessionId);
      if (!item) {
        item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, this.nextCardPriority--);
        // Clicking a card opens the panel pinned to *this* session's Context
        // Health, rather than the generic "most recent" view.
        item.command = { command: 'claudeCodeUsage.showDetails', title: '', arguments: [card.sessionId] };
        this.sessionItems.set(card.sessionId, item);
      }
      this.cardData.set(card.sessionId, card);
      this.applyCard(item, card);
      item.show();
    }
    // Drop cards for sessions that are no longer active.
    for (const [sid, item] of this.sessionItems) {
      if (!seen.has(sid)) {
        item.dispose();
        this.sessionItems.delete(sid);
        this.cardData.delete(sid);
      }
    }
  }

  /** Re-render only each card's text + background (the cache countdown changes
   * every second). The hover tooltip is left untouched here and refreshed on
   * the full data render, so we don't rebuild markdown once a second. */
  tickCardCaches(): void {
    for (const [sid, item] of this.sessionItems) {
      const card = this.cardData.get(sid);
      if (card) {
        this.applyCardText(item, card);
      }
    }
  }

  /** Set a card's text and background from its payload (cheap; called on every
   * tick). */
  private applyCardText(item: vscode.StatusBarItem, card: SessionCard): void {
    const health = card.health;
    const cd = this.cacheCountdown(card.lastActivity);
    const icon = health?.status === 'rot' ? '$(warning)' : health?.status === 'watch' ? '$(dashboard)' : '$(pulse)';
    const parts: string[] = [icon];
    const label = this.shortLabel(card.projectName);
    if (label) {
      parts.push(label);
    }
    const model = card.model ? this.prettyModel(card.model) : '';
    if (model) {
      parts.push(model);
    }
    if (health) {
      parts.push(`${Math.round(health.fillRatio * 100)}%`);
    }
    parts.push(`$(zap)${cd.text}`);
    item.text = parts.join(' ');
    // Warn (orange) on a rot verdict or an almost-cold cache; quiet otherwise.
    item.backgroundColor =
      health?.status === 'rot' || cd.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  /** Full render of a card: text + background + the (heavier) hover tooltip. */
  private applyCard(item: vscode.StatusBarItem, card: SessionCard): void {
    this.applyCardText(item, card);
    item.tooltip = this.createCardTooltip(card, this.cacheCountdown(card.lastActivity));
  }

  /** Prompt-cache countdown for one session from its last activity. */
  private cacheCountdown(lastActivity: string): { text: string; warn: boolean; cold: boolean; remainingMs: number } {
    const ts = Date.parse(lastActivity);
    if (isNaN(ts)) {
      return { text: '—', warn: false, cold: true, remainingMs: 0 };
    }
    const remainingMs = CACHE_TTL_MS - (Date.now() - ts);
    if (remainingMs <= 0) {
      return { text: '—', warn: false, cold: true, remainingMs: 0 };
    }
    const totalSec = Math.ceil(remainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return { text: `${min}:${String(sec).padStart(2, '0')}`, warn: remainingMs < 60_000, cold: false, remainingMs };
  }

  /** Truncate a project name to a compact status-bar label. */
  private shortLabel(name: string): string {
    if (!name || name === 'unknown') {
      return '';
    }
    const max = 14;
    return name.length > max ? name.slice(0, max - 1) + '…' : name;
  }

  /** Hover card: a session header + prompt-cache line, then the full Context
   * Health breakdown (reused) when the analysis is available. */
  private createCardTooltip(card: SessionCard, cd: { text: string; cold: boolean; remainingMs: number }): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;

    const model = card.model ? this.prettyModel(card.model) : 'Claude';
    const project = card.projectName && card.projectName !== 'unknown' ? card.projectName : '—';
    md.appendMarkdown(`**$(pulse) ${project} · ${model}**\n\n`);
    md.appendMarkdown(`Session \`${card.sessionId.slice(0, 8)}\`\n\n`);

    // Opening prompt — the quickest "which session is this?" cue.
    if (card.firstPrompt) {
      md.appendMarkdown(`$(comment) *${this.escapeMarkdown(card.firstPrompt)}*\n\n`);
    }

    // Prompt-cache warmth for this session specifically.
    const last = new Date(card.lastActivity);
    const lastStr = isNaN(last.getTime()) ? '—' : last.toLocaleTimeString();
    if (cd.cold) {
      md.appendMarkdown(`$(zap) Cache **cold** — the 5-minute TTL has expired; the next request re-writes the cached prefix at the 1.25× write rate.\n\n`);
    } else {
      const min = Math.floor(cd.remainingMs / 60_000);
      const sec = Math.ceil((cd.remainingMs % 60_000) / 1000);
      const human = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
      md.appendMarkdown(`$(zap) Cache warm — expires in **${human}**\n\n`);
    }
    md.appendMarkdown(`Last request: ${lastStr}\n\n`);

    // Full Context Health breakdown, when computed for this session.
    if (card.health) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(this.createContextTooltip(card.health).value);
    }
    return md;
  }

  /** Escape Markdown control characters so a prompt snippet renders verbatim
   * (and can't break the surrounding italic emphasis). */
  private escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-!|<>]/g, '\\$&');
  }

  /** Unicode sparkline scaled to the series' own peak (shows the growth shape). */
  private sparkline(series: number[]): string {
    if (!series || series.length === 0) {
      return '';
    }
    const blocks = '▁▂▃▄▅▆▇█';
    const hi = Math.max(...series) || 1;
    return series.map((v) => blocks[Math.max(0, Math.min(7, Math.floor((v / hi) * 7.999)))]).join('');
  }

  /** Proportional fill bar, e.g. "██████░░░░". */
  private bar(ratio: number, width: number = 10): string {
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  }

  private createContextTooltip(health: ContextHealth): vscode.MarkdownString {
    const t = I18n.t.contextHealth;
    const p = I18n.t.popup;
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;

    const statusLabel =
      health.status === 'rot' ? t.statusRot : health.status === 'watch' ? t.statusWatch : t.statusHealthy;
    md.appendMarkdown(`**$(book) ${t.title} — ${statusLabel}**\n\n`);

    const pct = Math.round(health.fillRatio * 100);
    md.appendMarkdown(
      `${t.windowSize}: **${I18n.formatNumber(health.contextTokens)}** / ${I18n.formatNumber(health.contextLimit)} (${pct}%)\n\n`
    );

    // Context-growth sparkline over the session.
    const spark = this.sparkline(health.contextSeries);
    if (spark) {
      md.appendMarkdown(`${t.growth}: \`${spark}\` → ${pct}%\n\n`);
    }

    // Growth rate + ETA to the model limit at the current pace.
    if (health.growthTokensPerMin && health.growthTokensPerMin > 0) {
      let line = `${t.pace}: **+${I18n.formatNumber(health.growthTokensPerMin)}**/min`;
      if (health.etaToLimitMin) {
        line += ` · ${t.etaToLimit} ~${health.etaToLimitMin}m`;
      }
      md.appendMarkdown(`${line}\n\n`);
    }

    // Composition — a proportional bar per category of what fills the window.
    const total = health.composition.reduce((s, c) => s + c.estimatedTokens, 0) || 1;
    const catLabel = (key: string): string => {
      switch (key) {
        case 'userPrompts':
          return p.catUserPrompts;
        case 'assistantText':
          return p.catAssistantText;
        case 'assistantThinking':
          return p.catAssistantThinking;
        case 'toolCalls':
          return p.catToolCalls;
        case 'toolResults':
          return p.catToolResults;
        case 'injectedContext':
          return p.catInjected;
        default:
          return key;
      }
    };
    md.appendMarkdown(`| ${t.composition} | | ${p.share} |\n`);
    md.appendMarkdown(`|:--|:--|--:|\n`);
    for (const c of health.composition) {
      const frac = c.estimatedTokens / total;
      md.appendMarkdown(`| ${catLabel(c.key)} | \`${this.bar(frac)}\` | ${Math.round(frac * 100)}% |\n`);
    }

    // Per-topic breakdown (only meaningful when the session spans >1 topic).
    if (health.topics.length > 1) {
      md.appendMarkdown(`\n**${t.topics}**\n\n`);
      for (const topic of health.topics.slice(0, 4)) {
        const label = topic.label ? `"${topic.label}"` : '—';
        md.appendMarkdown(`- ${label} — ${I18n.formatNumber(topic.estimatedTokens)}\n`);
      }
    }

    // Detected rot signals.
    if (health.signals.length > 0) {
      md.appendMarkdown(`\n`);
      for (const s of health.signals) {
        md.appendMarkdown(`- $(warning) ${this.describeSignal(s)}\n`);
      }
    }

    // Candidate topic-switch point.
    if (health.topicSwitchAt && health.topicSwitchGapMin) {
      const at = new Date(health.topicSwitchAt);
      const time = isNaN(at.getTime()) ? '' : at.toLocaleTimeString();
      md.appendMarkdown(`\n${t.topicSwitch}: **${time}** (${health.topicSwitchGapMin}m)\n`);
    }

    const suggestion = health.status === 'healthy' ? t.suggestHealthy : t.suggestClear;
    md.appendMarkdown(`\n*${suggestion}*`);
    return md;
  }

  private describeSignal(s: ContextRotSignal): string {
    const t = I18n.t.contextHealth;
    switch (s.kind) {
      case 'nearLimit':
        return `${t.sigNearLimit} (${s.value}%)`;
      case 'largeToolResult':
        return `${t.sigLargeToolResult}: ${s.label} (${s.value}%)`;
      case 'staleContext':
        return `${t.sigStaleContext} (${s.value}%)`;
      case 'redundantReads':
        return `${t.sigRedundantReads}: ${s.label} ×${s.value}`;
      case 'multiTopic':
        return `${t.sigMultiTopic} (${s.value}m)`;
      case 'cacheBust':
        return `${t.sigCacheBust} (×${s.value})`;
      case 'largeBaseline':
        return `${t.sigLargeBaseline} (~${s.value}k)`;
      case 'fullFileReads':
        return `${t.sigFullFileReads} (×${s.value})`;
      case 'contextDegradation':
        return `${t.sigContextDegradation} (${s.value}%)`;
      case 'repeatedCalls':
        return `${t.sigRepeatedCalls}: ${s.label} ×${s.value}`;
      case 'largeUserPrompt':
        return `${t.sigLargeUserPrompt} (~${s.value}k)`;
      case 'stuckSession':
        return `${t.sigStuckSession} (${s.value}%)`;
      default:
        return '';
    }
  }

  private showNoData(): void {
    this.statusBarItem.text = `$(circle-slash) ${I18n.t.statusBar.noData}`;
    this.statusBarItem.tooltip = I18n.t.statusBar.notRunning;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.hideAllCards();
  }

  private showError(error: string): void {
    this.statusBarItem.text = `$(error) ${I18n.t.statusBar.error}`;
    this.statusBarItem.tooltip = error;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.hideAllCards();
  }

  /** Tear down all session cards (used on error / no-data states). */
  private hideAllCards(): void {
    for (const item of this.sessionItems.values()) {
      item.dispose();
    }
    this.sessionItems.clear();
    this.cardData.clear();
  }

  /**
   * Hover tooltip as a Markdown table so figures line up in neat, right-aligned
   * columns (a plain-text tooltip cannot align reliably).
   */
  private createTooltip(todayData: UsageData, sessionData: SessionData | null): vscode.MarkdownString {
    const t = I18n.t.popup;
    const session = sessionData && sessionData.messageCount > 0 ? sessionData : null;

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;

    if (session) {
      md.appendMarkdown(`| | $(pulse) ${t.today} | $(history) ${I18n.t.statusBar.currentSession} |\n`);
      md.appendMarkdown(`|:--|--:|--:|\n`);
    } else {
      md.appendMarkdown(`| | $(pulse) ${t.today} |\n`);
      md.appendMarkdown(`|:--|--:|\n`);
    }

    const row = (label: string, todayValue: string, sessionValue: string): void => {
      md.appendMarkdown(session ? `| ${label} | ${todayValue} | ${sessionValue} |\n` : `| ${label} | ${todayValue} |\n`);
    };

    row(t.cost, I18n.formatCurrency(todayData.totalCost), session ? I18n.formatCurrency(session.totalCost) : '');
    row(
      t.inputTokens,
      I18n.formatNumber(todayData.totalInputTokens),
      session ? I18n.formatNumber(session.totalInputTokens) : ''
    );
    row(
      t.outputTokens,
      I18n.formatNumber(todayData.totalOutputTokens),
      session ? I18n.formatNumber(session.totalOutputTokens) : ''
    );
    row(
      t.cacheCreation,
      I18n.formatNumber(todayData.totalCacheCreationTokens),
      session ? I18n.formatNumber(session.totalCacheCreationTokens) : ''
    );
    row(
      t.cacheRead,
      I18n.formatNumber(todayData.totalCacheReadTokens),
      session ? I18n.formatNumber(session.totalCacheReadTokens) : ''
    );
    row(t.messages, I18n.formatNumber(todayData.messageCount), session ? I18n.formatNumber(session.messageCount) : '');

    md.appendMarkdown(`\n\n*Click for detailed breakdown*`);
    return md;
  }

  private createQuotaTooltip(usageLimits: ClaudeApiUsageResponse): vscode.MarkdownString {
    const t = I18n.t.popup;
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    // supportHtml lets us use <br> inside table cells to put the weekly
    // reset time and countdown on two lines (otherwise the cell gets long).
    md.supportHtml = true;
    md.appendMarkdown(`**${t.quota}**\n\n`);
    // Pad each cell with non-breaking spaces on both sides so column text does
    // not crowd the separators — VS Code's tooltip markdown renderer collapses
    // ordinary leading/trailing whitespace, but &nbsp; survives.
    const PAD = '  ';
    const GAP = '    ';
    md.appendMarkdown(
      `|${PAD}${t.quotaWindow}${PAD}|${PAD}${PAD}|${PAD}${t.share}${PAD}|${GAP}${PAD}${t.resets}${PAD}|\n`
    );
    md.appendMarkdown(`|:--|:--|--:|--:|\n`);

    if (usageLimits.five_hour) {
      this.appendQuotaRow(md, t.quota5h, usageLimits.five_hour, false);
    }
    if (usageLimits.seven_day) {
      this.appendQuotaRow(md, t.quotaWeekly, usageLimits.seven_day, true);
    }
    if (usageLimits.seven_day_opus) {
      this.appendQuotaRow(md, `${t.quotaWeekly} (Opus)`, usageLimits.seven_day_opus, true);
    }

    // Recent shape of the quota from the local history: how the 5-hour window
    // filled over the last 24h, and the weekly window over the last 7 days.
    const spark5h = this.quotaSparkline((s) => s.fiveHour, 24 * 60);
    const sparkWk = this.quotaSparkline((s) => s.sevenDay, 7 * 24 * 60);
    if (spark5h || sparkWk) {
      md.appendMarkdown(`\n**${t.quotaOverTime}**\n\n`);
      if (spark5h) {
        md.appendMarkdown(`\`${spark5h}\` ${t.quota5h} (24h)\n\n`);
      }
      if (sparkWk) {
        md.appendMarkdown(`\`${sparkWk}\` ${t.quotaWeekly} (7d)\n\n`);
      }
    }

    md.appendMarkdown(`\n*${t.quotaHint}*`);
    return md;
  }

  /** Unicode sparkline of one quota series from the recorded history, on an
   * absolute 0-100% scale (bar height = how full the window was). */
  private quotaSparkline(pick: (s: QuotaSnapshot) => number | null, windowMinutes: number): string {
    const cutoff = Date.now() - windowMinutes * 60_000;
    const pts: number[] = [];
    for (const s of this.lastQuotaHistory) {
      const v = pick(s);
      const ts = Date.parse(s.ts);
      if (v != null && !isNaN(ts) && ts >= cutoff) {
        pts.push(Math.max(0, Math.min(100, v)));
      }
    }
    if (pts.length < 2) {
      return '';
    }
    // Down-sample to a tooltip-friendly width.
    const WIDTH = 24;
    let series = pts;
    if (pts.length > WIDTH) {
      series = [];
      const step = (pts.length - 1) / (WIDTH - 1);
      for (let i = 0; i < WIDTH; i++) {
        series.push(pts[Math.round(i * step)]);
      }
    }
    const blocks = '▁▂▃▄▅▆▇█';
    return series.map((v) => blocks[Math.max(0, Math.min(7, Math.floor((v / 100) * 7.999)))]).join('');
  }

  private appendQuotaRow(md: vscode.MarkdownString, label: string, limit: ClaudeUsageLimit, weekly: boolean): void {
    const resetDate = new Date(limit.resets_at);
    // Weekly cell renders the reset time on one line and the countdown on
    // the next via <br>, so the cell stays narrow with both pieces present.
    const resets = isNaN(resetDate.getTime())
      ? '—'
      : weekly
        ? `${this.formatWeeklyReset(resetDate)}<br>${this.formatCountdown(resetDate)}`
        : this.formatCountdown(resetDate);
    const PAD = '  ';
    const GAP = '    ';
    md.appendMarkdown(
      `|${PAD}${label}${PAD}|${PAD}\`${this.bar(limit.utilization / 100)}\`${PAD}|${PAD}${limit.utilization.toFixed(1)}%${PAD}|${GAP}${PAD}${resets}${PAD}|\n`
    );
  }

  /** Time remaining until a reset, e.g. "2h 15m" or "3d 4h". */
  private formatCountdown(target: Date): string {
    const ms = target.getTime() - Date.now();
    if (ms <= 0) {
      return '0m';
    }
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours >= 24) {
      return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  /** Localised weekday + time of a weekly reset, e.g. "Wed 03:00". */
  private formatWeeklyReset(target: Date): string {
    try {
      return target.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
      return target.toISOString();
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.quotaItem.dispose();
    for (const item of this.sessionItems.values()) {
      item.dispose();
    }
    this.sessionItems.clear();
    this.cardData.clear();
  }
}
