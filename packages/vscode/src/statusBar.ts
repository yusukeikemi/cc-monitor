import * as vscode from 'vscode';
import { ClaudeApiUsageResponse, ClaudeUsageLimit, ContextHealth, ContextRotSignal, SessionData, UsageData } from './types';
import { I18n } from './i18n';

const CACHE_TTL_MS = 5 * 60 * 1000;

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private quotaItem: vscode.StatusBarItem;
  private cacheItem: vscode.StatusBarItem;
  private contextItem: vscode.StatusBarItem;
  private isLoading: boolean = false;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'claudeCodeUsage.showDetails';
    this.statusBarItem.show();

    // A second, quieter item for the real usage-limit indicator.
    this.quotaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.quotaItem.command = 'claudeCodeUsage.showDetails';

    // Third item: prompt-cache warmth countdown.
    this.cacheItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.cacheItem.command = 'claudeCodeUsage.showDetails';

    // Fourth item: live Context Health for the active session.
    this.contextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    this.contextItem.command = 'claudeCodeUsage.showDetails';

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
    usageLimits?: ClaudeApiUsageResponse | null
  ): void {
    this.isLoading = false;

    if (error) {
      this.showError(error);
      this.quotaItem.hide();
      return;
    }

    if (!todayData) {
      this.showNoData();
      this.quotaItem.hide();
      return;
    }

    this.showTodayData(todayData, sessionData ?? null);
    this.updateQuota(usageLimits ?? null);
  }

  private updateStatusBar(): void {
    if (this.isLoading) {
      this.statusBarItem.text = `$(sync~spin) ${I18n.t.statusBar.loading}`;
      this.statusBarItem.tooltip = I18n.t.statusBar.loading;
      return;
    }
  }

  private showTodayData(todayData: UsageData, sessionData: SessionData | null): void {
    const todayCost = I18n.formatCurrency(todayData.totalCost);
    // Primary number = today's cost. When an active session exists, show its
    // cost as a secondary value so per-session spend is visible at a glance.
    let text = `$(pulse) ${todayCost}`;
    if (sessionData && sessionData.messageCount > 0) {
      text += ` $(history) ${I18n.formatCurrency(sessionData.totalCost)}`;
    }
    this.statusBarItem.text = text;

    this.statusBarItem.tooltip = this.createTooltip(todayData, sessionData);
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Update the quota indicator with real 5-hour / weekly utilisation from the
   * OAuth usage API. Hidden when the data is unavailable (e.g. not signed in).
   * Public so it can be refreshed on its own while the rest of the UI is idle.
   */
  updateQuota(usageLimits: ClaudeApiUsageResponse | null): void {
    const fiveHour = usageLimits?.five_hour;
    const weekly = usageLimits?.seven_day;
    if (!fiveHour && !weekly) {
      this.quotaItem.hide();
      return;
    }

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
   * Update the prompt-cache warmth indicator.
   * Shows a countdown (e.g. "$(zap) 3:24") from the last API request.
   * Hidden when the cache has already expired or no data is available.
   * Public so the extension can tick it every 30 s without a full refresh.
   */
  updateCacheWarmth(lastRequestTime: Date | null): void {
    if (!lastRequestTime) {
      this.cacheItem.hide();
      return;
    }
    const remainingMs = CACHE_TTL_MS - (Date.now() - lastRequestTime.getTime());
    if (remainingMs <= 0) {
      this.cacheItem.hide();
      return;
    }
    const totalSec = Math.ceil(remainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const countdown = `${min}:${String(sec).padStart(2, '0')}`;
    this.cacheItem.text = `$(zap) ${countdown}`;
    this.cacheItem.tooltip = this.createCacheTooltip(lastRequestTime, remainingMs);
    if (remainingMs < 60_000) {
      this.cacheItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.cacheItem.backgroundColor = undefined;
    }
    this.cacheItem.show();
  }

  private createCacheTooltip(lastRequest: Date, remainingMs: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    const min = Math.floor(remainingMs / 60_000);
    const sec = Math.ceil((remainingMs % 60_000) / 1000);
    const countdown = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
    md.appendMarkdown(`**$(zap) Prompt Cache**\n\n`);
    md.appendMarkdown(`Cache warm — expires in **${countdown}**\n\n`);
    md.appendMarkdown(`Last request: ${lastRequest.toLocaleTimeString()}\n\n`);
    md.appendMarkdown(`*Each API call resets the 5-minute TTL.*`);
    return md;
  }

  /**
   * Update the live Context Health indicator for the active session.
   * Shows the window fill ratio (e.g. "$(book) 78%") and, on a "rot" verdict, a
   * warning icon + background. Hidden when no active session is available.
   */
  updateContextHealth(health: ContextHealth | null): void {
    if (!health) {
      this.contextItem.hide();
      return;
    }
    const pct = Math.round(health.fillRatio * 100);
    const icon = health.status === 'rot' ? '$(warning)' : '$(book)';
    this.contextItem.text = `${icon} ${pct}%`;
    this.contextItem.backgroundColor =
      health.status === 'rot' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.contextItem.tooltip = this.createContextTooltip(health);
    this.contextItem.show();
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

    // Composition table — what is filling the window.
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
        default:
          return key;
      }
    };
    md.appendMarkdown(`| ${t.composition} | ${p.estTokens} | ${p.share} |\n`);
    md.appendMarkdown(`|:--|--:|--:|\n`);
    for (const c of health.composition) {
      const share = Math.round((c.estimatedTokens / total) * 100);
      md.appendMarkdown(`| ${catLabel(c.key)} | ${I18n.formatNumber(c.estimatedTokens)} | ${share}% |\n`);
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
      default:
        return '';
    }
  }

  private showNoData(): void {
    this.statusBarItem.text = `$(circle-slash) ${I18n.t.statusBar.noData}`;
    this.statusBarItem.tooltip = I18n.t.statusBar.notRunning;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.contextItem.hide();
  }

  private showError(error: string): void {
    this.statusBarItem.text = `$(error) ${I18n.t.statusBar.error}`;
    this.statusBarItem.tooltip = error;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.contextItem.hide();
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
      `|${PAD}${t.quotaWindow}${PAD}|${PAD}${t.share}${PAD}|${GAP}${PAD}${t.resets}${PAD}|\n`
    );
    md.appendMarkdown(`|:--|--:|--:|\n`);

    if (usageLimits.five_hour) {
      this.appendQuotaRow(md, t.quota5h, usageLimits.five_hour, false);
    }
    if (usageLimits.seven_day) {
      this.appendQuotaRow(md, t.quotaWeekly, usageLimits.seven_day, true);
    }
    if (usageLimits.seven_day_opus) {
      this.appendQuotaRow(md, `${t.quotaWeekly} (Opus)`, usageLimits.seven_day_opus, true);
    }

    md.appendMarkdown(`\n\n*${t.quotaHint}*`);
    return md;
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
      `|${PAD}${label}${PAD}|${PAD}${limit.utilization.toFixed(1)}%${PAD}|${GAP}${PAD}${resets}${PAD}|\n`
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
    this.cacheItem.dispose();
    this.contextItem.dispose();
  }
}
