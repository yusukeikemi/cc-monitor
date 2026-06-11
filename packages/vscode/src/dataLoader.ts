import * as fs from 'fs';
import { readFile } from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
// Removed tinyglobby dependency - using native fs instead
// Removed zod dependency - using native validation instead
import { calculateCostBreakdown, getModelContextLimit, getModelPricing } from './pricing';
import {
  ActivityAnalysis,
  BranchUsage,
  CacheBustEvent,
  ClaudeUsageRecord,
  ContentAnalysis,
  ContentSlice,
  ContextHealth,
  ContextRotSignal,
  ProjectGroup,
  ProjectUsage,
  SessionData,
  SessionUsage,
  UsageData,
} from './types';

// Constants
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLAUDE_PROJECTS_DIR_NAME = 'projects';
const DEFAULT_CLAUDE_CODE_PATH = '.claude';
const USAGE_DATA_GLOB_PATTERN = '**/*.jsonl';
const USER_HOME_DIR = os.homedir();

// XDG config directory
const XDG_CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(USER_HOME_DIR, '.config');
const DEFAULT_CLAUDE_CONFIG_PATH = path.join(XDG_CONFIG_DIR, 'claude');

// Native file search function to replace tinyglobby
async function findJsonlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function searchRecursively(currentDir: string) {
    try {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await searchRecursively(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore permission errors and continue
      console.warn(`Cannot read directory ${currentDir}:`, error);
    }
  }

  await searchRecursively(dir);
  return files;
}

// Native validation function to replace zod
function validateUsageRecord(data: any): data is ClaudeUsageRecord {
  // Basic structure validation
  if (!data || typeof data !== 'object') return false;

  // Required timestamp
  if (typeof data.timestamp !== 'string') return false;

  // Required message with usage
  if (!data.message || typeof data.message !== 'object') return false;
  if (!data.message.usage || typeof data.message.usage !== 'object') return false;

  const usage = data.message.usage;

  // Required token fields must be numbers
  if (typeof usage.input_tokens !== 'number') return false;
  if (typeof usage.output_tokens !== 'number') return false;

  // Optional fields validation
  if (usage.cache_creation_input_tokens !== undefined && typeof usage.cache_creation_input_tokens !== 'number') return false;
  if (usage.cache_read_input_tokens !== undefined && typeof usage.cache_read_input_tokens !== 'number') return false;

  // Optional fields validation
  if (data.message.model !== undefined && typeof data.message.model !== 'string') return false;
  if (data.message.id !== undefined && typeof data.message.id !== 'string') return false;
  if (data.costUSD !== undefined && typeof data.costUSD !== 'number') return false;
  if (data.requestId !== undefined && typeof data.requestId !== 'string') return false;
  if (data.isApiErrorMessage !== undefined && typeof data.isApiErrorMessage !== 'boolean') return false;

  return true;
}

// --- Content-consumption analysis helpers ---
// These estimate which conversation content uses tokens. Token figures are
// derived from character counts, so they are approximate; the relative shares
// between categories are the dependable signal.

interface AnalysisBucket {
  tokens: number;
  chars: number;
  count: number;
}

// Per-tool activity counters (distinct from the token-estimate `tools` bucket).
interface ToolActivity {
  count: number;
  errors: number;
  totalDurationMs: number;
  durationSamples: number;
}

interface SubagentActivity {
  count: number;
  totalTokens: number;
  totalDurationMs: number;
  totalToolUseCount: number;
}

interface AnalysisAcc {
  cat: Record<string, AnalysisBucket>;
  tools: Record<string, AnalysisBucket>;
  toolIdToName: Record<string, string>;
  seenUuids: Set<string>;
  cutoffMs: number;
  // --- activity accumulators ---
  toolActivity: Record<string, ToolActivity>;
  skills: Record<string, number>;
  subagents: Record<string, SubagentActivity>;
  stopReasons: Record<string, number>;
  permissionModes: Record<string, number>;
  promptIds: Set<string>;
  loosePromptCount: number;
  prUrls: Set<string>;
  filesEditedCount: number;
  linesAdded: number;
  linesRemoved: number;
  userModifiedCount: number;
  editResultCount: number;
  gitOperations: number;
  mainOutputTokens: number;
  sidechainOutputTokens: number;
  assistantTurns: number; // billable main-thread assistant turns
  thinkingBlocks: number; // thinking blocks seen (text may be redacted/empty)
  heatmap: number[][];
  titlesBySession: Map<string, string>;
  windowDays: number;
}

// cutoffMs: ignore log lines older than this (0 = no cutoff).
function newAnalysisAcc(cutoffMs: number, windowDays: number): AnalysisAcc {
  return {
    cat: {},
    tools: {},
    toolIdToName: {},
    seenUuids: new Set<string>(),
    cutoffMs,
    toolActivity: {},
    skills: {},
    subagents: {},
    stopReasons: {},
    permissionModes: {},
    promptIds: new Set<string>(),
    loosePromptCount: 0,
    prUrls: new Set<string>(),
    filesEditedCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    userModifiedCount: 0,
    editResultCount: 0,
    gitOperations: 0,
    mainOutputTokens: 0,
    sidechainOutputTokens: 0,
    assistantTurns: 0,
    thinkingBlocks: 0,
    heatmap: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
    titlesBySession: new Map<string, string>(),
    windowDays,
  };
}

// Rough token estimate from text length (CJK characters are denser than ASCII).
function estimateTokens(text: string): number {
  const len = text.length;
  if (len === 0) {
    return 0;
  }
  if (len > 200000) {
    return Math.round(len / 4);
  }
  let cjk = 0;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x3000 && code <= 0x9fff) {
      cjk++;
    }
  }
  return Math.round(cjk / 1.5 + (len - cjk) / 4);
}

// Human-readable label for a user prompt. Slash-command invocations are logged
// wrapped in harness XML (<command-name>…, <command-message>…, local command
// output in <local-command-stdout>…) — show the command name instead of the
// raw markup, and strip the other harness tags from ordinary prompts.
function promptLabel(text: string): string {
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd && cmd[1].trim()) {
    return cmd[1].trim();
  }
  return text
    .replace(/<\/?(?:command-name|command-message|command-args|command-contents|local-command-stdout|local-command-caveat|system-reminder)>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Flatten a content value (string, or array of blocks) to plain text.
function blockText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    let text = '';
    for (const block of content) {
      if (typeof block === 'string') {
        text += block;
      } else if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        text += (block as { text: string }).text;
      }
    }
    return text;
  }
  return '';
}

// Rough estimate of the tokens a single message contributes (text + thinking +
// tool calls + tool results), for per-topic sizing in the Context Health view.
function estimateMessageTokens(message: any): number {
  const content = message?.content;
  if (typeof content === 'string') {
    return estimateTokens(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== 'object') {
      continue;
    }
    if (typeof b.text === 'string') {
      n += estimateTokens(b.text);
    } else if (typeof b.thinking === 'string') {
      n += estimateTokens(b.thinking);
    } else if (b.type === 'tool_result') {
      n += estimateTokens(blockText(b.content));
    } else if (b.type === 'tool_use') {
      n += estimateTokens(JSON.stringify(b.input || {}));
    }
  }
  return n;
}

function addToBucket(map: Record<string, AnalysisBucket>, key: string, text: string): void {
  if (!text) {
    return;
  }
  if (!map[key]) {
    map[key] = { tokens: 0, chars: 0, count: 0 };
  }
  map[key].tokens += estimateTokens(text);
  map[key].chars += text.length;
  map[key].count += 1;
}

const numOr0 = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

function bumpTool(acc: AnalysisAcc, name: string): ToolActivity {
  let t = acc.toolActivity[name];
  if (!t) {
    t = { count: 0, errors: 0, totalDurationMs: 0, durationSamples: 0 };
    acc.toolActivity[name] = t;
  }
  return t;
}

// Pull a human-readable skill name out of a Skill tool_use's input.
function skillNameFromInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['skill', 'command', 'name']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim() !== '') {
        return v.trim();
      }
    }
  }
  return 'unknown';
}

