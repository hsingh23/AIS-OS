// Meta agent: watches the event log + stats, says how to go faster, and applies safe knob changes right away.
// It can only touch concurrency, throttle_ms and paused, always within hard bounds.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { stats, setControl, publish } from "./db.mjs";

let client;
const MODEL = process.env.ADVISOR_MODEL || "claude-opus-5-5";
const BOUNDS = { concurrency: [1, 20], throttle_ms: [0, 10_000] };

const Advice = z.object({
  diagnosis: z.string(),
  advice: z.string(),
  set_concurrency: z.number().int().nullable(),
  set_throttle_ms: z.number().int().nullable(),
  set_paused: z.boolean().nullable(),
});

const SYSTEM = `You supervise a pipeline that writes AI descriptions into a Google Photos library through browser tabs.
Each worker tab: open photo page -> fetch still -> vision model describes it -> type into the description field -> wait for save.
You get throughput, queue counts, per-worker output, errors by stage, and current knobs, plus the history of your past changes.
Goal: finish the whole library as fast as possible WITHOUT getting the Google account rate-limited or flagged.
Rules of thumb:
- Rising "open" or "write" errors, or auth errors, mean Google is pushing back: raise throttle_ms and/or lower concurrency. Pause on auth errors.
- "describe" errors that look like 429/overloaded mean the model API is the bottleneck: lower concurrency a little.
- Low errors and stable throughput: you may raise concurrency by at most 2 or lower throttle by at most 500ms per step.
- Change nothing if the last change has not had 10 minutes to show its effect.
Return null for any knob you do not want to change. Put code-level ideas (selectors, batching, different approach) in advice.`;

export async function adviseOnce(db, history) {
  const s = stats(db);
  client ??= new Anthropic({ maxRetries: 3 });
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: "low", format: zodOutputFormat(Advice) },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify({ now: new Date().toISOString(), stats: s, past_changes: history.slice(-6) }) }],
  });
  const a = res.parsed_output;
  if (!a) return null;
  const applied = {};
  const clamp = (k, v) => Math.min(BOUNDS[k][1], Math.max(BOUNDS[k][0], v));
  if (a.set_concurrency != null) { applied.concurrency = clamp("concurrency", a.set_concurrency); setControl(db, "concurrency", applied.concurrency); }
  if (a.set_throttle_ms != null) { applied.throttle_ms = clamp("throttle_ms", a.set_throttle_ms); setControl(db, "throttle_ms", applied.throttle_ms); }
  if (a.set_paused != null) { applied.paused = a.set_paused; setControl(db, "paused", a.set_paused ? 1 : 0); }
  const entry = { ts: new Date().toISOString(), diagnosis: a.diagnosis, advice: a.advice, applied };
  history.push(entry);
  publish(db, "advisor.advice", entry);
  return entry;
}
