import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ActivityAnalysis,
  ClaudeApiUsageResponse,
  ContentAnalysis,
  ContextHealth,
  ProjectGroup,
  SessionUsage,
  UsageData,
} from './types';

// Writes a machine-readable snapshot of the computed analysis to
// ~/.claude/cc-monitor/insights/latest.json so the cc-monitor Claude Code
// skills (/cc-usage-advice, /cc-session-review, …) can reuse the extension's
// aggregates instead of re-parsing the raw logs themselves.
// Local file only — nothing is transmitted anywhere.

const SCHEMA_VERSION = 1;
const MAX_SESSIONS = 20;
const MAX_PROJECTS = 20;
const MAX_TOOL_SLICES = 15;

export interface InsightsInput {
  generator: string;
  dataDirectory: string;
  today: UsageData | null;
  thisMonth: UsageData | null;
  allTime: UsageData | null;
  sessions: SessionUsage[];
  projects: ProjectGroup[];
  activity: ActivityAnalysis | null;
  content: ContentAnalysis | null;
  contextHealth: ContextHealth | null;
  quotaLatest: ClaudeApiUsageResponse | null;
}

export class InsightsExporter {
  static getInsightsFilePath(): string {
    return path.join(os.homedir(), '.claude', 'cc-monitor', 'insights', 'latest.json');
  }

  /** Build the snapshot and write it atomically (tmp file + rename). */
  static async write(input: InsightsInput): Promise<void> {
    const compactUsage = (d: UsageData | null) =>
      d === null
        ? null
        : {
            totalCost: d.totalCost,
            inputTokens: d.totalInputTokens,
            outputTokens: d.totalOutputTokens,
            cacheCreationTokens: d.totalCacheCreationTokens,
            cacheReadTokens: d.totalCacheReadTokens,
            messageCount: d.messageCount,
            costBreakdown: d.costBreakdown,
            modelBreakdown: d.modelBreakdown,
          };

    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      generator: input.generator,
      dataDirectory: input.dataDirectory,
      today: compactUsage(input.today),
      thisMonth: compactUsage(input.thisMonth),
      allTime: compactUsage(input.allTime),
      // Most recently active conversations, newest first.
      sessions: input.sessions.slice(0, MAX_SESSIONS).map((s) => ({
        sessionId: s.sessionId,
        projectName: s.projectName,
        projectPath: s.projectPath,
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        peakContextTokens: s.peakContextTokens,
        totalCost: s.data.totalCost,
        messageCount: s.data.messageCount,
        inputTokens: s.data.totalInputTokens,
        outputTokens: s.data.totalOutputTokens,
        cacheReadTokens: s.data.totalCacheReadTokens,
        cacheCreationTokens: s.data.totalCacheCreationTokens,
      })),
      projects: input.projects.slice(0, MAX_PROJECTS).map((g) => ({
        groupName: g.groupName,
        groupPath: g.groupPath,
        isGitRepo: g.isGitRepo,
        sessionCount: g.sessionCount,
        firstSeen: g.firstSeen.toISOString(),
        lastSeen: g.lastSeen.toISOString(),
        totalCost: g.data.totalCost,
        messageCount: g.data.messageCount,
        cacheReadTokens: g.data.totalCacheReadTokens,
        cacheCreationTokens: g.data.totalCacheCreationTokens,
      })),
      // Exact counts over the analysis window (tools, skills, subagents, …).
      activity: input.activity,
      // Estimated token composition. recentPrompts is intentionally excluded:
      // the snapshot must not duplicate conversation text.
      content: input.content
        ? {
            categories: input.content.categories,
            toolResultBreakdown: input.content.toolResultBreakdown.slice(0, MAX_TOOL_SLICES),
            totalEstimatedTokens: input.content.totalEstimatedTokens,
          }
        : null,
      contextHealth: input.contextHealth,
      quotaLatest: input.quotaLatest,
    };

    const file = this.getInsightsFilePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 1), 'utf-8');
    await fs.promises.rename(tmp, file);
  }
}