// Build a stable key identifying a tool call by its primary argument, so that
// identical repeated calls (a loop) collapse to the same key. Keyed by the
// tool name plus the salient input (command / pattern / path). Returns '' when
// there's no meaningful argument to key on.
function repeatedCallKey(name: string, input: Record<string, unknown>): string {
  const pick = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  let arg = '';
  switch (name) {
    case 'Bash':
      arg = pick('command');
      break;
    case 'Grep':
    case 'Glob':
      arg = pick('pattern');
      break;
    default:
      arg = pick('file_path') || pick('path') || pick('query') || pick('prompt');
      if (!arg) {
        try {
          arg = JSON.stringify(input).slice(0, 200);
        } catch {
          arg = '';
        }
      }
  }
  arg = arg.trim();
  return arg ? name + ' ' + arg : '';
}

// Count added/removed lines from an Edit result's structured patch.
function tallyPatch(acc: AnalysisAcc, patch: unknown): void {
  if (!Array.isArray(patch)) {
    return;
  }
  for (const hunk of patch) {
    const lines = hunk && typeof hunk === 'object' ? (hunk as { lines?: unknown }).lines : null;
    if (!Array.isArray(lines)) {
      continue;
    }
    for (const line of lines) {
      if (typeof line !== 'string') {
        continue;
      }
      if (line.startsWith('+')) {
        acc.linesAdded++;
      } else if (line.startsWith('-')) {
        acc.linesRemoved++;
      }
    }
  }
}

// Fold the top-level `toolUseResult` of a user record into the activity stats:
// subagent cost, git operations and code-change figures.
function analyzeToolUseResult(acc: AnalysisAcc, tur: any, toolName: string | null): void {
  if (!tur || typeof tur !== 'object') {
    return;
  }
  // Subagent (Task/Agent) — the result carries the agent's own usage.
  if (typeof tur.agentType === 'string') {
    let s = acc.subagents[tur.agentType];
    if (!s) {
      s = { count: 0, totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0 };
      acc.subagents[tur.agentType] = s;
    }
    s.count++;
    s.totalTokens += numOr0(tur.totalTokens);
    s.totalDurationMs += numOr0(tur.totalDurationMs);
    s.totalToolUseCount += numOr0(tur.totalToolUseCount);
  }
  if (tur.gitOperation) {
    acc.gitOperations++;
  }
  // Per-tool duration sample, when the tool reported timing.
  if (typeof tur.durationMs === 'number' && toolName) {
    const t = bumpTool(acc, toolName);
    t.totalDurationMs += tur.durationMs;
    t.durationSamples++;
  }
  // Code changes: edits carry a structured patch; writes carry full content.
  if (Array.isArray(tur.structuredPatch)) {
    acc.editResultCount++;
    acc.filesEditedCount++;
    if (tur.userModified) {
      acc.userModifiedCount++;
    }
    tallyPatch(acc, tur.structuredPatch);
  } else if (typeof tur.filePath === 'string' && typeof tur.content === 'string' && tur.oldString === undefined) {
    acc.filesEditedCount++;
    acc.linesAdded += tur.content.split('\n').length;
  }
}

// Accumulate one raw log line into the content + activity analysis.
function analyzeLine(parsed: any, acc: AnalysisAcc): void {
  if (!parsed || typeof parsed !== 'object') {
    return;
  }
  // Scope the analysis to a recent window so it reflects current habits.
  const tsMs = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
  if (acc.cutoffMs > 0 && !isNaN(tsMs) && tsMs < acc.cutoffMs) {
    return;
  }
  const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null;
  if (uuid) {
    if (acc.seenUuids.has(uuid)) {
      return;
    }
    acc.seenUuids.add(uuid);
  }

  // Standalone log events (no message payload).
  const ptype = typeof parsed.type === 'string' ? parsed.type : '';
  if (ptype === 'pr-link') {
    const url = typeof parsed.prUrl === 'string' ? parsed.prUrl : '';
    if (url) {
      acc.prUrls.add(url);
    }
    return;
  }
  if (ptype === 'ai-title') {
    const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
    const title = typeof parsed.aiTitle === 'string' ? parsed.aiTitle : '';
    if (sid && title) {
      // Re-insert so the most recently updated title sorts last (newest).
      acc.titlesBySession.delete(sid);
      acc.titlesBySession.set(sid, title);
    }
    return;
  }

  const message = parsed.message;
  if (!message || typeof message !== 'object') {
    return;
  }
  const role = message.role || parsed.type;
  const content = message.content;

  if (role === 'assistant') {
    // Turn outcome and main/subagent output-token split.
    if (typeof message.stop_reason === 'string') {
      acc.stopReasons[message.stop_reason] = (acc.stopReasons[message.stop_reason] || 0) + 1;
    }
    const usage = message.usage;
    if (usage && typeof usage.output_tokens === 'number') {
      if (parsed.isSidechain) {
        acc.sidechainOutputTokens += usage.output_tokens;
      } else {
        acc.mainOutputTokens += usage.output_tokens;
        acc.assistantTurns++;
      }
    }
    // Activity heatmap: one assistant turn per local weekday/hour cell.
    if (!isNaN(tsMs)) {
      const d = new Date(tsMs);
      acc.heatmap[d.getDay()][d.getHours()]++;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          addToBucket(acc.cat, 'assistantText', block.text);
        } else if (block.type === 'thinking') {
          acc.thinkingBlocks++;
          if (typeof block.thinking === 'string') {
            addToBucket(acc.cat, 'assistantThinking', block.thinking);
          }
        } else if (block.type === 'tool_use') {
          if (typeof block.id === 'string' && typeof block.name === 'string') {
            acc.toolIdToName[block.id] = block.name;
          }
          addToBucket(acc.cat, 'toolCalls', JSON.stringify(block.input || {}));
          if (typeof block.name === 'string') {
            bumpTool(acc, block.name).count++;
            if (block.name === 'Skill') {
              const sk = skillNameFromInput(block.input);
              acc.skills[sk] = (acc.skills[sk] || 0) + 1;
            }
          }
        }
      }
    } else if (typeof content === 'string') {
      addToBucket(acc.cat, 'assistantText', content);
    }
  } else if (role === 'user') {
    const isMeta = parsed.isMeta === true;
    // Meta messages are harness-injected (skill bodies, command expansions) —
    // they fill the window like a prompt but the user never typed them, so
    // they get their own composition bucket and stay out of the prompt feed.
    const textBucket = isMeta ? 'injectedContext' : 'userPrompts';
    let hasRealText = false;
    let recordToolName: string | null = null;

    if (typeof content === 'string') {
      addToBucket(acc.cat, textBucket, content);
      if (content.trim().length >= 4) {
        hasRealText = true;
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        if (block.type === 'tool_result') {
          const text = blockText(block.content);
          addToBucket(acc.cat, 'toolResults', text);
          const toolName = acc.toolIdToName[block.tool_use_id] || 'unknown';
          addToBucket(acc.tools, toolName, text);
          recordToolName = toolName;
          if (block.is_error) {
            bumpTool(acc, toolName).errors++;
          }
        } else if (block.type === 'text' && typeof block.text === 'string') {
          addToBucket(acc.cat, textBucket, block.text);
          if (block.text.trim().length >= 4) {
            hasRealText = true;
          }
        }
      }
    }

    // Count a real, human-authored prompt once, and the mode it ran under.
    if (!isMeta && hasRealText) {
      const promptId = typeof parsed.promptId === 'string' ? parsed.promptId : '';
      if (promptId) {
        acc.promptIds.add(promptId);
      } else {
        acc.loosePromptCount++;
      }
      if (typeof parsed.permissionMode === 'string') {
        acc.permissionModes[parsed.permissionMode] = (acc.permissionModes[parsed.permissionMode] || 0) + 1;
      }
    }

    analyzeToolUseResult(acc, parsed.toolUseResult, recordToolName);
  }
}

function finalizeAnalysis(acc: AnalysisAcc): ContentAnalysis {
  const toSlices = (map: Record<string, AnalysisBucket>): ContentSlice[] =>
    Object.keys(map)
      .map((key) => ({ key, estimatedTokens: map[key].tokens, charCount: map[key].chars, count: map[key].count }))
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

  const categories = toSlices(acc.cat);
  return {
    categories,
    toolResultBreakdown: toSlices(acc.tools),
    totalEstimatedTokens: categories.reduce((sum, c) => sum + c.estimatedTokens, 0),
  };
}

