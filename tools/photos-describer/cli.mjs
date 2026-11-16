#!/usr/bin/env node
// Google Photos describer: N browser tabs write searchable AI descriptions into every photo/video.
//
//   node cli.mjs login                 one-time: sign in to Google in the dedicated Chrome profile
//   node cli.mjs probe [--n 3]         dry run on a few items, prints what it sees (no writes)
//   node cli.mjs run [--tabs 10] [--dry-run] [--headless] [--overwrite] [--no-advisor] [--no-enumerate]
//   node cli.mjs status                counts, throughput, ETA, recent errors, advisor notes
//   node cli.mjs set <key> <value>     live knobs: concurrency | throttle_ms | paused | max_attempts
//   node cli.mjs export > out.csv      id,url,status,description
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import * as Q from "./lib/db.mjs";
import * as G from "./lib/gphotos.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.PHOTOS_PROFILE_DIR || path.join(here, ".chrome-profile");
const DB_FILE = process.env.PHOTOS_DB || path.join(here, "state", "queue.sqlite");

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    tabs: { type: "string" }, n: { type: "string", default: "3" },
    "dry-run": { type: "boolean" }, headless: { type: "boolean" }, overwrite: { type: "boolean" },
    "no-advisor": { type: "boolean" }, "no-enumerate": { type: "boolean" },
    "advise-every-min": { type: "string", default: "5" },
  },
});
const cmd = positionals[0] || "status";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function launch({ headless = false } = {}) {
  return chromium.launchPersistentContext(PROFILE, {
    channel: (process.env.PHOTOS_CHROME_CHANNEL ?? "chrome") || undefined, // real Chrome; "" = bundled Chromium
    executablePath: process.env.PHOTOS_CHROME_PATH || undefined,
    headless,
    viewport: { width: 1280, height: 860 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

// ---------------------------------------------------------------- login
async function login() {
  const ctx = await launch();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(G.HOME);
  log("Sign in to Google Photos in the window that opened. Close the window when your library is showing.");
  await new Promise(r => ctx.on("close", r));
}

// ---------------------------------------------------------------- probe
async function probe() {
  (await import("node:fs")).mkdirSync(path.join(here, "state"), { recursive: true });
  const { describeImage } = await import("./lib/describe.mjs");
  const ctx = await launch({ headless: opt.headless });
  const page = ctx.pages()[0] || await ctx.newPage();
  const gen = G.enumerateLibrary(page, { idleRounds: 1 });
  const first = (await gen.next()).value || [];
  const sample = first.slice(0, Number(opt.n));
  log(`grid shows ${first.length} items; probing ${sample.length}`);
  for (const it of sample) {
    try {
      await G.openItem(page, it.url);
      const existing = await G.readDescription(page);
      const still = await G.grabStill(page);
      const { text } = await describeImage({ ...still, kind: it.kind });
      console.log(JSON.stringify({ id: it.id, kind: it.kind, label: it.label, existing, via: still.via, would_write: text }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ id: it.id, error: e.message }));
      await page.screenshot({ path: path.join(here, "state", `probe-${it.id.slice(0, 12)}.png`) }).catch(() => {});
    }
  }
  await ctx.close();
}

// ---------------------------------------------------------------- run
async function run() {
  const { describeImage, AI_MARKER } = await import("./lib/describe.mjs");
  const { adviseOnce } = await import("./lib/advisor.mjs");
  const db = Q.openDb(DB_FILE);
  if (opt.tabs) Q.setControl(db, "concurrency", Number(opt.tabs));
  const released = Q.releaseStale(db, 0);
  if (released) log(`requeued ${released} items left claimed by a previous run`);
  Q.publish(db, "run.start", { dry_run: !!opt["dry-run"], tabs: Q.getControl(db).concurrency });

  const ctx = await launch({ headless: opt.headless });
  // Don't download heavy bytes we never look at.
  await ctx.route(/\.(mp4|webm|m3u8)(\?|$)/, r => r.abort());
  let stopping = false, fatal = null, enumDone = !!opt["no-enumerate"];

  // Producer: one tab scrolls the library and feeds the queue. Workers start as soon as rows land.
  const producer = enumDone ? Promise.resolve() : (async () => {
    const page = await ctx.newPage();
    let total = 0;
    try {
      for await (const batch of G.enumerateLibrary(page)) {
        if (stopping) break;
        const added = Q.enqueue(db, batch);
        total += added;
        Q.publish(db, "enum.batch", { seen: batch.length, added, total });
      }
    } catch (e) {
      Q.publish(db, "enum.error", { error: e.message });
      log("enumeration error:", e.message);
    } finally {
      enumDone = true;
      Q.publish(db, "enum.done", { total });
      log(`enumeration finished: ${total} new items queued`);
      await page.close().catch(() => {});
    }
  })();

  async function processItem(page, item, worker) {
    const t0 = Date.now();
    let stage = "open";
    try {
      await G.openItem(page, item.url);
      stage = "read";
      const existing = await G.readDescription(page);
      const ours = existing.startsWith(AI_MARKER);
      if (existing && !opt.overwrite) {
        Q.finish(db, item.id, "skipped", { description: existing, error: ours ? "already described" : "has user description" });
        Q.publish(db, "item.skipped", { worker, item_id: item.id, reason: ours ? "ours" : "user" });
        return;
      }
      if (existing && !ours) { // --overwrite only replaces descriptions this tool wrote, never yours
        stage = "skip-user"; Q.finish(db, item.id, "skipped", { description: existing, error: "has user description" }); return;
      }
      stage = "still";
      const still = await G.grabStill(page);
      stage = "describe";
      const { text, usage } = await describeImage({ ...still, kind: item.kind });
      if (!opt["dry-run"]) {
        stage = "write";
        const saved = await G.writeDescription(page, text);
        if (!saved) throw Object.assign(new Error("no save request seen after blur"), { stage });
      }
      Q.finish(db, item.id, "done", { description: text });
      Q.publish(db, "item.done", { worker, item_id: item.id, ms: Date.now() - t0, via: still.via,
        in_tok: usage?.input_tokens, out_tok: usage?.output_tokens, dry_run: !!opt["dry-run"] });
    } catch (e) {
      const st = e.stage || stage;
      Q.publish(db, "item.error", { worker, item_id: item.id, stage: st, error: String(e.message).slice(0, 300) });
      if (e.fatal) { fatal = e; stopping = true; Q.requeue(db, item.id, e.message); return; }
      const { max_attempts } = Q.getControl(db);
      if (e.permanent || item.attempts >= max_attempts) Q.finish(db, item.id, "failed", { error: `${st}: ${e.message}` });
      else Q.requeue(db, item.id, `${st}: ${e.message}`);
    }
  }

  // Worker pool, resized live from the control table (advisor or `cli set concurrency N`).
  const active = new Map();
  async function worker(idx) {
    const name = `tab${String(idx).padStart(2, "0")}`;
    const page = await ctx.newPage();
    Q.publish(db, "worker.start", { worker: name });
    try {
      while (!stopping) {
        const c = Q.getControl(db);
        if (idx >= c.concurrency) break;
        if (c.paused) { await sleep(3000); continue; }
        const item = Q.claim(db, name, c.max_attempts);
        if (!item) { if (enumDone) break; await sleep(2000); continue; }
        await processItem(page, item, name);
        if (c.throttle_ms) await sleep(c.throttle_ms * (0.75 + Math.random() * 0.5));
      }
    } finally {
      Q.publish(db, "worker.stop", { worker: name });
      await page.close().catch(() => {});
      active.delete(idx);
    }
  }
  const supervisor = setInterval(() => {
    const { concurrency } = Q.getControl(db);
    for (let i = 0; i < concurrency && !stopping; i++) if (!active.has(i)) active.set(i, worker(i));
  }, 2000);

  // Meta agent on a timer; its knob changes take effect on the workers' next loop.
  const history = [];
  const advisor = opt["no-advisor"] ? null : setInterval(async () => {
    try {
      const a = await adviseOnce(db, history);
      if (a) log(`ADVISOR: ${a.diagnosis} | ${a.advice} | applied ${JSON.stringify(a.applied)}`);
    } catch (e) { log("advisor error:", e.message); }
  }, Number(opt["advise-every-min"]) * 60_000);

  const ticker = setInterval(() => {
    const s = Q.stats(db);
    log(`done=${s.counts.done ?? 0} skipped=${s.counts.skipped ?? 0} failed=${s.counts.failed ?? 0} ` +
        `queued=${s.counts.queued ?? 0} | ${s.per_min}/min | ETA ${s.eta_min ?? "?"} min | tabs=${active.size}`);
  }, 30_000);

  process.on("SIGINT", () => { log("stopping after current items..."); stopping = true; });

  await producer;
  await sleep(2500); // let the supervisor start workers
  while (active.size) await Promise.race([...active.values()]).catch(() => {});
  clearInterval(supervisor); clearInterval(ticker); if (advisor) clearInterval(advisor);
  Q.publish(db, "run.end", { fatal: fatal?.message ?? null });
  console.log(JSON.stringify(Q.stats(db), null, 2));
  await ctx.close();
  if (fatal) { console.error("FATAL:", fatal.message); process.exit(2); }
}

// ---------------------------------------------------------------- status / set / export
function status() {
  const db = Q.openDb(DB_FILE);
  console.log(JSON.stringify(Q.stats(db), null, 2));
  const notes = db.prepare("SELECT ts, data FROM events WHERE topic='advisor.advice' ORDER BY id DESC LIMIT 3").all();
  for (const n of notes) console.log("advisor", new Date(n.ts).toISOString(), n.data);
}
function set() {
  const [, key, value] = positionals;
  if (!["concurrency", "throttle_ms", "paused", "max_attempts"].includes(key)) throw new Error("unknown key " + key);
  const db = Q.openDb(DB_FILE);
  Q.setControl(db, key, value);
  Q.publish(db, "control.set", { key, value, by: "human" });
  console.log(Q.getControl(db));
}
function exportCsv() {
  const db = Q.openDb(DB_FILE);
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  console.log("id,url,kind,status,description,error");
  for (const r of db.prepare("SELECT * FROM items ORDER BY seq").iterate())
    console.log([r.id, r.url, r.kind, r.status, r.description, r.error].map(esc).join(","));
}

const commands = { login, probe, run, status, set, export: exportCsv };
if (!commands[cmd]) { console.error(`unknown command ${cmd}`); process.exit(1); }
await commands[cmd]();
