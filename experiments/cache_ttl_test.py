#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic>=0.40.0"]
# ///
"""
Experiment: Does reading from prompt cache extend the 5-minute TTL?

Protocol (total ~9 min):
  T+0:00  Request A — send large system prompt → expect cache_creation > 0
  T+0:30  Request B — same prompt             → expect cache_read > 0 (confirm)
  T+4:30  Request C — same prompt             → just before 5-min mark; may refresh TTL
  T+9:00  Request D — same prompt             → verdict
            cache_read > 0  →  reads DO extend TTL
            cache_read = 0  →  TTL is fixed from creation time

Usage:
  ANTHROPIC_API_KEY=sk-... uv run experiments/cache_ttl_test.py
"""

import json
import os
import time
from datetime import datetime

import anthropic

# ~6 000 tokens — well above the 2 048-token minimum for prompt caching.
# Content is deterministic so the cache key is identical across all requests.
_RULES = "\n".join(
    f"Rule {i:04d}: Prioritise clarity, accuracy, and helpfulness. "
    "When uncertain, ask for clarification rather than guessing. "
    "Give concrete examples when explaining abstract ideas."
    for i in range(1, 400)
)
SYSTEM_PROMPT = f"You are a helpful assistant.\n\n{_RULES}"
USER_MESSAGE = "Reply with only the word OK."

MODEL = "claude-haiku-4-5-20251001"  # cheapest model; full caching support


# ── helpers ──────────────────────────────────────────────────────────────────

def make_request(client: anthropic.Anthropic, label: str) -> dict:
    ts = datetime.now()
    print(f"\n[{ts.strftime('%H:%M:%S')}] {label}")

    resp = client.messages.create(
        model=MODEL,
        max_tokens=10,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": USER_MESSAGE}],
    )

    u = resp.usage
    row = {
        "label": label,
        "ts": ts.isoformat(),
        "input_tokens": u.input_tokens,
        "cache_creation": getattr(u, "cache_creation_input_tokens", 0) or 0,
        "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
        "output_tokens": u.output_tokens,
    }

    if row["cache_read"] > 0:
        status = "✅ CACHE HIT"
    elif row["cache_creation"] > 0:
        status = "📝 CACHE WRITE"
    else:
        status = "❌ CACHE MISS (no cache activity)"

    print(f"  {status}")
    print(
        f"  input={row['input_tokens']:,}  "
        f"creation={row['cache_creation']:,}  "
        f"read={row['cache_read']:,}"
    )
    return row


def sleep_until(target_s: float, t0: float) -> None:
    remaining = (t0 + target_s) - time.time()
    if remaining > 0:
        wake = datetime.fromtimestamp(t0 + target_s).strftime("%H:%M:%S")
        print(f"\n  ⏱  sleeping {remaining:.0f}s  (next request at {wake})")
        time.sleep(remaining)


# ── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise SystemExit(
            "ERROR: ANTHROPIC_API_KEY is not set.\n"
            "Run:  ANTHROPIC_API_KEY=sk-... uv run experiments/cache_ttl_test.py"
        )

    client = anthropic.Anthropic(api_key=api_key)

    word_count = len(SYSTEM_PROMPT.split())
    print("=" * 60)
    print("Prompt-cache TTL experiment")
    print("Question: do cache reads extend the 5-minute TTL?")
    print(f"Model   : {MODEL}")
    print(f"Prompt  : ~{word_count:,} words  (~{word_count * 4 // 3:,} tokens est.)")
    print("Runtime : ~9 minutes")
    print("=" * 60)

    results = []
    t0 = time.time()

    # T+0:00  create the cache
    results.append(make_request(client, "A  T+0:00  (create cache)"))

    # T+0:30  confirm cache is working
    sleep_until(30, t0)
    results.append(make_request(client, "B  T+0:30  (confirm hit)"))

    # T+4:30  read just before the 5-min mark — this may refresh the TTL
    sleep_until(4.5 * 60, t0)
    results.append(make_request(client, "C  T+4:30  (pre-expiry read)"))

    # T+9:00  verdict
    #   • If reads extend TTL: C refreshed to +5 min → expires ~T+9:30 → still warm
    #   • If TTL is fixed:     cache expired at T+5:00 → cold
    sleep_until(9 * 60, t0)
    results.append(make_request(client, "D  T+9:00  (verdict)"))

    # ── verdict ──────────────────────────────────────────────────────────────
    verdict = results[-1]
    print("\n" + "=" * 60)
    if verdict["cache_read"] > 0:
        print("RESULT  ✅  Cache was WARM at T+9:00")
        print("→ Cache reads extend the TTL (each hit resets the 5-min clock)")
        conclusion = "reads_extend_ttl"
    else:
        print("RESULT  ❌  Cache was COLD at T+9:00")
        print("→ Cache reads do NOT extend the TTL (fixed 5 min from creation)")
        conclusion = "ttl_fixed_from_creation"

    # ── summary table ────────────────────────────────────────────────────────
    print("\nSummary:")
    print(f"  {'Request':<30}  {'creation':>10}  {'read':>10}  {'status'}")
    print(f"  {'-'*30}  {'-'*10}  {'-'*10}  {'-'*20}")
    for r in results:
        hit = r["cache_read"] > 0
        write = r["cache_creation"] > 0
        s = "HIT" if hit else ("WRITE" if write else "MISS")
        print(f"  {r['label']:<30}  {r['cache_creation']:>10,}  {r['cache_read']:>10,}  {s}")

    # ── raw JSON for reference ───────────────────────────────────────────────
    out = {"conclusion": conclusion, "model": MODEL, "results": results}
    outfile = "experiments/cache_ttl_result.json"
    with open(outfile, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nFull results saved → {outfile}")


if __name__ == "__main__":
    main()
