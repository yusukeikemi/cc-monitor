import { SupportedLanguage } from './types';

export interface Translations {
  statusBar: {
    loading: string;
    noData: string;
    notRunning: string;
    error: string;
    currentSession: string;
  };
  contextHealth: {
    title: string;
    windowSize: string;
    composition: string;
    topicSwitch: string;
    growth: string;
    pace: string;
    etaToLimit: string;
    topics: string;
    signalsTitle: string;
    peak: string;
    inspect: string;
    viewing: string;
    backToActive: string;
    notifyRot: string;
    statusHealthy: string;
    statusWatch: string;
    statusRot: string;
    sigNearLimit: string;
    sigLargeToolResult: string;
    sigStaleContext: string;
    sigRedundantReads: string;
    sigMultiTopic: string;
    sigCacheBust: string;
    sigLargeBaseline: string;
    sigFullFileReads: string;
    efficiency: string;
    cacheWaste: string;
    baseline: string;
    reclaimable: string;
    fullFileReadsLabel: string;
    recCacheBust: string;
    recBaseline: string;
    recReclaim: string;
    suggestClear: string;
    suggestHealthy: string;
  };
  popup: {
    title: string;
    currentSession: string;
    today: string;
    thisMonth: string;
    allTime: string;
    refresh: string;
    settings: string;
    totalTokens: string;
    inputTokens: string;
    outputTokens: string;
    cacheCreation: string;
    cacheRead: string;
    cost: string;
    messages: string;
    modelBreakdown: string;
    dailyBreakdown: string;
    monthlyBreakdown: string;
    hourlyBreakdown: string;
    sessions: string;
    sessionBreakdown: string;
    project: string;
    startTime: string;
    duration: string;
    hour: string;
    projects: string;
    projectBreakdown: string;
    fullPath: string;
    peakContext: string;
    tokenComposition: string;
    lastActive: string;
    pricing: string;
    refreshPricing: string;
    pricingUpdated: string;
    pricingUpdateFailed: string;
    sortHint: string;
    quota: string;
    quotaWindow: string;
    quotaLimit: string;
    quota5h: string;
    quotaWeekly: string;
    quotaHint: string;
    contentAnalysis: string;
    estimatedNote: string;
    byTool: string;
    catUserPrompts: string;
    catAssistantText: string;
    catAssistantThinking: string;
    catToolCalls: string;
    catToolResults: string;
    estTokens: string;
    share: string;
    resets: string;
    cacheHitRate: string;
    cacheLowEfficiency: string;
    cacheEfficiencyTip: string;
    last30days: string;
    branches: string;
    branchBreakdown: string;
    branch: string;
    getAdvice: string;
    adviceNeedsKey: string;
    adviceGenerating: string;
    adviceFailed: string;
    adviceScopeOverall: string;
    adviceScopePrompt: string;
    adviceDemoButton: string;
    adviceDemoNotice: string;
    costComposition: string;
    date: string;
    yesterday: string;
    dataDirectory: string;
    noDataMessage: string;
    errorMessage: string;
    // Activity tab
    activity: string;
    toolUsage: string;
    toolCalls: string;
    skillUsage: string;
    subagentUsage: string;
    count: string;
    errors: string;
    errorRate: string;
    avgDuration: string;
    skill: string;
    subagent: string;
    tokensCol: string;
    toolUses: string;
    prompts: string;
    prsCreated: string;
    turnOutcomes: string;
    permissionModes: string;
    codeChanges: string;
    filesEdited: string;
    linesAdded: string;
    linesRemoved: string;
    userModifiedRate: string;
    gitOps: string;
    tokenSplit: string;
    mainThread: string;
    subagentsLabel: string;
    activityHeatmap: string;
    heatmapHint: string;
    recentTopics: string;
    activityNote: string;
    // Quota tab
    quotaHistory: string;
    quotaHistoryEmpty: string;
    quotaHistoryNote: string;
    quotaUtilization: string;
    quotaOpus: string;
    quotaOverTime: string;
    quotaByHour: string;
    quotaByHourHint: string;
  };
  settings: {
    title: string;
    refreshInterval: string;
    dataDirectory: string;
    language: string;
    decimalPlaces: string;
  };
}