function finalizeActivity(acc: AnalysisAcc): ActivityAnalysis {
  const tools = Object.entries(acc.toolActivity)
    .map(([name, t]) => ({
      name,
      count: t.count,
      errors: t.errors,
      totalDurationMs: t.totalDurationMs,
      durationSamples: t.durationSamples,
    }))
    .sort((a, b) => b.count - a.count);

  const skills = Object.entries(acc.skills)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const subagents = Object.entries(acc.subagents)
    .map(([agentType, s]) => ({ agentType, ...s }))
    .sort((a, b) => b.count - a.count);

  const labeled = (rec: Record<string, number>) =>
    Object.entries(rec)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

  const recentTitles = Array.from(acc.titlesBySession.entries())
    .slice(-30)
    .reverse()
    .map(([sessionId, title]) => ({ sessionId, title }));

  return {
    windowDays: acc.windowDays,
    totalToolCalls: tools.reduce((sum, t) => sum + t.count, 0),
    toolErrors: tools.reduce((sum, t) => sum + t.errors, 0),
    tools,
    skills,
    subagents,
    promptCount: acc.promptIds.size + acc.loosePromptCount,
    prCount: acc.prUrls.size,
    stopReasons: labeled(acc.stopReasons),
    permissionModes: labeled(acc.permissionModes),
    filesEditedCount: acc.filesEditedCount,
    linesAdded: acc.linesAdded,
    linesRemoved: acc.linesRemoved,
    userModifiedCount: acc.userModifiedCount,
    editResultCount: acc.editResultCount,
    gitOperations: acc.gitOperations,
    mainOutputTokens: acc.mainOutputTokens,
    sidechainOutputTokens: acc.sidechainOutputTokens,
    assistantTurns: acc.assistantTurns,
    thinkingTokensEst: acc.cat['assistantThinking']?.tokens || 0,
    assistantTextTokensEst: acc.cat['assistantText']?.tokens || 0,
    thinkingBlocksSeen: acc.thinkingBlocks,
    heatmap: acc.heatmap,
    recentTitles,
  };
}

