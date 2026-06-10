#!/usr/bin/env node
// extract-session.mjs — distill one Claude Code session (.jsonl) into a compact
// facts JSON for the cc-monitor skills (/cc-session-review etc.).
//
// Deterministic, zero-dependency (Node 18+), read-only. The point is to keep
// LLM input small: the skill feeds this summary to the model instead of the
// raw transcript, so facts come from code and only judgement comes from the LLM.
//
// Usage:
//   node scripts/extract-session.mjs                  # latest session overall
//   node scripts/extract-session.mjs --session <id>   # specific session id
//   node scripts/extract-session.mjs --project <substr>  # latest in matching project dir
//   node scripts/extract-session.mjs --dir <claude-dir>  # explicit ~/.claude override
//
// Output: JSON on stdout. Errors: message on stderr, exit 1.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- CLI args ----------
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const wantSession = argValue('--session');
const wantProject = argValue('--project');
const wantDir = argValue('--dir');

// ---------- locate the Claude data directory ----------
function candidateDirs() {
  const dirs = [];
  if (wantDir) {
    dirs.push(wantDir);
  }
  const env = (process.env.CLAUDE_CONFIG_DIR ?? '').trim();
  if (env !== '') {
    for (const p of env.split(',').map((s) => s.trim()).filter(Boolean)) {
      dirs.push(p);
    }
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  dirs.push(path.join(xdg, 'claude'));
  dirs.push(path.join(os.homedir(), '.claude'));
  return dirs.filter((d) => existsSync(path.join(d, 'projects')));
}

async function findJsonlFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

// ---------- token estimate (mirrors the extension's heuristic) ----------
function estimateTokens(text) {
  const len = text.length;
  if (len === 0) return 0;
  if (len > 200000) return Math.round(len / 4);
  let cjk = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x3000 && c <= 0x9fff) cjk++;
  }
  return Math.round(cjk / 1.5 + (len - cjk) / 4);
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let t = '';
    for (const b of content) {
      if (typeof b === 'string') t += b;
      else if (b && typeof b === 'object' && typeof b.text === 'string') t += b.text;
    }
    return t;
  }
  return '';
}

const head = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

// ---------- pick the target session file ----------
const dirs = candidateDirs();
if (dirs.length === 0) {
  console.error('extract-session: no Claude data directory found (~/.claude/projects).');
  process.exit(1);
}

let files = [];
for (const d of dirs) {
  files.push(...(await findJsonlFiles(path.join(d, 'projects'))));
}
if (wantProject) {
  const needle = wantProject.toLowerCase();
  files = files.filter((f) => path.dirname(f).toLowerCase().includes(needle));
}
if (files.length === 0) {
  console.error('extract-session: no .jsonl session logs found.');
  process.exit(1);
}

let target = null;
if (wantSession && wantSession !== 'latest') {
  target = files.find((f) => path.basename(f, '.jsonl') === wantSession) ?? null;
  if (!target) {
    console.error(`extract-session: session "${wantSession}" not found.`);
    process.exit(1);
  }
} else {
  let best = -Infinity;
  for (const f of files) {
    try {
      const st = await stat(f);
      if (st.mtimeMs > best) {
        best = st.mtimeMs;
        target = f;
      }
    } catch {
      /* unreadable — skip */
    }
  }
}

// ---------- parse the transcript ----------
const raw = await readFile(target, 'utf-8');

const MAX_ERRORS = 40;
const MAX_PROMPTS = 30;
const ERROR_HEAD = 300;
const PROMPT_HEAD = 200;

const toolIdToName = {};
const toolCounts = {};
const toolErrors = {};
const stopReasons = {};
const errors = [];
const prompts = [];
const repeated = {};
const largeResults = [];
const promptGaps = [];
const models = new Set();
const dedupe = new Set();

let sumInput = 0, sumOutput = 0, sumRead = 0, sumCreate = 0;
let assistantTurns = 0, sidechainTurns = 0, toolCallCount = 0, toolResultCount = 0;
let firstTs = null, lastTs = null, lastPromptTs = null;
let latestCtx = 0, peakCtx = 0, latestCtxTs = -Infinity;
let finalAssistantText = '';
let lineCount = 0, badLines = 0;

function repeatedKey(name, input) {
  const pick = (k) => (typeof input[k] === 'string' ? input[k] : '');
  let arg =
    name === 'Bash' ? pick('command')
    : name === 'Grep' || name === 'Glob' ? pick('pattern')
    : pick('file_path') || pick('path') || pick('query') || pick('prompt');
  if (!arg) {
    try { arg = JSON.stringify(input).slice(0, 200); } catch { arg = ''; }
  }
  arg = arg.trim();
  return arg ? `${name} ${arg}` : '';
}

