// Bookkeeping + pub/sub on one SQLite file.
// items   = the work queue (one row per photo/video)
// events  = append-only pub/sub log; any process can tail it by id
// control = live knobs the advisor (or you) can change while workers run
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      seq INTEGER,
      url TEXT NOT NULL,
      kind TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'queued',  -- queued|claimed|done|skipped|failed
      worker TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      error TEXT,
      claimed_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS items_status ON items(status, seq);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      topic TEXT NOT NULL,
      worker TEXT,
      item_id TEXT,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const defaults = { concurrency: "10", throttle_ms: "1500", paused: "0", max_attempts: "3" };
  const ins = db.prepare("INSERT OR IGNORE INTO control(key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);
  return db;
}

const now = () => Date.now();

export function publish(db, topic, { worker = null, item_id = null, ...data } = {}) {
  db.prepare("INSERT INTO events(ts, topic, worker, item_id, data) VALUES (?,?,?,?,?)")
    .run(now(), topic, worker, item_id, JSON.stringify(data));
}

// Subscribe by polling the log; returns a stop function.
export function subscribe(db, topics, onEvent, { fromId = null, everyMs = 1000 } = {}) {
  let last = fromId ?? (db.prepare("SELECT COALESCE(MAX(id),0) m FROM events").get().m);
  const placeholders = topics.map(() => "?").join(",");
  const q = db.prepare(`SELECT * FROM events WHERE id > ? AND topic IN (${placeholders}) ORDER BY id`);
  const t = setInterval(() => {
    for (const ev of q.all(last, ...topics)) {
      last = ev.id;
      onEvent({ ...ev, data: JSON.parse(ev.data || "{}") });
    }
  }, everyMs);
  return () => clearInterval(t);
}

export function getControl(db) {
  const out = {};
  for (const r of db.prepare("SELECT key, value FROM control").all()) out[r.key] = r.value;
  return {
    concurrency: Number(out.concurrency),
    throttle_ms: Number(out.throttle_ms),
    paused: out.paused === "1",
    max_attempts: Number(out.max_attempts),
  };
}

export function setControl(db, key, value) {
  db.prepare("INSERT INTO control(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

export function enqueue(db, items) {
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq),0) m FROM items").get().m;
  const ins = db.prepare("INSERT OR IGNORE INTO items(id, seq, url, kind, label, updated_at) VALUES (?,?,?,?,?,?)");
  let added = 0, seq = maxSeq;
  db.exec("BEGIN");
  try {
    for (const it of items) added += Number(ins.run(it.id, ++seq, it.url, it.kind, it.label, now()).changes);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return added;
}

// One process owns the db connection and calls are synchronous, so this claim is atomic.
export function claim(db, worker, maxAttempts) {
  return db.prepare(`
    UPDATE items SET status='claimed', worker=?, claimed_at=?, attempts=attempts+1, updated_at=?
    WHERE id = (SELECT id FROM items WHERE status='queued' AND attempts < ? ORDER BY seq LIMIT 1)
    RETURNING *`).get(worker, now(), now(), maxAttempts) ?? null;
}

export function finish(db, id, status, { description = null, error = null } = {}) {
  db.prepare("UPDATE items SET status=?, description=COALESCE(?, description), error=?, updated_at=? WHERE id=?")
    .run(status, description, error, now(), id);
}

export function requeue(db, id, error) {
  db.prepare("UPDATE items SET status='queued', error=?, updated_at=? WHERE id=?").run(error, now(), id);
}

// Claims left behind by a crash go back on the queue.
export function releaseStale(db, olderThanMs = 5 * 60_000) {
  // An interrupted attempt doesn't count, so items on their last attempt stay claimable.
  return Number(db.prepare(`UPDATE items SET status='queued', worker=NULL, attempts=MAX(attempts-1, 0)
                            WHERE status='claimed' AND claimed_at <= ?`).run(now() - olderThanMs).changes);
}

// For --overwrite: put items this tool already described back on the queue. User descriptions never match.
export function requeueOurs(db, marker) {
  return Number(db.prepare(`UPDATE items SET status='queued', attempts=0, worker=NULL
                            WHERE status IN ('done','skipped') AND substr(description, 1, ?) = ?`)
    .run(marker.length, marker).changes);
}

export function stats(db, windowMs = 10 * 60_000) {
  const counts = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) n FROM items GROUP BY status").all().map(r => [r.status, r.n]));
  const since = now() - windowMs;
  const recentDone = db.prepare("SELECT COUNT(*) n FROM items WHERE status IN ('done','skipped') AND updated_at > ?").get(since).n;
  const perWorker = db.prepare(`SELECT worker, COUNT(*) n FROM events WHERE topic='item.done' AND ts > ? GROUP BY worker`).all(since);
  const errors = db.prepare(`SELECT json_extract(data,'$.stage') stage, COUNT(*) n FROM events
                             WHERE topic='item.error' AND ts > ? GROUP BY stage`).all(since);
  const lastErrors = db.prepare(`SELECT worker, item_id, data FROM events WHERE topic='item.error' ORDER BY id DESC LIMIT 5`).all();
  const firstTs = db.prepare("SELECT MIN(ts) t FROM events WHERE topic IN ('item.done','item.skipped') AND ts > ?").get(since).t;
  const spanMin = firstTs ? Math.max(0.5, (now() - firstTs) / 60_000) : windowMs / 60_000;
  const perMin = recentDone / spanMin;
  const remaining = (counts.queued ?? 0) + (counts.claimed ?? 0);
  return {
    counts, remaining, per_min: Number(perMin.toFixed(1)),
    eta_min: perMin > 0 ? Math.round(remaining / perMin) : null,
    per_worker: perWorker, errors_by_stage: errors,
    last_errors: lastErrors.map(e => ({ ...e, data: JSON.parse(e.data) })),
    control: getControl(db),
  };
}
