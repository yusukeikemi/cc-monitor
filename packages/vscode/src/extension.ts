import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeDataLoader } from './dataLoader';
import { StatusBarManager } from './statusBar';
import { UsageWebviewProvider } from './webview';
import { I18n } from './i18n';
import { ClaudeApiClient } from './claudeApiClient';
import { InsightsExporter } from './insightsExporter';
import { QuotaHistory, QuotaSnapshot } from './quotaHistory';
import { ActivityAnalysis, ClaudeApiUsageResponse, ContentAnalysis, ExtensionConfig, SessionCard } from './types';

export class ClaudeCodeUsageExtension {
  private statusBar: StatusBarManager;
  private webviewProvider: UsageWebviewProvider;
  private apiClient: ClaudeApiClient;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cacheWarmthTimer: NodeJS.Timeout | undefined;
  private fileWatcher: fs.FSWatcher | undefined;
  private watchDebounceTimer: NodeJS.Timeout | undefined;
  private watchedDir: string | null = null;
  // Debounce the "context rot" toast: at most one per session, re-armed after a
  // gap. Keyed by sessionId so each running session is tracked independently.
  private lastRotNotifiedAt: Map<string, number> = new Map();
  // Highest 5-hour quota threshold (80/95) already toasted in the current
  // window; reset to 0 when utilisation drops (i.e. the window rolled over).
  private quotaNotifiedThreshold = 0;
  // Whether we have already tried to seed the quota cache from persisted history
  // this process. Done once, lazily, on the first usage fetch.
  private seededQuotaFromHistory = false;
  private cache: {
    records: any[];
    contentAnalysis: ContentAnalysis | null;
    activityAnalysis: ActivityAnalysis | null;
    lastUpdate: Date;
    dataDirectory: string | null;
    usageLimits: ClaudeApiUsageResponse | null;
    usageLimitsLastUpdate: Date;
  } = {
    records: [],
    contentAnalysis: null,
    activityAnalysis: null,
    lastUpdate: new Date(0),
    dataDirectory: null,
    usageLimits: null,
    usageLimitsLastUpdate: new Date(0)
  };

  private outputChannel: vscode.OutputChannel;

  constructor(private context: vscode.ExtensionContext) {
    console.log('Claude Code Usage Extension: Constructor called');
    this.outputChannel = vscode.window.createOutputChannel('Claude Code Usage');
    context.subscriptions.push(this.outputChannel);
    this.statusBar = new StatusBarManager();
    this.webviewProvider = new UsageWebviewProvider(context);
    this.apiClient = new ClaudeApiClient(this.outputChannel);

    this.setupCommands();
    this.loadConfiguration();
    this.startAutoRefresh();
    this.startCacheWarmthTimer();
    this.refreshData().then(() => this.startFileWatching());
    console.log('Claude Code Usage Extension: Initialization complete');
  }

  private setupCommands(): void {
    const commands = [
      vscode.commands.registerCommand('claudeCodeUsage.refresh', () => {
        this.refreshData();
      }),
      vscode.commands.registerCommand('claudeCodeUsage.showDetails', (sessionId?: string) => {
        this.webviewProvider.show(typeof sessionId === 'string' ? sessionId : undefined);
      }),
      vscode.commands.registerCommand('claudeCodeUsage.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCodeUsage');
      }),
      vscode.commands.registerCommand('claudeCodeUsage.showLogs', () => {
        this.outputChannel.show();
      }),
      vscode.commands.registerCommand('claudeCodeUsage.exportQuotaHistory', () => {
        this.exportQuotaHistory();
      }),
      vscode.commands.registerCommand('claudeCodeUsage.openQuotaHistoryFile', async () => {
        const file = QuotaHistory.getHistoryFilePath();
        if (!fs.existsSync(file)) {
          vscode.window.showInformationMessage('No quota history recorded yet. It accrues while the extension runs.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
      })
    ];

    commands.forEach(command => this.context.subscriptions.push(command));
  }