const translations: Record<SupportedLanguage, Translations> = {
  en: {
    statusBar: {
      loading: 'Loading...',
      noData: 'No Claude Code Data',
      notRunning: 'Claude Code Not Running',
      error: 'Error',
      currentSession: 'Session',
    },
    contextHealth: {
      title: 'Context Health',
      windowSize: 'Window',
      composition: "What's in context",
      topicSwitch: 'Topic-switch point',
      growth: 'Growth',
      pace: 'Pace',
      etaToLimit: 'to limit',
      topics: 'Topics',
      signalsTitle: 'Signals',
      peak: 'Peak',
      inspect: 'Inspect',
      viewing: 'Viewing session',
      backToActive: 'Back to active',
      notifyRot: 'Context is getting bloated — consider /clear to start a fresh topic.',
      statusHealthy: 'Healthy',
      statusWatch: 'Getting heavy',
      statusRot: 'Bloated',
      sigNearLimit: 'Context near the model limit',
      sigLargeToolResult: 'A large tool result dominates the context',
      sigStaleContext: 'Mostly carried-over old content',
      sigRedundantReads: 'Same file re-read repeatedly',
      sigMultiTopic: 'Multiple topics in one session',
      sigCacheBust: 'Cache repeatedly invalidated (costly re-writes)',
      sigLargeBaseline: 'Large startup context (system prompt / CLAUDE.md / tools)',
      sigFullFileReads: 'Whole files read without line ranges',
      efficiency: 'Token efficiency',
      cacheWaste: 'Cache waste',
      baseline: 'Startup baseline',
      reclaimable: 'Reclaimable tool output',
      fullFileReadsLabel: 'Whole-file reads',
      recCacheBust: 'Avoid switching models mid-session to keep the cache warm.',
      recBaseline: 'Trim CLAUDE.md (<200 lines) and disable unused MCP servers.',
      recReclaim: 'Large tool outputs — prefer targeted reads and truncation.',
      suggestClear: 'Consider /clear to start a fresh topic.',
      suggestHealthy: 'Context looks healthy.',
    },
    popup: {
      title: 'Claude Code Usage',
      currentSession: 'Current Session',
      today: 'Today',
      thisMonth: 'This Month',
      allTime: 'All Time',
      refresh: 'Refresh',
      settings: 'Settings',
      totalTokens: 'Total Tokens',
      inputTokens: 'Input Tokens',
      outputTokens: 'Output Tokens',
      cacheCreation: 'Input Cache (Miss)',
      cacheRead: 'Input Cache (Hit)',
      cost: 'Cost',
      messages: 'Messages',
      modelBreakdown: 'Model Usage',
      dailyBreakdown: 'Daily Usage',
      monthlyBreakdown: 'Monthly Usage',
      hourlyBreakdown: 'Hourly Usage',
      sessions: 'Sessions',
      sessionBreakdown: 'Session Usage',
      project: 'Project',
      startTime: 'Start Time',
      duration: 'Duration',
      hour: 'Hour',
      projects: 'Projects',
      projectBreakdown: 'Project Usage',
      fullPath: 'Full Path',
      peakContext: 'Peak Context',
      tokenComposition: 'Token Composition',
      lastActive: 'Last Active',
      pricing: 'Pricing',
      refreshPricing: 'Refresh Token Pricing',
      pricingUpdated: 'Pricing updated',
      pricingUpdateFailed: 'Failed to update pricing',
      sortHint: 'Click a column header to sort',
      quota: 'Quota',
      quotaWindow: 'Window',
      quotaLimit: 'Limit',
      quota5h: '5-hour',
      quotaWeekly: 'Weekly',
      quotaHint: 'Real data from Anthropic /usage.',
      contentAnalysis: 'Content',
      estimatedNote: 'Estimated from text length — relative shares are reliable, absolute figures are approximate.',
      byTool: 'Tool Results by Tool',
      catUserPrompts: 'Your prompts',
      catAssistantText: 'Assistant responses',
      catAssistantThinking: 'Assistant thinking',
      catToolCalls: 'Tool calls',
      catToolResults: 'Tool results',
      estTokens: 'Est. tokens',
      share: 'Share',
      resets: 'Resets',
      cacheHitRate: 'Cache Hit Rate',
      cacheLowEfficiency: 'Projects with low cache efficiency (< 20%)',
      cacheEfficiencyTip: 'Low rates often mean repeated file reads without cache warmup. Try keeping sessions in the same working directory, or add key files to CLAUDE.md.',
      last30days: 'Last 30 days',
      branches: 'Branches',
      branchBreakdown: 'Branch Usage',
      branch: 'Branch',
      getAdvice: 'Get AI Advice',
      adviceNeedsKey: 'Set an API key in Settings to use AI advice.',
      adviceGenerating: 'Generating usage advice…',
      adviceFailed: 'Failed to get advice',
      adviceScopeOverall: 'Overall (all projects)',
      adviceScopePrompt: 'Choose what the advice should focus on',
      adviceDemoButton: 'Preview demo',
      adviceDemoNotice: '',
      costComposition: 'Cost Composition',
      date: 'Date',
      yesterday: 'Yesterday',
      dataDirectory: 'Data Directory',
      noDataMessage: 'No usage data found. Make sure Claude Code is running and configured correctly.',
      errorMessage: 'Error loading usage data. Please check your configuration.',
      activity: 'Activity',
      toolUsage: 'Tool Usage',
      toolCalls: 'Tool Calls',
      skillUsage: 'Skill Usage',
      subagentUsage: 'Subagent Usage',
      count: 'Count',
      errors: 'Errors',
      errorRate: 'Error Rate',
      avgDuration: 'Avg Time',
      skill: 'Skill',
      subagent: 'Subagent',
      tokensCol: 'Tokens',
      toolUses: 'Tool Uses',
      prompts: 'Prompts',
      prsCreated: 'PRs Created',
      turnOutcomes: 'Turn Outcomes',
      permissionModes: 'Permission Modes',
      codeChanges: 'Code Changes',
      filesEdited: 'Files Edited',
      linesAdded: 'Lines Added',
      linesRemoved: 'Lines Removed',
      userModifiedRate: 'Edits You Revised',
      gitOps: 'Git Operations',
      tokenSplit: 'Main vs Subagent (output tokens)',
      mainThread: 'Main thread',
      subagentsLabel: 'Subagents',
      activityHeatmap: 'Activity Heatmap',
      heatmapHint: 'Assistant turns by weekday and hour',
      recentTopics: 'Recent Session Topics',
      activityNote: 'Exact counts from the last 30 days.',
      quotaHistory: 'Quota History',
      quotaHistoryEmpty: 'No quota history recorded yet. It accrues while the extension is running — the API only reports the current value, so the past cannot be back-filled.',
      quotaHistoryNote: 'Recorded while the extension runs; granularity is a few minutes.',
      quotaUtilization: 'Utilization',
      quotaOpus: 'Weekly (Opus)',
      quotaOverTime: 'Utilization Over Time',
      quotaByHour: '5-hour Quota Consumed by Hour',
      quotaByHourHint: 'Sum of 5-hour utilization increases, bucketed by hour of day.',
    },
    settings: {
      title: 'Claude Code Usage Settings',
      refreshInterval: 'Refresh Interval (seconds)',
      dataDirectory: 'Data Directory Path',
      language: 'Language',
      decimalPlaces: 'Decimal Places',
    },
  },
  "de-DE": {
    statusBar: {
      loading: "Lädt...",
      noData: "Keine Claude Code Daten",
      notRunning: "Claude Code nicht erreichbar",
      error: "Error",
      currentSession: "Session",
    },
    contextHealth: {
      title: "Kontext-Zustand",
      windowSize: "Fenster",
      composition: "Was im Kontext ist",
      topicSwitch: "Themenwechsel-Punkt",
      growth: "Wachstum",
      pace: "Tempo",
      etaToLimit: "bis Limit",
      topics: "Themen",
      signalsTitle: "Signale",
      peak: "Spitze",
      inspect: "Prüfen",
      viewing: "Sitzung",
      backToActive: "Zur aktiven",
      notifyRot: "Der Kontext wird überladen — mit /clear ein neues Thema beginnen.",
      statusHealthy: "Gesund",
      statusWatch: "Wird voll",
      statusRot: "Überladen",
      sigNearLimit: "Kontext nahe am Modell-Limit",
      sigLargeToolResult: "Ein großes Tool-Ergebnis dominiert den Kontext",
      sigStaleContext: "Überwiegend übernommener alter Inhalt",
      sigRedundantReads: "Dieselbe Datei mehrfach gelesen",
      sigMultiTopic: "Mehrere Themen in einer Sitzung",
      sigCacheBust: "Cache wiederholt verworfen (teure Neuschreibungen)",
      sigLargeBaseline: "Großer Startkontext (System-Prompt / CLAUDE.md / Tools)",
      sigFullFileReads: "Ganze Dateien ohne Zeilenbereich gelesen",
      efficiency: "Token-Effizienz",
      cacheWaste: "Cache-Verschwendung",
      baseline: "Start-Grundlast",
      reclaimable: "Rückgewinnbare Tool-Ausgabe",
      fullFileReadsLabel: "Ganzdatei-Lesevorgänge",
      recCacheBust: "Modellwechsel mitten in der Sitzung vermeiden, um den Cache warm zu halten.",
      recBaseline: "CLAUDE.md kürzen (<200 Zeilen) und ungenutzte MCP-Server deaktivieren.",
      recReclaim: "Große Tool-Ausgaben — gezielte Reads und Kürzung bevorzugen.",
      suggestClear: "Mit /clear ein neues Thema beginnen.",
      suggestHealthy: "Kontext sieht gesund aus.",
    },
    popup: {
      title: "Claude Code Nutzung",
      currentSession: "Current Session",
      today: "Heute",
      thisMonth: "Diesen Monat",
      allTime: "Seit Aufzeichnungsbeginn",
      refresh: "Aktualisieren",
      settings: "Einstellungen",
      totalTokens: "Gesamte Token",
      inputTokens: "Eingabe Token",
      outputTokens: "Ausgabe Token",
      cacheCreation: "Eingabe-Cache (Miss)",
      cacheRead: "Eingabe-Cache (Hit)",
      cost: "Kosten",
      messages: "Nachrichten",
      modelBreakdown: "Nutzung nach Modell",
      dailyBreakdown: "Tages-Nutzungsübersicht",
      monthlyBreakdown: "Monats-Nutzungsübersicht",
      hourlyBreakdown: "Stunden-Nutzungsübersicht",
      sessions: "Sitzungen",
      sessionBreakdown: "Nutzung nach Sitzung",
      project: "Projekt",
      startTime: "Startzeit",
      duration: "Dauer",
      hour: "Stunde",
      projects: "Projekte",
      projectBreakdown: "Nutzung nach Projekt",
      fullPath: "Vollständiger Pfad",
      peakContext: "Größter Kontext",
      tokenComposition: "Token-Zusammensetzung",
      lastActive: "Zuletzt aktiv",
      pricing: "Preise",
      refreshPricing: "Token-Preise aktualisieren",
      pricingUpdated: "Preise aktualisiert",
      pricingUpdateFailed: "Preisaktualisierung fehlgeschlagen",
      sortHint: "Zum Sortieren auf eine Spaltenüberschrift klicken",
      quota: "Kontingent",
      quotaWindow: "Zeitfenster",
      quotaLimit: "Limit",
      quota5h: "5 Stunden",
      quotaWeekly: "Woche",
      quotaHint: "Echte Daten von Anthropic /usage.",
      contentAnalysis: "Inhalt",
      estimatedNote: "Aus Textlänge geschätzt — relative Anteile sind verlässlich, absolute Werte ungefähr.",
      byTool: "Tool-Ergebnisse nach Tool",
      catUserPrompts: "Deine Eingaben",
      catAssistantText: "Assistent-Antworten",
      catAssistantThinking: "Assistent-Denken",
      catToolCalls: "Tool-Aufrufe",
      catToolResults: "Tool-Ergebnisse",
      estTokens: "Gesch. Token",
      share: "Anteil",
      resets: "Reset",
      cacheHitRate: "Cache-Trefferrate",
      cacheLowEfficiency: "Projekte mit niedriger Cache-Effizienz (< 20%)",
      cacheEfficiencyTip: "Niedrige Raten deuten oft auf wiederholte Dateilesevorgänge ohne Cache-Aufwärmung hin. Versuche, Sitzungen im selben Arbeitsverzeichnis zu starten, oder füge wichtige Dateien zu CLAUDE.md hinzu.",
      last30days: "Letzte 30 Tage",
      branches: "Branches",
      branchBreakdown: "Nutzung nach Branch",
      branch: "Branch",
      getAdvice: "KI-Rat holen",
      adviceNeedsKey: "API-Schlüssel in den Einstellungen festlegen, um KI-Rat zu nutzen.",
      adviceGenerating: "Nutzungsrat wird erstellt…",
      adviceFailed: "Rat konnte nicht abgerufen werden",
      adviceScopeOverall: "Gesamt (alle Projekte)",
      adviceScopePrompt: "Worauf soll sich der Rat konzentrieren?",
      adviceDemoButton: "Demo ansehen",
      adviceDemoNotice: '',
      costComposition: "Kostenzusammensetzung",
      date: "Datum",
      yesterday: "Gestern",
      dataDirectory: "Daten Pfad",
      noDataMessage:
        "Keine Daten gefunden. Stell sicher, dass Claude Code läuft und entsprechend konfiguriert ist.",
      errorMessage:
        "Fehler beim laden der Nutzungsdaten. Bitte prüfe deine Konfiguration.",
      activity: "Aktivität",
      toolUsage: "Tool-Nutzung",
      toolCalls: "Tool-Aufrufe",
      skillUsage: "Skill-Nutzung",
      subagentUsage: "Subagent-Nutzung",
      count: "Anzahl",
      errors: "Fehler",
      errorRate: "Fehlerrate",
      avgDuration: "Ø Zeit",
      skill: "Skill",
      subagent: "Subagent",
      tokensCol: "Token",
      toolUses: "Tool-Aufrufe",
      prompts: "Eingaben",
      prsCreated: "Erstellte PRs",
      turnOutcomes: "Turn-Ergebnisse",
      permissionModes: "Berechtigungsmodi",
      codeChanges: "Code-Änderungen",
      filesEdited: "Bearbeitete Dateien",
      linesAdded: "Zeilen hinzugefügt",
      linesRemoved: "Zeilen entfernt",
      userModifiedRate: "Von dir überarbeitet",
      gitOps: "Git-Operationen",
      tokenSplit: "Haupt vs. Subagent (Ausgabe-Token)",
      mainThread: "Hauptthread",
      subagentsLabel: "Subagenten",
      activityHeatmap: "Aktivitäts-Heatmap",
      heatmapHint: "Assistent-Turns nach Wochentag und Stunde",
      recentTopics: "Letzte Sitzungsthemen",
      activityNote: "Exakte Zahlen der letzten 30 Tage.",
      quotaHistory: "Kontingent-Verlauf",
      quotaHistoryEmpty: "Noch kein Kontingent-Verlauf aufgezeichnet. Er wird gesammelt, während die Erweiterung läuft — die API liefert nur den aktuellen Wert, die Vergangenheit kann nicht nachgetragen werden.",
      quotaHistoryNote: "Wird während des Betriebs aufgezeichnet; Auflösung wenige Minuten.",
      quotaUtilization: "Auslastung",
      quotaOpus: "Woche (Opus)",
      quotaOverTime: "Auslastung im Zeitverlauf",
      quotaByHour: "5-Stunden-Kontingent nach Stunde",
      quotaByHourHint: "Summe der Anstiege der 5-Stunden-Auslastung, nach Tagesstunde gruppiert.",
    },
    settings: {
      title: "Claude Code Nutzungseinstellungen",
      refreshInterval: "Aktualisierungsinterval (in Sekunden)",
      dataDirectory: "Datenordner Pfad",
      language: "Sprache",
      decimalPlaces: "Dezimalstellen",
    },
  },
  'zh-TW': {
    statusBar: {
      loading: '載入中...',
      noData: '無 Claude Code 資料',
      notRunning: 'Claude Code 未執行',
      error: '錯誤',
      currentSession: '當前會話',
    },
    contextHealth: {
      title: '上下文健康度',
      windowSize: '視窗',
      composition: '上下文內容',
      topicSwitch: '話題切換點',
      growth: '成長',
      pace: '速度',
      etaToLimit: '距上限',
      topics: '話題',
      signalsTitle: '訊號',
      peak: '峰值',
      inspect: '深入查看',
      viewing: '檢視工作階段',
      backToActive: '返回當前',
      notifyRot: '上下文正在臃腫 — 建議使用 /clear 開始新話題。',
      statusHealthy: '健康',
      statusWatch: '漸趨臃腫',
      statusRot: '臃腫',
      sigNearLimit: '上下文接近模型上限',
      sigLargeToolResult: '單一工具結果佔據大量上下文',
      sigStaleContext: '多為延續的舊內容',
      sigRedundantReads: '同一檔案重複讀取',
      sigMultiTopic: '單一工作階段中有多個話題',
      sigCacheBust: '快取反覆失效（昂貴的重寫）',
      sigLargeBaseline: '啟動上下文龐大（系統提示／CLAUDE.md／工具）',
      sigFullFileReads: '未指定行範圍而讀取整個檔案',
      efficiency: 'Token 效率',
      cacheWaste: '快取浪費',
      baseline: '啟動基準量',
      reclaimable: '可回收的工具輸出',
      fullFileReadsLabel: '整檔讀取',
      recCacheBust: '避免在工作階段中途切換模型，以保持快取有效。',
      recBaseline: '精簡 CLAUDE.md（<200 行）並停用未使用的 MCP 伺服器。',
      recReclaim: '工具輸出過大——建議改用精準讀取與截斷。',
      suggestClear: '建議使用 /clear 開始新話題。',
      suggestHealthy: '上下文狀態良好。',
    },
    popup: {
      title: 'Claude Code 使用量',
      currentSession: '當前會話',
      today: '今日',
      thisMonth: '本月',
      allTime: '所有',
      refresh: '重新整理',
      settings: '設定',
      totalTokens: '總 Token 數',
      inputTokens: '輸入 Token',
      outputTokens: '輸出 Token',
      cacheCreation: '輸入快取（未命中）',
      cacheRead: '輸入快取（命中）',
      cost: '成本',
      messages: '訊息數',
      modelBreakdown: '模型使用量',
      dailyBreakdown: '每日使用量',
      monthlyBreakdown: '每月使用量',
      hourlyBreakdown: '每小時使用量',
      sessions: '會話',
      sessionBreakdown: '各會話使用量',
      project: '專案',
      startTime: '開始時間',
      duration: '時長',
      hour: '小時',
      projects: '專案',
      projectBreakdown: '各專案使用量',
      fullPath: '完整路徑',
      peakContext: '峰值上下文',
      tokenComposition: 'Token 組成',
      lastActive: '最近活動',
      pricing: '計費標準',
      refreshPricing: '更新 Token 單價',
      pricingUpdated: '價格已更新',
      pricingUpdateFailed: '價格更新失敗',
      sortHint: '點擊欄位標題可排序',
      quota: '用量額度',
      quotaWindow: '時間視窗',
      quotaLimit: '上限',
      quota5h: '5 小時',
      quotaWeekly: '每週',
      quotaHint: '來自 Anthropic /usage 的真實資料。',
      contentAnalysis: '內容分析',
      estimatedNote: '由文字長度估算 —— 相對佔比可靠,絕對數值為近似值。',
      byTool: '各工具結果用量',
      catUserPrompts: '你的提問',
      catAssistantText: '助手回覆',
      catAssistantThinking: '助手思考',
      catToolCalls: '工具呼叫',
      catToolResults: '工具結果',
      estTokens: '估算 Token',
      share: '佔比',
      resets: '重置',
      cacheHitRate: '快取命中率',
      cacheLowEfficiency: '快取效率偏低的專案（< 20%）',
      cacheEfficiencyTip: '命中率偏低通常代表檔案被重複讀取而未暖機。建議在相同工作目錄下開始會話，或將常用檔案加入 CLAUDE.md。',
      last30days: '近 30 天',
      branches: '分支',
      branchBreakdown: '各分支使用量',
      branch: '分支',
      getAdvice: '取得 AI 建議',
      adviceNeedsKey: '請先在設定中填入 API 金鑰以使用 AI 建議。',
      adviceGenerating: '正在產生使用建議…',
      adviceFailed: '取得建議失敗',
      adviceScopeOverall: '整體(所有專案)',
      adviceScopePrompt: '選擇建議要聚焦的範圍',
      adviceDemoButton: '查看示範',
      adviceDemoNotice: '',
      costComposition: '成本構成',
      date: '日期',
      yesterday: '昨日',
      dataDirectory: '資料目錄',
      noDataMessage: '找不到使用資料。請確認 Claude Code 正在執行且設定正確。',
      errorMessage: '載入使用資料時發生錯誤。請檢查您的設定。',
      activity: '活動',
      toolUsage: '工具使用',
      toolCalls: '工具呼叫',
      skillUsage: 'Skill 使用',
      subagentUsage: '子代理使用',
      count: '次數',
      errors: '錯誤',
      errorRate: '錯誤率',
      avgDuration: '平均耗時',
      skill: 'Skill',
      subagent: '子代理',
      tokensCol: 'Token',
      toolUses: '工具呼叫數',
      prompts: '提問數',
      prsCreated: '建立的 PR',
      turnOutcomes: '回合結果',
      permissionModes: '權限模式',
      codeChanges: '程式碼變更',
      filesEdited: '編輯檔案數',
      linesAdded: '新增行數',
      linesRemoved: '刪除行數',
      userModifiedRate: '你修改過的編輯',
      gitOps: 'Git 操作',
      tokenSplit: '主執行緒 vs 子代理（輸出 Token）',
      mainThread: '主執行緒',
      subagentsLabel: '子代理',
      activityHeatmap: '活動熱圖',
      heatmapHint: '依星期與時段的助手回合數',
      recentTopics: '近期會話主題',
      activityNote: '近 30 天的精確統計。',
      quotaHistory: '額度歷史',
      quotaHistoryEmpty: '尚未記錄額度歷史。資料會在擴充功能執行期間累積 —— API 僅回報目前數值,無法回補過去。',
      quotaHistoryNote: '於擴充功能執行期間記錄,粒度約數分鐘。',
      quotaUtilization: '使用率',
      quotaOpus: '每週 (Opus)',
      quotaOverTime: '使用率隨時間變化',
      quotaByHour: '依時段的 5 小時額度消耗',
      quotaByHourHint: '5 小時使用率增量的總和,依當日時段分組。',
    },
    settings: {
      title: 'Claude Code 使用量設定',
      refreshInterval: '重新整理間隔（秒）',
      dataDirectory: '資料目錄路徑',
      language: '語言',
      decimalPlaces: '小數位數',
    },
  },
  'zh-CN': {
    statusBar: {
      loading: '加载中...',
      noData: '无 Claude Code 数据',
      notRunning: 'Claude Code 未运行',
      error: '错误',
      currentSession: '当前会话',
    },
    contextHealth: {
      title: '上下文健康度',
      windowSize: '窗口',
      composition: '上下文内容',
      topicSwitch: '话题切换点',
      growth: '增长',
      pace: '速度',
      etaToLimit: '距上限',
      topics: '话题',
      signalsTitle: '信号',
      peak: '峰值',
      inspect: '深入查看',
      viewing: '查看会话',
      backToActive: '返回当前',
      notifyRot: '上下文正在臃肿 — 建议使用 /clear 开始新话题。',
      statusHealthy: '健康',
      statusWatch: '渐趋臃肿',
      statusRot: '臃肿',
      sigNearLimit: '上下文接近模型上限',
      sigLargeToolResult: '单个工具结果占据大量上下文',
      sigStaleContext: '多为延续的旧内容',
      sigRedundantReads: '同一文件重复读取',
      sigMultiTopic: '单个会话中有多个话题',
      sigCacheBust: '缓存反复失效（代价高昂的重写）',
      sigLargeBaseline: '启动上下文庞大（系统提示／CLAUDE.md／工具）',
      sigFullFileReads: '未指定行范围而读取整个文件',
      efficiency: 'Token 效率',
      cacheWaste: '缓存浪费',
      baseline: '启动基准量',
      reclaimable: '可回收的工具输出',
      fullFileReadsLabel: '整文件读取',
      recCacheBust: '避免在会话中途切换模型，以保持缓存有效。',
      recBaseline: '精简 CLAUDE.md（<200 行）并停用未使用的 MCP 服务器。',
      recReclaim: '工具输出过大——建议改用精准读取与截断。',
      suggestClear: '建议使用 /clear 开始新话题。',
      suggestHealthy: '上下文状态良好。',
    },
    popup: {
      title: 'Claude Code 使用量',
      currentSession: '当前会话',
      today: '今日',
      thisMonth: '本月',
      allTime: '所有',
      refresh: '刷新',
      settings: '设置',
      totalTokens: '总 Token 数',
      inputTokens: '输入 Token',
      outputTokens: '输出 Token',
      cacheCreation: '输入缓存（未命中）',
      cacheRead: '输入缓存（命中）',
      cost: '成本',
      messages: '消息数',
      modelBreakdown: '模型使用量',
      dailyBreakdown: '每日使用量',
      monthlyBreakdown: '每月使用量',
      hourlyBreakdown: '每小时使用量',
      sessions: '会话',
      sessionBreakdown: '各会话使用量',
      project: '项目',
      startTime: '开始时间',
      duration: '时长',
      hour: '小时',
      projects: '项目',
      projectBreakdown: '各项目使用量',
      fullPath: '完整路径',
      peakContext: '峰值上下文',
      tokenComposition: 'Token 组成',
      lastActive: '最近活动',
      pricing: '计费标准',
      refreshPricing: '更新 Token 单价',
      pricingUpdated: '价格已更新',
      pricingUpdateFailed: '价格更新失败',
      sortHint: '点击列标题可排序',
      quota: '用量额度',
      quotaWindow: '时间窗口',
      quotaLimit: '上限',
      quota5h: '5 小时',
      quotaWeekly: '每周',
      quotaHint: '来自 Anthropic /usage 的真实数据。',
      contentAnalysis: '内容分析',
      estimatedNote: '由文本长度估算 —— 相对占比可靠,绝对数值为近似值。',
      byTool: '各工具结果用量',
      catUserPrompts: '你的提问',
      catAssistantText: '助手回复',
      catAssistantThinking: '助手思考',
      catToolCalls: '工具调用',
      catToolResults: '工具结果',
      estTokens: '估算 Token',
      share: '占比',
      resets: '重置',
      cacheHitRate: '缓存命中率',
      cacheLowEfficiency: '缓存效率偏低的项目（< 20%）',
      cacheEfficiencyTip: '命中率偏低通常意味着文件被反复读取而未预热。建议在相同工作目录下启动会话，或将常用文件添加到 CLAUDE.md。',
      last30days: '近 30 天',
      branches: '分支',
      branchBreakdown: '各分支使用量',
      branch: '分支',
      getAdvice: '获取 AI 建议',
      adviceNeedsKey: '请先在设置中填入 API 密钥以使用 AI 建议。',
      adviceGenerating: '正在生成使用建议…',
      adviceFailed: '获取建议失败',
      adviceScopeOverall: '整体(所有项目)',
      adviceScopePrompt: '选择建议要聚焦的范围',
      adviceDemoButton: '查看示例',
      adviceDemoNotice: '',
      costComposition: '成本构成',
      date: '日期',
      yesterday: '昨日',
      dataDirectory: '数据目录',
      noDataMessage: '找不到使用数据。请确认 Claude Code 正在运行且配置正确。',
      errorMessage: '加载使用数据时发生错误。请检查您的配置。',
      activity: '活动',
      toolUsage: '工具使用',
      toolCalls: '工具调用',
      skillUsage: 'Skill 使用',
      subagentUsage: '子代理使用',
      count: '次数',
      errors: '错误',
      errorRate: '错误率',
      avgDuration: '平均耗时',
      skill: 'Skill',
      subagent: '子代理',
      tokensCol: 'Token',
      toolUses: '工具调用数',
      prompts: '提问数',
      prsCreated: '创建的 PR',
      turnOutcomes: '回合结果',
      permissionModes: '权限模式',
      codeChanges: '代码变更',
      filesEdited: '编辑文件数',
      linesAdded: '新增行数',
      linesRemoved: '删除行数',
      userModifiedRate: '你修改过的编辑',
      gitOps: 'Git 操作',
      tokenSplit: '主线程 vs 子代理（输出 Token）',
      mainThread: '主线程',
      subagentsLabel: '子代理',
      activityHeatmap: '活动热图',
      heatmapHint: '按星期与时段的助手回合数',
      recentTopics: '近期会话主题',
      activityNote: '近 30 天的精确统计。',
      quotaHistory: '额度历史',
      quotaHistoryEmpty: '尚未记录额度历史。数据会在扩展运行期间累积 —— API 仅返回当前数值,无法回补过去。',
      quotaHistoryNote: '于扩展运行期间记录,粒度约数分钟。',
      quotaUtilization: '使用率',
      quotaOpus: '每周 (Opus)',
      quotaOverTime: '使用率随时间变化',
      quotaByHour: '按时段的 5 小时额度消耗',
      quotaByHourHint: '5 小时使用率增量的总和,按当日时段分组。',
    },
    settings: {
      title: 'Claude Code 使用量设置',
      refreshInterval: '刷新间隔（秒）',
      dataDirectory: '数据目录路径',
      language: '语言',
      decimalPlaces: '小数位数',
    },
  },
  ja: {
    statusBar: {
      loading: '読み込み中...',
      noData: 'Claude Code データなし',
      notRunning: 'Claude Code 未実行',
      error: 'エラー',
      currentSession: '現在のセッション',
    },
    contextHealth: {
      title: 'コンテキスト健全度',
      windowSize: 'ウィンドウ',
      composition: 'コンテキストの中身',
      topicSwitch: '話題の切り替え目安',
      growth: '成長',
      pace: 'ペース',
      etaToLimit: '上限まで',
      topics: '話題',
      signalsTitle: '検知信号',
      peak: 'ピーク',
      inspect: '深掘り',
      viewing: '表示中のセッション',
      backToActive: '現在に戻る',
      notifyRot: 'コンテキストが肥大化しています — /clear で新しい話題を始めると効果的です。',
      statusHealthy: '良好',
      statusWatch: 'やや過多',
      statusRot: '肥大化',
      sigNearLimit: 'コンテキストがモデル上限に接近',
      sigLargeToolResult: '大きなツール結果がコンテキストを占有',
      sigStaleContext: '古い引き継ぎ内容が大半',
      sigRedundantReads: '同じファイルを繰り返し読み込み',
      sigCacheBust: 'キャッシュが繰り返し無効化（高コストな再書き込み）',
      sigLargeBaseline: '起動コンテキストが大きい（システムプロンプト／CLAUDE.md／ツール）',
      sigFullFileReads: '行範囲を指定せずファイル全体を読み込み',
      efficiency: 'トークン効率',
      cacheWaste: 'キャッシュ浪費',
      baseline: '起動ベースライン',
      reclaimable: '回収可能なツール出力',
      fullFileReadsLabel: 'ファイル全体の読み込み',
      recCacheBust: 'キャッシュを維持するため、セッション途中でのモデル切り替えを避けましょう。',
      recBaseline: 'CLAUDE.md を簡潔に（200行未満）、未使用の MCP サーバーを無効化しましょう。',
      recReclaim: 'ツール出力が大きすぎます——範囲指定読み込みや切り詰めを推奨します。',
      sigMultiTopic: '1セッションに複数の話題',
      suggestClear: '/clear で新しい話題を始めると効果的です。',
      suggestHealthy: 'コンテキストは良好です。',
    },
    popup: {
      title: 'Claude Code 使用量',
      currentSession: '現在のセッション',
      today: '今日',
      thisMonth: '今月',
      allTime: 'すべて',
      refresh: '更新',
      settings: '設定',
      totalTokens: '総トークン数',
      inputTokens: '入力トークン',
      outputTokens: '出力トークン',
      cacheCreation: '入力キャッシュ（ミス）',
      cacheRead: '入力キャッシュ（ヒット）',
      cost: 'コスト',
      messages: 'メッセージ数',
      modelBreakdown: 'モデル別使用量',
      dailyBreakdown: '日別使用量',
      monthlyBreakdown: '月別使用量',
      hourlyBreakdown: '時間別使用量',
      sessions: 'セッション',
      sessionBreakdown: 'セッション別使用量',
      project: 'プロジェクト',
      startTime: '開始時刻',
      duration: '期間',
      hour: '時刻',
      projects: 'プロジェクト',
      projectBreakdown: 'プロジェクト別使用量',
      fullPath: 'フルパス',
      peakContext: '最大コンテキスト',
      tokenComposition: 'トークン構成',
      lastActive: '最終アクティブ',
      pricing: '料金',
      refreshPricing: 'Token 単価を更新',
      pricingUpdated: '価格を更新しました',
      pricingUpdateFailed: '価格の更新に失敗しました',
      sortHint: '列見出しをクリックで並べ替え',
      quota: '使用枠',
      quotaWindow: '期間',
      quotaLimit: '上限',
      quota5h: '5時間',
      quotaWeekly: '週間',
      quotaHint: 'Anthropic /usage からの実データ。',
      contentAnalysis: 'コンテンツ',
      estimatedNote: 'テキスト長からの推定値 — 相対割合は信頼でき、絶対値は概算です。',
      byTool: 'ツール別の結果使用量',
      catUserPrompts: 'あなたの入力',
      catAssistantText: 'アシスタント応答',
      catAssistantThinking: 'アシスタント思考',
      catToolCalls: 'ツール呼び出し',
      catToolResults: 'ツール結果',
      estTokens: '推定トークン',
      share: '割合',
      resets: 'リセット',
      cacheHitRate: 'キャッシュヒット率',
      cacheLowEfficiency: 'キャッシュ効率が低いプロジェクト（< 20%）',
      cacheEfficiencyTip: 'ヒット率が低い場合、同じファイルをセッションごとに再読み込みしている可能性があります。同じ作業ディレクトリでセッションを継続するか、CLAUDE.md に主要ファイルを追記してみてください。',
      last30days: '過去 30 日',
      branches: 'ブランチ',
      branchBreakdown: 'ブランチ別使用量',
      branch: 'ブランチ',
      getAdvice: 'AI アドバイスを取得',
      adviceNeedsKey: '設定で API キーを入力してください。',
      adviceGenerating: '使用アドバイスを生成中…',
      adviceFailed: 'アドバイスの取得に失敗しました',
      adviceScopeOverall: '全体(全プロジェクト)',
      adviceScopePrompt: 'アドバイスの対象範囲を選択',
      adviceDemoButton: 'デモを見る',
      adviceDemoNotice: '',
      costComposition: 'コスト構成',
      date: '日付',
      yesterday: '昨日',
      dataDirectory: 'データディレクトリ',
      noDataMessage: '使用データが見つかりません。Claude Code が実行され、正しく設定されていることを確認してください。',
      errorMessage: '使用データの読み込み中にエラーが発生しました。設定を確認してください。',
      activity: 'アクティビティ',
      toolUsage: 'ツール使用',
      toolCalls: 'ツール呼び出し',
      skillUsage: 'Skill 使用',
      subagentUsage: 'サブエージェント使用',
      count: '回数',
      errors: 'エラー',
      errorRate: 'エラー率',
      avgDuration: '平均時間',
      skill: 'Skill',
      subagent: 'サブエージェント',
      tokensCol: 'トークン',
      toolUses: 'ツール呼び出し数',
      prompts: 'プロンプト数',
      prsCreated: '作成 PR 数',
      turnOutcomes: 'ターンの結果',
      permissionModes: '権限モード',
      codeChanges: 'コード変更',
      filesEdited: '編集ファイル数',
      linesAdded: '追加行数',
      linesRemoved: '削除行数',
      userModifiedRate: 'あとで手直しした編集',
      gitOps: 'Git 操作',
      tokenSplit: 'メイン vs サブエージェント（出力トークン）',
      mainThread: 'メインスレッド',
      subagentsLabel: 'サブエージェント',
      activityHeatmap: 'アクティビティ ヒートマップ',
      heatmapHint: '曜日×時間帯ごとのアシスタント ターン数',
      recentTopics: '最近のセッション トピック',
      activityNote: '過去 30 日間の正確なカウントです。',
      quotaHistory: '使用枠の履歴',
      quotaHistoryEmpty: 'まだ使用枠の履歴がありません。拡張機能の動作中に蓄積されます — API は現在値のみを返すため、過去にさかのぼって記録することはできません。',
      quotaHistoryNote: '拡張機能の動作中に記録されます。粒度は数分間隔です。',
      quotaUtilization: '使用率',
      quotaOpus: '週間 (Opus)',
      quotaOverTime: '使用率の推移',
      quotaByHour: '時間帯別の5時間枠の消費',
      quotaByHourHint: '5時間枠の使用率の増加分を、時刻（時）ごとに合計したものです。',
    },
    settings: {
      title: 'Claude Code 使用量設定',
      refreshInterval: '更新間隔（秒）',
      dataDirectory: 'データディレクトリパス',
      language: '言語',
      decimalPlaces: '小数点以下桁数',
    },
  },
  ko: {
    statusBar: {
      loading: '로딩 중...',
      noData: 'Claude Code 데이터 없음',
      notRunning: 'Claude Code 실행되지 않음',
      error: '오류',
      currentSession: '현재 세션',
    },
    contextHealth: {
      title: '컨텍스트 상태',
      windowSize: '윈도우',
      composition: '컨텍스트 구성',
      topicSwitch: '주제 전환 지점',
      growth: '증가',
      pace: '속도',
      etaToLimit: '한도까지',
      topics: '주제',
      signalsTitle: '시그널',
      peak: '최대',
      inspect: '자세히',
      viewing: '세션 보기',
      backToActive: '현재로',
      notifyRot: '컨텍스트가 비대해지고 있습니다 — /clear로 새 주제를 시작하세요.',
      statusHealthy: '양호',
      statusWatch: '점점 과다',
      statusRot: '비대',
      sigNearLimit: '컨텍스트가 모델 한도에 근접',
      sigLargeToolResult: '큰 도구 결과가 컨텍스트를 점유',
      sigStaleContext: '대부분 이어받은 오래된 내용',
      sigRedundantReads: '같은 파일을 반복해서 읽음',
      sigCacheBust: '캐시가 반복적으로 무효화됨(비용이 큰 재작성)',
      sigLargeBaseline: '시작 컨텍스트가 큼(시스템 프롬프트／CLAUDE.md／도구)',
      sigFullFileReads: '행 범위 없이 파일 전체를 읽음',
      efficiency: '토큰 효율',
      cacheWaste: '캐시 낭비',
      baseline: '시작 베이스라인',
      reclaimable: '회수 가능한 도구 출력',
      fullFileReadsLabel: '파일 전체 읽기',
      recCacheBust: '캐시를 유지하려면 세션 도중 모델 전환을 피하세요.',
      recBaseline: 'CLAUDE.md를 간결하게(200줄 미만) 하고 사용하지 않는 MCP 서버를 비활성화하세요.',
      recReclaim: '도구 출력이 너무 큽니다 — 범위 지정 읽기와 잘라내기를 권장합니다.',
      sigMultiTopic: '한 세션에 여러 주제',
      suggestClear: '/clear로 새 주제를 시작하는 것이 좋습니다.',
      suggestHealthy: '컨텍스트 상태가 양호합니다.',
    },
    popup: {
      title: 'Claude Code 사용량',
      currentSession: '현재 세션',
      today: '오늘',
      thisMonth: '이번 달',
      allTime: '전체',
      refresh: '새로고침',
      settings: '설정',
      totalTokens: '총 토큰 수',
      inputTokens: '입력 토큰',
      outputTokens: '출력 토큰',
      cacheCreation: '입력 캐시 (미스)',
      cacheRead: '입력 캐시 (히트)',
      cost: '비용',
      messages: '메시지 수',
      modelBreakdown: '모델별 사용량',
      dailyBreakdown: '일별 사용량',
      monthlyBreakdown: '월별 사용량',
      hourlyBreakdown: '시간별 사용량',
      sessions: '세션',
      sessionBreakdown: '세션별 사용량',
      project: '프로젝트',
      startTime: '시작 시간',
      duration: '사용 시간',
      hour: '시각',
      projects: '프로젝트',
      projectBreakdown: '프로젝트별 사용량',
      fullPath: '전체 경로',
      peakContext: '최대 컨텍스트',
      tokenComposition: '토큰 구성',
      lastActive: '마지막 활동',
      pricing: '요금',
      refreshPricing: '토큰 단가 업데이트',
      pricingUpdated: '가격이 업데이트됨',
      pricingUpdateFailed: '가격 업데이트 실패',
      sortHint: '열 머리글을 클릭하여 정렬',
      quota: '사용 한도',
      quotaWindow: '기간',
      quotaLimit: '한도',
      quota5h: '5시간',
      quotaWeekly: '주간',
      quotaHint: 'Anthropic /usage의 실제 데이터입니다.',
      contentAnalysis: '콘텐츠',
      estimatedNote: '텍스트 길이로 추정 — 상대 비율은 신뢰할 수 있고 절대값은 근사치입니다.',
      byTool: '도구별 결과 사용량',
      catUserPrompts: '내 입력',
      catAssistantText: '어시스턴트 응답',
      catAssistantThinking: '어시스턴트 사고',
      catToolCalls: '도구 호출',
      catToolResults: '도구 결과',
      estTokens: '추정 토큰',
      share: '비율',
      resets: '재설정',
      cacheHitRate: '캐시 적중률',
      cacheLowEfficiency: '캐시 효율이 낮은 프로젝트 (< 20%)',
      cacheEfficiencyTip: '적중률이 낮으면 세션마다 동일한 파일을 반복 읽는 경우가 많습니다. 같은 작업 디렉토리에서 세션을 유지하거나 주요 파일을 CLAUDE.md에 추가해 보세요.',
      last30days: '최근 30일',
      branches: '브랜치',
      branchBreakdown: '브랜치별 사용량',
      branch: '브랜치',
      getAdvice: 'AI 조언 받기',
      adviceNeedsKey: '설정에서 API 키를 입력하세요.',
      adviceGenerating: '사용 조언 생성 중…',
      adviceFailed: '조언을 가져오지 못했습니다',
      adviceScopeOverall: '전체(모든 프로젝트)',
      adviceScopePrompt: '조언 범위를 선택하세요',
      adviceDemoButton: '데모 보기',
      adviceDemoNotice: '',
      costComposition: '비용 구성',
      date: '날짜',
      yesterday: '어제',
      dataDirectory: '데이터 디렉토리',
      noDataMessage: '사용 데이터를 찾을 수 없습니다. Claude Code가 실행 중이고 올바르게 구성되었는지 확인하세요.',
      errorMessage: '사용 데이터를 로드하는 중 오류가 발생했습니다. 구성을 확인하세요.',
      activity: '활동',
      toolUsage: '도구 사용',
      toolCalls: '도구 호출',
      skillUsage: 'Skill 사용',
      subagentUsage: '서브에이전트 사용',
      count: '횟수',
      errors: '오류',
      errorRate: '오류율',
      avgDuration: '평균 시간',
      skill: 'Skill',
      subagent: '서브에이전트',
      tokensCol: '토큰',
      toolUses: '도구 호출 수',
      prompts: '프롬프트 수',
      prsCreated: '생성한 PR',
      turnOutcomes: '턴 결과',
      permissionModes: '권한 모드',
      codeChanges: '코드 변경',
      filesEdited: '편집한 파일 수',
      linesAdded: '추가된 줄',
      linesRemoved: '삭제된 줄',
      userModifiedRate: '직접 수정한 편집',
      gitOps: 'Git 작업',
      tokenSplit: '메인 vs 서브에이전트 (출력 토큰)',
      mainThread: '메인 스레드',
      subagentsLabel: '서브에이전트',
      activityHeatmap: '활동 히트맵',
      heatmapHint: '요일·시간대별 어시스턴트 턴 수',
      recentTopics: '최근 세션 주제',
      activityNote: '최근 30일간의 정확한 집계입니다.',
      quotaHistory: '사용 한도 기록',
      quotaHistoryEmpty: '아직 기록된 사용 한도 내역이 없습니다. 확장이 실행되는 동안 누적됩니다 — API는 현재 값만 반환하므로 과거는 소급할 수 없습니다.',
      quotaHistoryNote: '확장 실행 중에 기록되며, 단위는 수 분입니다.',
      quotaUtilization: '사용률',
      quotaOpus: '주간 (Opus)',
      quotaOverTime: '시간에 따른 사용률',
      quotaByHour: '시간대별 5시간 한도 소비',
      quotaByHourHint: '5시간 사용률 증가분을 시간대별로 합산한 값입니다.',
    },
    settings: {
      title: 'Claude Code 사용량 설정',
      refreshInterval: '새로고침 간격 (초)',
      dataDirectory: '데이터 디렉토리 경로',
      language: '언어',
      decimalPlaces: '소수점 자릿수',
    },
  },
};

