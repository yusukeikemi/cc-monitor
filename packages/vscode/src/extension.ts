import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeDataLoader } from './dataLoader';
import { StatusBarManager } from './statusBar';
import { UsageWebviewProvider } from './webview';
import { I18n } from './i18n';
import { ClaudeApiClient } from './claudeApiClient';
import { ClaudeApiUsageResponse, ContentAnalysis, ExtensionConfig } from './types';

export class ClaudeCodeUsageExtension {
  private statusBar: StatusBarManager;
  private webviewProvider: UsageWebviewProvider;
  private apiClient: ClaudeApiClient;
  private refreshTimer: NodeJS.Timeout | undefined;
  private fileWatcher: fs.FSWatcher | undefined;
  private watchDebounceTimer: NodeJS.Timeout | undefined;
  private watchedDir: string | null = null;
  private cache: {
    records: any[];
    contentAnalysis: ContentAnalysis | null;
    lastUpdate: Date;
    dataDirectory: string | null;
    usageLimits: ClaudeApiUsageResponse | null;
    usageLimitsLastUpdate: Date;
  } = {
    records: [],
    contentAnalysis: null,
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
      enableContentAnalysis: config.get('enableContentAnalysis', true),
      projectGroupingMode: config.get('projectGroupingMode', 'git') as 'git' | 'folder' | 'flat'
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
        // Idle: logs unchanged — only refresh the (independent) quota indicator.
        this.statusBar.updateQuota(usageLimits);
        return;
      }

      this.statusBar.setLoading(true);
      this.webviewProvider.setLoading(true);

      const loaded = await ClaudeDataLoader.loadUsageRecords(dataDirectory, {
        analyzeContent: config.enableContentAnalysis
      });
      const records = loaded.records;
      const contentAnalysis = loaded.contentAnalysis;
      this.cache.records = records;
      this.cache.contentAnalysis = contentAnalysis;
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

      // Update UI
      this.statusBar.updateUsageData(todayData, sessionData, undefined, usageLimits);
      this.webviewProvider.updateData(sessionData, todayData, monthData, allTimeData, dailyDataForMonth, dailyDataForAllTime, hourlyDataForToday, undefined, dataDirectory, records, sessionBreakdown, projectBreakdown, contentAnalysis, branchBreakdown);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Error refreshing Claude Code usage data:', error);

      this.statusBar.updateUsageData(null, null, errorMessage);
      this.webviewProvider.updateData(null, null, null, null, [], [], [], errorMessage, null);
    }
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
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
