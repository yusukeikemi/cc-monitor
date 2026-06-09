import * as vscode from 'vscode';
import { I18n } from './i18n';
import { getModelRatesPerMillion } from './pricing';
import { QuotaSnapshot } from './quotaHistory';
import { ActivityAnalysis, BranchUsage, ContentAnalysis, ContextHealth, ContextRotSignal, ProjectGroup, ProjectUsage, SessionData, SessionUsage, UsageData } from './types';

export class UsageWebviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentSessionData: SessionData | null = null;
  private todayData: UsageData | null = null;
  private monthData: UsageData | null = null;
  private allTimeData: UsageData | null = null;
  private dailyDataForMonth: { date: string; data: UsageData }[] = [];
  private dailyDataForAllTime: { date: string; data: UsageData }[] = [];
  private hourlyDataForToday: { hour: string; data: UsageData }[] = [];
  private isLoading: boolean = false;
  private error: string | null = null;
  private dataDirectory: string | null = null;
  private currentTab: string = 'today';
  private hourlyDataCache: Map<string, { hour: string; data: UsageData }[]> = new Map();
  private allRecords: any[] = [];
  private sessionBreakdown: SessionUsage[] = [];
  private projectBreakdown: ProjectGroup[] = [];
  private contentAnalysis: ContentAnalysis | null = null;
  private branchBreakdown: BranchUsage[] = [];
  private activityAnalysis: ActivityAnalysis | null = null;
  private quotaHistory: QuotaSnapshot[] = [];
  // Context Health for the live/active session (refreshed automatically).
  private activeContextHealth: ContextHealth | null = null;
  // A specific session pinned via the Sessions-tab drill-down; overrides the
  // active session in the Context Health tab until cleared. null = follow active.
  private inspectedContextHealth: ContextHealth | null = null;
  private get contextHealth(): ContextHealth | null {
    return this.inspectedContextHealth ?? this.activeContextHealth;
  }
  // True once the dashboard shell (document + script) is live in the panel, so
  // subsequent refreshes can swap just the inner content instead of reloading
  // the whole document (which flashed the panel blank on every refresh).
  private shellReady: boolean = false;

  constructor(private context: vscode.ExtensionContext) {}

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel('claudeCodeUsage', I18n.t.popup.title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    // A fresh panel has no shell yet — the first updateWebview() does a full render.
    this.shellReady = false;

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.shellReady = false;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'refresh':
          vscode.commands.executeCommand('claudeCodeUsage.refresh');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('claudeCodeUsage.openSettings');
          break;
        case 'tabChanged':
          this.currentTab = message.tab;
          break;
        case 'inspectContextHealth': {
          const sessionId = message.sessionId;
          if (sessionId && this.dataDirectory) {
            const { ClaudeDataLoader } = await import('./dataLoader');
            const health = await ClaudeDataLoader.getContextHealth(this.allRecords, this.dataDirectory, sessionId);
            if (health) {
              this.inspectedContextHealth = health;
              this.currentTab = 'contextHealth';
              this.updateWebview();
            }
          }
          break;
        }
        case 'clearInspectContextHealth':
          this.inspectedContextHealth = null;
          this.updateWebview();
          break;
        case 'getHourlyData':
          const dateString = message.date;
          if (dateString && this.panel) {
            // Get hourly data for the specified date
            const { ClaudeDataLoader } = await import('./dataLoader');
            const hourlyData = ClaudeDataLoader.getHourlyDataForDate(this.allRecords, dateString);

            // Send data back to webview
            this.panel.webview.postMessage({
              command: 'hourlyDataResponse',
              date: dateString,
              data: hourlyData,
            });
          }
          break;
        case 'getDailyData':
          const monthString = message.month;
          if (monthString && this.panel) {
            // Get daily data for the specified month
            const { ClaudeDataLoader } = await import('./dataLoader');
            const dailyData = ClaudeDataLoader.getDailyDataForSpecificMonth(this.allRecords, monthString);

            // Send data back to webview
            this.panel.webview.postMessage({
              command: 'dailyDataResponse',
              month: monthString,
              data: dailyData,
            });
          }
          break;
      }
    });

    this.updateWebview();
  }

  updateData(
    sessionData: SessionData | null,
    todayData: UsageData | null,
    monthData: UsageData | null,
    allTimeData: UsageData | null,
    dailyDataForMonth: { date: string; data: UsageData }[] = [],
    dailyDataForAllTime: { date: string; data: UsageData }[] = [],
    hourlyDataForToday: { hour: string; data: UsageData }[] = [],
    error?: string,
    dataDirectory?: string | null,
    allRecords?: any[],
    sessionBreakdown: SessionUsage[] = [],
    projectBreakdown: ProjectGroup[] = [],
    contentAnalysis: ContentAnalysis | null = null,
    branchBreakdown: BranchUsage[] = [],
    activityAnalysis: ActivityAnalysis | null = null,
    quotaHistory: QuotaSnapshot[] = [],
    contextHealth: ContextHealth | null = null
  ): void {
    this.currentSessionData = sessionData;
    this.todayData = todayData;
    this.monthData = monthData;
    this.allTimeData = allTimeData;
    this.dailyDataForMonth = dailyDataForMonth;
    this.dailyDataForAllTime = dailyDataForAllTime;
    this.hourlyDataForToday = hourlyDataForToday;
    this.error = error || null;
    this.dataDirectory = dataDirectory || null;
    this.isLoading = false;
    if (allRecords) {
      this.allRecords = allRecords;
    }
    this.sessionBreakdown = sessionBreakdown;
    this.projectBreakdown = projectBreakdown;
    this.contentAnalysis = contentAnalysis;
    this.branchBreakdown = branchBreakdown;
    this.activityAnalysis = activityAnalysis;
    this.quotaHistory = quotaHistory;
    this.activeContextHealth = contextHealth;

    if (this.panel) {
      this.updateWebview();
    }
  }

  setLoading(loading: boolean): void {
    this.isLoading = loading;
    // While a refresh is in flight, keep the existing dashboard on screen rather
    // than swapping in the spinner page — that swap is what made the panel flash
    // blank on every refresh. The fresh data arrives via updateData() moments
    // later and is swapped in smoothly. Only show the spinner on the very first
    // load, before any content exists.
    if (this.panel && (!loading || !this.shellReady)) {
      this.updateWebview();
    }
  }

  private updateWebview(): void {
    if (!this.panel) return;

    // Incremental path: once the dashboard shell is live and we have data (not an
    // error / no-data / loading state), swap only the inner content. Reassigning
    // webview.html reloads the whole document and flashes the panel blank, so we
    // avoid it on refresh.
    const hasData = !!(this.currentSessionData || this.todayData || this.monthData);
    if (this.shellReady && !this.isLoading && !this.error && hasData) {
      this.panel.webview.postMessage({
        command: 'updateContent',
        html: this.getMainContentInner(),
      });
      return;
    }

    this.panel.webview.html = this.getWebviewContent();
    // The shell is reusable only when we just rendered the full dashboard.
    this.shellReady = !this.isLoading && !this.error && hasData;
  }

  private getWebviewContent(): string {
    if (this.isLoading) {
      return this.getLoadingContent();
    }

    if (this.error) {
      return this.getErrorContent();
    }

    if (!this.currentSessionData && !this.todayData && !this.monthData) {
      return this.getNoDataContent();
    }

    return this.getMainContent();
  }

  private getLoadingContent(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
        <title>${I18n.t.popup.title}</title>
        <style>${this.getStyles()}</style>
      </head>
      <body>
        <div class="container">
          <div class="loading">
            <div class="spinner"></div>
            <p>${I18n.t.statusBar.loading}</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private getErrorContent(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
        <title>${I18n.t.popup.title}</title>
        <style>${this.getStyles()}</style>
      </head>
      <body>
        <div class="container">
          <div class="error">
            <h2>${I18n.t.statusBar.error}</h2>
            <p>${this.error}</p>
            <button onclick="refresh()">${I18n.t.popup.refresh}</button>
          </div>
        </div>
        <script>${this.getScript()}</script>
      </body>
      </html>
    `;
  }

  private getNoDataContent(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
        <title>${I18n.t.popup.title}</title>
        <style>${this.getStyles()}</style>
      </head>
      <body>
        <div class="container">
          <div class="no-data">
            <h2>${I18n.t.statusBar.noData}</h2>
            <p>${I18n.t.popup.noDataMessage}</p>
            <div class="actions">
              <button onclick="refresh()">${I18n.t.popup.refresh}</button>
              <button onclick="openSettings()">${I18n.t.popup.settings}</button>
            </div>
          </div>
        </div>
        <script>${this.getScript()}</script>
      </body>
      </html>
    `;
  }

  private getMainContent(): string {
    const title = I18n.t.popup.title;

    return (
      `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
        <title>` +
      title +
      `</title>
        <style>` +
      this.getStyles() +
      `</style>
      </head>
      <body>
        <div class="container">` +
      this.getMainContentInner() +
      `</div>
        <script>` +
      this.getScript() +
      `</script>
      </body>
      </html>
    `
    );
  }

  /**
   * The dashboard's inner markup (everything inside <div class="container">),
   * rendered without the surrounding document shell or <script>. On refresh we
   * post just this fragment to the live webview and swap it into the existing
   * container — see updateWebview(). That keeps the panel from reloading the
   * whole document, which used to flash blank on every refresh.
   */
  private getMainContentInner(): string {
    // Pre-resolve I18n values to avoid template literal issues
    const title = I18n.t.popup.title;
    const refresh = I18n.t.popup.refresh;
    const settings = I18n.t.popup.settings;
    const today = I18n.t.popup.today;
    const thisMonth = I18n.t.popup.thisMonth;
    const allTime = I18n.t.popup.allTime;
    const sessions = I18n.t.popup.sessions;
    const projects = I18n.t.popup.projects;
    const contentTab = I18n.t.popup.contentAnalysis;
    const branchesTab = I18n.t.popup.branches;

    const todayActive = this.currentTab === 'today' ? 'active' : '';
    const monthActive = this.currentTab === 'month' ? 'active' : '';
    const allActive = this.currentTab === 'all' ? 'active' : '';
    const sessionsActive = this.currentTab === 'sessions' ? 'active' : '';
    const projectsActive = this.currentTab === 'projects' ? 'active' : '';
    const contentActive = this.currentTab === 'content' ? 'active' : '';
    const branchesActive = this.currentTab === 'branches' ? 'active' : '';
    const activityActive = this.currentTab === 'activity' ? 'active' : '';
    const quotaActive = this.currentTab === 'quota' ? 'active' : '';
    const contextHealthActive = this.currentTab === 'contextHealth' ? 'active' : '';

    // The Context Health tab is shown only when an active session's health was
    // computed (enableContextHealth on, and a current session exists).
    const contextHealthEnabled = this.contextHealth !== null;
    const contextHealthTabButton = contextHealthEnabled
      ? '<button id="tab-contextHealth" class="tab ' + contextHealthActive +
        '" onclick="showTab(\'contextHealth\')">' + I18n.t.contextHealth.title + '</button>'
      : '';
    const contextHealthTabContent = contextHealthEnabled
      ? '<div id="contextHealth" class="tab-content ' + contextHealthActive + '">' + this.renderContextHealthData() + '</div>'
      : '';

    // The Content tab is hidden when content analysis is disabled via
    // claudeCodeUsage.enableContentAnalysis (the analyser returned null).
    const contentEnabled = this.contentAnalysis !== null;
    const contentTabButton = contentEnabled
      ? '<button id="tab-content" class="tab ' + contentActive +
        '" onclick="showTab(\'content\')">' + contentTab + '</button>'
      : '';
    const contentTabContent = contentEnabled
      ? '<div id="content" class="tab-content ' + contentActive + '">' + this.renderContentData() + '</div>'
      : '';

    // The Activity tab rides on the same analysis pass as Content, so it is
    // shown/hidden under the same condition.
    const activityEnabled = this.activityAnalysis !== null;
    const activityTab = I18n.t.popup.activity;
    const activityTabButton = activityEnabled
      ? '<button id="tab-activity" class="tab ' + activityActive +
        '" onclick="showTab(\'activity\')">' + activityTab + '</button>'
      : '';
    const activityTabContent = activityEnabled
      ? '<div id="activity" class="tab-content ' + activityActive + '">' + this.renderActivityData() + '</div>'
      : '';

    return (
      `
          <header>
            <h1>` +
      title +
      `</h1>
            <div class="actions">
              <button onclick="refresh()" class="btn-secondary">` +
      refresh +
      `</button>
              <button onclick="openSettings()" class="btn-secondary">` +
      settings +
      `</button>
            </div>
          </header>

          <div class="tabs">
            <button id="tab-today" class="tab ` +
      todayActive +
      `" onclick="showTab('today')">` +
      today +
      `</button>
            <button id="tab-month" class="tab ` +
      monthActive +
      `" onclick="showTab('month')">` +
      thisMonth +
      `</button>
            <button id="tab-all" class="tab ` +
      allActive +
      `" onclick="showTab('all')">` +
      allTime +
      `</button>
            <button id="tab-sessions" class="tab ` +
      sessionsActive +
      `" onclick="showTab('sessions')">` +
      sessions +
      `</button>
            <button id="tab-projects" class="tab ` +
      projectsActive +
      `" onclick="showTab('projects')">` +
      projects +
      `</button>
            ` +
      contentTabButton +
      `
            <button id="tab-branches" class="tab ` +
      branchesActive +
      `" onclick="showTab('branches')">` +
      branchesTab +
      `</button>
            ` +
      activityTabButton +
      `
            <button id="tab-quota" class="tab ` +
      quotaActive +
      `" onclick="showTab('quota')">` +
      I18n.t.popup.quotaHistory +
      `</button>
            ` +
      contextHealthTabButton +
      `
          </div>

          <div id="today" class="tab-content ` +
      todayActive +
      `">
            ` +
      this.renderTodayData() +
      `
          </div>

          <div id="month" class="tab-content ` +
      monthActive +
      `">
            ` +
      this.renderMonthData() +
      `
          </div>

          <div id="all" class="tab-content ` +
      allActive +
      `">
            ` +
      this.renderAllTimeData() +
      `
          </div>

          <div id="sessions" class="tab-content ` +
      sessionsActive +
      `">
            ` +
      this.renderSessionData() +
      `
          </div>

          <div id="projects" class="tab-content ` +
      projectsActive +
      `">
            ` +
      this.renderProjectData() +
      `
          </div>

          ` +
      contentTabContent +
      `

          <div id="branches" class="tab-content ` +
      branchesActive +
      `">
            ` +
      this.renderBranchData() +
      `
          </div>

          ` +
      activityTabContent +
      `

          <div id="quota" class="tab-content ` +
      quotaActive +
      `">
            ` +
      this.renderQuotaData() +
      `
          </div>

          ` +
      contextHealthTabContent +
      `
    `
    );
  }

  private renderTodayData(): string {
    if (!this.todayData) {
      return '<div class="no-data"><p>' + I18n.t.popup.noDataMessage + '</p></div>';
    }

    const todaySummary = this.renderUsageData(this.todayData);

    let hourlyBreakdown = '';
    if (this.hourlyDataForToday.length > 0) {
      const cost = I18n.t.popup.cost;
      const inputTokens = I18n.t.popup.inputTokens;
      const outputTokens = I18n.t.popup.outputTokens;
      const cacheCreation = I18n.t.popup.cacheCreation;
      const cacheRead = I18n.t.popup.cacheRead;
      const messages = I18n.t.popup.messages;

      let hourlyRows = '';
      this.hourlyDataForToday.forEach(({ hour, data }) => {
        hourlyRows +=
          '<tr>' +
          '<td class="date-cell">' +
          hour +
          '</td>' +
          '<td class="cost-cell">' +
          I18n.formatCurrency(data.totalCost) +
          '</td>' +
          '<td class="number-cell">' +
          I18n.formatNumber(data.totalInputTokens) +
          '</td>' +
          '<td class="number-cell">' +
          I18n.formatNumber(data.totalOutputTokens) +
          '</td>' +
          '<td class="number-cell">' +
          I18n.formatNumber(data.totalCacheCreationTokens) +
          '</td>' +
          '<td class="number-cell">' +
          I18n.formatNumber(data.totalCacheReadTokens) +
          '</td>' +
          '<td class="number-cell">' +
          I18n.formatNumber(data.messageCount) +
          '</td>' +
          '</tr>';
      });

      hourlyBreakdown =
        '<div class="daily-breakdown">' +
        '<h3>' +
        I18n.t.popup.hourlyBreakdown +
        '</h3>' +
        '<div class="chart-tabs">' +
        '<button class="chart-tab active" data-metric="cost">' +
        cost +
        '</button>' +
        '<button class="chart-tab" data-metric="inputTokens">' +
        inputTokens +
        '</button>' +
        '<button class="chart-tab" data-metric="outputTokens">' +
        outputTokens +
        '</button>' +
        '<button class="chart-tab" data-metric="cacheCreation">' +
        cacheCreation +
        '</button>' +
        '<button class="chart-tab" data-metric="cacheRead">' +
        cacheRead +
        '</button>' +
        '<button class="chart-tab" data-metric="messages">' +
        messages +
        '</button>' +
        '</div>' +
        this.renderHourlyChart() +
        this.renderCompositionChart(
          [...this.hourlyDataForToday]
            .sort((a, b) => a.hour.localeCompare(b.hour))
            .map((h) => ({ label: h.hour, data: h.data }))
        ) +
        '<div class="daily-table-container">' +
        '<table class="daily-table">' +
        '<thead>' +
        '<tr>' +
        '<th>' +
        I18n.t.popup.hour +
        '</th>' +
        '<th>' +
        cost +
        '</th>' +
        '<th>' +
        inputTokens +
        '</th>' +
        '<th>' +
        outputTokens +
        '</th>' +
        '<th>' +
        cacheCreation +
        '</th>' +
        '<th>' +
        cacheRead +
        '</th>' +
        '<th>' +
        messages +
        '</th>' +
        '</tr>' +
        '</thead>' +
        '<tbody>' +
        hourlyRows +
        '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>';
    }

    return todaySummary + hourlyBreakdown;
  }

  private renderUsageData(data: UsageData | null): string {
    if (!data) {
      return '<div class="no-data"><p>' + I18n.t.popup.noDataMessage + '</p></div>';
    }

    const cost = I18n.t.popup.cost;
    const messages = I18n.t.popup.messages;
    const inputTokens = I18n.t.popup.inputTokens;
    const outputTokens = I18n.t.popup.outputTokens;
    const cacheCreation = I18n.t.popup.cacheCreation;
    const cacheRead = I18n.t.popup.cacheRead;
    const modelBreakdown = I18n.t.popup.modelBreakdown;
    const pricing = I18n.t.popup.pricing;

    // Cache hit rate: share of input-side tokens served cheaply from cache.
    const inputSideTokens = data.totalInputTokens + data.totalCacheCreationTokens + data.totalCacheReadTokens;
    const cacheHitRate = inputSideTokens > 0 ? (data.totalCacheReadTokens / inputSideTokens) * 100 : 0;

    // Cost composition: how each token type contributes to the total cost.
    const cb = data.costBreakdown;
    const costTotal = cb.input + cb.output + cb.cacheWrite + cb.cacheRead;
    const cpct = (v: number): number => (costTotal > 0 ? (v / costTotal) * 100 : 0);
    const compSeg = (cls: string, v: number): string =>
      '<div class="cost-comp-seg ' + cls + '" style="width: ' + cpct(v).toFixed(2) + '%;"></div>';
    const compItem = (cls: string, label: string, v: number): string =>
      '<span class="legend-item"><span class="legend-dot ' + cls + '"></span>' +
      label + ' ' + I18n.formatCurrency(v) + ' (' + cpct(v).toFixed(0) + '%)</span>';
    const costComposition =
      costTotal > 0
        ? '<div class="cost-composition">' +
          '<div class="cost-comp-head">' + I18n.t.popup.costComposition + '</div>' +
          '<div class="cost-comp-bar">' +
          compSeg('seg-input', cb.input) +
          compSeg('seg-output', cb.output) +
          compSeg('seg-cache-creation', cb.cacheWrite) +
          compSeg('seg-cache-read', cb.cacheRead) +
          '</div>' +
          '<div class="cost-comp-legend">' +
          compItem('seg-input', inputTokens, cb.input) +
          compItem('seg-output', outputTokens, cb.output) +
          compItem('seg-cache-creation', cacheCreation, cb.cacheWrite) +
          compItem('seg-cache-read', cacheRead, cb.cacheRead) +
          '</div>' +
          '</div>'
        : '';

    let html =
      '<div class="usage-summary">' +
      '<div class="summary-grid">' +
      '<div class="summary-item">' +
      '<div class="label">' +
      cost +
      '</div>' +
      '<div class="value cost">' +
      I18n.formatCurrency(data.totalCost) +
      '</div>' +
      '</div>' +
      '<div class="summary-item">' +
      '<div class="label">' +
      messages +
      '</div>' +
      '<div class="value">' +
      I18n.formatNumber(data.messageCount) +
      '</div>' +
      '</div>' +
      '<div class="summary-item">' +
      '<div class="label">' +
      inputTokens +
      '</div>' +
      '<div class="value">' +
      I18n.formatNumber(data.totalInputTokens) +
      '</div>' +
      '</div>' +
      '<div class="summary-item">' +
      '<div class="label">' +
      outputTokens +
      '</div>' +
      '<div class="value">' +
      I18n.formatNumber(data.totalOutputTokens) +
      '</div>' +
      '</div>' +
      '<div class="summary-item">' +
      '<div class="label">' +
      cacheCreation +
      '</div>' +
      '<div class="value">' +
      I18n.formatNumber(data.totalCacheCreationTokens) +
      '</div>' +
      '</div>' +
      '<div class="summary-item">' +
      '<div class="label">' +
      cacheRead +
      '</div>' +
      '<div class="value">' +
      I18n.formatNumber(data.totalCacheReadTokens) +
      '</div>' +
      '</div>' +
      '<div class="summary-item">' +
      '<div class="label">' +
      I18n.t.popup.cacheHitRate +
      '</div>' +
      '<div class="value">' +
      cacheHitRate.toFixed(0) +
      '%</div>' +
      '</div>' +
      '</div>' +
      costComposition +
      '</div>';

    if (Object.keys(data.modelBreakdown).length > 0) {
      // Sort models by cost descending so the most expensive model is on top.
      // Default state: only the top model is open; the rest collapse to one
      // line — keeps low-cost noise from pushing the dashboard long.
      const sortedModels = Object.entries(data.modelBreakdown).sort(
        ([, a], [, b]) => b.cost - a.cost
      );

      html +=
        '<div class="model-breakdown">' +
        '<div class="section-header">' +
        '<h3>' +
        modelBreakdown +
        '</h3>' +
        '</div>' +
        '<div class="model-list">';

      sortedModels.forEach(([model, modelData], index) => {
        const rates = getModelRatesPerMillion(model);
        const pricingLine = rates
          ? '<div class="model-pricing">' +
            pricing +
            ' (/1M): ' +
            inputTokens +
            ' ' +
            this.formatRate(rates.input) +
            ' · ' +
            outputTokens +
            ' ' +
            this.formatRate(rates.output) +
            ' · ' +
            cacheCreation +
            ' ' +
            this.formatRate(rates.cacheWrite) +
            ' · ' +
            cacheRead +
            ' ' +
            this.formatRate(rates.cacheRead) +
            '</div>'
          : '';

        // Per-model cache hit rate, same formula as the summary card.
        const modelInputSide =
          modelData.inputTokens + modelData.cacheCreationTokens + modelData.cacheReadTokens;
        const modelHitRate =
          modelInputSide > 0 ? (modelData.cacheReadTokens / modelInputSide) * 100 : 0;

        // <details open> on index 0 only; subsequent models collapse so the
        // user only sees N model rows by default.
        const openAttr = index === 0 ? ' open' : '';
        html +=
          '<details class="model-item"' +
          openAttr +
          '>' +
          '<summary class="model-header">' +
          '<span class="model-name">' +
          this.escapeHtml(model) +
          '</span>' +
          '<span class="model-cost">' +
          I18n.formatCurrency(modelData.cost) +
          '</span>' +
          '</summary>' +
          '<div class="model-details model-details-stacked">' +
          '<span><span class="model-stat-label">' + inputTokens + ':</span>' +
          ' ' + I18n.formatNumber(modelData.inputTokens) + '</span>' +
          '<span><span class="model-stat-label">' + outputTokens + ':</span>' +
          ' ' + I18n.formatNumber(modelData.outputTokens) + '</span>' +
          '<span><span class="model-stat-label">' + cacheCreation + ':</span>' +
          ' ' + I18n.formatNumber(modelData.cacheCreationTokens) + '</span>' +
          '<span><span class="model-stat-label">' + cacheRead + ':</span>' +
          ' ' + I18n.formatNumber(modelData.cacheReadTokens) + '</span>' +
          '<span><span class="model-stat-label">' + I18n.t.popup.cacheHitRate + ':</span>' +
          ' ' + modelHitRate.toFixed(0) + '%</span>' +
          '<span><span class="model-stat-label">' + messages + ':</span>' +
          ' ' + I18n.formatNumber(modelData.count) + '</span>' +
          '</div>' +
          pricingLine +
          '</details>';
      });

      html += '</div></div>';
    }

    return html;
  }

  private renderMonthData(): string {
    if (!this.monthData) {
      return `<div class="no-data"><p>${I18n.t.popup.noDataMessage}</p></div>`;
    }

    const monthSummary = this.renderUsageData(this.monthData);

    const dailyBreakdown =
      this.dailyDataForMonth.length > 0
        ? `
      <div class="daily-breakdown">
        <h3>${I18n.t.popup.dailyBreakdown}</h3>

        <!-- Chart Tabs -->
        <div class="chart-tabs">
          <button class="chart-tab active" data-metric="cost">${I18n.t.popup.cost}</button>
          <button class="chart-tab" data-metric="inputTokens">${I18n.t.popup.inputTokens}</button>
          <button class="chart-tab" data-metric="outputTokens">${I18n.t.popup.outputTokens}</button>
          <button class="chart-tab" data-metric="cacheCreation">${I18n.t.popup.cacheCreation}</button>
          <button class="chart-tab" data-metric="cacheRead">${I18n.t.popup.cacheRead}</button>
          <button class="chart-tab" data-metric="messages">${I18n.t.popup.messages}</button>
        </div>

        <!-- Chart Container -->
        <div class="chart-container">
          <div class="chart-content" id="dailyChart">
            ${this.renderDailyChart()}
          </div>
        </div>

        ${this.renderCompositionChart(
          [...this.dailyDataForMonth]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((d) => ({ label: this.getShortDate(d.date), data: d.data }))
        )}

        <div class="daily-table-container">
          <table class="daily-table">
            <thead>
              <tr>
                <th>${I18n.t.popup.date}</th>
                <th>${I18n.t.popup.cost}</th>
                <th>${I18n.t.popup.inputTokens}</th>
                <th>${I18n.t.popup.outputTokens}</th>
                <th>${I18n.t.popup.cacheCreation}</th>
                <th>${I18n.t.popup.cacheRead}</th>
                <th>${I18n.t.popup.messages}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${this.dailyDataForMonth
                .map(
                  ({ date, data }) => `
                <tr class="daily-row" data-date="${date}">
                  <td class="date-cell">${this.formatDate(date)}</td>
                  <td class="cost-cell">${I18n.formatCurrency(data.totalCost)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalInputTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalOutputTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalCacheCreationTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalCacheReadTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.messageCount)}</td>
                  <td class="detail-cell">
                    <button class="detail-button" onclick="toggleHourlyDetail('${date}')" title="${I18n.t.popup.hourlyBreakdown}">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path class="expand-icon" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
                      </svg>
                    </button>
                  </td>
                </tr>
                <tr class="hourly-detail-row" data-date="${date}" style="display: none;">
                  <td colspan="8">
                    <div class="hourly-detail-container" id="hourly-detail-${date}">
                      <div class="loading-indicator">載入中...</div>
                    </div>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `
        : '';

    return monthSummary + dailyBreakdown;
  }

  private renderAllTimeData(): string {
    if (!this.allTimeData) {
      return `<div class="no-data"><p>${I18n.t.popup.noDataMessage}</p></div>`;
    }

    const allTimeSummary = this.renderUsageData(this.allTimeData);

    const dailyBreakdown =
      this.dailyDataForAllTime.length > 0
        ? `
      <div class="daily-breakdown">
        <h3>${I18n.t.popup.monthlyBreakdown}</h3>

        <!-- Chart Tabs -->
        <div class="chart-tabs">
          <button class="chart-tab active" data-metric="cost">${I18n.t.popup.cost}</button>
          <button class="chart-tab" data-metric="inputTokens">${I18n.t.popup.inputTokens}</button>
          <button class="chart-tab" data-metric="outputTokens">${I18n.t.popup.outputTokens}</button>
          <button class="chart-tab" data-metric="cacheCreation">${I18n.t.popup.cacheCreation}</button>
          <button class="chart-tab" data-metric="cacheRead">${I18n.t.popup.cacheRead}</button>
          <button class="chart-tab" data-metric="messages">${I18n.t.popup.messages}</button>
        </div>

        <!-- Chart Container -->
        <div class="chart-container">
          <div class="chart-content" id="allTimeChart">
            ${this.renderAllTimeChart()}
          </div>
        </div>

        ${this.renderCompositionChart(
          [...this.dailyDataForAllTime]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((d) => ({ label: this.getShortDate(d.date), data: d.data }))
        )}

        <div class="daily-table-container">
          <table class="daily-table">
            <thead>
              <tr>
                <th>${I18n.t.popup.date}</th>
                <th>${I18n.t.popup.cost}</th>
                <th>${I18n.t.popup.inputTokens}</th>
                <th>${I18n.t.popup.outputTokens}</th>
                <th>${I18n.t.popup.cacheCreation}</th>
                <th>${I18n.t.popup.cacheRead}</th>
                <th>${I18n.t.popup.messages}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${this.dailyDataForAllTime
                .map(
                  ({ date, data }) => `
                <tr class="daily-row" data-date="${date}">
                  <td class="date-cell">${this.formatDate(date)}</td>
                  <td class="cost-cell">${I18n.formatCurrency(data.totalCost)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalInputTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalOutputTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalCacheCreationTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.totalCacheReadTokens)}</td>
                  <td class="number-cell">${I18n.formatNumber(data.messageCount)}</td>
                  <td class="detail-cell">
                    <button class="detail-button" onclick="toggleMonthlyDetail('${date}')" title="顯示每日詳細資料">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path class="expand-icon" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
                      </svg>
                    </button>
                  </td>
                </tr>
                <tr class="monthly-detail-row" data-date="${date}" style="display: none;">
                  <td colspan="8">
                    <div class="monthly-detail-container" id="monthly-detail-${date}">
                      <div class="loading-indicator">載入中...</div>
                    </div>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `
        : '';

    return allTimeSummary + dailyBreakdown;
  }

  private renderSessionData(): string {
    if (!this.sessionBreakdown || this.sessionBreakdown.length === 0) {
      return '<div class="no-data"><p>' + I18n.t.popup.noDataMessage + '</p></div>';
    }

    const t = I18n.t.popup;

    let rows = '';
    this.sessionBreakdown.forEach((s) => {
      const d = s.data;
      rows +=
        '<tr class="sort-row"' +
        ' data-sort-time="' + s.startTime.getTime() + '"' +
        ' data-sort-project="' + this.escapeHtml((s.projectName || '').toLowerCase()) + '"' +
        ' data-sort-context="' + s.peakContextTokens + '"' +
        ' data-sort-duration="' + (s.endTime.getTime() - s.startTime.getTime()) + '"' +
        this.usageSortAttrs(d) +
        '>' +
        '<td class="date-cell" title="' + this.escapeHtml(s.sessionId) + '">' +
        this.escapeHtml(this.formatDateTime(s.startTime)) +
        '</td>' +
        this.renderProjectCell(s.projectName, s.projectPath) +
        '<td class="cost-cell">' + I18n.formatCurrency(d.totalCost) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalInputTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalOutputTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalCacheCreationTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalCacheReadTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(s.peakContextTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.messageCount) + '</td>' +
        '<td class="number-cell">' + this.escapeHtml(this.formatDuration(s.startTime, s.endTime)) + '</td>' +
        '<td class="number-cell"><button class="ch-inspect-btn" data-session="' + this.escapeHtml(s.sessionId) +
        '" onclick="inspectContextHealth(this.dataset.session)" title="' + I18n.t.contextHealth.inspect + '">🔍 ' +
        I18n.t.contextHealth.inspect + '</button></td>' +
        '</tr>';
    });

    const th = (key: string, label: string): string =>
      '<th class="sortable" data-sortkey="' + key + '">' + label + '</th>';

    return (
      '<div class="daily-breakdown">' +
      '<h3>' + t.sessionBreakdown + '</h3>' +
      '<p class="table-hint">' + t.sortHint + '</p>' +
      '<div class="daily-table-container">' +
      '<table class="daily-table sortable-table">' +
      '<thead><tr>' +
      th('time', t.startTime) +
      th('project', t.project) +
      th('cost', t.cost) +
      th('input', t.inputTokens) +
      th('output', t.outputTokens) +
      th('cachecreate', t.cacheCreation) +
      th('cacheread', t.cacheRead) +
      th('context', t.peakContext) +
      th('messages', t.messages) +
      th('duration', t.duration) +
      '<th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>' +
      '</div>'
    );
  }

  /** Reading-friendly date/time: "Today HH:MM", "Yesterday HH:MM", "MM-DD HH:MM" or "YYYY-MM-DD". */
  private formatDateTime(date: Date): string {
    if (!date || isNaN(date.getTime()) || date.getTime() === 0) {
      return '-';
    }
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const hm = pad(date.getHours()) + ':' + pad(date.getMinutes());
    const sameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    if (sameDay(date, now)) {
      return I18n.t.popup.today + ' ' + hm;
    }
    if (sameDay(date, yesterday)) {
      return I18n.t.popup.yesterday + ' ' + hm;
    }
    if (date.getFullYear() === now.getFullYear()) {
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + hm;
    }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  /** USD per-1M-token rate, trimmed of trailing zeros for compact display. */
  private formatRate(n: number): string {
    return '$' + parseFloat(n.toFixed(4)).toString();
  }

  /** data-sort-* attributes for the token/cost columns shared by both tables. */
  private usageSortAttrs(d: UsageData): string {
    return (
      ' data-sort-cost="' + d.totalCost +
      '" data-sort-input="' + d.totalInputTokens +
      '" data-sort-output="' + d.totalOutputTokens +
      '" data-sort-cachecreate="' + d.totalCacheCreationTokens +
      '" data-sort-cacheread="' + d.totalCacheReadTokens +
      '" data-sort-messages="' + d.messageCount + '"'
    );
  }

  /** Cache hit rate: share of input-side tokens served cheaply from cache (0–100), or null when no data. */
  private cacheHitRatePct(d: UsageData): number | null {
    const denom = d.totalInputTokens + d.totalCacheCreationTokens + d.totalCacheReadTokens;
    return denom > 0 ? (d.totalCacheReadTokens / denom) * 100 : null;
  }

  /** A colored badge cell for cache hit rate. Green ≥50%, yellow 20–49%, red <20%. */
  private renderCacheHitCell(d: UsageData): string {
    const rate = this.cacheHitRatePct(d);
    if (rate === null) {
      return '<td class="number-cell">—</td>';
    }
    const pct = Math.round(rate);
    const cls = pct >= 50 ? 'cache-badge-good' : pct >= 20 ? 'cache-badge-mid' : 'cache-badge-low';
    return '<td class="number-cell"><span class="cache-badge ' + cls + '">' + pct + '%</span></td>';
  }

  /** Insights card: overall rate + worst-offender list for the Projects tab. */
  private renderCacheInsights(groups: ProjectGroup[]): string {
    const t = I18n.t.popup;
    const totalTokens = (d: UsageData) =>
      d.totalInputTokens + d.totalCacheCreationTokens + d.totalCacheReadTokens;

    // Weighted overall rate across all projects.
    let sumRead = 0, sumTotal = 0;
    groups.forEach((g) => { sumRead += g.data.totalCacheReadTokens; sumTotal += totalTokens(g.data); });
    const overallRate = sumTotal > 0 ? Math.round((sumRead / sumTotal) * 100) : null;

    // Low-performers: rate < 20% with at least 50k input-side tokens (filter out tiny projects).
    const low = groups
      .filter((g) => totalTokens(g.data) >= 50_000)
      .map((g) => ({ name: g.groupName, rate: this.cacheHitRatePct(g.data) }))
      .filter((x): x is { name: string; rate: number } => x.rate !== null && x.rate < 20)
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 4);

    if (overallRate === null && low.length === 0) {
      return '';
    }

    const overallBadge = overallRate !== null
      ? '<span class="cache-badge ' + (overallRate >= 50 ? 'cache-badge-good' : overallRate >= 20 ? 'cache-badge-mid' : 'cache-badge-low') + '">' + overallRate + '%</span>'
      : '';

    const lowList = low.length > 0
      ? '<p class="table-hint cache-low-list"><strong>' + t.cacheLowEfficiency + ':</strong> ' +
        low.map((x) => '<span class="cache-badge cache-badge-low">' + this.escapeHtml(x.name) + ' ' + Math.round(x.rate) + '%</span>').join(' ') +
        '</p>'
      : '';

    const tip = low.length > 0
      ? '<p class="table-hint">' + t.cacheEfficiencyTip + '</p>'
      : '';

    return (
      '<div class="daily-breakdown cache-insights-card">' +
      '<h3>' + t.cacheHitRate + ' ' + overallBadge + '</h3>' +
      lowList +
      tip +
      '</div>'
    );
  }

  private formatDuration(start: Date, end: Date): string {
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
      return '-';
    }
    const ms = end.getTime() - start.getTime();
    if (ms <= 0) {
      return '<1m';
    }
    const totalMinutes = Math.round(ms / 60000);
    if (totalMinutes < 1) {
      return '<1m';
    }
    if (totalMinutes < 60) {
      return totalMinutes + 'm';
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? hours + 'h ' + minutes + 'm' : hours + 'h';
  }

  /** A table cell showing the project's friendly name with its full path beneath. */
  private renderProjectCell(name: string, fullPath: string): string {
    const safeName = this.escapeHtml(name || 'unknown');
    const safePath = this.escapeHtml(fullPath || '');
    const pathLine = safePath ? '<div class="project-path" title="' + safePath + '">' + safePath + '</div>' : '';
    return '<td class="project-cell"><div class="project-name">' + safeName + '</div>' + pathLine + '</td>';
  }

  private renderProjectData(): string {
    if (!this.projectBreakdown || this.projectBreakdown.length === 0) {
      return '<div class="no-data"><p>' + I18n.t.popup.noDataMessage + '</p></div>';
    }

    const t = I18n.t.popup;

    const usageCells = (d: UsageData): string =>
      '<td class="cost-cell">' + I18n.formatCurrency(d.totalCost) + '</td>' +
      '<td class="number-cell">' + I18n.formatNumber(d.totalInputTokens) + '</td>' +
      '<td class="number-cell">' + I18n.formatNumber(d.totalOutputTokens) + '</td>' +
      '<td class="number-cell">' + I18n.formatNumber(d.totalCacheCreationTokens) + '</td>' +
      '<td class="number-cell">' + I18n.formatNumber(d.totalCacheReadTokens) + '</td>' +
      '<td class="number-cell">' + I18n.formatNumber(d.messageCount) + '</td>' +
      this.renderCacheHitCell(d);

    let rows = '';
    this.projectBreakdown.forEach((group, idx) => {
      const groupId = 'pg' + idx;
      const cacheRate = this.cacheHitRatePct(group.data);
      const sortAttrs =
        ' data-sort-name="' + this.escapeHtml(group.groupName.toLowerCase()) + '"' +
        ' data-sort-sessions="' + group.sessionCount + '"' +
        ' data-sort-lastactive="' + group.lastSeen.getTime() + '"' +
        ' data-sort-cachehit="' + (cacheRate !== null ? cacheRate.toFixed(2) : '-1') + '"' +
        this.usageSortAttrs(group.data);

      if (group.children.length <= 1) {
        // A single project — render as one plain, sortable row.
        const only = group.children[0];
        const name = only ? only.projectName : group.groupName;
        const path = only ? only.projectPath : group.groupPath;
        rows +=
          '<tr class="sort-row"' + sortAttrs + '>' +
          this.renderProjectCell(name, path) +
          '<td class="number-cell">' + I18n.formatNumber(group.sessionCount) + '</td>' +
          usageCells(group.data) +
          '<td class="date-cell">' + this.escapeHtml(this.formatDateTime(group.lastSeen)) + '</td>' +
          '</tr>';
      } else {
        // Several projects under one folder — an expandable group row.
        rows +=
          '<tr class="sort-row project-group-row" data-group="' + groupId + '"' + sortAttrs + '>' +
          '<td class="project-cell">' +
          '<div class="project-name">' +
          '<span class="group-toggle" onclick="toggleProjectGroup(\'' + groupId + '\')">▶</span> ' +
          (group.isGitRepo ? '<span class="git-badge">git</span> ' : '') +
          this.escapeHtml(group.groupName) +
          ' <span class="group-count">(' + group.projectCount + ')</span>' +
          '</div>' +
          '<div class="project-path" title="' + this.escapeHtml(group.groupPath) + '">' +
          this.escapeHtml(group.groupPath) +
          '</div>' +
          '</td>' +
          '<td class="number-cell">' + I18n.formatNumber(group.sessionCount) + '</td>' +
          usageCells(group.data) +
          '<td class="date-cell">' + this.escapeHtml(this.formatDateTime(group.lastSeen)) + '</td>' +
          '</tr>';
        group.children.forEach((child) => {
          rows +=
            '<tr class="sort-child project-child-row" data-group="' + groupId + '" style="display:none;">' +
            '<td class="project-cell project-child-cell">' +
            '<div class="project-name">' + this.escapeHtml(child.projectName) + '</div>' +
            '<div class="project-path" title="' + this.escapeHtml(child.projectPath) + '">' +
            this.escapeHtml(child.projectPath) +
            '</div>' +
            '</td>' +
            '<td class="number-cell">' + I18n.formatNumber(child.sessionCount) + '</td>' +
            usageCells(child.data) +
            '<td class="date-cell">' + this.escapeHtml(this.formatDateTime(child.lastSeen)) + '</td>' +
            '</tr>';
        });
      }
    });

    const th = (key: string, label: string): string =>
      '<th class="sortable" data-sortkey="' + key + '">' + label + '</th>';

    return (
      this.renderCacheInsights(this.projectBreakdown) +
      '<div class="daily-breakdown">' +
      '<h3>' + t.projectBreakdown + '</h3>' +
      '<p class="table-hint">' + t.sortHint + '</p>' +
      '<div class="daily-table-container">' +
      '<table class="daily-table sortable-table">' +
      '<thead><tr>' +
      th('name', t.project) +
      th('sessions', t.sessions) +
      th('cost', t.cost) +
      th('input', t.inputTokens) +
      th('output', t.outputTokens) +
      th('cachecreate', t.cacheCreation) +
      th('cacheread', t.cacheRead) +
      th('messages', t.messages) +
      th('cachehit', t.cacheHitRate) +
      th('lastactive', t.lastActive) +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>' +
      '</div>'
    );
  }

  private renderBranchData(): string {
    if (!this.branchBreakdown || this.branchBreakdown.length === 0) {
      return '<div class="no-data"><p>' + I18n.t.popup.noDataMessage + '</p></div>';
    }

    const t = I18n.t.popup;

    let rows = '';
    this.branchBreakdown.forEach((b) => {
      const d = b.data;
      rows +=
        '<tr class="sort-row"' +
        ' data-sort-branch="' + this.escapeHtml(b.branch.toLowerCase()) + '"' +
        ' data-sort-project="' + this.escapeHtml((b.projectName || '').toLowerCase()) + '"' +
        ' data-sort-sessions="' + b.sessionCount + '"' +
        ' data-sort-lastactive="' + b.lastSeen.getTime() + '"' +
        this.usageSortAttrs(d) +
        '>' +
        '<td class="date-cell" title="' + this.escapeHtml(b.projectPath) + '">' + this.escapeHtml(b.branch) + '</td>' +
        '<td>' + this.escapeHtml(b.projectName) + '</td>' +
        '<td class="cost-cell">' + I18n.formatCurrency(d.totalCost) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalInputTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalOutputTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalCacheCreationTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.totalCacheReadTokens) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(d.messageCount) + '</td>' +
        '<td class="number-cell">' + I18n.formatNumber(b.sessionCount) + '</td>' +
        '<td class="date-cell">' + this.escapeHtml(this.formatDateTime(b.lastSeen)) + '</td>' +
        '</tr>';
    });

    const th = (key: string, label: string): string =>
      '<th class="sortable" data-sortkey="' + key + '">' + label + '</th>';

    return (
      '<div class="daily-breakdown">' +
      '<h3>' + t.branchBreakdown + '</h3>' +
      '<p class="table-hint">' + t.sortHint + '</p>' +
      '<div class="daily-table-container">' +
      '<table class="daily-table sortable-table">' +
      '<thead><tr>' +
      th('branch', t.branch) +
      th('project', t.project) +
      th('cost', t.cost) +
      th('input', t.inputTokens) +
      th('output', t.outputTokens) +
      th('cachecreate', t.cacheCreation) +
      th('cacheread', t.cacheRead) +
      th('messages', t.messages) +
      th('sessions', t.sessions) +
      th('lastactive', t.lastActive) +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>' +
      '</div>'
    );
  }

  /**
   * "Content" tab: an estimated breakdown of which conversation content consumes
   * tokens (your prompts vs. tool results vs. assistant output), to help spot
   * habits worth optimising. Token figures are estimated from text length.
   */
  private renderContentData(): string {
    const t = I18n.t.popup;
    const analysis = this.contentAnalysis;
    if (!analysis || analysis.categories.length === 0 || analysis.totalEstimatedTokens === 0) {
      return '<div class="no-data"><p>' + I18n.t.popup.noDataMessage + '</p></div>';
    }

    const total = analysis.totalEstimatedTokens;

    const catLabel = (key: string): string => {
      switch (key) {
        case 'userPrompts':
          return t.catUserPrompts;
        case 'assistantText':
          return t.catAssistantText;
        case 'assistantThinking':
          return t.catAssistantThinking;
        case 'toolCalls':
          return t.catToolCalls;
        case 'toolResults':
          return t.catToolResults;
        default:
          return key;
      }
    };
    const catColor: Record<string, string> = {
      userPrompts: 'cf-1',
      assistantText: 'cf-2',
      assistantThinking: 'cf-3',
      toolCalls: 'cf-4',
      toolResults: 'cf-5',
    };

    const barRow = (label: string, tokens: number, barMax: number, colorClass: string): string => {
      const pct = total > 0 ? (tokens / total) * 100 : 0;
      const width = barMax > 0 ? (tokens / barMax) * 100 : 0;
      return (
        '<div class="cbar-row">' +
        '<div class="cbar-label" title="' + this.escapeHtml(label) + '">' + this.escapeHtml(label) + '</div>' +
        '<div class="cbar-track"><div class="cbar-fill ' + colorClass + '" style="width: ' + width.toFixed(1) + '%;"></div></div>' +
        '<div class="cbar-val">' + I18n.formatNumber(tokens) + '</div>' +
        '<div class="cbar-pct">' + pct.toFixed(1) + '%</div>' +
        '</div>'
      );
    };

    const maxCat = Math.max(...analysis.categories.map((c) => c.estimatedTokens), 1);
    let catRows = '';
    analysis.categories.forEach((c) => {
      catRows += barRow(catLabel(c.key), c.estimatedTokens, maxCat, catColor[c.key] || 'cf-1');
    });

    let toolSection = '';
    if (analysis.toolResultBreakdown.length > 0) {
      const maxTool = Math.max(...analysis.toolResultBreakdown.map((s) => s.estimatedTokens), 1);
      let toolRows = '';
      analysis.toolResultBreakdown.forEach((s) => {
        toolRows += barRow(s.key, s.estimatedTokens, maxTool, 'cf-4');
      });
      toolSection = '<h4 class="cbar-subhead">' + t.byTool + '</h4><div class="cbar-list">' + toolRows + '</div>';
    }

    return (
      '<div class="daily-breakdown">' +
      '<div class="section-header"><h3>' + t.contentAnalysis + '</h3>' +
      '<span class="section-header-right">' +
      '<span class="cbar-total">' + t.estTokens + ': ~' + I18n.formatNumber(total) + '</span>' +
      '</span></div>' +
      '<p class="table-hint">' + t.last30days + ' · ' + t.estimatedNote + '</p>' +
      '<div class="cbar-list">' + catRows + '</div>' +
      toolSection +
      '</div>'
    );
  }

  /**
   * "Activity" tab: exact counts (not token estimates) of how tools, skills and
   * subagents were used over the same recent window as the content analysis,
   * plus code-change, turn-outcome and time-of-day activity.
   */
  private renderActivityData(): string {
    const t = I18n.t.popup;
    const a = this.activityAnalysis;
    if (!a) {
      return '<div class="no-data"><p>' + I18n.t.popup.noDataMessage + '</p></div>';
    }

    const num = (n: number): string => I18n.formatNumber(n);
    const pct = (n: number, d: number): string => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '—');
    const fmtDur = (ms: number): string => {
      if (!ms || ms <= 0) {
        return '—';
      }
      const s = ms / 1000;
      if (s < 60) {
        return s.toFixed(1) + 's';
      }
      const m = Math.floor(s / 60);
      return m + 'm ' + Math.round(s % 60) + 's';
    };

    // --- summary cards ---
    const card = (label: string, value: string): string =>
      '<div class="summary-item"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
    const summary =
      '<div class="usage-summary"><div class="summary-grid">' +
      card(t.toolCalls, num(a.totalToolCalls)) +
      card(t.errorRate, pct(a.toolErrors, a.totalToolCalls)) +
      card(t.prompts, num(a.promptCount)) +
      card(t.prsCreated, num(a.prCount)) +
      card(t.filesEdited, num(a.filesEditedCount)) +
      card(t.linesAdded, '+' + num(a.linesAdded)) +
      card(t.linesRemoved, '-' + num(a.linesRemoved)) +
      card(t.gitOps, num(a.gitOperations)) +
      card(t.userModifiedRate, pct(a.userModifiedCount, a.editResultCount)) +
      '</div></div>';

    // --- horizontal bar list (reuses the .cbar-* styles from the Content tab) ---
    const barList = (rows: { label: string; value: number; extra?: string }[], colorClass: string): string => {
      if (rows.length === 0) {
        return '';
      }
      const max = Math.max(...rows.map((r) => r.value), 1);
      const total = rows.reduce((s, r) => s + r.value, 0);
      let html = '';
      rows.forEach((r) => {
        const width = (r.value / max) * 100;
        html +=
          '<div class="cbar-row">' +
          '<div class="cbar-label" title="' + this.escapeHtml(r.label) + '">' + this.escapeHtml(r.label) + '</div>' +
          '<div class="cbar-track"><div class="cbar-fill ' + colorClass + '" style="width: ' + width.toFixed(1) + '%;"></div></div>' +
          '<div class="cbar-val">' + num(r.value) + (r.extra ? ' ' + r.extra : '') + '</div>' +
          '<div class="cbar-pct">' + pct(r.value, total) + '</div>' +
          '</div>';
      });
      return '<div class="cbar-list">' + html + '</div>';
    };

    // --- tools table ---
    let toolsTable = '';
    if (a.tools.length > 0) {
      let rows = '';
      a.tools.forEach((tool) => {
        const avg = tool.durationSamples > 0 ? fmtDur(tool.totalDurationMs / tool.durationSamples) : '—';
        rows +=
          '<tr>' +
          '<td class="date-cell">' + this.escapeHtml(tool.name) + '</td>' +
          '<td class="number-cell">' + num(tool.count) + '</td>' +
          '<td class="number-cell">' + num(tool.errors) + '</td>' +
          '<td class="number-cell">' + pct(tool.errors, tool.count) + '</td>' +
          '<td class="number-cell">' + avg + '</td>' +
          '</tr>';
      });
      toolsTable =
        '<div class="daily-breakdown"><h3>' + t.toolUsage + '</h3>' +
        '<div class="daily-table-container"><table class="daily-table"><thead><tr>' +
        '<th>' + t.toolUsage + '</th><th>' + t.count + '</th><th>' + t.errors + '</th>' +
        '<th>' + t.errorRate + '</th><th>' + t.avgDuration + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }

    // --- skills ---
    let skillsSection = '';
    if (a.skills.length > 0) {
      skillsSection =
        '<div class="daily-breakdown"><h3>' + t.skillUsage + '</h3>' +
        barList(a.skills.map((s) => ({ label: s.name, value: s.count })), 'cf-3') +
        '</div>';
    }

    // --- subagents ---
    let subagentTable = '';
    if (a.subagents.length > 0) {
      let rows = '';
      a.subagents.forEach((s) => {
        rows +=
          '<tr>' +
          '<td class="date-cell">' + this.escapeHtml(s.agentType) + '</td>' +
          '<td class="number-cell">' + num(s.count) + '</td>' +
          '<td class="number-cell">' + num(s.totalTokens) + '</td>' +
          '<td class="number-cell">' + num(s.totalToolUseCount) + '</td>' +
          '<td class="number-cell">' + fmtDur(s.count > 0 ? s.totalDurationMs / s.count : 0) + '</td>' +
          '</tr>';
      });
      subagentTable =
        '<div class="daily-breakdown"><h3>' + t.subagentUsage + '</h3>' +
        '<div class="daily-table-container"><table class="daily-table"><thead><tr>' +
        '<th>' + t.subagent + '</th><th>' + t.count + '</th><th>' + t.tokensCol + '</th>' +
        '<th>' + t.toolUses + '</th><th>' + t.avgDuration + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }

    // --- turn outcomes + permission modes ---
    let turnsSection = '';
    if (a.stopReasons.length > 0) {
      turnsSection =
        '<div class="daily-breakdown"><h3>' + t.turnOutcomes + '</h3>' +
        barList(a.stopReasons.map((r) => ({ label: r.label, value: r.count })), 'cf-1') +
        '</div>';
    }
    let permSection = '';
    if (a.permissionModes.length > 0) {
      permSection =
        '<div class="daily-breakdown"><h3>' + t.permissionModes + '</h3>' +
        barList(a.permissionModes.map((r) => ({ label: r.label, value: r.count })), 'cf-2') +
        '</div>';
    }

    // --- main vs subagent output-token split ---
    let splitSection = '';
    const splitTotal = a.mainOutputTokens + a.sidechainOutputTokens;
    if (splitTotal > 0) {
      const mPct = (a.mainOutputTokens / splitTotal) * 100;
      const sPct = (a.sidechainOutputTokens / splitTotal) * 100;
      splitSection =
        '<div class="daily-breakdown"><h3>' + t.tokenSplit + '</h3>' +
        '<div class="cost-comp-bar">' +
        '<div class="cost-comp-seg seg-input" style="width: ' + mPct.toFixed(2) + '%;"></div>' +
        '<div class="cost-comp-seg seg-output" style="width: ' + sPct.toFixed(2) + '%;"></div>' +
        '</div>' +
        '<div class="cost-comp-legend">' +
        '<span class="legend-item"><span class="legend-dot seg-input"></span>' + t.mainThread + ' ' + num(a.mainOutputTokens) + ' (' + mPct.toFixed(0) + '%)</span>' +
        '<span class="legend-item"><span class="legend-dot seg-output"></span>' + t.subagentsLabel + ' ' + num(a.sidechainOutputTokens) + ' (' + sPct.toFixed(0) + '%)</span>' +
        '</div></div>';
    }

    // --- activity heatmap (weekday × hour) ---
    const heatMax = Math.max(...a.heatmap.flat(), 1);
    let hourHeader = '<div class="hm-row"><div class="hm-label"></div>';
    for (let h = 0; h < 24; h++) {
      hourHeader += '<div class="hm-hhead">' + (h % 6 === 0 ? h : '') + '</div>';
    }
    hourHeader += '</div>';
    let heatRows = '';
    for (let dow = 0; dow < 7; dow++) {
      const wd = new Date(2023, 0, 1 + dow); // 2023-01-01 was a Sunday
      const wdLabel = wd.toLocaleDateString(I18n.getLocale(), { weekday: 'short' });
      heatRows += '<div class="hm-row"><div class="hm-label">' + this.escapeHtml(wdLabel) + '</div>';
      for (let h = 0; h < 24; h++) {
        const v = a.heatmap[dow][h];
        const op = v > 0 ? 0.15 + 0.85 * (v / heatMax) : 0;
        const bg = v > 0 ? 'background: var(--vscode-charts-blue); opacity: ' + op.toFixed(2) + ';' : '';
        heatRows += '<div class="hm-cell" style="' + bg + '" title="' + wdLabel + ' ' + h + ':00 — ' + num(v) + '"></div>';
      }
      heatRows += '</div>';
    }
    const heatmapSection =
      '<div class="daily-breakdown"><h3>' + t.activityHeatmap + '</h3>' +
      '<p class="table-hint">' + t.heatmapHint + '</p>' +
      '<div class="heatmap">' + hourHeader + heatRows + '</div></div>';

    // --- recent session topics ---
    let topicsSection = '';
    if (a.recentTitles.length > 0) {
      const items = a.recentTitles
        .map((tt) => '<li>' + this.escapeHtml(tt.title) + '</li>')
        .join('');
      topicsSection =
        '<div class="daily-breakdown"><h3>' + t.recentTopics + '</h3>' +
        '<ul class="topic-list">' + items + '</ul></div>';
    }

    return (
      '<p class="table-hint">' + t.last30days + ' · ' + t.activityNote + '</p>' +
      summary +
      toolsTable +
      skillsSection +
      subagentTable +
      turnsSection +
      permSection +
      splitSection +
      heatmapSection +
      topicsSection
    );
  }

  /**
   * "Quota" tab: the real 5-hour / weekly utilisation recorded over time
   * (from api.anthropic.com/api/oauth/usage). Shows a time-series line chart,
   * an hour-of-day breakdown of when the 5-hour quota is consumed, and the
   * latest reset info. History only accrues while the extension runs.
   */
  private renderQuotaData(): string {
    const t = I18n.t.popup;
    const history = [...this.quotaHistory].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );
    if (history.length === 0) {
      return '<div class="no-data"><p>' + t.quotaHistoryEmpty + '</p></div>';
    }

    const latest = history[history.length - 1];
    const fmtTime = (iso: string | null): string => {
      if (!iso) {
        return '—';
      }
      const d = new Date(iso);
      if (isNaN(d.getTime())) {
        return '—';
      }
      return d.toLocaleString(
        I18n.getLocale(),
        I18n.dateFormatOptions({ month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      );
    };
    const pctStr = (v: number | null): string => (v == null ? '—' : v.toFixed(0) + '%');

    // --- latest values table ---
    const row = (label: string, util: number | null, resets: string | null): string =>
      '<tr><td class="date-cell">' + label + '</td>' +
      '<td class="number-cell">' + pctStr(util) + '</td>' +
      '<td class="number-cell">' + fmtTime(resets) + '</td></tr>';
    let latestRows = row(t.quota5h, latest.fiveHour, latest.fiveHourResetsAt) +
      row(t.quotaWeekly, latest.sevenDay, latest.sevenDayResetsAt);
    if (latest.sevenDayOpus != null) {
      latestRows += row(t.quotaOpus, latest.sevenDayOpus, latest.sevenDayOpusResetsAt);
    }
    const latestTable =
      '<div class="daily-breakdown"><h3>' + t.quota + '</h3>' +
      '<div class="daily-table-container"><table class="daily-table"><thead><tr>' +
      '<th>' + t.quotaWindow + '</th><th>' + t.quotaUtilization + '</th><th>' + t.resets + '</th>' +
      '</tr></thead><tbody>' + latestRows + '</tbody></table></div></div>';

    // --- time-series line chart (server-rendered SVG, 0-100%) ---
    const W = 640, H = 200, padL = 36, padR = 12, padT = 12, padB = 28;
    const t0 = new Date(history[0].ts).getTime();
    const t1 = new Date(latest.ts).getTime();
    const span = Math.max(t1 - t0, 1);
    const xOf = (ts: string): number => padL + ((new Date(ts).getTime() - t0) / span) * (W - padL - padR);
    const yOf = (v: number): number => padT + (1 - v / 100) * (H - padT - padB);

    const series = (pick: (s: QuotaSnapshot) => number | null, color: string): string => {
      const pts = history.filter((s) => pick(s) != null);
      if (pts.length === 0) {
        return '';
      }
      const coords = pts.map((s) => xOf(s.ts).toFixed(1) + ',' + yOf(pick(s) as number).toFixed(1));
      const line =
        '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + coords.join(' ') + '" />';
      const dots = pts
        .map((s) => '<circle cx="' + xOf(s.ts).toFixed(1) + '" cy="' + yOf(pick(s) as number).toFixed(1) + '" r="2" fill="' + color + '" />')
        .join('');
      return line + dots;
    };

    let gridlines = '';
    [0, 25, 50, 75, 100].forEach((g) => {
      const y = yOf(g).toFixed(1);
      gridlines +=
        '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y +
        '" stroke="var(--vscode-panel-border)" stroke-width="1" opacity="0.5" />' +
        '<text x="' + (padL - 6) + '" y="' + (yOf(g) + 3).toFixed(1) +
        '" text-anchor="end" font-size="10" fill="var(--vscode-descriptionForeground)">' + g + '</text>';
    });
    let xlabels = '';
    [history[0], history[Math.floor(history.length / 2)], latest].forEach((s, i) => {
      const anchor = i === 0 ? 'start' : i === 2 ? 'end' : 'middle';
      xlabels +=
        '<text x="' + xOf(s.ts).toFixed(1) + '" y="' + (H - 8) +
        '" text-anchor="' + anchor + '" font-size="10" fill="var(--vscode-descriptionForeground)">' +
        this.escapeHtml(fmtTime(s.ts)) + '</text>';
    });
    const blue = 'var(--vscode-charts-blue)';
    const orange = 'var(--vscode-charts-orange)';
    const chart =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" role="img">' +
      gridlines +
      series((s) => s.fiveHour, blue) +
      series((s) => s.sevenDay, orange) +
      xlabels +
      '</svg>';
    const legend =
      '<div class="cost-comp-legend">' +
      '<span class="legend-item"><span class="legend-dot" style="background:' + blue + ';"></span>' + t.quota5h + '</span>' +
      '<span class="legend-item"><span class="legend-dot" style="background:' + orange + ';"></span>' + t.quotaWeekly + '</span>' +
      '</div>';
    const chartSection =
      '<div class="daily-breakdown"><h3>' + t.quotaOverTime + '</h3>' + chart + legend + '</div>';

    // --- hour-of-day consumption: sum positive jumps in 5-hour utilisation,
    // bucketed by the local hour of the later sample (negatives = a quota reset).
    const hourFmt = new Intl.DateTimeFormat('en-US', I18n.dateFormatOptions({ hour: '2-digit', hour12: false }));
    const buckets = new Array(24).fill(0);
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1].fiveHour;
      const cur = history[i].fiveHour;
      if (prev == null || cur == null) {
        continue;
      }
      const delta = cur - prev;
      if (delta <= 0) {
        continue;
      }
      const h = parseInt(hourFmt.format(new Date(history[i].ts)), 10) % 24;
      buckets[h] += delta;
    }
    const hourMax = Math.max(...buckets, 1);
    let hourHeader = '<div class="hm-row"><div class="hm-label"></div>';
    for (let h = 0; h < 24; h++) {
      hourHeader += '<div class="hm-hhead">' + (h % 6 === 0 ? h : '') + '</div>';
    }
    hourHeader += '</div>';
    let hourCells = '<div class="hm-row"><div class="hm-label">' + t.quota5h + '</div>';
    for (let h = 0; h < 24; h++) {
      const v = buckets[h];
      const op = v > 0 ? 0.15 + 0.85 * (v / hourMax) : 0;
      const bg = v > 0 ? 'background: var(--vscode-charts-blue); opacity: ' + op.toFixed(2) + ';' : '';
      hourCells += '<div class="hm-cell" style="' + bg + '" title="' + h + ':00 — +' + v.toFixed(0) + '%"></div>';
    }
    hourCells += '</div>';
    const hourSection =
      '<div class="daily-breakdown"><h3>' + t.quotaByHour + '</h3>' +
      '<p class="table-hint">' + t.quotaByHourHint + '</p>' +
      '<div class="heatmap">' + hourHeader + hourCells + '</div></div>';

    return (
      '<p class="table-hint">' + t.quotaHint + ' · ' + t.quotaHistoryNote + '</p>' +
      latestTable +
      chartSection +
      hourSection
    );
  }

  // Chart palette reused across the Context Health visualisations.
  private static CH_PALETTE = [
    'var(--vscode-charts-blue)',
    'var(--vscode-charts-green)',
    'var(--vscode-charts-orange)',
    'var(--vscode-charts-purple)',
    'var(--vscode-charts-red)',
    'var(--vscode-charts-yellow)',
  ];

  /** The "Context Health" dashboard tab for the active session. */
  private renderContextHealthData(): string {
    const h = this.contextHealth;
    const t = I18n.t.contextHealth;
    const p = I18n.t.popup;
    if (!h) {
      return '<div class="no-data">' + p.noDataMessage + '</div>';
    }
    const num = (n: number): string => I18n.formatNumber(n);
    const pct = Math.round(h.fillRatio * 100);
    const statusLabel = h.status === 'rot' ? t.statusRot : h.status === 'watch' ? t.statusWatch : t.statusHealthy;
    const palette = UsageWebviewProvider.CH_PALETTE;
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

    // Drill-down banner (when a specific session is pinned from the Sessions tab).
    let inspectBanner = '';
    if (this.inspectedContextHealth) {
      inspectBanner =
        '<div class="ch-inspecting"><span>' + t.viewing + ': ' + this.escapeHtml(h.sessionId) + '</span>' +
        '<button class="ch-back-btn" onclick="backToActiveContextHealth()">' + t.backToActive + '</button></div>';
    }

    // Header + window-fill bar.
    const header =
      '<div class="ch-head ch-' + h.status + '">' +
      '<span class="ch-badge">' + statusLabel + '</span>' +
      '<span class="ch-sub">' + this.escapeHtml(h.projectName) + ' · ' + this.escapeHtml(h.model || '') + '</span>' +
      '</div>';
    let paceLine = '';
    if (h.growthTokensPerMin && h.growthTokensPerMin > 0) {
      paceLine = '<div class="ch-pace">' + t.pace + ': +' + num(h.growthTokensPerMin) + '/min';
      if (h.etaToLimitMin) {
        paceLine += ' · ' + t.etaToLimit + ' ~' + h.etaToLimitMin + 'm';
      }
      paceLine += '</div>';
    }
    const windowBlock =
      '<div class="ch-window">' +
      '<div class="ch-winrow"><span>' + t.windowSize + '</span><span><b>' + num(h.contextTokens) + '</b> / ' + num(h.contextLimit) + ' (' + pct + '%)</span></div>' +
      '<div class="ch-fill"><div class="ch-fillbar ch-fill-' + h.status + '" style="width:' + Math.min(100, pct) + '%;"></div></div>' +
      '<div class="ch-winrow ch-muted"><span>' + t.peak + '</span><span>' + num(h.peakContextTokens) + '</span></div>' +
      paceLine +
      '</div>';

    // Composition donut (CSS conic-gradient) + legend.
    const total = h.composition.reduce((s, c) => s + c.estimatedTokens, 0) || 1;
    let acc = 0;
    const stops: string[] = [];
    const legendItems: string[] = [];
    h.composition.forEach((c, i) => {
      const frac = c.estimatedTokens / total;
      const color = palette[i % palette.length];
      const start = (acc * 360).toFixed(1);
      acc += frac;
      const end = (acc * 360).toFixed(1);
      stops.push(color + ' ' + start + 'deg ' + end + 'deg');
      legendItems.push(
        '<div class="ch-leg"><span class="ch-swatch" style="background:' + color + ';"></span>' +
        '<span class="ch-leglabel">' + catLabel(c.key) + '</span>' +
        '<span class="ch-legval">' + Math.round(frac * 100) + '% · ' + num(c.estimatedTokens) + '</span></div>'
      );
    });
    const donut =
      '<div class="ch-donut-wrap">' +
      '<div class="ch-donut" style="background: conic-gradient(' + stops.join(', ') + ');">' +
      '<div class="ch-donut-hole"><span class="ch-donut-num">' + num(total) + '</span><span class="ch-donut-cap">' + p.estTokens + '</span></div>' +
      '</div><div class="ch-legendcol">' + legendItems.join('') + '</div></div>';

    const grid =
      '<div class="ch-grid">' +
      '<div class="ch-card"><h3>' + t.growth + '</h3>' + this.renderContextGrowthChart(h) + '</div>' +
      '<div class="ch-card"><h3>' + t.composition + '</h3>' + donut + '</div>' +
      '</div>';

    // Per-topic timeline (token-weighted, chronological) — only when >1 topic.
    let topicsBlock = '';
    if (h.topics.length > 1) {
      const tsorted = h.topics.slice().sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
      const ttotal = tsorted.reduce((s, x) => s + x.estimatedTokens, 0) || 1;
      const segs = tsorted
        .map((x, i) => {
          const w = Math.max(2, (x.estimatedTokens / ttotal) * 100);
          const lbl = x.label ? this.escapeHtml(x.label) : '—';
          return '<div class="ch-tlseg" style="width:' + w.toFixed(1) + '%; background:' + palette[i % palette.length] + ';" title="' + lbl + ' — ' + num(x.estimatedTokens) + '"></div>';
        })
        .join('');
      const tlegend = tsorted
        .map((x, i) => {
          const lbl = x.label ? this.escapeHtml(x.label) : '—';
          return '<div class="ch-leg"><span class="ch-swatch" style="background:' + palette[i % palette.length] + ';"></span><span class="ch-leglabel">' + lbl + '</span><span class="ch-legval">' + num(x.estimatedTokens) + '</span></div>';
        })
        .join('');
      topicsBlock =
        '<div class="ch-card"><h3>' + t.topics + '</h3><div class="ch-timeline">' + segs + '</div><div class="ch-legendcol">' + tlegend + '</div></div>';
    }

    // Signal cards.
    let signalsBlock = '';
    if (h.signals.length > 0) {
      const cards = h.signals
        .map((s) => '<div class="ch-sig"><span class="ch-sigicon">⚠</span><span>' + this.escapeHtml(this.describeContextSignal(s)) + '</span></div>')
        .join('');
      signalsBlock = '<div class="ch-card"><h3>' + t.signalsTitle + '</h3><div class="ch-sigs">' + cards + '</div></div>';
    }

    let switchHint = '';
    if (h.topicSwitchAt && h.topicSwitchGapMin) {
      const at = new Date(h.topicSwitchAt);
      const time = isNaN(at.getTime()) ? '' : this.formatDateTime(at);
      switchHint = '<p class="table-hint">' + t.topicSwitch + ': ' + this.escapeHtml(time) + ' (' + h.topicSwitchGapMin + 'm)</p>';
    }
    const suggestion = h.status === 'healthy' ? t.suggestHealthy : t.suggestClear;
    const suggestBlock = '<div class="ch-suggest ch-suggest-' + h.status + '">' + this.escapeHtml(suggestion) + '</div>';

    return '<div class="ch">' + inspectBanner + header + windowBlock + grid + topicsBlock + signalsBlock + switchHint + suggestBlock + '</div>';
  }

  /** Server-rendered SVG line chart of context-window growth over the session. */
  private renderContextGrowthChart(h: ContextHealth): string {
    const series = h.contextSeries || [];
    if (series.length < 2) {
      return '<p class="table-hint">—</p>';
    }
    const W = 560, H = 180, padL = 48, padR = 12, padT = 12, padB = 22;
    const n = series.length;
    const maxY = Math.max(h.contextLimit, ...series) || 1;
    const xOf = (i: number): number => padL + (i / (n - 1)) * (W - padL - padR);
    const yOf = (v: number): number => padT + (1 - v / maxY) * (H - padT - padB);
    const color =
      h.status === 'rot' ? 'var(--vscode-charts-red)' : h.status === 'watch' ? 'var(--vscode-charts-yellow)' : 'var(--vscode-charts-green)';

    const coords = series.map((v, i) => xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1));
    const line = '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + coords.join(' ') + '" />';
    const areaPts = xOf(0).toFixed(1) + ',' + yOf(0).toFixed(1) + ' ' + coords.join(' ') + ' ' + xOf(n - 1).toFixed(1) + ',' + yOf(0).toFixed(1);
    const area = '<polygon fill="' + color + '" opacity="0.12" points="' + areaPts + '" />';

    let gridlines = '';
    [0, 0.25, 0.5, 0.75, 1].forEach((g) => {
      const val = g * maxY;
      const y = yOf(val).toFixed(1);
      gridlines +=
        '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--vscode-panel-border)" stroke-width="1" opacity="0.4" />' +
        '<text x="' + (padL - 6) + '" y="' + (yOf(val) + 3).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--vscode-descriptionForeground)">' + I18n.formatNumber(Math.round(val)) + '</text>';
    });
    const ly = yOf(h.contextLimit).toFixed(1);
    const limitLine =
      '<line x1="' + padL + '" y1="' + ly + '" x2="' + (W - padR) + '" y2="' + ly + '" stroke="var(--vscode-charts-red)" stroke-width="1" stroke-dasharray="4 3" opacity="0.7" />';

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" role="img">' + gridlines + area + line + limitLine + '</svg>';
  }

  /** Localised, number-filled description of one context-rot signal. */
  private describeContextSignal(s: ContextRotSignal): string {
    const t = I18n.t.contextHealth;
    switch (s.kind) {
      case 'nearLimit':
        return t.sigNearLimit + ' (' + s.value + '%)';
      case 'largeToolResult':
        return t.sigLargeToolResult + ': ' + (s.label || '') + ' (' + s.value + '%)';
      case 'staleContext':
        return t.sigStaleContext + ' (' + s.value + '%)';
      case 'redundantReads':
        return t.sigRedundantReads + ': ' + (s.label || '') + ' ×' + s.value;
      case 'multiTopic':
        return t.sigMultiTopic + ' (' + s.value + 'm)';
      default:
        return '';
    }
  }

  /**
   * Static stacked-bar chart breaking each period into input / cache-read /
   * cache-write / output tokens — a finer view than the single-metric chart.
   */
  private renderCompositionChart(items: { label: string; data: UsageData }[]): string {
    if (!items || items.length === 0) {
      return '';
    }

    const t = I18n.t.popup;
    const maxHeight = 120;
    const totals = items.map(
      (it) =>
        it.data.totalInputTokens + it.data.totalOutputTokens + it.data.totalCacheCreationTokens + it.data.totalCacheReadTokens
    );
    const maxTotal = Math.max(...totals, 1);

    let bars = '';
    items.forEach((it, idx) => {
      const d = it.data;
      const total = totals[idx];
      const barHeight = (total / maxTotal) * maxHeight;
      const seg = (value: number, cls: string, label: string): string => {
        const h = total > 0 ? (value / total) * barHeight : 0;
        return (
          '<div class="stack-seg ' +
          cls +
          '" style="height: ' +
          h +
          'px;" title="' +
          this.escapeHtml(label) +
          ': ' +
          I18n.formatNumber(value) +
          '"></div>'
        );
      };
      bars +=
        '<div class="hc-col">' +
        '<div class="stack-bar" title="' +
        this.escapeHtml(it.label) +
        ': ' +
        I18n.formatNumber(total) +
        '">' +
        seg(d.totalInputTokens, 'seg-input', t.inputTokens) +
        seg(d.totalCacheReadTokens, 'seg-cache-read', t.cacheRead) +
        seg(d.totalCacheCreationTokens, 'seg-cache-creation', t.cacheCreation) +
        seg(d.totalOutputTokens, 'seg-output', t.outputTokens) +
        '</div>' +
        '</div>';
    });

    const xlabels = items.map((it) => '<div class="hc-xlabel">' + this.escapeHtml(it.label) + '</div>').join('');

    const dot = (cls: string, label: string): string =>
      '<span class="legend-item"><span class="legend-dot ' + cls + '"></span>' + label + '</span>';

    return (
      '<div class="composition-chart">' +
      '<h4>' +
      t.tokenComposition +
      '</h4>' +
      '<div class="stack-legend">' +
      dot('seg-input', t.inputTokens) +
      dot('seg-cache-read', t.cacheRead) +
      dot('seg-cache-creation', t.cacheCreation) +
      dot('seg-output', t.outputTokens) +
      '</div>' +
      '<div class="hc-wrap">' +
      '<div class="hc-yaxis">' +
      '<span class="hc-yval">' + I18n.formatNumber(maxTotal) + '</span>' +
      '<span class="hc-yval">' + I18n.formatNumber(Math.round(maxTotal / 2)) + '</span>' +
      '<span class="hc-yval">0</span>' +
      '</div>' +
      '<div class="hc-main"><div class="hc-scroll">' +
      '<div class="hc-plot">' +
      '<div class="hc-grid hc-grid-top"></div>' +
      '<div class="hc-grid hc-grid-mid"></div>' +
      '<div class="hc-bars">' +
      bars +
      '</div>' +
      '</div>' +
      '<div class="hc-xlabels">' +
      xlabels +
      '</div>' +
      '</div></div>' +
      '</div>' +
      '</div>'
    );
  }

  private renderDailyChart(): string {
    if (this.dailyDataForMonth.length === 0) {
      return '<div class="no-chart-data">No data available</div>';
    }

    // Sort data by date (oldest first for chart display)
    const sortedData = [...this.dailyDataForMonth].sort((a, b) => a.date.localeCompare(b.date));

    // Generate chart bars for cost (default metric)
    const maxCost = Math.max(...sortedData.map((d) => d.data.totalCost));
    const maxHeight = 120; // Max height in pixels

    return `
      <div class="chart-bars">
        ${sortedData
          .map(({ date, data }) => {
            const height = maxCost > 0 ? (data.totalCost / maxCost) * maxHeight : 0;
            return `
            <div class="chart-bar-container" data-date="${date}">
              <div class="chart-bar cost-bar clickable"
                   style="height: ${height}px;"
                   data-cost="${data.totalCost}"
                   data-input="${data.totalInputTokens}"
                   data-output="${data.totalOutputTokens}"
                   data-cache-creation="${data.totalCacheCreationTokens}"
                   data-cache-read="${data.totalCacheReadTokens}"
                   data-messages="${data.messageCount}"
                   title="${this.formatDate(date)}: ${I18n.formatCurrency(data.totalCost)}">
              </div>
              <div class="chart-label">${this.getShortDate(date)}</div>
            </div>
          `;
          })
          .join('')}
      </div>
    `;
  }

  private renderAllTimeChart(): string {
    if (this.dailyDataForAllTime.length === 0) {
      return '<div class="no-chart-data">No data available</div>';
    }

    // Sort data by date (oldest first for chart display)
    const sortedData = [...this.dailyDataForAllTime].sort((a, b) => a.date.localeCompare(b.date));

    // Generate chart bars for cost (default metric)
    const maxCost = Math.max(...sortedData.map((d) => d.data.totalCost));
    const maxHeight = 120; // Max height in pixels

    return `
      <div class="chart-bars">
        ${sortedData
          .map(({ date, data }) => {
            const height = maxCost > 0 ? (data.totalCost / maxCost) * maxHeight : 0;
            return `
            <div class="chart-bar-container" data-date="${date}">
              <div class="chart-bar cost-bar clickable"
                   style="height: ${height}px;"
                   data-cost="${data.totalCost}"
                   data-input="${data.totalInputTokens}"
                   data-output="${data.totalOutputTokens}"
                   data-cache-creation="${data.totalCacheCreationTokens}"
                   data-cache-read="${data.totalCacheReadTokens}"
                   data-messages="${data.messageCount}"
                   title="${this.formatDate(date)}: ${I18n.formatCurrency(data.totalCost)}">
              </div>
              <div class="chart-label">${this.getShortDate(date)}</div>
            </div>
          `;
          })
          .join('')}
      </div>
    `;
  }

  /**
   * Today's hourly chart. Unlike the other charts it has a Y-axis, two dashed
   * reference lines and a value label on top of every bar, so figures are
   * readable without hovering.
   */
  private renderHourlyChart(): string {
    if (this.hourlyDataForToday.length === 0) {
      return '<div class="no-chart-data">No data available</div>';
    }

    const sortedData = [...this.hourlyDataForToday].sort((a, b) => a.hour.localeCompare(b.hour));
    const maxCost = Math.max(...sortedData.map((d) => d.data.totalCost), 0);
    const maxHeight = 120; // Plot height in pixels — kept in sync with updateMainChart.

    const bars = sortedData
      .map(({ hour, data }) => {
        const height = maxCost > 0 ? (data.totalCost / maxCost) * maxHeight : 0;
        return (
          '<div class="hc-col" data-hour="' + hour + '">' +
          '<div class="hc-barval">' + I18n.formatCurrency(data.totalCost) + '</div>' +
          '<div class="chart-bar cost-bar" style="height: ' + height + 'px;" ' +
          'data-cost="' + data.totalCost + '" ' +
          'data-input="' + data.totalInputTokens + '" ' +
          'data-output="' + data.totalOutputTokens + '" ' +
          'data-cache-creation="' + data.totalCacheCreationTokens + '" ' +
          'data-cache-read="' + data.totalCacheReadTokens + '" ' +
          'data-messages="' + data.messageCount + '" ' +
          'title="' + I18n.formatCurrency(data.totalCost) + '"></div>' +
          '</div>'
        );
      })
      .join('');

    const xlabels = sortedData.map(({ hour }) => '<div class="hc-xlabel">' + hour + '</div>').join('');

    return (
      '<div class="hc-wrap">' +
      '<div class="hc-yaxis">' +
      '<span class="hc-yval">' + I18n.formatCurrency(maxCost) + '</span>' +
      '<span class="hc-yval">' + I18n.formatCurrency(maxCost / 2) + '</span>' +
      '<span class="hc-yval">' + I18n.formatCurrency(0) + '</span>' +
      '</div>' +
      '<div class="hc-main">' +
      '<div class="hc-scroll">' +
      '<div class="hc-plot" id="hourlyChart">' +
      '<div class="hc-grid hc-grid-top"></div>' +
      '<div class="hc-grid hc-grid-mid"></div>' +
      '<div class="hc-bars">' + bars + '</div>' +
      '</div>' +
      '<div class="hc-xlabels">' + xlabels + '</div>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  private getShortDate(dateString: string): string {
    const date = new Date(dateString);
    // Check if this is a month-only date (ends with -01)
    if (dateString.endsWith('-01')) {
      // Format as YYYY/MM for monthly data
      return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    }
    // Format as MM/DD for daily data
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  private formatDate(dateString: string): string {
    const date = new Date(dateString);
    // Check if this is a month-only date (ends with -01)
    if (dateString.endsWith('-01')) {
      return date.toLocaleDateString(I18n.getLocale(), I18n.dateFormatOptions({ year: 'numeric', month: 'long' }));
    }
    // Standard date formatting for daily data, locale + timezone aware.
    return date.toLocaleDateString(I18n.getLocale(), I18n.dateFormatOptions());
  }

  private getStyles(): string {
    return `
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
        margin: 0;
        padding: 16px;
      }

      .container {
        max-width: 800px;
        margin: 0 auto;
      }

      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
        border-bottom: 1px solid var(--vscode-panel-border);
        padding-bottom: 16px;
      }


      h1 {
        margin: 0;
        font-size: 20px;
      }

      .actions {
        display: flex;
        gap: 8px;
      }

      button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 4px;
        padding: 8px 12px;
        cursor: pointer;
        font-size: 12px;
      }

      button:hover {
        background: var(--vscode-button-hoverBackground);
      }

      .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .btn-secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }

      .tabs {
        display: flex;
        margin-bottom: 20px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .tab {
        background: transparent;
        border: none;
        padding: 8px 16px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        /* Explicit foreground colour — otherwise the inherited button
           foreground (white) becomes invisible on light themes. (Fixes
           upstream issue #11.) */
        color: var(--vscode-foreground);
      }

      .tab.active {
        border-bottom-color: var(--vscode-focusBorder);
        color: var(--vscode-focusBorder);
      }

      .tab-content {
        display: none;
      }

      .tab-content.active {
        display: block;
      }

      .usage-summary {
        margin-bottom: 24px;
      }

      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
      }

      .summary-item {
        text-align: center;
        padding: 16px;
        background: var(--vscode-input-background);
        border-radius: 8px;
        border: 1px solid var(--vscode-input-border);
      }

      .summary-item .label {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
      }

      .summary-item .value {
        font-size: 18px;
        font-weight: bold;
      }

      .summary-item .value.cost {
        color: var(--vscode-charts-green);
      }

      .model-breakdown, .daily-breakdown {
        margin-top: 24px;
      }

      .model-breakdown h3, .daily-breakdown h3 {
        margin-bottom: 16px;
        font-size: 16px;
      }

      .model-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .model-item {
        padding: 12px;
        background: var(--vscode-input-background);
        border-radius: 6px;
        border: 1px solid var(--vscode-input-border);
      }

      /* <details>/<summary> reset: remove the default triangle, position our own */
      details.model-item > summary {
        list-style: none;
        cursor: pointer;
      }
      details.model-item > summary::-webkit-details-marker { display: none; }
      details.model-item > summary::before {
        content: '▸';
        display: inline-block;
        margin-right: 6px;
        color: var(--vscode-descriptionForeground);
        transition: transform 0.15s ease;
      }
      details.model-item[open] > summary::before {
        transform: rotate(90deg);
      }

      .model-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      /* Model name sits flush against the disclosure triangle on the left;
         the cost is pushed to the far right by margin-left:auto. Avoids the
         "name centred in the middle" effect that flex space-between gives
         when the triangle ::before becomes a third flex child. */
      .model-name {
        flex: 0 1 auto;
        text-align: left;
      }

      .model-name {
        font-weight: bold;
        color: var(--vscode-symbolIcon-functionForeground);
      }

      .model-cost {
        font-weight: bold;
        color: var(--vscode-charts-green);
        margin-left: auto;
      }

      .model-details {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      /* Stack token stats one per line — fixed layout that does not reshuffle
         when the window is resized. Each row is "label  value" left-aligned. */
      .model-details-stacked {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 4px;
      }

      .model-details-stacked > span {
        display: flex;
        justify-content: space-between;
        padding: 2px 0;
        border-bottom: 1px dashed var(--vscode-input-border);
      }
      .model-details-stacked > span:last-child {
        border-bottom: none;
      }

      .model-stat-label {
        color: var(--vscode-descriptionForeground);
        opacity: 0.85;
      }

      .chart-tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 16px;
        flex-wrap: wrap;
      }

      .chart-tab {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: 1px solid var(--vscode-input-border);
        border-radius: 4px;
        padding: 6px 12px;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .chart-tab:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }

      .chart-tab.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-focusBorder);
      }

      .chart-container {
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 20px;
        height: 180px;
        overflow-x: auto;
      }

      .chart-content {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: end;
        justify-content: center;
      }

      .chart-bars {
        display: flex;
        align-items: end;
        gap: 4px;
        min-width: fit-content;
        height: 100%;
        padding: 0 8px;
      }

      .chart-bar-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        min-width: 40px;
        height: 100%;
        position: relative;
        padding-bottom: 20px;
      }

      .chart-bar {
        width: 24px;
        min-height: 2px;
        border-radius: 2px 2px 0 0;
        transition: all 0.3s ease;
        margin-bottom: 8px;
      }

      .chart-bar.clickable {
        cursor: pointer;
      }

      .chart-bar.clickable:hover {
        opacity: 0.8;
        transform: scaleY(1.05);
      }

      .chart-bar.selected {
        border: 2px solid var(--vscode-focusBorder);
        box-shadow: 0 0 4px var(--vscode-focusBorder);
      }

      .cost-bar {
        background: linear-gradient(to top, var(--vscode-charts-green), var(--vscode-charts-blue));
      }

      .input-bar {
        background: linear-gradient(to top, var(--vscode-charts-blue), var(--vscode-charts-purple));
      }

      .output-bar {
        background: linear-gradient(to top, var(--vscode-charts-orange), var(--vscode-charts-red));
      }

      .cache-creation-bar {
        background: linear-gradient(to top, var(--vscode-charts-purple), var(--vscode-charts-pink));
      }

      .cache-read-bar {
        background: linear-gradient(to top, var(--vscode-charts-yellow), var(--vscode-charts-orange));
      }

      .messages-bar {
        background: linear-gradient(to top, var(--vscode-charts-foreground), var(--vscode-charts-lines));
      }

      .chart-label {
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        text-align: center;
        word-break: break-all;
        line-height: 12px;
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 100%;
      }

      .no-chart-data {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }

      .daily-table-container {
        overflow-x: auto;
        margin-top: 12px;
      }

      .daily-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      .daily-table th,
      .daily-table td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .daily-table th {
        background: var(--vscode-input-background);
        font-weight: bold;
        color: var(--vscode-foreground);
        position: sticky;
        top: 0;
      }

      .daily-table tbody tr:hover {
        background: var(--vscode-list-hoverBackground);
      }

      .date-cell {
        font-weight: bold;
        color: var(--vscode-symbolIcon-functionForeground);
        white-space: nowrap;
      }

      .cost-cell {
        font-weight: bold;
        color: var(--vscode-charts-green);
        text-align: right;
      }

      .number-cell {
        text-align: right;
        font-family: var(--vscode-editor-font-family);
      }

      .loading, .error, .no-data {
        text-align: center;
        padding: 40px 20px;
      }

      .spinner {
        width: 32px;
        height: 32px;
        border: 3px solid var(--vscode-progressBar-background);
        border-top: 3px solid var(--vscode-focusBorder);
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin: 0 auto 16px;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      .error {
        color: var(--vscode-errorForeground);
      }

      .no-data {
        color: var(--vscode-descriptionForeground);
      }

      .detail-cell {
        text-align: center;
        width: 40px;
      }

      .detail-button {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        cursor: pointer;
        padding: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s ease;
      }

      .detail-button:hover {
        background: var(--vscode-list-hoverBackground);
        border-radius: 4px;
      }

      .detail-button.expanded svg {
        transform: rotate(180deg);
      }

      .hourly-detail-row td {
        padding: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .hourly-detail-container {
        padding: 16px;
        background: var(--vscode-input-background);
        border-top: 1px solid var(--vscode-panel-border);
      }

      .hourly-detail-container h4 {
        margin: 0 0 12px 0;
        font-size: 14px;
        color: var(--vscode-foreground);
      }

      .loading-indicator {
        text-align: center;
        color: var(--vscode-descriptionForeground);
        padding: 20px;
      }

      .project-cell {
        max-width: 340px;
      }

      .project-name {
        font-weight: bold;
        color: var(--vscode-symbolIcon-functionForeground);
      }

      .project-path {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        word-break: break-all;
        margin-top: 2px;
      }

      .composition-chart {
        margin: 12px 0 20px;
      }

      .cost-composition {
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .cost-comp-head {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 6px;
      }

      .cost-comp-bar {
        display: flex;
        height: 14px;
        border-radius: 3px;
        overflow: hidden;
        background: var(--vscode-input-background);
      }

      .cost-comp-seg {
        height: 100%;
      }

      .cost-comp-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        margin-top: 6px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .composition-chart h4 {
        margin: 0 0 8px 0;
        font-size: 13px;
      }

      .stack-legend {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        margin-bottom: 8px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      .legend-dot {
        width: 10px;
        height: 10px;
        border-radius: 2px;
        display: inline-block;
      }

      .stack-bar {
        width: 24px;
        display: flex;
        flex-direction: column-reverse;
        border-radius: 2px 2px 0 0;
        overflow: hidden;
        margin-bottom: 8px;
        min-height: 2px;
      }

      .stack-seg {
        width: 100%;
      }

      .seg-input {
        background: var(--vscode-charts-blue);
      }

      .seg-output {
        background: var(--vscode-charts-orange);
      }

      .seg-cache-creation {
        background: var(--vscode-charts-purple);
      }

      .seg-cache-read {
        background: var(--vscode-charts-green);
      }

      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        gap: 12px;
      }

      .section-header h3 {
        margin: 0;
      }

      .section-header-right {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }

      .btn-small {
        padding: 4px 10px;
        font-size: 11px;
        white-space: nowrap;
      }

      .model-pricing {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px dashed var(--vscode-panel-border);
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        word-break: break-word;
      }

      .table-hint {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin: 0 0 8px 0;
      }

      th.sortable {
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }

      th.sortable:hover {
        color: var(--vscode-focusBorder);
      }

      th.sortable.sorted-asc::after {
        content: ' \\25B2';
        font-size: 9px;
      }

      th.sortable.sorted-desc::after {
        content: ' \\25BC';
        font-size: 9px;
      }

      .group-toggle {
        display: inline-block;
        width: 14px;
        cursor: pointer;
        color: var(--vscode-descriptionForeground);
        transition: transform 0.15s ease;
      }

      .group-toggle.expanded {
        transform: rotate(90deg);
      }

      .group-count {
        font-weight: normal;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .project-child-cell {
        padding-left: 28px;
      }

      .project-child-row {
        background: var(--vscode-input-background);
      }

      .hc-wrap {
        display: flex;
        gap: 6px;
        margin-bottom: 20px;
        padding-top: 18px;
      }

      .hc-yaxis {
        width: 62px;
        height: 120px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        text-align: right;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
      }

      .hc-yval {
        line-height: 1;
        white-space: nowrap;
      }

      .hc-main {
        flex: 1;
        min-width: 0;
      }

      .hc-scroll {
        overflow-x: auto;
        overflow-y: visible;
      }

      .hc-plot {
        position: relative;
        height: 120px;
        min-width: fit-content;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .hc-grid {
        position: absolute;
        left: 0;
        right: 0;
        border-top: 1px dashed var(--vscode-panel-border);
        opacity: 0.6;
        pointer-events: none;
      }

      .hc-grid-top {
        top: 0;
      }

      .hc-grid-mid {
        top: 50%;
      }

      .hc-bars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 120px;
        min-width: fit-content;
      }

      .hc-col {
        width: 38px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
      }

      .hc-col .chart-bar,
      .hc-col .stack-bar {
        margin-bottom: 0;
      }

      .hc-barval {
        font-size: 9px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
        white-space: nowrap;
      }

      .hc-xlabels {
        display: flex;
        gap: 4px;
        min-width: fit-content;
        margin-top: 4px;
      }

      .hc-xlabel {
        width: 38px;
        flex-shrink: 0;
        text-align: center;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
      }

      .git-badge {
        display: inline-block;
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 1px 5px;
        border-radius: 3px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        vertical-align: middle;
      }

      .cache-badge {
        display: inline-block;
        font-size: 11px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 3px;
        white-space: nowrap;
      }
      .cache-badge-good { background: rgba(40,167,69,0.18); color: var(--vscode-charts-green, #28a745); }
      .cache-badge-mid  { background: rgba(255,165,0,0.15); color: var(--vscode-charts-yellow, #d4a017); }
      .cache-badge-low  { background: rgba(220,53,69,0.15); color: var(--vscode-charts-red, #dc3545); }

      .cache-insights-card { margin-bottom: 12px; }
      .cache-low-list { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 6px 0 4px; }
      .cache-low-list strong { margin-right: 4px; }

      .cbar-total {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }

      .cbar-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 8px 0 16px;
      }

      .cbar-subhead {
        margin: 16px 0 4px;
        font-size: 14px;
      }

      .cbar-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
      }

      .cbar-label {
        width: 160px;
        flex-shrink: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .cbar-track {
        flex: 1;
        height: 16px;
        min-width: 40px;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        border-radius: 3px;
        overflow: hidden;
      }

      .cbar-fill {
        height: 100%;
        border-radius: 2px;
        min-width: 1px;
      }

      .cbar-val {
        width: 96px;
        flex-shrink: 0;
        text-align: right;
        font-family: var(--vscode-editor-font-family);
      }

      .cbar-pct {
        width: 52px;
        flex-shrink: 0;
        text-align: right;
        color: var(--vscode-descriptionForeground);
      }

      .cf-1 {
        background: var(--vscode-charts-blue);
      }

      .cf-2 {
        background: var(--vscode-charts-orange);
      }

      .cf-3 {
        background: var(--vscode-charts-purple);
      }

      .cf-4 {
        background: var(--vscode-charts-green);
      }

      .cf-5 {
        background: var(--vscode-charts-red);
      }

      .heatmap {
        display: flex;
        flex-direction: column;
        gap: 3px;
        overflow-x: auto;
        padding-bottom: 4px;
      }

      .hm-row {
        display: flex;
        gap: 3px;
        align-items: center;
      }

      .hm-label {
        width: 38px;
        flex-shrink: 0;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        text-align: right;
        padding-right: 4px;
        white-space: nowrap;
      }

      .hm-hhead {
        width: 16px;
        flex-shrink: 0;
        font-size: 9px;
        color: var(--vscode-descriptionForeground);
        text-align: center;
      }

      .hm-cell {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        border-radius: 2px;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
      }

      .topic-list {
        margin: 8px 0 0;
        padding-left: 18px;
        font-size: 12px;
        color: var(--vscode-foreground);
      }

      .topic-list li {
        margin-bottom: 4px;
      }

      /* --- Context Health tab --- */
      .ch { display: flex; flex-direction: column; gap: 16px; }
      .ch-head { display: flex; align-items: center; gap: 12px; }
      .ch-badge {
        font-weight: 600;
        font-size: 13px;
        padding: 3px 12px;
        border-radius: 12px;
        color: var(--vscode-editor-background);
      }
      .ch-healthy .ch-badge { background: var(--vscode-charts-green); }
      .ch-watch .ch-badge { background: var(--vscode-charts-yellow); }
      .ch-rot .ch-badge { background: var(--vscode-charts-red); }
      .ch-sub { color: var(--vscode-descriptionForeground); font-size: 12px; }
      .ch-window { display: flex; flex-direction: column; gap: 6px; }
      .ch-winrow { display: flex; justify-content: space-between; font-size: 13px; }
      .ch-winrow.ch-muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
      .ch-fill {
        height: 12px;
        border-radius: 6px;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
        overflow: hidden;
      }
      .ch-fillbar { height: 100%; border-radius: 6px; transition: width 0.3s ease; }
      .ch-fill-healthy { background: var(--vscode-charts-green); }
      .ch-fill-watch { background: var(--vscode-charts-yellow); }
      .ch-fill-rot { background: var(--vscode-charts-red); }
      .ch-pace { font-size: 12px; color: var(--vscode-descriptionForeground); }
      .ch-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      @media (max-width: 720px) { .ch-grid { grid-template-columns: 1fr; } }
      .ch-card {
        background: var(--vscode-editorWidget-background, var(--vscode-input-background));
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        padding: 12px 14px;
      }
      .ch-card h3 { margin: 0 0 10px; font-size: 13px; }
      .ch-donut-wrap { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
      .ch-donut {
        position: relative;
        width: 132px;
        height: 132px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .ch-donut-hole {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 82px; height: 82px;
        border-radius: 50%;
        background: var(--vscode-editor-background);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
      }
      .ch-donut-num { font-size: 15px; font-weight: 600; }
      .ch-donut-cap { font-size: 10px; color: var(--vscode-descriptionForeground); }
      .ch-legendcol { display: flex; flex-direction: column; gap: 4px; min-width: 160px; flex: 1; }
      .ch-leg { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .ch-swatch { width: 11px; height: 11px; border-radius: 3px; flex-shrink: 0; }
      .ch-leglabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ch-legval { color: var(--vscode-descriptionForeground); }
      .ch-timeline {
        display: flex;
        height: 26px;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid var(--vscode-input-border);
        margin-bottom: 10px;
      }
      .ch-tlseg { height: 100%; }
      .ch-sigs { display: flex; flex-direction: column; gap: 8px; }
      .ch-sig {
        display: flex; align-items: flex-start; gap: 8px;
        font-size: 12px;
        padding: 8px 10px;
        border-radius: 6px;
        background: var(--vscode-input-background);
        border-left: 3px solid var(--vscode-charts-yellow);
      }
      .ch-sigicon { flex-shrink: 0; }
      .ch-suggest {
        font-size: 13px;
        padding: 10px 14px;
        border-radius: 8px;
        background: var(--vscode-input-background);
        border-left: 4px solid var(--vscode-charts-green);
      }
      .ch-suggest-watch { border-left-color: var(--vscode-charts-yellow); }
      .ch-suggest-rot { border-left-color: var(--vscode-charts-red); }
      .ch-inspect-btn {
        background: transparent;
        border: 1px solid var(--vscode-button-border, var(--vscode-input-border));
        color: var(--vscode-foreground);
        border-radius: 4px;
        padding: 2px 8px;
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
      }
      .ch-inspect-btn:hover {
        background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      }
      .ch-inspecting {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 12px;
        border-radius: 6px;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-panel-border);
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }
      .ch-back-btn {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 4px;
        padding: 3px 10px;
        font-size: 12px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .ch-back-btn:hover { background: var(--vscode-button-hoverBackground); }
    `;
  }

  private getScript(): string {
    return `
console.log("[DEBUG] === JAVASCRIPT INITIALIZATION START ===");

// Get VSCode API
const vscode = acquireVsCodeApi();
console.log("[DEBUG] VSCode API acquired");

// Locale + timezone baked in at render time so drill-down renders match the
// user's UI language and configured timezone (instead of the hardcoded zh-TW
// that the original used in this script body).
const __locale = ${JSON.stringify(I18n.getLocale())};
const __tz = ${JSON.stringify(I18n.getTimezone())};
const __dateOpts = (extra) => {
  const opts = Object.assign({}, extra || {});
  if (__tz) opts.timeZone = __tz;
  return opts;
};

// Define basic functions
function refresh() {
  console.log("[DEBUG] refresh called");
  vscode.postMessage({ command: 'refresh' });
}

function openSettings() {
  console.log("[DEBUG] openSettings called");
  vscode.postMessage({ command: 'openSettings' });
}

function inspectContextHealth(sessionId) {
  vscode.postMessage({ command: 'inspectContextHealth', sessionId: sessionId });
}

function backToActiveContextHealth() {
  vscode.postMessage({ command: 'clearInspectContextHealth' });
}

function toggleProjectGroup(groupId) {
  var groupRow = document.querySelector('.project-group-row[data-group="' + groupId + '"]');
  var childRows = document.querySelectorAll('.project-child-row[data-group="' + groupId + '"]');
  var toggle = groupRow ? groupRow.querySelector('.group-toggle') : null;
  var expanded = toggle && toggle.classList.contains('expanded');
  childRows.forEach(function(r) {
    r.style.display = expanded ? 'none' : 'table-row';
  });
  if (toggle) {
    toggle.classList.toggle('expanded');
    toggle.textContent = expanded ? '▶' : '▼';
  }
}

// Sort a table by a column key. Rows with class "sort-child" travel with the
// preceding "sort-row" (used for expandable project groups).
function sortTable(table, key, th) {
  var tbody = table.querySelector('tbody');
  if (!tbody) { return; }
  var allRows = Array.prototype.slice.call(tbody.children);

  var units = [];
  var current = null;
  allRows.forEach(function(row) {
    if (row.classList.contains('sort-child') && current) {
      current.rows.push(row);
    } else {
      current = { lead: row, rows: [row] };
      units.push(current);
    }
  });

  // First click on a column sorts descending; clicking again flips direction.
  var ascending = th.getAttribute('data-sortdir') === 'desc';

  table.querySelectorAll('th.sortable').forEach(function(h) {
    h.removeAttribute('data-sortdir');
    h.classList.remove('sorted-asc', 'sorted-desc');
  });
  th.setAttribute('data-sortdir', ascending ? 'asc' : 'desc');
  th.classList.add(ascending ? 'sorted-asc' : 'sorted-desc');

  units.sort(function(a, b) {
    var va = a.lead.getAttribute('data-sort-' + key);
    var vb = b.lead.getAttribute('data-sort-' + key);
    if (va === null) { va = ''; }
    if (vb === null) { vb = ''; }
    var na = parseFloat(va);
    var nb = parseFloat(vb);
    var cmp;
    if (va !== '' && vb !== '' && !isNaN(na) && !isNaN(nb)) {
      cmp = na - nb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return ascending ? cmp : -cmp;
  });

  units.forEach(function(u) {
    u.rows.forEach(function(r) { tbody.appendChild(r); });
  });
}

function showTab(tabName) {
  console.log("[DEBUG] showTab called:", tabName);

  try {
    // Remove active from all tabs and contents
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    // Add active to selected tab and content
    const selectedTab = document.getElementById('tab-' + tabName);
    const selectedContent = document.getElementById(tabName);

    if (selectedTab && selectedContent) {
      selectedTab.classList.add('active');
      selectedContent.classList.add('active');
      console.log("[DEBUG] Tab switched successfully to:", tabName);

      // Notify extension
      vscode.postMessage({ command: 'tabChanged', tab: tabName });
    } else {
      console.error("[DEBUG] Tab or content not found:", tabName);
    }
  } catch (error) {
    console.error("[DEBUG] Error switching tabs:", error);
  }
}

function toggleHourlyDetail(date) {
  console.log("[DEBUG] toggleHourlyDetail called for date:", date);

  try {
    const detailRow = document.querySelector('.hourly-detail-row[data-date="' + date + '"]');
    const button = document.querySelector('.daily-row[data-date="' + date + '"] .detail-button');
    const container = document.getElementById('hourly-detail-' + date);
    const chartBar = document.querySelector('.chart-bar-container[data-date="' + date + '"] .chart-bar');

    console.log("[DEBUG] Found elements:", {
      detailRow: !!detailRow,
      button: !!button,
      container: !!container,
      chartBar: !!chartBar
    });

    if (detailRow && button && container) {
      const isExpanded = detailRow.style.display !== 'none' && detailRow.style.display !== '';

      if (!isExpanded) {
        // First, close all other expanded details
        closeAllHourlyDetails();

        // Show detail for this date
        detailRow.style.display = 'table-row';
        button.classList.add('expanded');

        // Update chart bar selection state
        if (chartBar) {
          chartBar.classList.add('selected');
          console.log("[DEBUG] Chart bar selected for date:", date);
        }

        console.log("[DEBUG] Showing hourly detail for date:", date);

        // Request hourly data if not loaded
        if (!container.dataset.loaded) {
          console.log("[DEBUG] Requesting hourly data for date:", date);
          vscode.postMessage({ command: 'getHourlyData', date: date });
          container.dataset.loaded = 'true';
        }
      } else {
        // Hide detail
        detailRow.style.display = 'none';
        button.classList.remove('expanded');

        // Update chart bar selection state
        if (chartBar) {
          chartBar.classList.remove('selected');
          console.log("[DEBUG] Chart bar deselected for date:", date);
        }

        console.log("[DEBUG] Hiding hourly detail for date:", date);
      }

    } else {
      console.error("[DEBUG] Could not find required elements for date:", date);
    }
  } catch (error) {
    console.error("[DEBUG] Error in toggleHourlyDetail:", error);
  }
}

function closeAllHourlyDetails() {
  console.log("[DEBUG] closeAllHourlyDetails called");

  // Close all expanded detail rows
  const allDetailRows = document.querySelectorAll('.hourly-detail-row');
  const allButtons = document.querySelectorAll('.detail-button.expanded');
  const allChartBars = document.querySelectorAll('.chart-bar.selected');

  allDetailRows.forEach(function(row) {
    row.style.display = 'none';
  });

  allButtons.forEach(function(btn) {
    btn.classList.remove('expanded');
  });

  allChartBars.forEach(function(bar) {
    bar.classList.remove('selected');
  });

  console.log("[DEBUG] Closed all detail rows");
}

function toggleMonthlyDetail(monthDate) {
  console.log("[DEBUG] toggleMonthlyDetail called for month:", monthDate);

  try {
    const detailRow = document.querySelector('.monthly-detail-row[data-date="' + monthDate + '"]');
    const button = document.querySelector('.daily-row[data-date="' + monthDate + '"] .detail-button');
    const container = document.getElementById('monthly-detail-' + monthDate);
    const chartBar = document.querySelector('.chart-bar-container[data-date="' + monthDate + '"] .chart-bar');

    console.log("[DEBUG] Found elements:", {
      detailRow: !!detailRow,
      button: !!button,
      container: !!container,
      chartBar: !!chartBar
    });

    if (detailRow && button && container) {
      const isExpanded = detailRow.style.display !== 'none' && detailRow.style.display !== '';

      if (!isExpanded) {
        // First, close all other expanded details
        closeAllMonthlyDetails();

        // Show detail for this month
        detailRow.style.display = 'table-row';
        button.classList.add('expanded');

        // Update chart bar selection state
        if (chartBar) {
          chartBar.classList.add('selected');
          console.log("[DEBUG] Chart bar selected for month:", monthDate);
        }

        console.log("[DEBUG] Showing monthly detail for month:", monthDate);

        // Request monthly data if not loaded
        if (!container.dataset.loaded) {
          console.log("[DEBUG] Requesting daily data for month:", monthDate);
          vscode.postMessage({ command: 'getDailyData', month: monthDate });
          container.dataset.loaded = 'true';
        }
      } else {
        // Hide detail
        detailRow.style.display = 'none';
        button.classList.remove('expanded');

        // Update chart bar selection state
        if (chartBar) {
          chartBar.classList.remove('selected');
          console.log("[DEBUG] Chart bar deselected for month:", monthDate);
        }

        console.log("[DEBUG] Hiding monthly detail for month:", monthDate);
      }

    } else {
      console.error("[DEBUG] Could not find required elements for month:", monthDate);
    }
  } catch (error) {
    console.error("[DEBUG] Error in toggleMonthlyDetail:", error);
  }
}

function closeAllMonthlyDetails() {
  console.log("[DEBUG] closeAllMonthlyDetails called");

  // Close all expanded monthly detail rows
  const allDetailRows = document.querySelectorAll('.monthly-detail-row');
  const allButtons = document.querySelectorAll('.detail-button.expanded');
  const allChartBars = document.querySelectorAll('.chart-bar.selected');

  allDetailRows.forEach(function(row) {
    row.style.display = 'none';
  });

  allButtons.forEach(function(btn) {
    btn.classList.remove('expanded');
  });

  allChartBars.forEach(function(bar) {
    bar.classList.remove('selected');
  });

  console.log("[DEBUG] Closed all monthly detail rows");
}

function updateHourlyChart(date, metric) {
  console.log("[DEBUG] updateHourlyChart called with date:", date, "metric:", metric);

  const container = document.getElementById('hourly-detail-' + date);
  if (!container) return;

  // Update active tab
  const tabs = container.querySelectorAll('.chart-tab');
  tabs.forEach(function(tab) {
    if (tab.dataset.metric === metric) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Re-render chart
  const chartContainer = document.getElementById('hourly-chart-' + date);
  const hourlyData = window['hourlyData_' + date];
  if (hourlyData && chartContainer) {
    chartContainer.innerHTML = renderHourlyChart(hourlyData, metric);
  }
}

// Sync chart bar selection state
function syncChartBarSelection(date, isSelected) {
  console.log("[DEBUG] syncChartBarSelection called for date:", date, "selected:", isSelected);

  const chartBar = document.querySelector('.chart-bar-container[data-date="' + date + '"] .chart-bar');
  if (chartBar) {
    if (isSelected) {
      chartBar.classList.add('selected');
    } else {
      chartBar.classList.remove('selected');
    }
  }
}

// Make functions available globally
window.refresh = refresh;
window.openSettings = openSettings;
window.toggleProjectGroup = toggleProjectGroup;
window.sortTable = sortTable;
window.showTab = showTab;
window.toggleHourlyDetail = toggleHourlyDetail;
window.toggleMonthlyDetail = toggleMonthlyDetail;
window.updateHourlyChart = updateHourlyChart;
window.syncChartBarSelection = syncChartBarSelection;
window.closeAllHourlyDetails = closeAllHourlyDetails;
window.closeAllMonthlyDetails = closeAllMonthlyDetails;

// Handle messages from extension
window.addEventListener('message', function(event) {
  const message = event.data;
  console.log("[DEBUG] Received message from extension:", message);

  if (message.command === 'updateContent') {
    // Smooth refresh: replace only the dashboard's inner markup, preserving the
    // document (and scroll position) so the panel never flashes blank. Click and
    // message handling use document/window-level delegation, so they keep working
    // across the swap; we only need to re-bind the direct chart-tab listeners.
    var container = document.querySelector('.container');
    if (container && typeof message.html === 'string') {
      container.innerHTML = message.html;
      document.querySelectorAll('.daily-breakdown').forEach(function(c) {
        bindChartTabEvents(c);
      });
    }
    return;
  }

  if (message.command === 'hourlyDataResponse') {
    const container = document.getElementById('hourly-detail-' + message.date);
    if (container && message.data) {
      console.log("[DEBUG] Rendering hourly data for date:", message.date);
      container.innerHTML = renderHourlyData(message.data, message.date);

      // Re-bind chart tab events after rendering
      bindChartTabEvents(container);
    }
  }

  if (message.command === 'dailyDataResponse') {
    const container = document.getElementById('monthly-detail-' + message.month);
    if (container && message.data) {
      console.log("[DEBUG] Rendering daily data for month:", message.month);
      container.innerHTML = renderDailyData(message.data, message.month);

      // Re-bind chart tab events after rendering
      bindChartTabEvents(container);
    }
  }
});

// Global event delegation for chart tabs and chart bars
document.addEventListener('click', function(event) {
  console.log("[DEBUG] Document click event:", event.target);

  // Handle sortable table header clicks
  var sortableTh = event.target.closest ? event.target.closest('th.sortable') : null;
  if (sortableTh) {
    var sortTableEl = sortableTh.closest('table');
    var sortKey = sortableTh.getAttribute('data-sortkey');
    if (sortTableEl && sortKey) {
      sortTable(sortTableEl, sortKey, sortableTh);
    }
    return;
  }

  // Handle chart tab clicks
  if (event.target.classList.contains('chart-tab')) {
    console.log("[DEBUG] Chart tab clicked:", event.target);

    event.preventDefault();
    const metric = event.target.dataset.metric;
    console.log("[DEBUG] Chart tab metric:", metric);

    // Find the container and determine the context
    const container = event.target.closest('.daily-breakdown') || event.target.closest('.hourly-breakdown');
    console.log("[DEBUG] Chart tab container:", container);

    if (container) {
      // Update active tab
      const tabs = container.querySelectorAll('.chart-tab');
      tabs.forEach(function(tab) {
        tab.classList.remove('active');
      });
      event.target.classList.add('active');

      // Determine chart type and update accordingly
      if (container.classList.contains('hourly-breakdown')) {
        // This is an hourly detail chart - extract date from the chart content ID
        const chartContent = container.querySelector('[id^="hourly-chart-"]');
        if (chartContent) {
          const date = chartContent.id.replace('hourly-chart-', '');
          console.log("[DEBUG] Updating hourly chart for date:", date, "metric:", metric);
          updateHourlyChart(date, metric);
        }
      } else {
        // This is a main chart (daily/monthly)
        console.log("[DEBUG] Updating main chart with metric:", metric);
        updateMainChart(metric, container);
      }
    }
  }

  // Handle chart bar clicks - only for clickable charts
  if (event.target.classList.contains('chart-bar') && event.target.classList.contains('clickable')) {
    console.log("[DEBUG] Clickable chart bar clicked:", event.target);

    event.preventDefault();
    const container = event.target.closest('.chart-bar-container');
    if (container) {
      const date = container.dataset.date;
      if (date) {
        console.log("[DEBUG] Chart bar clicked for date:", date);

        // Determine if this is a monthly chart or daily chart based on current tab
        const activeTab = document.querySelector('.tab.active');
        if (activeTab && activeTab.id === 'tab-all') {
          // This is in the "all time" tab, so it's a monthly chart
          toggleMonthlyDetail(date);
        } else {
          // This is in the "month" tab, so it's a daily chart
          toggleHourlyDetail(date);
        }
      }
    }
  }
});

function bindChartTabEvents(container) {
  console.log("[DEBUG] Binding chart tab events for container:", container);

  const chartTabs = container.querySelectorAll('.chart-tab');
  console.log("[DEBUG] Found chart tabs:", chartTabs.length);

  chartTabs.forEach(function(tab, index) {
    console.log("[DEBUG] Processing chart tab", index, ":", tab.dataset.metric);

    // Remove existing event listeners to prevent duplicates
    tab.removeEventListener('click', handleChartTabClick);

    // Add new event listener
    tab.addEventListener('click', handleChartTabClick);
  });
}

function handleChartTabClick(event) {
  console.log("[DEBUG] handleChartTabClick called");
  event.preventDefault();

  const metric = this.dataset.metric;
  const container = this.closest('.daily-breakdown') || this.closest('.hourly-breakdown');

  if (container) {
    // Update active tab
    const tabs = container.querySelectorAll('.chart-tab');
    tabs.forEach(function(tab) {
      tab.classList.remove('active');
    });
    this.classList.add('active');

    // Update chart based on context
    if (container.classList.contains('hourly-breakdown')) {
      const chartContent = container.querySelector('[id^="hourly-chart-"]');
      if (chartContent) {
        const date = chartContent.id.replace('hourly-chart-', '');
        updateHourlyChart(date, metric);
      }
    } else {
      updateMainChart(metric, null);
    }
  }
}

function updateMainChart(metric, container) {
  console.log("[DEBUG] updateMainChart called with metric:", metric, "container:", container);

  // If container is provided, use it; otherwise find the active tab content
  let targetContainer = container;
  if (!targetContainer) {
    targetContainer = document.querySelector('.tab-content.active');
    if (!targetContainer) {
      console.error("[DEBUG] No active tab content found");
      return;
    }
  }

  // Update chart in the target container
  const chartBars = targetContainer.querySelectorAll('.chart-bar');
  if (chartBars.length === 0) {
    console.log("[DEBUG] No chart bars found in target container");
    return;
  }

  console.log("[DEBUG] Updating", chartBars.length, "chart bars with metric:", metric);

  // Calculate max values for the metric
  const values = Array.from(chartBars).map(function(bar) {
    const value = parseFloat(bar.dataset[getDataAttribute(metric)]) || 0;
    return value;
  });

  const maxValue = Math.max(...values);
  const maxHeight = 120;

  console.log("[DEBUG] Max value for metric", metric, ":", maxValue);

  // Update each bar
  chartBars.forEach(function(bar, index) {
    const value = parseFloat(bar.dataset[getDataAttribute(metric)]) || 0;
    const height = maxValue > 0 ? (value / maxValue) * maxHeight : 2;

    // Update height
    bar.style.height = height + 'px';

    // Update class - preserve clickable and selected states
    const baseClass = 'chart-bar ' + getBarClass(metric);
    const hasClickable = bar.classList.contains('clickable');
    const hasSelected = bar.classList.contains('selected');

    bar.className = baseClass;
    if (hasClickable) {
      bar.classList.add('clickable');
    }
    if (hasSelected) {
      bar.classList.add('selected');
    }

    // Update tooltip + on-bar value label
    const formattedValue = formatValue(value, metric);
    const container = bar.parentElement;
    const date = container.dataset.date;
    const hour = container.dataset.hour;

    if (hour) {
      // Hourly chart: tooltip shows the value only (the hour is on the x-axis).
      bar.title = formattedValue;
    } else if (date) {
      const dateObj = new Date(date);
      bar.title = dateObj.toLocaleDateString() + ': ' + formattedValue;
    }

    const barVal = container.querySelector('.hc-barval');
    if (barVal) {
      barVal.textContent = formattedValue;
    }
  });

  // Update the hourly chart's Y-axis reference labels, if present.
  const yvals = targetContainer.querySelectorAll('.hc-yaxis .hc-yval');
  if (yvals.length === 3) {
    yvals[0].textContent = formatValue(maxValue, metric);
    yvals[1].textContent = formatValue(maxValue / 2, metric);
    yvals[2].textContent = formatValue(0, metric);
  }
}

function getDataAttribute(metric) {
  const mapping = {
    'cost': 'cost',
    'inputTokens': 'input',
    'outputTokens': 'output',
    'cacheCreation': 'cacheCreation',
    'cacheRead': 'cacheRead',
    'messages': 'messages'
  };
  return mapping[metric] || 'cost';
}

function getBarClass(metric) {
  const mapping = {
    'cost': 'cost-bar',
    'inputTokens': 'input-bar',
    'outputTokens': 'output-bar',
    'cacheCreation': 'cache-creation-bar',
    'cacheRead': 'cache-read-bar',
    'messages': 'messages-bar'
  };
  return mapping[metric] || 'cost-bar';
}

function formatValue(value, metric) {
  if (metric === 'cost') {
    return '$' + value.toFixed(2);
  } else {
    return value.toLocaleString();
  }
}

function renderHourlyData(hourlyData, date) {
  if (!hourlyData || hourlyData.length === 0) {
    return '<div class="no-data">${I18n.t.popup.noDataMessage}</div>';
  }

  let html = '<div class="hourly-breakdown">';
  html += '<h4>' + new Date(date).toLocaleDateString(__locale, __dateOpts()) + ' ${I18n.t.popup.hourlyBreakdown}</h4>';

  html += '<div class="chart-tabs">';
  html += '<button class="chart-tab active" data-metric="cost">${I18n.t.popup.cost}</button>';
  html += '<button class="chart-tab" data-metric="inputTokens">${I18n.t.popup.inputTokens}</button>';
  html += '<button class="chart-tab" data-metric="outputTokens">${I18n.t.popup.outputTokens}</button>';
  html += '<button class="chart-tab" data-metric="cacheCreation">${I18n.t.popup.cacheCreation}</button>';
  html += '<button class="chart-tab" data-metric="cacheRead">${I18n.t.popup.cacheRead}</button>';
  html += '<button class="chart-tab" data-metric="messages">${I18n.t.popup.messages}</button>';
  html += '</div>';

  html += '<div class="chart-container">';
  html += '<div class="chart-content" id="hourly-chart-' + date + '">';
  html += renderHourlyChart(hourlyData, 'cost');
  html += '</div>';
  html += '</div>';

  html += '<div class="daily-table-container"><table class="daily-table"><thead><tr>';
  html += '<th>${I18n.t.popup.hour}</th>';
  html += '<th>${I18n.t.popup.cost}</th>';
  html += '<th>${I18n.t.popup.inputTokens}</th>';
  html += '<th>${I18n.t.popup.outputTokens}</th>';
  html += '<th>${I18n.t.popup.cacheCreation}</th>';
  html += '<th>${I18n.t.popup.cacheRead}</th>';
  html += '<th>${I18n.t.popup.messages}</th>';
  html += '</tr></thead><tbody>';

  hourlyData.forEach(function(item) {
    html += '<tr>';
    html += '<td class="date-cell">' + item.hour + '</td>';
    html += '<td class="cost-cell">$' + item.data.totalCost.toFixed(2) + '</td>';
    html += '<td class="number-cell">' + item.data.totalInputTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.totalOutputTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.totalCacheCreationTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.totalCacheReadTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.messageCount.toLocaleString(__locale) + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  window['hourlyData_' + date] = hourlyData;
  html += '</div>';
  return html;
}

function renderDailyData(dailyData, monthDate) {
  if (!dailyData || dailyData.length === 0) {
    return '<div class="no-data">${I18n.t.popup.noDataMessage}</div>';
  }

  let html = '<div class="daily-breakdown">';
  html += '<h4>' + new Date(monthDate).toLocaleDateString(__locale, __dateOpts({ year: 'numeric', month: 'long' })) + ' ${I18n.t.popup.dailyBreakdown}</h4>';

  html += '<div class="chart-tabs">';
  html += '<button class="chart-tab active" data-metric="cost">${I18n.t.popup.cost}</button>';
  html += '<button class="chart-tab" data-metric="inputTokens">${I18n.t.popup.inputTokens}</button>';
  html += '<button class="chart-tab" data-metric="outputTokens">${I18n.t.popup.outputTokens}</button>';
  html += '<button class="chart-tab" data-metric="cacheCreation">${I18n.t.popup.cacheCreation}</button>';
  html += '<button class="chart-tab" data-metric="cacheRead">${I18n.t.popup.cacheRead}</button>';
  html += '<button class="chart-tab" data-metric="messages">${I18n.t.popup.messages}</button>';
  html += '</div>';

  html += '<div class="chart-container">';
  html += '<div class="chart-content" id="daily-chart-' + monthDate + '">';
  html += renderDailyChart(dailyData, 'cost');
  html += '</div>';
  html += '</div>';

  html += '<div class="daily-table-container"><table class="daily-table"><thead><tr>';
  html += '<th>${I18n.t.popup.date}</th>';
  html += '<th>${I18n.t.popup.cost}</th>';
  html += '<th>${I18n.t.popup.inputTokens}</th>';
  html += '<th>${I18n.t.popup.outputTokens}</th>';
  html += '<th>${I18n.t.popup.cacheCreation}</th>';
  html += '<th>${I18n.t.popup.cacheRead}</th>';
  html += '<th>${I18n.t.popup.messages}</th>';
  html += '</tr></thead><tbody>';

  dailyData.forEach(function(item) {
    const dateObj = new Date(item.date);
    const formattedDate = dateObj.toLocaleDateString(__locale, __dateOpts({ month: 'numeric', day: 'numeric' }));

    html += '<tr>';
    html += '<td class="date-cell">' + formattedDate + '</td>';
    html += '<td class="cost-cell">$' + item.data.totalCost.toFixed(2) + '</td>';
    html += '<td class="number-cell">' + item.data.totalInputTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.totalOutputTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.totalCacheCreationTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.totalCacheReadTokens.toLocaleString(__locale) + '</td>';
    html += '<td class="number-cell">' + item.data.messageCount.toLocaleString(__locale) + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  window['dailyData_' + monthDate] = dailyData;
  html += '</div>';
  return html;
}

function renderDailyChart(dailyData, metric) {
  console.log("[DEBUG] renderDailyChart called with metric:", metric);

  const maxValues = {
    cost: Math.max(...dailyData.map(d => d.data.totalCost)),
    inputTokens: Math.max(...dailyData.map(d => d.data.totalInputTokens)),
    outputTokens: Math.max(...dailyData.map(d => d.data.totalOutputTokens)),
    cacheCreation: Math.max(...dailyData.map(d => d.data.totalCacheCreationTokens)),
    cacheRead: Math.max(...dailyData.map(d => d.data.totalCacheReadTokens)),
    messages: Math.max(...dailyData.map(d => d.data.messageCount))
  };

  const maxHeight = 120;
  const maxValue = maxValues[metric] || 0;

  let html = '<div class="chart-bars">';

  dailyData.forEach(function(item) {
    let value = 0;
    let barClass = 'cost-bar';

    switch(metric) {
      case 'cost':
        value = item.data.totalCost;
        barClass = 'cost-bar';
        break;
      case 'inputTokens':
        value = item.data.totalInputTokens;
        barClass = 'input-bar';
        break;
      case 'outputTokens':
        value = item.data.totalOutputTokens;
        barClass = 'output-bar';
        break;
      case 'cacheCreation':
        value = item.data.totalCacheCreationTokens;
        barClass = 'cache-creation-bar';
        break;
      case 'cacheRead':
        value = item.data.totalCacheReadTokens;
        barClass = 'cache-read-bar';
        break;
      case 'messages':
        value = item.data.messageCount;
        barClass = 'messages-bar';
        break;
    }

    const height = maxValue > 0 ? Math.max((value / maxValue) * maxHeight, 2) : 2;
    const dateObj = new Date(item.date);
    const shortDate = dateObj.getDate().toString();

    html += '<div class="chart-bar-container" data-date="' + item.date + '">';
    html += '<div class="chart-bar ' + barClass + '" ';
    html += 'style="height: ' + height + 'px;" ';
    html += 'data-cost="' + item.data.totalCost + '" ';
    html += 'data-input="' + item.data.totalInputTokens + '" ';
    html += 'data-output="' + item.data.totalOutputTokens + '" ';
    html += 'data-cache-creation="' + item.data.totalCacheCreationTokens + '" ';
    html += 'data-cache-read="' + item.data.totalCacheReadTokens + '" ';
    html += 'data-messages="' + item.data.messageCount + '" ';
    html += 'title="' + dateObj.toLocaleDateString(__locale, __dateOpts()) + ': ' + formatValue(value, metric) + '">';
    html += '</div>';
    html += '<div class="chart-label">' + shortDate + '</div>';
    html += '</div>';
  });

  html += '</div>';

  return html;
}

function renderHourlyChart(hourlyData, metric) {
  console.log("[DEBUG] renderHourlyChart called with metric:", metric);

  const maxValues = {
    cost: Math.max(...hourlyData.map(d => d.data.totalCost)),
    inputTokens: Math.max(...hourlyData.map(d => d.data.totalInputTokens)),
    outputTokens: Math.max(...hourlyData.map(d => d.data.totalOutputTokens)),
    cacheCreation: Math.max(...hourlyData.map(d => d.data.totalCacheCreationTokens)),
    cacheRead: Math.max(...hourlyData.map(d => d.data.totalCacheReadTokens)),
    messages: Math.max(...hourlyData.map(d => d.data.messageCount))
  };

  const maxHeight = 120;
  const maxValue = maxValues[metric] || 0;

  let html = '<div class="chart-bars">';

  hourlyData.forEach(function(item) {
    let value = 0;
    let barClass = 'cost-bar';

    switch(metric) {
      case 'cost':
        value = item.data.totalCost;
        barClass = 'cost-bar';
        break;
      case 'inputTokens':
        value = item.data.totalInputTokens;
        barClass = 'input-bar';
        break;
      case 'outputTokens':
        value = item.data.totalOutputTokens;
        barClass = 'output-bar';
        break;
      case 'cacheCreation':
        value = item.data.totalCacheCreationTokens;
        barClass = 'cache-creation-bar';
        break;
      case 'cacheRead':
        value = item.data.totalCacheReadTokens;
        barClass = 'cache-read-bar';
        break;
      case 'messages':
        value = item.data.messageCount;
        barClass = 'messages-bar';
        break;
    }

    const height = maxValue > 0 ? Math.max((value / maxValue) * maxHeight, 2) : 2;

    html += '<div class="chart-bar-container" data-hour="' + item.hour + '">';
    html += '<div class="chart-bar ' + barClass + '" ';
    html += 'style="height: ' + height + 'px;" ';
    html += 'data-cost="' + item.data.totalCost + '" ';
    html += 'data-input="' + item.data.totalInputTokens + '" ';
    html += 'data-output="' + item.data.totalOutputTokens + '" ';
    html += 'data-cache-creation="' + item.data.totalCacheCreationTokens + '" ';
    html += 'data-cache-read="' + item.data.totalCacheReadTokens + '" ';
    html += 'data-messages="' + item.data.messageCount + '" ';
    html += 'title="' + item.hour + ': ' + formatValue(value, metric) + '">';
    html += '</div>';
    html += '<div class="chart-label">' + item.hour + '</div>';
    html += '</div>';
  });

  html += '</div>';

  return html;
}

// Initialize chart tab events for existing elements
setTimeout(function() {
  console.log("[DEBUG] Initializing chart tab events for existing elements");
  const existingChartContainers = document.querySelectorAll('.daily-breakdown');
  existingChartContainers.forEach(function(container) {
    bindChartTabEvents(container);
  });
}, 1000);

console.log("[DEBUG] All functions defined and ready");`;
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
    }
  }
}