export class I18n {
  private static currentLanguage: SupportedLanguage = 'en';
  private static currentDecimalPlaces: number = 2;
  private static compactNumbers: boolean = false;
  private static timezone: string = '';

  /** Locale string suitable for Intl APIs (toLocaleString, etc.). */
  static getLocale(): string {
    return this.currentLanguage;
  }

  /** IANA timezone (e.g. "Asia/Hong_Kong"), or '' to use the system zone. */
  static setTimezone(tz: string): void {
    this.timezone = typeof tz === 'string' ? tz.trim() : '';
  }

  static getTimezone(): string {
    return this.timezone;
  }

  /** Intl date-format options merged with the configured timezone (if any). */
  static dateFormatOptions(extra: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormatOptions {
    return this.timezone ? { ...extra, timeZone: this.timezone } : extra;
  }

  /** Set the number of decimal places used by formatCurrency (claudeCodeUsage.decimalPlaces). */
  static setDecimalPlaces(places: number): void {
    if (typeof places === 'number' && isFinite(places) && places >= 0 && places <= 4) {
      this.currentDecimalPlaces = Math.floor(places);
    }
  }

  /** Toggle compact number formatting, e.g. 1.2M / 345K (claudeCodeUsage.compactNumbers). */
  static setCompactNumbers(enabled: boolean): void {
    this.compactNumbers = !!enabled;
  }

  static setLanguage(lang: SupportedLanguage | 'auto'): void {
    if (lang === 'auto') {
      this.currentLanguage = this.detectLanguage();
    } else {
      this.currentLanguage = lang;
    }
  }

  static getCurrentLanguage(): SupportedLanguage {
    return this.currentLanguage;
  }

  /** Localised + English name of the current UI language, used to instruct LLMs. */
  static getLanguageName(): string {
    switch (this.currentLanguage) {
      case 'zh-CN':
        return '简体中文 (Simplified Chinese)';
      case 'zh-TW':
        return '繁體中文 (Traditional Chinese)';
      case 'ja':
        return '日本語 (Japanese)';
      case 'ko':
        return '한국어 (Korean)';
      case 'de-DE':
        return 'Deutsch (German)';
      case 'en':
      default:
        return 'English';
    }
  }

  static get t(): Translations {
    return translations[this.currentLanguage];
  }

  private static detectLanguage(): SupportedLanguage {
    const locale = process.env.LANG || process.env.LANGUAGE || 'en';

    if (locale.includes('zh')) {
      if (locale.includes('TW') || locale.includes('HK') || locale.includes('MO')) {
        return 'zh-TW';
      }
      return 'zh-CN';
    }

    if (locale.includes('ja')) return 'ja';
    if (locale.includes('ko')) return 'ko';

    return 'en';
  }

  static formatCurrency(amount: number, decimalPlaces?: number): string {
    const places = decimalPlaces != null ? decimalPlaces : this.currentDecimalPlaces;
    return `$${amount.toFixed(places)}`;
  }

  static formatNumber(num: number): string {
    if (this.compactNumbers) {
      const abs = Math.abs(num);
      if (abs >= 1_000_000_000) {
        return parseFloat((num / 1_000_000_000).toFixed(2)) + 'B';
      }
      if (abs >= 1_000_000) {
        return parseFloat((num / 1_000_000).toFixed(2)) + 'M';
      }
      if (abs >= 1_000) {
        return parseFloat((num / 1_000).toFixed(1)) + 'K';
      }
    }
    // Use the user's selected locale so the thousands separator etc. match
    // the UI language instead of the system default (addresses upstream PR #8).
    return num.toLocaleString(this.currentLanguage);
  }
}