export class ClaudeDataLoader {
  static getClaudePaths(): string[] {
    const paths: string[] = [];
    const normalizedPaths = new Set<string>();

    // Check environment variable first (supports comma-separated paths)
    const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
    if (envPaths !== '') {
      const envPathList = envPaths
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
      for (const envPath of envPathList) {
        const normalizedPath = path.resolve(envPath);
        if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isDirectory()) {
          const projectsPath = path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME);
          if (fs.existsSync(projectsPath) && fs.statSync(projectsPath).isDirectory()) {
            if (!normalizedPaths.has(normalizedPath)) {
              normalizedPaths.add(normalizedPath);
              paths.push(normalizedPath);
            }
          }
        }
      }
    }

    // Add default paths if they exist
    const defaultPaths = [DEFAULT_CLAUDE_CONFIG_PATH, path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH)];

    for (const defaultPath of defaultPaths) {
      const normalizedPath = path.resolve(defaultPath);
      if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isDirectory()) {
        const projectsPath = path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME);
        if (fs.existsSync(projectsPath) && fs.statSync(projectsPath).isDirectory()) {
          if (!normalizedPaths.has(normalizedPath)) {
            normalizedPaths.add(normalizedPath);
            paths.push(normalizedPath);
          }
        }
      }
    }

    return paths;
  }

  static async findClaudeDataDirectory(customPath?: string): Promise<string | null> {
    if (customPath) {
      const projectsPath = path.join(customPath, CLAUDE_PROJECTS_DIR_NAME);
      if (fs.existsSync(projectsPath) && fs.statSync(projectsPath).isDirectory()) {
        return customPath;
      }
      return null;
    }

    const claudePaths = this.getClaudePaths();
    return claudePaths.length > 0 ? claudePaths[0] : null;
  }

  static async loadUsageRecords(
    dataDirectory?: string,
    options?: { analyzeContent?: boolean }
  ): Promise<{ records: ClaudeUsageRecord[]; contentAnalysis: ContentAnalysis | null; activityAnalysis: ActivityAnalysis | null }> {
    const analyzeContent = options?.analyzeContent !== false; // default true
    try {
      const claudePaths = dataDirectory ? [dataDirectory] : this.getClaudePaths();
      const allFiles: string[] = [];

      for (const claudePath of claudePaths) {
        const claudeDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
        if (fs.existsSync(claudeDir)) {
          const files = await findJsonlFiles(claudeDir);
          allFiles.push(...files);
        }
      }

      const sortedFiles = await this.sortFilesByTimestamp(allFiles);
      const processedHashes = new Set<string>();
      const records: ClaudeUsageRecord[] = [];
      // Content analysis (last 30 days) is optional — skipped when the user
      // disables it via claudeCodeUsage.enableContentAnalysis.
      const analysis = analyzeContent ? newAnalysisAcc(Date.now() - 30 * 24 * 60 * 60 * 1000, 30) : null;
      let fileIndex = 0;

      for (const file of sortedFiles) {
        try {
          const content = await readFile(file, 'utf-8');
          const lines = content
            .trim()
            .split('\n')
            .filter((line) => line.trim() !== '');

          // Each .jsonl file is one Claude Code conversation/session.
          const sessionInfo = this.parseSessionInfo(file);

          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as unknown;

              // Feed every line into the content analysis (not only usage records).
              if (analysis) {
                analyzeLine(parsed, analysis);
              }

              if (!validateUsageRecord(parsed)) {
                continue;
              }

              const data = parsed;
              const uniqueHash = this.createUniqueHash(data);

              if (uniqueHash && processedHashes.has(uniqueHash)) {
                continue;
              }

              if (uniqueHash) {
                processedHashes.add(uniqueHash);
              }

              // Tag the record with the session/project it came from.
              // Prefer the real working directory (`cwd`) recorded in the log line
              // over the lossy, dash-encoded folder name when it is available.
              const record = data as ClaudeUsageRecord;
              record._sessionId = sessionInfo.sessionId;
              record._logDir = sessionInfo.projectPath;
              const cwd = (parsed as { cwd?: unknown }).cwd;
              if (typeof cwd === 'string' && cwd.trim() !== '') {
                record._projectPath = cwd;
                record._projectName = this.lastPathSegment(cwd);
              } else {
                record._projectPath = sessionInfo.projectPath;
                record._projectName = sessionInfo.projectName;
              }
              const gitBranch = (parsed as { gitBranch?: unknown }).gitBranch;
              record._gitBranch = typeof gitBranch === 'string' && gitBranch.trim() !== '' ? gitBranch : undefined;
              records.push(record);
            } catch (parseError) {
              console.warn(`Failed to parse line in ${file}:`, parseError);
            }
          }
        } catch (fileError) {
          console.warn(`Failed to read file ${file}:`, fileError);
        }

        // Yield to the event loop every so often so a large history does not
        // block the extension host (keeps VS Code and Claude Code responsive).
        if (++fileIndex % 25 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      return {
        records,
        contentAnalysis: analysis ? finalizeAnalysis(analysis) : null,
        activityAnalysis: analysis ? finalizeActivity(analysis) : null,
      };
    } catch (error) {
      console.error('Error loading usage records:', error);
      return { records: [], contentAnalysis: null, activityAnalysis: null };
    }
  }

  private static createUniqueHash(data: any): string | null {
    const messageId = data.message?.id;
    const requestId = data.requestId;

    if (!messageId && !requestId) {
      return null;
    }

    return `${messageId || 'no-msg'}-${requestId || 'no-req'}`;
  }

  /**
   * Derive session + project info from a usage log file path.
   * Claude Code stores logs as: <claudeDir>/projects/<encoded-cwd>/<session-id>.jsonl
   * The encoded-cwd folder is the working directory with path separators replaced by '-'.
   */
  private static parseSessionInfo(filePath: string): { sessionId: string; projectName: string; projectPath: string } {
    const sessionId = path.basename(filePath, '.jsonl');
    const projectPath = path.basename(path.dirname(filePath));
    // Use the last meaningful segment of the encoded path as a friendly project name.
    const segments = projectPath.split('-').filter((s) => s.length > 0);
    const projectName = segments.length > 0 ? segments[segments.length - 1] : projectPath || 'unknown';
    return { sessionId, projectName, projectPath };
  }

  /** Last segment of a path, handling both '/' and '\\' separators. */
  private static lastPathSegment(p: string): string {
    const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : p;
  }

  /**
   * Context-window size for a single request: every token on the input side
   * (fresh input + cache reads + cache writes). Mirrors what Claude Code's
   * /context command summarises.
   */
  private static recordContextTokens(record: ClaudeUsageRecord): number {
    const usage = record.message.usage;
    return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  }

  /**
   * Live "Context Health" for the currently-active session (the conversation
   * holding the most recent record). Re-reads that single .jsonl and derives,
   * with offline heuristics only, how full the context window is, what is
   * filling it, and whether it shows signs of "context rot". Returns null when
   * there is no active session or its file can't be read.
   */
  static async getContextHealth(
    records: ClaudeUsageRecord[],
    dataDirectory: string,
    sessionId?: string
  ): Promise<ContextHealth | null> {
    if (!records || records.length === 0) {
      return null;
    }

    // Target a specific session when asked (Sessions-tab drill-down); otherwise
    // the active session = the one holding the most recent record.
    const pool = sessionId ? records.filter((r) => r._sessionId === sessionId) : records;
    if (pool.length === 0) {
      return null;
    }
    let latest: ClaudeUsageRecord | null = null;
    let latestMs = -Infinity;
    // Earliest record too: its _projectName is what the Sessions tab shows for
    // this session (the cwd can drift mid-session, e.g. into a subfolder).
    let first: ClaudeUsageRecord | null = null;
    let firstMs = Infinity;
    for (const r of pool) {
      const ms = new Date(r.timestamp).getTime();
      if (!isNaN(ms) && ms > latestMs) {
        latestMs = ms;
        latest = r;
      }
      if (!isNaN(ms) && ms < firstMs) {
        firstMs = ms;
        first = r;
      }
    }
    // The on-disk folder is the encoded _logDir; _projectPath holds the real
    // cwd and would produce an invalid path under projects/.
    const logDir = latest ? latest._logDir || latest._projectPath : undefined;
    if (!latest || !latest._sessionId || !logDir) {
      return null;
    }

    const filePath = path.join(dataDirectory, CLAUDE_PROJECTS_DIR_NAME, logDir, `${latest._sessionId}.jsonl`);
    let fileContent: string;
    try {
      fileContent = await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const TOPIC_GAP_MIN = 45;
    const acc = newAnalysisAcc(0, 0); // analyse the whole session (no time cutoff)
    let contextTokens = 0; // window size of the most recent assistant request
    let peakContextTokens = 0;
    let model = latest.message.model || '';
    let lastAssistantMs = -Infinity;
    const readCounts: Record<string, number> = {};
    // Per-assistant-turn cache usage (time-ordered) for cache-bust detection
    // and the per-turn session-cost estimate.
    const turns: { ts: number; read: number; create: number; input: number; output: number; model: string }[] = [];
    let sumRead = 0, sumCreate = 0, sumInput = 0, sumOutput = 0; // session totals (cache hit rate, in:out ratio)
    const toolResultSizes: number[] = []; // estimated tokens of each individual tool_result
    const toolResultEvents: { ts: number; tokens: number }[] = []; // timed, for the masking what-if
    let errorToolResultTokens = 0; // tokens spent on tool calls that errored (waste accounting)
    let fullFileReads = 0; // Read calls with no offset/limit (whole-file dumps)
    let currentCtx = 0; // running context size (latest assistant turn so far)
    const toolEvents: { ctx: number; error: boolean }[] = []; // per tool_result, for #4
    const callCounts: Record<string, number> = {}; // identical non-Read tool calls, for #7
    const ctxSeries: { ts: number; ctx: number }[] = []; // context size per assistant turn
    const lineEst: { ts: number; est: number }[] = []; // per-message token estimate (any role)
    const promptTexts: { ts: number; text: string }[] = []; // real user prompts (for topics)
    let largestUserPromptTokens = 0; // biggest single prompt (paste detection)

    for (const line of fileContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // Reuse the shared analyser for per-category composition + tool-result sizes.
      analyzeLine(parsed, acc);

      const message = parsed.message;
      if (!message || typeof message !== 'object') {
        continue;
      }
      const role = message.role || parsed.type;
      const tsMs = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;

      if (!isNaN(tsMs)) {
        const est = estimateMessageTokens(message);
        if (est > 0) {
          lineEst.push({ ts: tsMs, est });
        }
      }

      // Size each individual tool_result (for reclaimable-output detection).
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && block.type === 'tool_result') {
            const sz = estimateTokens(blockText(block.content));
            if (sz > 0) {
              toolResultSizes.push(sz);
              if (!isNaN(tsMs)) {
                toolResultEvents.push({ ts: tsMs, tokens: sz });
              }
              if (block.is_error === true) {
                errorToolResultTokens += sz;
              }
            }
            toolEvents.push({ ctx: currentCtx, error: block.is_error === true });
          }
        }
      }

      if (role === 'assistant' && message.usage) {
        const ctx = this.recordContextTokens({ message } as ClaudeUsageRecord);
        // Skip synthetic/error records (mirrors calculateUsageData): they carry
        // zero usage and would otherwise become the "latest" window state.
        if (message.model === '<synthetic>' || parsed.isApiErrorMessage === true || ctx === 0) {
          continue;
        }
        peakContextTokens = Math.max(peakContextTokens, ctx);
        currentCtx = ctx;
        const u = message.usage;
        const read = u.cache_read_input_tokens || 0;
        const create = u.cache_creation_input_tokens || 0;
        const inp = u.input_tokens || 0;
        const out = u.output_tokens || 0;
        sumRead += read;
        sumCreate += create;
        sumInput += inp;
        sumOutput += out;
        if (!isNaN(tsMs)) {
          ctxSeries.push({ ts: tsMs, ctx });
          turns.push({ ts: tsMs, read, create, input: inp, output: out, model: typeof message.model === 'string' ? message.model : model });
        }
        if (!isNaN(tsMs) && tsMs >= lastAssistantMs) {
          lastAssistantMs = tsMs;
          contextTokens = ctx;
          if (typeof message.model === 'string') {
            model = message.model;
          }
        }
        // Count Read file paths (redundant reads) and identical non-Read calls
        // (looping / snowball detection).
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') {
              continue;
            }
            const inp2 = block.input && typeof block.input === 'object' ? block.input : {};
            if (block.name === 'Read') {
              const fp = typeof inp2.file_path === 'string' ? inp2.file_path : '';
              if (fp) {
                readCounts[fp] = (readCounts[fp] || 0) + 1;
              }
              // A Read with neither offset nor limit dumps the entire file.
              if (inp2.offset == null && inp2.limit == null) {
                fullFileReads++;
              }
            } else {
              const key = repeatedCallKey(block.name, inp2);
              if (key) {
                callCounts[key] = (callCounts[key] || 0) + 1;
              }
            }
          }
        }
      } else if (role === 'user' && !isNaN(tsMs)) {
        const c = message.content;
        let pText = '';
        let fullText = '';
        if (typeof c === 'string') {
          pText = c;
          fullText = c;
        } else if (Array.isArray(c)) {
          const tb = c.find((b: any) => b && b.type === 'text' && typeof b.text === 'string');
          pText = tb ? tb.text : '';
          // All text blocks together = what the message actually adds to the
          // window (tool_result blocks are counted separately).
          for (const b of c) {
            if (b && b.type === 'text' && typeof b.text === 'string') {
              fullText += b.text;
            }
          }
        }
        // Track meta messages too: harness-injected content (skill bodies,
        // command expansions) fills the window just like a paste does.
        largestUserPromptTokens = Math.max(largestUserPromptTokens, estimateTokens(fullText));
        // Real, human-authored prompts only (topic-gap detection + topic labels).
        if (parsed.isMeta !== true) {
          const label = promptLabel(pText);
          if (label.length >= 4) {
            promptTexts.push({ ts: tsMs, text: label.slice(0, 60) });
          }
        }
      }
    }

    if (contextTokens === 0 && peakContextTokens === 0) {
      return null; // no billable assistant turns yet
    }

    const analysis = finalizeAnalysis(acc);
    const composition = analysis.categories;
    const topToolResults = analysis.toolResultBreakdown.slice(0, 3);
    const contentTotal = analysis.totalEstimatedTokens || 1;

    // The observed peak is a lower bound on the real window — protects against
    // unknown/newer models whose table entry is too small (fill% would exceed 100).
    const contextLimit = Math.max(getModelContextLimit(model), peakContextTokens);
    const fillRatio = contextLimit > 0 ? contextTokens / contextLimit : 0;

    // --- Heuristic rot signals (offline only) ---
    const signals: ContextRotSignal[] = [];

    if (fillRatio >= 0.85) {
      signals.push({ kind: 'nearLimit', value: Math.round(fillRatio * 100) });
    }

    // Largest single tool-result contributor dominating the context.
    const topTool = analysis.toolResultBreakdown[0];
    if (topTool) {
      const share = topTool.estimatedTokens / contentTotal;
      if (share >= 0.35 && topTool.estimatedTokens > 5000) {
        signals.push({ kind: 'largeToolResult', label: topTool.key, value: Math.round(share * 100) });
      }
    }

    // Carried-over / stale: window large, dominated by tool results + thinking,
    // very little fresh user input.
    const byKey = (k: string): number => composition.find((c) => c.key === k)?.estimatedTokens || 0;
    const staleTokens = byKey('toolResults') + byKey('assistantThinking');
    const promptTokens = byKey('userPrompts');
    if (fillRatio >= 0.6 && staleTokens / contentTotal >= 0.6 && promptTokens / contentTotal <= 0.1) {
      signals.push({ kind: 'staleContext', value: Math.round((staleTokens / contentTotal) * 100) });
    }

    // Redundant file re-reads.
    let maxReads = 0;
    let maxReadFile = '';
    for (const [fp, n] of Object.entries(readCounts)) {
      if (n > maxReads) {
        maxReads = n;
        maxReadFile = fp;
      }
    }
    if (maxReads >= 3) {
      signals.push({ kind: 'redundantReads', label: this.lastPathSegment(maxReadFile), value: maxReads });
    }

    // Split the session into topics at large prompt gaps, and find the single
    // largest gap as the candidate topic-switch point.
    const proms = promptTexts.slice().sort((a, b) => a.ts - b.ts);
    let topicSwitchAt: string | undefined;
    let topicSwitchGapMin: number | undefined;
    let maxGapMs = 0;
    let gapAtMs = 0;
    const segments: { start: number; end: number; label: string }[] = [];
    if (proms.length > 0) {
      let segStart = proms[0].ts;
      let segLabel = proms[0].text;
      for (let i = 1; i < proms.length; i++) {
        const gap = proms[i].ts - proms[i - 1].ts;
        if (gap > maxGapMs) {
          maxGapMs = gap;
          gapAtMs = proms[i].ts;
        }
        if (gap >= TOPIC_GAP_MIN * 60_000) {
          segments.push({ start: segStart, end: proms[i].ts, label: segLabel });
          segStart = proms[i].ts;
          segLabel = proms[i].text;
        }
      }
      segments.push({ start: segStart, end: Infinity, label: segLabel });
    }
    if (maxGapMs >= TOPIC_GAP_MIN * 60_000) {
      topicSwitchGapMin = Math.round(maxGapMs / 60_000);
      topicSwitchAt = new Date(gapAtMs).toISOString();
      signals.push({ kind: 'multiTopic', value: topicSwitchGapMin });
    }

    const topics = segments
      .map((s) => ({
        label: s.label,
        estimatedTokens: lineEst.filter((l) => l.ts >= s.start && l.ts < s.end).reduce((n, l) => n + l.est, 0),
        startTime: new Date(s.start).toISOString(),
      }))
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

    // Down-sampled context-growth series (oldest→newest) for the sparkline.
    ctxSeries.sort((a, b) => a.ts - b.ts);
    const rawSeries = ctxSeries.map((p) => p.ctx);
    const MAX_POINTS = 24;
    let contextSeries = rawSeries;
    if (rawSeries.length > MAX_POINTS) {
      contextSeries = [];
      const step = (rawSeries.length - 1) / (MAX_POINTS - 1);
      for (let i = 0; i < MAX_POINTS; i++) {
        contextSeries.push(rawSeries[Math.round(i * step)]);
      }
    }

    // Recent growth rate + a rough ETA to the model limit at that pace.
    let growthTokensPerMin: number | undefined;
    let etaToLimitMin: number | undefined;
    if (ctxSeries.length >= 2) {
      const last = ctxSeries[ctxSeries.length - 1];
      const ref = ctxSeries[Math.max(0, ctxSeries.length - 6)];
      const dtMin = (last.ts - ref.ts) / 60_000;
      if (dtMin > 0) {
        const rate = (last.ctx - ref.ctx) / dtMin;
        if (rate > 0) {
          growthTokensPerMin = Math.round(rate);
          const remaining = contextLimit - last.ctx;
          if (remaining > 0) {
            etaToLimitMin = Math.max(1, Math.round(remaining / rate));
          }
        }
      }
    }

    // --- Token-efficiency metrics (offline, from usage fields + tool blocks) ---
    // Cache hit rate: share of input-side tokens served cheaply from cache.
    const cacheInputSide = sumRead + sumCreate + sumInput;
    const cacheHitRate = cacheInputSide > 0 ? (sumRead / cacheInputSide) * 100 : 0;

    // Cache-bust detection: a turn that re-writes a large prefix which the
    // previous turn already had cached (read collapses while creation spikes) —
    // e.g. a mid-session model switch or system/tool churn. Those re-writes pay
    // the 1.25x write rate instead of the 0.1x read rate.
    const CACHE_PREFIX_MIN = 4096;
    const CACHE_TTL_MS = 5 * 60 * 1000;
    turns.sort((a, b) => a.ts - b.ts);
    let cacheBustCount = 0;
    let cacheWastedTokens = 0;
    const cacheBusts: CacheBustEvent[] = [];
    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1];
      const cur = turns[i];
      const prevCached = prev.read + prev.create;
      if (prevCached >= CACHE_PREFIX_MIN && cur.read < prevCached * 0.5 && cur.create >= CACHE_PREFIX_MIN) {
        cacheBustCount++;
        cacheWastedTokens += cur.create;
        // Attribute the bust to its most likely trigger so the fix is obvious:
        // a model switch invalidates the prefix outright; a >TTL idle gap lets
        // the cache expire; near-simultaneous turns are parallel requests that
        // each paid the write before the cache warmed; anything else is prefix
        // churn (system/tool changes).
        const gapMs = cur.ts - prev.ts;
        const cause: CacheBustEvent['cause'] =
          cur.model !== prev.model ? 'modelSwitch' : gapMs > CACHE_TTL_MS ? 'ttlExpiry' : gapMs <= 2000 ? 'parallel' : 'other';
        cacheBusts.push({ at: new Date(cur.ts).toISOString(), cause, wastedTokens: cur.create });
      }
    }
    const pricing = getModelPricing(model);
    const cacheWastedUSD = pricing
      ? Math.max(0, cacheWastedTokens * ((pricing.cache_creation_input_token_cost || 0) - (pricing.cache_read_input_token_cost || 0)))
      : 0;

    // Estimated session cost (per-turn usage × that turn's model pricing), so
    // the cache waste can be expressed as a share of what the session cost.
    let sessionCostUSD = 0;
    for (const tn of turns) {
      const pr = getModelPricing(tn.model);
      if (!pr) {
        continue;
      }
      sessionCostUSD +=
        tn.input * (pr.input_cost_per_token || 0) +
        tn.output * (pr.output_cost_per_token || 0) +
        tn.create * (pr.cache_creation_input_token_cost || 0) +
        tn.read * (pr.cache_read_input_token_cost || 0);
    }
    const cacheWastePct = sessionCostUSD > 0 ? Math.min(100, (cacheWastedUSD / sessionCostUSD) * 100) : 0;

    // Masking what-if (arXiv:2508.21433): had tool outputs older than the
    // keep-window been masked, every later request's input side would have been
    // that much smaller. Attribute each tool result to the assistant turn it
    // followed, then for each turn sum the results that had gone stale by then.
    // Rough by design: masked tokens are priced at the cache-read rate (what
    // resident context actually costs per turn), and the cache re-writes a
    // masking boundary would itself cause are ignored.
    const MASK_KEEP_TURNS = 10;
    let maskingSavingsTokens = 0;
    if (turns.length > MASK_KEEP_TURNS && toolResultEvents.length > 0) {
      toolResultEvents.sort((a, b) => a.ts - b.ts);
      const tokensByTurn = new Array<number>(turns.length).fill(0);
      let ti = 0;
      for (const ev of toolResultEvents) {
        while (ti + 1 < turns.length && turns[ti + 1].ts <= ev.ts) {
          ti++;
        }
        tokensByTurn[ti] += ev.tokens;
      }
      const prefix = new Array<number>(turns.length).fill(0);
      for (let i = 0; i < turns.length; i++) {
        prefix[i] = tokensByTurn[i] + (i > 0 ? prefix[i - 1] : 0);
      }
      for (let i = MASK_KEEP_TURNS + 1; i < turns.length; i++) {
        maskingSavingsTokens += prefix[i - MASK_KEEP_TURNS - 1];
      }
    }
    const maskingSavingsUSD = pricing ? maskingSavingsTokens * (pricing.cache_read_input_token_cost || 0) : 0;

    // Input-side tokens paid per output token (agent norm: 2:1 up to 150:1).
    const inputOutputRatio = sumOutput > 0 ? (sumRead + sumCreate + sumInput) / sumOutput : 0;

    // Startup baseline: the first request's written/processed prefix (system
    // prompt + tool schemas + CLAUDE.md), present every session regardless of work.
    const firstTurn = turns.length > 0 ? turns[0] : null;
    const baselineTokens = firstTurn ? (firstTurn.create > 0 ? firstTurn.create : firstTurn.input) : 0;

    // Reclaimable tool output: tokens in oversized individual results beyond a cap.
    const TOOL_RESULT_CAP = 8000;
    let reclaimableTokens = 0;
    for (const sz of toolResultSizes) {
      if (sz > TOOL_RESULT_CAP) {
        reclaimableTokens += sz - TOOL_RESULT_CAP;
      }
    }

    // Quality-aware context-rot: compare tool-error rate in the lower vs upper
    // half of the window (a local proxy for length-driven degradation). is_error
    // also captures user rejections, so treat the rates as a rough signal.
    const splitCtx = contextLimit * 0.5;
    let loTotal = 0, loErr = 0, hiTotal = 0, hiErr = 0;
    for (const ev of toolEvents) {
      if (ev.ctx <= 0) {
        continue;
      }
      if (ev.ctx < splitCtx) {
        loTotal++;
        if (ev.error) loErr++;
      } else {
        hiTotal++;
        if (ev.error) hiErr++;
      }
    }
    const errorRateLowCtx = loTotal >= 5 ? (loErr / loTotal) * 100 : -1;
    const errorRateHighCtx = hiTotal >= 5 ? (hiErr / hiTotal) * 100 : -1;

    // Snowball / looping: the most-repeated identical non-Read tool call.
    let maxRepeatedCall = 0;
    let maxRepeatedCallKeyStr = '';
    for (const [k, n] of Object.entries(callCounts)) {
      if (n > maxRepeatedCall) {
        maxRepeatedCall = n;
        maxRepeatedCallKeyStr = k;
      }
    }
    const maxRepeatedCallLabel = maxRepeatedCallKeyStr.split(' ')[0] || '';

    if (cacheWastedTokens >= 20000) {
      signals.push({ kind: 'cacheBust', value: cacheBustCount });
    }
    if (baselineTokens >= 25000) {
      signals.push({ kind: 'largeBaseline', value: Math.round(baselineTokens / 1000) });
    }
    if (fullFileReads >= 5) {
      signals.push({ kind: 'fullFileReads', value: fullFileReads });
    }
    if (errorRateLowCtx >= 0 && errorRateHighCtx >= 0 && errorRateHighCtx >= Math.max(10, errorRateLowCtx * 1.5)) {
      signals.push({ kind: 'contextDegradation', value: Math.round(errorRateHighCtx) });
    }
    if (maxRepeatedCall >= 4) {
      signals.push({ kind: 'repeatedCalls', label: maxRepeatedCallLabel, value: maxRepeatedCall });
    }
    // A single prompt this big is almost always pasted file/log content; it
    // stays in the window (and on the bill) for every following turn.
    if (largestUserPromptTokens >= 10000) {
      signals.push({ kind: 'largeUserPrompt', value: Math.round(largestUserPromptTokens / 1000) });
    }

    // Stuck session: the recent tool-error rate spiked well above the session's
    // earlier rate — the observable shape of a run that stopped making progress
    // (trajectory-level early-warning, after arXiv:2601.05777). Whether to cut
    // losses stays the user's call; this only surfaces the trend.
    const STUCK_RECENT = 12;
    if (toolEvents.length >= STUCK_RECENT + 8) {
      const recent = toolEvents.slice(-STUCK_RECENT);
      const earlier = toolEvents.slice(0, -STUCK_RECENT);
      const recentErrPct = (recent.filter((e) => e.error).length / recent.length) * 100;
      const earlierErrPct = (earlier.filter((e) => e.error).length / earlier.length) * 100;
      if (recentErrPct >= 40 && recentErrPct >= earlierErrPct * 2) {
        signals.push({ kind: 'stuckSession', value: Math.round(recentErrPct) });
      }
    }

    // --- Overall status ---
    const hasLarge = signals.some((s) => s.kind === 'largeToolResult');
    const hasMulti = signals.some((s) => s.kind === 'multiTopic');
    let status: ContextHealth['status'] = 'healthy';
    if (fillRatio >= 0.85 || hasLarge || (hasMulti && fillRatio >= 0.6)) {
      status = 'rot';
    } else if (fillRatio >= 0.6 || signals.length > 0) {
      status = 'watch';
    }

    return {
      sessionId: latest._sessionId,
      // Use the earliest record's project (same as the Sessions tab) — the cwd
      // of later records can drift into subfolders and mislabel the session.
      projectName: first?._projectName || latest._projectName || 'unknown',
      model,
      contextTokens,
      peakContextTokens,
      contextLimit,
      fillRatio,
      composition,
      topToolResults,
      signals,
      cacheHitRate,
      cacheBustCount,
      cacheWastedTokens,
      cacheWastedUSD,
      cacheBusts,
      sessionCostUSD,
      cacheWastePct,
      maskingSavingsTokens,
      maskingSavingsUSD,
      inputOutputRatio,
      errorToolResultTokens,
      wasteTokens: cacheWastedTokens + errorToolResultTokens,
      baselineTokens,
      reclaimableTokens,
      fullFileReads,
      largestUserPromptTokens,
      errorRateLowCtx,
      errorRateHighCtx,
      maxRepeatedCall,
      maxRepeatedCallLabel,
      status,
      contextSeries,
      growthTokensPerMin,
      etaToLimitMin,
      topics,
      topicSwitchAt,
      topicSwitchGapMin,
    };
  }

  private static async getEarliestTimestamp(filePath: string): Promise<Date | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      for (const line of lines) {
        if (line.trim() === '') continue;

        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.timestamp === 'string') {
            const date = new Date(json.timestamp);
            if (!isNaN(date.getTime())) {
              return date;
            }
          }
        } catch {
          // Skip invalid lines
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private static async sortFilesByTimestamp(files: string[]): Promise<string[]> {
    const filesWithTimestamps = await Promise.all(
      files.map(async (file) => {
        const timestamp = await this.getEarliestTimestamp(file);
        return {
          file,
          timestamp: timestamp || new Date(0),
        };
      })
    );

    return filesWithTimestamps.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()).map((item) => item.file);
  }

  static calculateUsageData(records: ClaudeUsageRecord[]): UsageData {
    const data: UsageData = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCost: 0,
      costBreakdown: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      messageCount: 0,
      modelBreakdown: {},
    };

    for (const record of records) {
      // Only count records with usage and model (typically assistant type)
      if (!record.message.usage || !record.message.model) {
        continue;
      }

      const usage = record.message.usage;
      const model = record.message.model;

      // Skip error records and invalid records
      if (model === '<synthetic>' || record.isApiErrorMessage) {
        continue;
      }

      // Skip records where all tokens are 0
      const tokenSum = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      if (tokenSum === 0) {
        continue;
      }

      // Cost split by token type; the total is the sum of the four components.
      const costParts = calculateCostBreakdown(usage, model);
      const calculatedCost = costParts.input + costParts.output + costParts.cacheWrite + costParts.cacheRead;

      data.totalInputTokens += usage.input_tokens;
      data.totalOutputTokens += usage.output_tokens;
      data.totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
      data.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
      data.totalCost += calculatedCost;
      data.costBreakdown.input += costParts.input;
      data.costBreakdown.output += costParts.output;
      data.costBreakdown.cacheWrite += costParts.cacheWrite;
      data.costBreakdown.cacheRead += costParts.cacheRead;
      data.messageCount++;

      if (!data.modelBreakdown[model]) {
        data.modelBreakdown[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
          count: 0,
        };
      }

      const modelData = data.modelBreakdown[model];
      modelData.inputTokens += usage.input_tokens;
      modelData.outputTokens += usage.output_tokens;
      modelData.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
      modelData.cacheReadTokens += usage.cache_read_input_tokens || 0;
      modelData.cost += calculatedCost;
      modelData.count++;
    }

    return data;
  }

  static getCurrentSessionData(records: ClaudeUsageRecord[]): SessionData | null {
    if (records.length === 0) {
      return null;
    }

    // Sort records by timestamp
    const sortedRecords = records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const now = new Date();
    const sessionRecords = sortedRecords.filter((record) => {
      const recordTime = new Date(record.timestamp);
      const timeDiff = now.getTime() - recordTime.getTime();
      return timeDiff <= 5 * 60 * 60 * 1000; // 5 hours in milliseconds
    });

    if (sessionRecords.length === 0) {
      return null;
    }

    const usageData = this.calculateUsageData(sessionRecords);
    const sessionStart = new Date(sessionRecords[0].timestamp);
    const sessionEnd = new Date(sessionRecords[sessionRecords.length - 1].timestamp);

    return {
      ...usageData,
      sessionStart,
      sessionEnd,
    };
  }

  static getTodayData(records: ClaudeUsageRecord[]): UsageData {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRecords = records.filter((record) => {
      const recordDate = new Date(record.timestamp);
      return recordDate >= today;
    });

    return this.calculateUsageData(todayRecords);
  }

  static getThisMonthData(records: ClaudeUsageRecord[]): UsageData {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthRecords = records.filter((record) => {
      const recordDate = new Date(record.timestamp);
      return recordDate >= monthStart;
    });

    return this.calculateUsageData(monthRecords);
  }

  static getDailyDataForMonth(records: ClaudeUsageRecord[]): { date: string; data: UsageData }[] {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthRecords = records.filter((record) => {
      const recordDate = new Date(record.timestamp);
      return recordDate >= monthStart;
    });

    // Group records by date
    const recordsByDate: Record<string, ClaudeUsageRecord[]> = {};

    monthRecords.forEach((record) => {
      const recordDate = new Date(record.timestamp);
      const dateKey = recordDate.toISOString().split('T')[0]; // YYYY-MM-DD

      if (!recordsByDate[dateKey]) {
        recordsByDate[dateKey] = [];
      }
      recordsByDate[dateKey].push(record);
    });

    // Calculate usage data for each day and sort by date (newest first)
    const dailyData = Object.entries(recordsByDate)
      .map(([date, dayRecords]) => ({
        date,
        data: this.calculateUsageData(dayRecords),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return dailyData;
  }

  static getAllTimeData(records: ClaudeUsageRecord[]): UsageData {
    return this.calculateUsageData(records);
  }

  /**
   * Group records by their source session (.jsonl file) and aggregate usage per session.
   * Returns sessions with billable usage, sorted by most recent activity first.
   * @param records All loaded usage records
   * @param limit Maximum number of sessions to return (default 50)
   */
  static getSessionBreakdown(records: ClaudeUsageRecord[], limit: number = 50): SessionUsage[] {
    const recordsBySession: Record<string, ClaudeUsageRecord[]> = {};

    for (const record of records) {
      const sessionId = record._sessionId || 'unknown';
      if (!recordsBySession[sessionId]) {
        recordsBySession[sessionId] = [];
      }
      recordsBySession[sessionId].push(record);
    }

    const sessions: SessionUsage[] = Object.entries(recordsBySession).map(([sessionId, sessionRecords]) => {
      const timestamps = sessionRecords
        .map((r) => new Date(r.timestamp).getTime())
        .filter((t) => !isNaN(t));
      const startTime = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date(0);
      const endTime = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date(0);
      const first = sessionRecords[0];
      const peakContextTokens = sessionRecords.reduce((peak, r) => Math.max(peak, this.recordContextTokens(r)), 0);

      return {
        sessionId,
        projectName: first._projectName || 'unknown',
        projectPath: first._projectPath || '',
        startTime,
        endTime,
        data: this.calculateUsageData(sessionRecords),
        peakContextTokens,
      };
    });

    return sessions
      .filter((s) => s.data.messageCount > 0)
      .sort((a, b) => b.endTime.getTime() - a.endTime.getTime())
      .slice(0, limit);
  }

  /** Normalise a path for case-insensitive comparison and grouping. */
  private static normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  /** Number of leading path segments shared by every segment list. */
  private static commonPrefixLength(lists: string[][]): number {
    if (lists.length === 0) {
      return 0;
    }
    const first = lists[0];
    let len = 0;
    for (let i = 0; i < first.length; i++) {
      if (lists.every((l) => i < l.length && l[i] === first[i])) {
        len++;
      } else {
        break;
      }
    }
    return len;
  }

  /** Original-casing display path for a group, derived from a child's path. */
  private static deriveGroupDisplayPath(childOriginalPath: string, groupKey: string): string {
    const groupSegCount = groupKey.split('/').filter((s) => s.length > 0).length;
    const sep = childOriginalPath.includes('\\') ? '\\' : '/';
    const originalSegments = childOriginalPath.split(/[\\/]/).filter((s) => s.length > 0);
    return originalSegments.slice(0, groupSegCount).join(sep);
  }

  /** Resolve the enclosing git repository root for a path, or null. Walks up the tree. */
  private static resolveGitRoot(startPath: string, cache: Map<string, string | null>): string | null {
    const visited: string[] = [];
    let dir = startPath;
    for (let i = 0; i < 80; i++) {
      if (cache.has(dir)) {
        const cached = cache.get(dir) ?? null;
        for (const v of visited) {
          cache.set(v, cached);
        }
        return cached;
      }
      visited.push(dir);
      let isRepo = false;
      try {
        isRepo = fs.existsSync(path.join(dir, '.git'));
      } catch {
        isRepo = false;
      }
      if (isRepo) {
        for (const v of visited) {
          cache.set(v, dir);
        }
        return dir;
      }
      const parent = path.dirname(dir);
      if (!parent || parent === dir) {
        break;
      }
      dir = parent;
    }
    for (const v of visited) {
      cache.set(v, null);
    }
    return null;
  }

  /**
   * Group records by project (working directory), then group those projects by
   * their enclosing git repository — or, when a project is not inside a repo, by
   * its top-level project folder. Paths that differ only in case are merged.
   * @param records All loaded usage records
   * @param limit Maximum number of project groups to return (default 60)
   */
  static getProjectBreakdown(
    records: ClaudeUsageRecord[],
    limit: number = 60,
    mode: 'git' | 'folder' | 'flat' = 'git'
  ): ProjectGroup[] {
    // 1. Group records per project, merging paths that differ only in case.
    const recordsByKey: Record<string, ClaudeUsageRecord[]> = {};
    const displayPathByKey: Record<string, string> = {};

    for (const record of records) {
      const rawPath = record._projectPath || record._projectName || 'unknown';
      const key = this.normalizePath(rawPath);
      if (!recordsByKey[key]) {
        recordsByKey[key] = [];
        displayPathByKey[key] = rawPath;
      }
      recordsByKey[key].push(record);
    }

    const keys = Object.keys(recordsByKey);
    if (keys.length === 0) {
      return [];
    }

    // 2. Common root — the grouping fallback for projects not inside a git repo.
    const segmentLists = keys.map((k) => k.split('/').filter((s) => s.length > 0));
    const commonRootLen = this.commonPrefixLength(segmentLists);

    // 3. Build a project per key and assign it to a group (git repo, else folder).
    const groups: Record<
      string,
      { records: ClaudeUsageRecord[]; children: ProjectUsage[]; displayPath: string; isGitRepo: boolean }
    > = {};
    const gitCache = new Map<string, string | null>();

    keys.forEach((key, idx) => {
      const projectRecords = recordsByKey[key];
      const originalPath = displayPathByKey[key];
      const segments = segmentLists[idx];

      let groupKey: string;
      let groupDisplayPath: string;
      let isGitRepo = false;

      if (mode === 'flat') {
        // Every working directory is its own group.
        groupKey = segments.join('/');
        groupDisplayPath = originalPath;
      } else {
        let gitRoot: string | null = null;
        if (mode === 'git') {
          gitRoot = this.resolveGitRoot(originalPath, gitCache);
        }
        if (gitRoot) {
          groupKey = this.normalizePath(gitRoot);
          groupDisplayPath = gitRoot;
          isGitRepo = true;
        } else {
          // No git repo (or 'folder' mode): top-level project folder heuristic.
          const groupLen = commonRootLen === 0 ? segments.length : Math.min(segments.length, commonRootLen + 1);
          groupKey = segments.slice(0, groupLen).join('/');
          groupDisplayPath = this.deriveGroupDisplayPath(originalPath, groupKey);
        }
      }

      const timestamps = projectRecords.map((r) => new Date(r.timestamp).getTime()).filter((t) => !isNaN(t));
      const first = projectRecords[0];
      const project: ProjectUsage = {
        projectName: first._projectName || 'unknown',
        projectPath: displayPathByKey[key],
        sessionCount: new Set(projectRecords.map((r) => r._sessionId || 'unknown')).size,
        firstSeen: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date(0),
        lastSeen: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date(0),
        data: this.calculateUsageData(projectRecords),
      };

      if (!groups[groupKey]) {
        groups[groupKey] = { records: [], children: [], displayPath: groupDisplayPath, isGitRepo };
      }
      groups[groupKey].records.push(...projectRecords);
      groups[groupKey].children.push(project);
    });

    // 4. Aggregate each group.
    const result: ProjectGroup[] = Object.values(groups).map((g) => {
      const timestamps = g.records.map((r) => new Date(r.timestamp).getTime()).filter((t) => !isNaN(t));
      const sessionCount = new Set(g.records.map((r) => r._sessionId || 'unknown')).size;
      const children = g.children.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
      const pathSegments = g.displayPath.split(/[\\/]/).filter((s) => s.length > 0);
      const groupName = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : g.displayPath;

      return {
        groupName,
        groupPath: g.displayPath,
        isGitRepo: g.isGitRepo,
        projectCount: children.length,
        sessionCount,
        firstSeen: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date(0),
        lastSeen: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date(0),
        data: this.calculateUsageData(g.records),
        children,
      };
    });

    return result
      .filter((g) => g.data.messageCount > 0)
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
      .slice(0, limit);
  }

  /**
   * Group records by git branch (within each project) and aggregate usage.
   * Returns branches with billable usage, sorted by cost descending.
   * @param records All loaded usage records
   * @param limit Maximum number of branches to return (default 60)
   */
  static getBranchBreakdown(records: ClaudeUsageRecord[], limit: number = 60): BranchUsage[] {
    const byKey: Record<string, ClaudeUsageRecord[]> = {};
    for (const record of records) {
      const branch = record._gitBranch && record._gitBranch.trim() !== '' ? record._gitBranch : '-';
      const key = (record._projectName || 'unknown') + ' ' + branch;
      if (!byKey[key]) {
        byKey[key] = [];
      }
      byKey[key].push(record);
    }

    const result: BranchUsage[] = Object.values(byKey).map((recs) => {
      const first = recs[0];
      const branch = first._gitBranch && first._gitBranch.trim() !== '' ? first._gitBranch : '-';
      const timestamps = recs.map((r) => new Date(r.timestamp).getTime()).filter((t) => !isNaN(t));
      return {
        branch,
        projectName: first._projectName || 'unknown',
        projectPath: first._projectPath || '',
        sessionCount: new Set(recs.map((r) => r._sessionId || 'unknown')).size,
        lastSeen: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date(0),
        data: this.calculateUsageData(recs),
      };
    });

    return result
      .filter((b) => b.data.messageCount > 0)
      .sort((a, b) => b.data.totalCost - a.data.totalCost)
      .slice(0, limit);
  }

  /**
   * Newest modification time (ms) across all usage log files. Used to skip
   * pointless reloads when nothing has changed since the last load.
   */
  static async getLatestModifiedTime(dataDirectory?: string): Promise<number> {
    try {
      const claudePaths = dataDirectory ? [dataDirectory] : this.getClaudePaths();
      let latest = 0;
      for (const claudePath of claudePaths) {
        const claudeDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
        if (!fs.existsSync(claudeDir)) {
          continue;
        }
        const files = await findJsonlFiles(claudeDir);
        for (const file of files) {
          try {
            const stat = await fs.promises.stat(file);
            if (stat.mtimeMs > latest) {
              latest = stat.mtimeMs;
            }
          } catch {
            // Ignore unreadable files.
          }
        }
      }
      return latest;
    } catch {
      return 0;
    }
  }

  static getDailyDataForSpecificMonth(records: ClaudeUsageRecord[], monthDateString: string): { date: string; data: UsageData }[] {
    // monthDateString format: YYYY-MM-01 (first day of the month)
    const monthDate = new Date(monthDateString);
    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0); // Last day of the month

    const monthRecords = records.filter((record) => {
      const recordDate = new Date(record.timestamp);
      return recordDate >= monthStart && recordDate <= monthEnd;
    });

    // Group records by date
    const recordsByDate: Record<string, ClaudeUsageRecord[]> = {};

    monthRecords.forEach((record) => {
      const recordDate = new Date(record.timestamp);
      const dateKey = recordDate.toISOString().split('T')[0]; // YYYY-MM-DD

      if (!recordsByDate[dateKey]) {
        recordsByDate[dateKey] = [];
      }
      recordsByDate[dateKey].push(record);
    });

    // Convert to array and sort by date
    return Object.keys(recordsByDate)
      .sort()
      .map((dateKey) => ({
        date: dateKey,
        data: this.calculateUsageData(recordsByDate[dateKey]),
      }));
  }

  static getDailyDataForAllTime(records: ClaudeUsageRecord[]): { date: string; data: UsageData }[] {
    // Group all records by month for all-time view
    const recordsByMonth: Record<string, ClaudeUsageRecord[]> = {};

    records.forEach((record) => {
      const recordDate = new Date(record.timestamp);
      const monthKey = `${recordDate.getFullYear()}-${String(recordDate.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM

      if (!recordsByMonth[monthKey]) {
        recordsByMonth[monthKey] = [];
      }
      recordsByMonth[monthKey].push(record);
    });

    // Calculate usage data for each month and sort by month (newest first)
    const monthlyData = Object.entries(recordsByMonth)
      .map(([month, monthRecords]) => ({
        date: month + '-01', // Set to first day of month for date sorting
        data: this.calculateUsageData(monthRecords),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return monthlyData;
  }

  static getHourlyDataForToday(records: ClaudeUsageRecord[]): { hour: string; data: UsageData }[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRecords = records.filter((record) => {
      const recordDate = new Date(record.timestamp);
      return recordDate >= today;
    });

    // Group records by hour
    const recordsByHour: Record<string, ClaudeUsageRecord[]> = {};

    todayRecords.forEach((record) => {
      const recordDate = new Date(record.timestamp);
      const hourKey = `${recordDate.getHours().toString().padStart(2, '0')}:00`; // HH:00 format

      if (!recordsByHour[hourKey]) {
        recordsByHour[hourKey] = [];
      }
      recordsByHour[hourKey].push(record);
    });

    // Calculate usage data for each hour and sort by hour
    const hourlyData = Object.entries(recordsByHour)
      .map(([hour, hourRecords]) => ({
        hour,
        data: this.calculateUsageData(hourRecords),
      }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    return hourlyData;
  }

  static getHourlyDataForDate(records: ClaudeUsageRecord[], dateString: string): { hour: string; data: UsageData }[] {
    const targetDate = new Date(dateString);
    targetDate.setHours(0, 0, 0, 0);

    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    const dateRecords = records.filter((record) => {
      const recordDate = new Date(record.timestamp);
      return recordDate >= targetDate && recordDate < nextDate;
    });

    // Group records by hour
    const recordsByHour: Record<string, ClaudeUsageRecord[]> = {};

    dateRecords.forEach((record) => {
      const recordDate = new Date(record.timestamp);
      const hourKey = `${recordDate.getHours().toString().padStart(2, '0')}:00`; // HH:00 format

      if (!recordsByHour[hourKey]) {
        recordsByHour[hourKey] = [];
      }
      recordsByHour[hourKey].push(record);
    });

    // Calculate usage data for each hour and sort by hour
    const hourlyData = Object.entries(recordsByHour)
      .map(([hour, hourRecords]) => ({
        hour,
        data: this.calculateUsageData(hourRecords),
      }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    return hourlyData;
  }
}
