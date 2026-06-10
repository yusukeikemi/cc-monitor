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
import { ActivityAnalysis, ClaudeApiUsageResponse, ContentAnalysis, ContextHealth, ExtensionConfig } from './types';

export class ClaudeCodeUsageExtension {
  private statusBar: StatusBarManager;
  private webviewProvider: UsageWebviewProvider;
  private apiClient: ClaudeApiClient;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cacheWarmthTimer: NodeJS.Timeout | undefined;
  private fileWatcher: fs.FSWatcher | undefined;
  private watchDebounceTimer: NodeJS.Timeout | undefined;
  private watchedDir: string | null = null;
  // Debounce the "context rot" toast: at most one per session, re-armed after a gap.
  private lastRotNotifiedSession: string | null = null;
  private lastRotNotifiedAt: number = 0;
  private cache: {
    records: any[];
    contentAnalysis: ContentAnalysis | null;
    activityAnalysis: ActivityAnalysis | null;
    lastUpdate: Date;
    dataDirectory: string | null;
    usageLimits: ClaudeApiUsageResponse | null;
    usageLimitsLastUpdate: Date;
    lastRecordTime: Date | null;
  } = {
    records: [],
    contentAnalysis: null,
    activityAnalysis: null,
    lastUpdate: new Date(0),
    dataDirectory: null,
    usageLimits: null,
    usageLimitsLastUpdate: new Date(0),
    lastRecordTime: null
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
      vscode.commands.registerCommand('claudeCodeUsage.showDetails', () => {
        this.webviewProvider.show();
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
      contextHealthRotNotification: config.get('contextHealthRotNotification', false),
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

  /** Tick the cache-warmth countdown every 30 s (independent of the data refresh). */
  private startCacheWarmthTimer(): void {
    if (this.cacheWarmthTimer) {
      clearInterval(this.cacheWarmthTimer);
    }
    this.cacheWarmthTimer = setInterval(() => {
      this.statusBar.updateCacheWarmth(this.cache.lastRecordTime);
    }, 30_000);
  }

  /** Fetch real usage limits via OAuth, cached for 2 minutes. */
  private async maybeFetchUsageLimits(config: ExtensionConfig): Promise<ClaudeApiUsageResponse | null> {
    if (!config.usageLimitTracking) {
      return null;
    }
    const age = Date.now() - this.cache.usageLimitsLastUpdate.getTime();
    if (this.cache.usageLimits && age < 120000) {
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
        // Idle: logs unchanged — only refresh the independent indicators.
        this.statusBar.updateQuota(usageLimits);
        this.statusBar.updateCacheWarmth(this.cache.lastRecordTime);
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

      // Track the timestamp of the most recent API call for the cache-warmth indicator.
      if (records.length > 0) {
        const maxTs = Math.max(...records.map((r: any) => new Date(r.timestamp).getTime()));
        if (!isNaN(maxTs)) {
          this.cache.lastRecordTime = new Date(maxTs);
        }
      }

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

      // Live Context Health for the active session (offline heuristics only).
      const contextHealth = config.enableContextHealth
        ? await ClaudeDataLoader.getContextHealth(records, dataDirectory)
        : null;

      // Update UI
      this.statusBar.updateUsageData(todayData, sessionData, undefined, usageLimits);
      this.statusBar.updateCacheWarmth(this.cache.lastRecordTime);
      this.statusBar.updateContextHealth(contextHealth);
      this.maybeNotifyContextRot(config, contextHealth);
      this.webviewProvider.updateData(sessionData, todayData, monthData, allTimeData, dailyDataForMonth, dailyDataForAllTime, hourlyDataForToday, undefined, dataDirectory, records, sessionBreakdown, projectBreakdown, contentAnalysis, branchBreakdown, activityAnalysis, quotaHistory, contextHealth);

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
   * Show a one-time, debounced toast the first time the active session turns
   * "rot". Opt-in (contextHealthRotNotification). Re-armed for the same session
   * only after a 30-minute quiet gap so it never nags on every refresh.
   */
  private maybeNotifyContextRot(config: ExtensionConfig, health: ContextHealth | null): void {
    if (!config.contextHealthRotNotification || !health || health.status !== 'rot') {
      return;
    }
    const now = Date.now();
    const sameSession = this.lastRotNotifiedSession === health.sessionId;
    if (sameSession && now - this.lastRotNotifiedAt < 30 * 60 * 1000) {
      return;
    }
    this.lastRotNotifiedSession = health.sessionId;
    this.lastRotNotifiedAt = now;
    vscode.window.showWarningMessage(I18n.t.contextHealth.notifyRot);
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