for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (trimmed === '') continue;
  lineCount++;
  let p;
  try {
    p = JSON.parse(trimmed);
  } catch {
    badLines++;
    continue;
  }
  const msg = p.message;
  if (!msg || typeof msg !== 'object') continue;
  const role = msg.role || p.type;
  const tsMs = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
  if (!isNaN(tsMs)) {
    if (firstTs === null || tsMs < firstTs) firstTs = tsMs;
    if (lastTs === null || tsMs > lastTs) lastTs = tsMs;
  }

  if (role === 'assistant') {
    if (typeof msg.model === 'string') models.add(msg.model);
    if (typeof msg.stop_reason === 'string') {
      stopReasons[msg.stop_reason] = (stopReasons[msg.stop_reason] || 0) + 1;
    }
    const u = msg.usage;
    if (u && typeof u.output_tokens === 'number') {
      // Dedupe retried/replayed usage rows the same way the extension does.
      const key = `${msg.id || 'no-msg'}-${p.requestId || 'no-req'}`;
      if (!(msg.id || p.requestId) || !dedupe.has(key)) {
        dedupe.add(key);
        if (p.isSidechain) {
          sidechainTurns++;
        } else {
          assistantTurns++;
        }
        sumInput += u.input_tokens || 0;
        sumOutput += u.output_tokens || 0;
        sumRead += u.cache_read_input_tokens || 0;
        sumCreate += u.cache_creation_input_tokens || 0;
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        peakCtx = Math.max(peakCtx, ctx);
        if (!isNaN(tsMs) && tsMs >= latestCtxTs && !p.isSidechain) {
          latestCtxTs = tsMs;
          latestCtx = ctx;
        }
      }
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '' && !p.isSidechain) {
          finalAssistantText = b.text;
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          toolCallCount++;
          toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
          if (typeof b.id === 'string') toolIdToName[b.id] = b.name;
          if (b.name !== 'Read') {
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            const key = repeatedKey(b.name, input);
            if (key) repeated[key] = (repeated[key] || 0) + 1;
          }
        }
      }
    }
  } else if (role === 'user') {
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          toolResultCount++;
          const tool = toolIdToName[b.tool_use_id] || 'unknown';
          const text = blockText(b.content);
          const est = estimateTokens(text);
          if (est > 0) largeResults.push({ tool, estTokens: est });
          if (b.is_error === true) {
            toolErrors[tool] = (toolErrors[tool] || 0) + 1;
            if (errors.length < MAX_ERRORS) {
              errors.push({
                tool,
                at: isNaN(tsMs) ? null : new Date(tsMs).toISOString(),
                text: head(text.trim(), ERROR_HEAD),
              });
            }
          }
        }
      }
    }
    // Real, human-authored prompts (skip meta + tool-result-only records).
    if (p.isMeta !== true) {
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const tb = msg.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
        text = tb ? tb.text : '';
      }
      text = text.trim();
      if (text.length >= 4) {
        prompts.push({ at: isNaN(tsMs) ? null : new Date(tsMs).toISOString(), text: head(text, PROMPT_HEAD) });
        if (lastPromptTs !== null && !isNaN(tsMs)) {
          const gapMin = Math.round((tsMs - lastPromptTs) / 60000);
          if (gapMin >= 15) {
            promptGaps.push({ at: new Date(tsMs).toISOString(), gapMin });
          }
        }
        if (!isNaN(tsMs)) lastPromptTs = tsMs;
      }
    }
  }
}

// ---------- assemble the summary ----------
const tools = Object.keys(toolCounts)
  .map((name) => ({ name, count: toolCounts[name], errors: toolErrors[name] || 0 }))
  .sort((a, b) => b.count - a.count);
const totalErrors = Object.values(toolErrors).reduce((s, n) => s + n, 0);

const repeatedTop = Object.entries(repeated)
  .filter(([, n]) => n >= 2)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([key, count]) => ({ call: head(key, 160), count }));

largeResults.sort((a, b) => b.estTokens - a.estTokens);

// Keep the narrative bookends: the opening prompts plus the most recent ones.
let promptsSample = prompts;
if (prompts.length > MAX_PROMPTS) {
  promptsSample = [...prompts.slice(0, 5), { at: null, text: `… (${prompts.length - MAX_PROMPTS} prompts omitted) …` }, ...prompts.slice(-(MAX_PROMPTS - 6))];
}

const cacheInputSide = sumRead + sumCreate + sumInput;

const summary = {
  schemaVersion: 1,
  sessionId: path.basename(target, '.jsonl'),
  file: target,
  projectDir: path.basename(path.dirname(target)),
  startTime: firstTs === null ? null : new Date(firstTs).toISOString(),
  endTime: lastTs === null ? null : new Date(lastTs).toISOString(),
  durationMin: firstTs !== null && lastTs !== null ? Math.round((lastTs - firstTs) / 60000) : null,
  models: [...models],
  lines: { total: lineCount, unparsable: badLines },
  usage: {
    inputTokens: sumInput,
    outputTokens: sumOutput,
    cacheReadTokens: sumRead,
    cacheCreationTokens: sumCreate,
    cacheHitRatePct: cacheInputSide > 0 ? Math.round((sumRead / cacheInputSide) * 100) : null,
    latestContextTokens: latestCtx,
    peakContextTokens: peakCtx,
  },
  counts: {
    assistantTurns,
    sidechainTurns,
    userPrompts: prompts.length,
    toolCalls: toolCallCount,
    toolResults: toolResultCount,
    toolErrors: totalErrors,
  },
  stopReasons,
  tools,
  errors,
  repeatedCalls: repeatedTop,
  largeToolResults: largeResults.slice(0, 10),
  promptGapsOver15Min: promptGaps,
  userPrompts: promptsSample,
  finalAssistantText: head(finalAssistantText.trim(), 600),
};

process.stdout.write(JSON.stringify(summary, null, 1) + '\n');