  private loadConfiguration(): void {
    const config = this.getConfiguration();
    I18n.setLanguage(config.language as any);
    I18n.setDecimalPlaces(config.decimalPlaces);
    I18n.setCompactNumbers(config.compactNumbers);
    I18n.setTimezone(config.timezone);

    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeCodeUsage')) {
        this.onConfigurationChanged();
      }
    });
  }

  private getConfiguration(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('claudeCodeUsage');
    return {
      refreshInterval: config.get('refreshInterval', 60),
      dataDirectory: config.get('dataDirectory', ''),
      language: config.get('language', 'auto'),
      decimalPlaces: config.get('decimalPlaces', 2),
      compactNumbers: config.get('compactNumbers', false),
      timezone: config.get('timezone', ''),
      usageLimitTracking: config.get('usageLimitTracking', true),
      recordQuotaHistory: config.get('recordQuotaHistory', true),
      enableContentAnalysis: config.get('enableContentAnalysis', true),
      enableContextHealth: config.get('enableContextHealth', true),
      sessionCardRecencyMinutes: config.get('sessionCardRecencyMinutes', 60),
      maxSessionCards: config.get('maxSessionCards', 5),
      contextHealthRotNotification: config.get('contextHealthRotNotification', false),
      quotaThresholdNotification: config.get('quotaThresholdNotification', true),
      projectGroupingMode: config.get('projectGroupingMode', 'git') as 'git' | 'folder' | 'flat',
      exportInsights: config.get('exportInsights', true)
    };
  }

  private onConfigurationChanged(): void {
    const config = this.getConfiguration();
    I18n.setLanguage(config.language as any);
    I18n.setDecimalPlaces(config.decimalPlaces);
    I18n.setCompactNumbers(config.compactNumbers);
    I18n.setTimezone(config.timezone);

    // Restart auto-refresh with new interval
    this.startAutoRefresh();

    // Clear cache if data directory changed
    if (config.dataDirectory !== this.cache.dataDirectory) {
      this.cache.records = [];
      this.cache.lastUpdate = new Date(0);
      this.cache.dataDirectory = config.dataDirectory;
      this.stopFileWatching();
    }

    // Refresh data immediately, then (re-)attach the file watcher.
    this.refreshData().then(() => this.startFileWatching());
  }

  /**
   * Watch the Claude projects directory for new/changed jsonl lines so the
   * status bar reflects new usage within ~1.5 seconds instead of waiting for
   * the polling timer. Falls back silently if fs.watch fails (some platforms /
   * filesystems do not support recursive watching).
   */
  private async startFileWatching(): Promise<void> {
    const config = this.getConfiguration();
    const dataDirectory = await ClaudeDataLoader.findClaudeDataDirectory(config.dataDirectory || undefined);
    if (!dataDirectory) {
      return;
    }
    const projectsDir = path.join(dataDirectory, 'projects');
    if (!fs.existsSync(projectsDir) || this.watchedDir === projectsDir) {
      return;
    }
    this.stopFileWatching();
    try {
      this.fileWatcher = fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
        if (!filename || !String(filename).endsWith('.jsonl')) {
          return;
        }
        // Debounce: Claude Code writes lines in bursts and the file mtime
        // changes for every line.
        if (this.watchDebounceTimer) {
          clearTimeout(this.watchDebounceTimer);
        }
        this.watchDebounceTimer = setTimeout(() => {
          this.refreshData();
        }, 1500);
      });
      this.watchedDir = projectsDir;
    } catch {
      // Recursive watching unsupported — the polling timer is enough.
    }
  }

  private stopFileWatching(): void {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = undefined;
    }
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch {
        // Already closed.
      }
      this.fileWatcher = undefined;
    }
    this.watchedDir = null;
  }

  private startAutoRefresh(): void {
    // Clear existing timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    const config = this.getConfiguration();
    const intervalMs = Math.max(config.refreshInterval * 1000, 30000); // Minimum 30 seconds

    this.refreshTimer = setInterval(() => {
      this.refreshData();
    }, intervalMs);
  }

  /** Tick each session card's cache-warmth countdown every second (independent
   * of the data refresh) so the m:ss readouts count down smoothly. The tick is
   * a Date subtraction + status-bar text set per card — negligible work. */
  private startCacheWarmthTimer(): void {
    if (this.cacheWarmthTimer) {
      clearInterval(this.cacheWarmthTimer);
    }
    this.cacheWarmthTimer = setInterval(() => {
      this.statusBar.tickCardCaches();
    }, 1_000);
  }

  /** Fetch real usage limits via OAuth, cached for 2 minutes. */
  private async maybeFetchUsageLimits(config: ExtensionConfig): Promise<ClaudeApiUsageResponse | null> {
    if (!config.usageLimitTracking) {
      return null;
    }

    // Seed the in-memory cache from the last persisted snapshot once per process,
    // so the quota card renders the last-known value immediately after a reload —
    // even while the first live fetch is still in flight, failing, or cooling
    // down after a 429. lastUpdate stays at epoch so a fresh fetch still fires
    // below; a successful fetch then replaces this stale seed.
    if (!this.seededQuotaFromHistory) {
      this.seededQuotaFromHistory = true;
      if (!this.cache.usageLimits) {
        const seeded = await QuotaHistory.latestAsUsageResponse().catch(() => null);
        if (seeded) {
          this.cache.usageLimits = seeded;
        }
      }
    }

    const age = Date.now() - this.cache.usageLimitsLastUpdate.getTime();
    if (this.cache.usageLimits && age < 60000) {
      return this.cache.usageLimits;
    }
    const fetched = await this.apiClient.fetchUsageLimits();
    if (fetched) {
      this.cache.usageLimits = fetched;
      this.cache.usageLimitsLastUpdate = new Date();
      if (config.recordQuotaHistory) {
        void QuotaHistory.appendSnapshot(fetched).catch((e) => {
          this.outputChannel.appendLine(`quota-history: append failed: ${(e as Error).message}`);
        });
      }
      this.maybeNotifyQuotaThreshold(config, fetched);
      return fetched;
    }
    // Keep showing the last known value if a refresh fails.
    return this.cache.usageLimits;
  }

  private async refreshData(): Promise<void> {
    try {
      const config = this.getConfiguration();

      // Find Claude data directory
      const dataDirectory = await ClaudeDataLoader.findClaudeDataDirectory(
        config.dataDirectory || undefined
      );

      if (!dataDirectory) {
        const error = 'Claude data directory not found. Please check your configuration.';
        this.statusBar.updateUsageData(null, null, error);
        this.webviewProvider.updateData(null, null, null, null, [], [], [], error, null);
        return;
      }

      // Skip the heavy recompute when nothing has changed since the last load —
      // this avoids pointless work (and CPU spikes) while you are not running code.
      const latestMtime = await ClaudeDataLoader.getLatestModifiedTime(dataDirectory);
      const dirChanged = this.cache.dataDirectory !== dataDirectory;
      const needFullRefresh =
        dirChanged || this.cache.records.length === 0 || latestMtime > this.cache.lastUpdate.getTime();

      const usageLimits = await this.maybeFetchUsageLimits(config);

      if (!needFullRefresh) {
        // Idle: logs unchanged — only refresh the independent indicators. The
        // session cards keep their last payload; their cache countdowns are
        // ticked by the 1-second timer (tickCardCaches).
        this.statusBar.updateQuota(usageLimits, undefined, this.cache.usageLimitsLastUpdate);
        this.statusBar.tickCardCaches();
        return;
      }

      this.statusBar.setLoading(true);
      this.webviewProvider.setLoading(true);

      const loaded = await ClaudeDataLoader.loadUsageRecords(dataDirectory, {
        analyzeContent: config.enableContentAnalysis
      });
      const records = loaded.records;
      const contentAnalysis = loaded.contentAnalysis;
      const activityAnalysis = loaded.activityAnalysis;
      this.cache.records = records;
      this.cache.contentAnalysis = contentAnalysis;
      this.cache.activityAnalysis = activityAnalysis;
      this.cache.lastUpdate = new Date();
      this.cache.dataDirectory = dataDirectory;

      if (records.length === 0) {
        const error = 'No usage records found. Make sure Claude Code is running.';
        this.statusBar.updateUsageData(null, null, error);
        this.webviewProvider.updateData(null, null, null, null, [], [], [], error, dataDirectory);
        return;
      }

      // Calculate usage data
      const sessionData = ClaudeDataLoader.getCurrentSessionData(records);
      const todayData = ClaudeDataLoader.getTodayData(records);
      const monthData = ClaudeDataLoader.getThisMonthData(records);
      const allTimeData = ClaudeDataLoader.getAllTimeData(records);
      const dailyDataForMonth = ClaudeDataLoader.getDailyDataForMonth(records);
      const dailyDataForAllTime = ClaudeDataLoader.getDailyDataForAllTime(records);
      const hourlyDataForToday = ClaudeDataLoader.getHourlyDataForToday(records);
      const sessionBreakdown = ClaudeDataLoader.getSessionBreakdown(records);
      const projectBreakdown = ClaudeDataLoader.getProjectBreakdown(records, undefined, config.projectGroupingMode);
      const branchBreakdown = ClaudeDataLoader.getBranchBreakdown(records);

      const quotaHistory = await QuotaHistory.readHistory({ sinceDays: 30 });

      // One card per currently-active session, each with its own model, context
      // fill, and prompt-cache warmth (offline heuristics only). The most-recent
      // session's health stands in for the single-session consumers below.
      const sessionCards = await ClaudeDataLoader.getActiveSessionCards(records, dataDirectory, {
        recencyMinutes: config.sessionCardRecencyMinutes,
        maxCards: config.maxSessionCards,
        includeHealth: config.enableContextHealth
      });
      const contextHealth = sessionCards.find((c) => c.health)?.health ?? null;

      // Per-session token share within the current 5-hour quota window. The
      // window start is anchored to the real reset time when the quota endpoint
      // is reachable, else a rolling 5 hours from now.
      const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
      const fiveHourResetsAt = usageLimits?.five_hour?.resets_at ?? null;
      const resetMs = fiveHourResetsAt ? new Date(fiveHourResetsAt).getTime() : NaN;
      const windowStartMs = !isNaN(resetMs) ? resetMs - FIVE_HOURS_MS : Date.now() - FIVE_HOURS_MS;
      const windowUsage = ClaudeDataLoader.getWindowUsage(records, windowStartMs, {
        windowEnd: fiveHourResetsAt,
        fiveHourUtilization: usageLimits?.five_hour?.utilization ?? null,
      });

      // Update UI
      this.statusBar.updateUsageData(todayData, sessionData, undefined, usageLimits, quotaHistory, this.cache.usageLimitsLastUpdate);
      this.statusBar.renderSessionCards(sessionCards);
      this.maybeNotifyContextRot(config, sessionCards);
      this.webviewProvider.updateData(sessionData, todayData, monthData, allTimeData, dailyDataForMonth, dailyDataForAllTime, hourlyDataForToday, undefined, dataDirectory, records, sessionBreakdown, projectBreakdown, contentAnalysis, branchBreakdown, activityAnalysis, quotaHistory, contextHealth, sessionCards, windowUsage);

      // Snapshot for the cc-monitor Claude Code skills (local file only).
      if (config.exportInsights) {
        void InsightsExporter.write({
          generator: 'cc-monitor-vscode/2.0.0',
          dataDirectory,
          today: todayData,
          thisMonth: monthData,
          allTime: allTimeData,
          sessions: sessionBreakdown,
          projects: projectBreakdown,
          activity: activityAnalysis,
          content: contentAnalysis,
          contextHealth,
          quotaLatest: usageLimits
        }).catch((e) => {
          this.outputChannel.appendLine(`insights: export failed: ${(e as Error).message}`);
        });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Error refreshing Claude Code usage data:', error);

      this.statusBar.updateUsageData(null, null, errorMessage);
      this.webviewProvider.updateData(null, null, null, null, [], [], [], errorMessage, null);
    }
  }

  /**
   * Show a one-time, debounced toast the first time a session turns "rot".
   * Opt-in (contextHealthRotNotification). Re-armed for the same session only
   * after a 30-minute quiet gap so it never nags on every refresh. Each active
   * session is debounced independently.
   */
  private maybeNotifyContextRot(config: ExtensionConfig, cards: SessionCard[]): void {
    if (!config.contextHealthRotNotification) {
      return;
    }
    const now = Date.now();
    // Forget sessions that are no longer active so the map cannot grow forever.
    const active = new Set(cards.map((c) => c.sessionId));
    for (const sid of [...this.lastRotNotifiedAt.keys()]) {
      if (!active.has(sid)) {
        this.lastRotNotifiedAt.delete(sid);
      }
    }
    for (const card of cards) {
      if (card.health?.status !== 'rot') {
        continue;
      }
      const last = this.lastRotNotifiedAt.get(card.sessionId);
      if (last !== undefined && now - last < 30 * 60 * 1000) {
        continue;
      }
      this.lastRotNotifiedAt.set(card.sessionId, now);
      const project = card.projectName && card.projectName !== 'unknown' ? card.projectName : '';
      vscode.window.showWarningMessage(
        project ? `${project}: ${I18n.t.contextHealth.notifyRot}` : I18n.t.contextHealth.notifyRot
      );
    }
  }

  /**
   * Warn once when the 5-hour quota crosses 80%, and again at 95%, so heavy
   * work can be paused before the window is exhausted mid-task. Re-armed when
   * utilisation drops back below 80% (the window reset).
   */
  private maybeNotifyQuotaThreshold(config: ExtensionConfig, limits: ClaudeApiUsageResponse): void {
    if (!config.quotaThresholdNotification) {
      return;
    }
    const fiveHour = limits.five_hour;
    if (!fiveHour || typeof fiveHour.utilization !== 'number') {
      return;
    }
    const pct = fiveHour.utilization;
    const threshold = pct >= 95 ? 95 : pct >= 80 ? 80 : 0;
    if (threshold === 0) {
      this.quotaNotifiedThreshold = 0;
      return;
    }
    if (threshold <= this.quotaNotifiedThreshold) {
      return;
    }
    this.quotaNotifiedThreshold = threshold;
    const resetDate = new Date(fiveHour.resets_at);
    const reset = isNaN(resetDate.getTime())
      ? '—'
      : resetDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const message = I18n.t.statusBar.quotaWarning
      .replace('{pct}', String(Math.round(pct)))
      .replace('{reset}', reset);
    vscode.window.showWarningMessage(message);
  }

  /** Export the full quota history to a user-chosen CSV or JSON file. */
  private async exportQuotaHistory(): Promise<void> {
    const history = await QuotaHistory.readHistory();
    if (history.length === 0) {
      vscode.window.showInformationMessage('No quota history recorded yet. It accrues while the extension runs.');
      return;
    }

    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Export Quota History',
      filters: { CSV: ['csv'], JSON: ['json'] },
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'quota-history.csv'))
    });
    if (!target) {
      return;
    }

    const asCsv = target.fsPath.toLowerCase().endsWith('.csv');
    let content: string;
    if (asCsv) {
      const header = 'ts,five_hour,five_hour_resets_at,seven_day,seven_day_resets_at,seven_day_opus,seven_day_opus_resets_at';
      const cell = (v: string | number | null): string => {
        if (v === null) {
          return '';
        }
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const rows = history.map((s: QuotaSnapshot) =>
        [s.ts, s.fiveHour, s.fiveHourResetsAt, s.sevenDay, s.sevenDayResetsAt, s.sevenDayOpus, s.sevenDayOpusResetsAt]
          .map(cell)
          .join(',')
      );
      content = [header, ...rows].join('\n') + '\n';
    } else {
      content = JSON.stringify(history, null, 2);
    }

    await fs.promises.writeFile(target.fsPath, content, 'utf-8');
    vscode.window.showInformationMessage(`Exported ${history.length} quota snapshots to ${target.fsPath}`);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    if (this.cacheWarmthTimer) {
      clearInterval(this.cacheWarmthTimer);
    }
    this.stopFileWatching();
    this.statusBar.dispose();
    this.webviewProvider.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Claude Code Usage extension is now active');

  const extension = new ClaudeCodeUsageExtension(context);
  context.subscriptions.push({
    dispose: () => extension.dispose()
  });
}

export function deactivate() {
  console.log('Claude Code Usage extension is now deactivated');
}
