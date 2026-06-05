import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeApiUsageResponse } from './types';

// Persists timestamped snapshots of the real 5-hour / weekly quota utilisation
// (from api.anthropic.com/api/oauth/usage) so the dashboard can show how quota
// is consumed over time and at what hour of day. The OAuth endpoint only ever
// returns the *current* value, so history can only accrue while the extension
// is running — it cannot be back-filled.

export interface QuotaSnapshot {
  ts: string; // ISO8601 time the snapshot was recorded
  fiveHour: number | null;
  fiveHourResetsAt: string | null;
  sevenDay: number | null;
  sevenDayResetsAt: string | null;
  sevenDayOpus: number | null;
  sevenDayOpusResetsAt: string | null;
}

export class QuotaHistory {
  // The three utilisation values of the most recently written line. Used to
  // skip writing identical consecutive rows (the value is unchanged while idle).
  // Seeded from the file on the first append of each process so duplicates are
  // also avoided across extension reloads.
  private static lastKey: string | null = null;
  private static seeded = false;

  static getHistoryFilePath(): string {
    return path.join(os.homedir(), '.claude', 'cc-monitor', 'quota-history.jsonl');
  }

  private static keyOf(s: QuotaSnapshot): string {
    return `${s.fiveHour}|${s.sevenDay}|${s.sevenDayOpus}`;
  }

  private static toSnapshot(resp: ClaudeApiUsageResponse, ts: string): QuotaSnapshot {
    return {
      ts,
      fiveHour: resp.five_hour?.utilization ?? null,
      fiveHourResetsAt: resp.five_hour?.resets_at ?? null,
      sevenDay: resp.seven_day?.utilization ?? null,
      sevenDayResetsAt: resp.seven_day?.resets_at ?? null,
      sevenDayOpus: resp.seven_day_opus?.utilization ?? null,
      sevenDayOpusResetsAt: resp.seven_day_opus?.resets_at ?? null
    };
  }

  /** Append a snapshot, skipping rows whose utilisation values are unchanged
   * from the previous row. Failures are swallowed (logged by the caller path). */
  static async appendSnapshot(resp: ClaudeApiUsageResponse): Promise<void> {
    const snapshot = this.toSnapshot(resp, new Date().toISOString());

    if (!this.seeded) {
      this.seeded = true;
      const existing = await this.readHistory().catch(() => [] as QuotaSnapshot[]);
      if (existing.length > 0) {
        this.lastKey = this.keyOf(existing[existing.length - 1]);
      }
    }

    const key = this.keyOf(snapshot);
    if (key === this.lastKey) {
      return;
    }

    const file = this.getHistoryFilePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, JSON.stringify(snapshot) + '\n', 'utf-8');
    this.lastKey = key;
  }

  /** Read recorded snapshots. `sinceDays` (default 30) drops older rows so the
   * dashboard render stays cheap. Malformed lines are ignored. */
  static async readHistory(opts: { sinceDays?: number } = {}): Promise<QuotaSnapshot[]> {
    const file = this.getHistoryFilePath();
    let content: string;
    try {
      content = await fs.promises.readFile(file, 'utf-8');
    } catch {
      return [];
    }

    const cutoff =
      opts.sinceDays != null ? Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000 : null;

    const out: QuotaSnapshot[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as QuotaSnapshot;
        if (!parsed || typeof parsed.ts !== 'string') {
          continue;
        }
        if (cutoff != null && new Date(parsed.ts).getTime() < cutoff) {
          continue;
        }
        out.push(parsed);
      } catch {
        // Skip malformed lines (tolerant, like the JSONL loader).
      }
    }
    return out;
  }
}
