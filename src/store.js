// store.js — SQLite persistence layer.
//
// Everything polibrief remembers lives here:
//   - which items it has already seen (so nothing is ever re-processed or re-summarized)
//   - when each source last succeeded (drives incremental "only fetch new stuff" windows)
//   - an index of saved briefs
//   - rough Anthropic token usage (powers the `audit` command's cost estimate)
//
// The database file (polibrief.db) sits in the project root, next to watchlist.json.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Where mutable data (database, briefings) lives. Defaults to the project root;
// Docker/Umbrel set POLIBRIEF_DATA_DIR to a mounted volume so data survives updates.
const DATA_DIR = process.env.POLIBRIEF_DATA_DIR
  ? path.resolve(process.env.POLIBRIEF_DATA_DIR)
  : PROJECT_ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "polibrief.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_items (
    uid            TEXT PRIMARY KEY,
    source_id      TEXT NOT NULL,
    first_seen_at  TEXT NOT NULL,
    triage_verdict TEXT,            -- 'relevant' | 'irrelevant' | 'unscored'
    triage_topics  TEXT,            -- JSON array of topic ids
    title          TEXT,
    url            TEXT,
    jurisdiction   TEXT,
    one_line       TEXT             -- Haiku's one-line "why it matters" (relevant items only)
  );

  CREATE TABLE IF NOT EXISTS runs (
    source_id       TEXT PRIMARY KEY,
    last_success_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS briefs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    edition    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    path       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    model         TEXT NOT NULL,
    purpose       TEXT NOT NULL,    -- 'triage' | 'brief' | 'query' | 'weekly'
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracked_items (
    uid          TEXT PRIMARY KEY,   -- the seen_items uid at time of pinning
    track_key    TEXT NOT NULL,      -- stable identity across updates (LegiScan bill_id, else uid)
    title        TEXT,
    url          TEXT,
    jurisdiction TEXT,
    tracked_at   TEXT NOT NULL
  );
`);

// Column migrations for databases created by earlier versions. Adding a column
// that already exists throws — that's how we know it's already migrated.
for (const columnDef of [
  "comment_deadline TEXT", // from raw.commentsCloseOn (Federal Register / regulations.gov)
  "doc_type TEXT",
  "published_at TEXT",
  "feedback TEXT", // 'up' | 'down' from the web UI — feeds triage few-shots
  "entity_id TEXT", // resolved registry entity (v2: rss/email-intake items)
  "item_type TEXT", // news|statement|bill_action|vote|event|fundraiser (v2)
  "geo TEXT", // JSON {county, districts} for events/entity items (v2)
  "body TEXT", // item body/summary text (esp. email bodies) — feeds the deeper News digest
  "feedback_note TEXT", // free-text note on 👍/👎, fed into the triage prompt as guidance
  "archived INTEGER DEFAULT 0", // set-aside items — out of the main LRD list, recoverable
]) {
  try {
    db.exec(`ALTER TABLE seen_items ADD COLUMN ${columnDef}`);
  } catch {
    /* column already exists */
  }
}

// Cached on-demand AI document summaries (web UI "AI summary" panel). Cached until
// the item's comment deadline (the document doesn't change before then), or a
// default window — see summarize.summaryExpiry.
db.exec(`
  CREATE TABLE IF NOT EXISTS item_summaries (
    uid        TEXT PRIMARY KEY,
    summary    TEXT NOT NULL,
    model      TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT
  );
`);

// ---------------------------------------------------------------------------
// v2 Entity Registry + geo cache. Additive — the v1.2 brief pipeline never
// reads these tables, so shipping this alongside the running app is safe.
// The registry is the backbone of v2: WHO we watch (entity) and HOW each one
// publishes (channel). See src/registry.js. geo_cache memoizes address→county
// lookups (src/geo.js) so we never re-hit the Census geocoder for one place.
db.exec(`
  CREATE TABLE IF NOT EXISTS entity (
    id           TEXT PRIMARY KEY,      -- stable slug ('us-sen-grassley') or 'system:extid'
    type         TEXT NOT NULL,         -- candidate|officeholder|party_org|committee|caucus
    full_name    TEXT NOT NULL,
    party        TEXT,                  -- R|D|I|NP|other
    office       TEXT,
    district     TEXT,
    ocd_id       TEXT,
    level        TEXT,                  -- federal|state|county|local
    counties     TEXT,                  -- JSON array of county names ('*' = statewide)
    incumbent    INTEGER,               -- 0|1
    status       TEXT DEFAULT 'active', -- active|inactive|withdrawn
    external_ids TEXT,                  -- JSON {fec_id, openstates_person_id, bioguide, ...}
    notes        TEXT,
    source       TEXT,                  -- seed|openstates|fec|socrata|manual
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel (
    id            TEXT PRIMARY KEY,     -- '<entity_id>::<kind>::<target>'
    entity_id     TEXT NOT NULL,
    kind          TEXT NOT NULL,        -- website|rss|ical|mobilize|eventbrite|x_handle|fb_page|newsletter_email|press_page|api
    url_or_handle TEXT NOT NULL,
    org_id        TEXT,                 -- platform id (Mobilize org, Eventbrite organizer, plus-address tag)
    active        INTEGER DEFAULT 1,
    last_ok_at    TEXT,                 -- channel health: last successful fetch
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_channel_entity ON channel(entity_id);
  CREATE INDEX IF NOT EXISTS idx_channel_kind   ON channel(kind);

  CREATE TABLE IF NOT EXISTS geo_cache (
    key         TEXT PRIMARY KEY,       -- normalized address / 'venue:<name>|<city>'
    county      TEXT,
    county_fips TEXT,
    state       TEXT,
    lat         REAL,
    lng         REAL,
    districts   TEXT,                   -- JSON {cd, sldl, sldu}
    resolved_at TEXT NOT NULL
  );
`);

// ---------- market timeseries (v1.5 Markets charts + CSV) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS market_series (
    series TEXT NOT NULL,       -- e.g. "eia:feedstock:soybean-oil"
    period TEXT NOT NULL,       -- "YYYY-MM" or "YYYY-MM-DD"
    value  REAL,
    PRIMARY KEY (series, period)
  );
  CREATE TABLE IF NOT EXISTS market_series_meta (
    series     TEXT PRIMARY KEY,
    label      TEXT,
    unit       TEXT,
    category   TEXT,            -- groups series into one chart (e.g. "biofuel_feedstock")
    updated_at TEXT
  );
`);

const stmtUpsertSeriesPoint = db.prepare(
  `INSERT INTO market_series (series, period, value) VALUES (?, ?, ?)
     ON CONFLICT(series, period) DO UPDATE SET value = excluded.value`
);
const stmtUpsertSeriesMeta = db.prepare(
  `INSERT INTO market_series_meta (series, label, unit, category, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(series) DO UPDATE SET label=excluded.label, unit=excluded.unit, category=excluded.category, updated_at=excluded.updated_at`
);
// Memoized marketSnapshot() result. The snapshot is derived purely from market_series /
// market_series_meta, which only change via saveSeriesPoints() — so we compute it once and
// hand back the same object until the series data changes. Invalidated below on every write.
// (All callers treat the result as read-only — see marketSnapshot's contract note.)
let _snapshotCache = null;

/** Upsert a whole timeseries (idempotent — safe to re-refresh each run). */
export function saveSeriesPoints(series, meta, points) {
  const run = db.transaction(() => {
    stmtUpsertSeriesMeta.run(series, meta.label ?? series, meta.unit ?? "", meta.category ?? "", new Date().toISOString());
    for (const p of points ?? []) {
      if (p && p.period != null && p.value != null && !Number.isNaN(Number(p.value))) {
        stmtUpsertSeriesPoint.run(series, String(p.period), Number(p.value));
      }
    }
  });
  run();
  _snapshotCache = null; // series data changed → drop the memoized snapshot
}
export function getSeries(series) {
  return db.prepare("SELECT period, value FROM market_series WHERE series = ? ORDER BY period").all(series);
}
export function listSeriesMeta(category = null) {
  return category
    ? db.prepare("SELECT * FROM market_series_meta WHERE category = ? ORDER BY label").all(category)
    : db.prepare("SELECT * FROM market_series_meta ORDER BY category, label").all();
}

/** "YYYY", "YYYY-MM", or "YYYY-MM-DD" → epoch ms (UTC), or null. */
function periodToMs(p) {
  const m = String(p).split("-");
  if (!/^\d{4}$/.test(m[0])) return null;
  const t = Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1);
  return Number.isNaN(t) ? null : t;
}

/**
 * Deep trend snapshot of every market series — computed over the FULL stored history,
 * so the query engine can teach trends, not just report the latest number. Per series:
 * latest + prior change, year-over-year, historical range + where the latest sits
 * (percentile), a seasonal read (vs. the same month across years), and a 12-point trail.
 * This is what lets "Ask the Bean Brief" (and the memos) answer "is this seasonally
 * normal / how does it compare to five years ago" from data we already keep. Cheap:
 * ~20 series × SQLite reads + arithmetic, a few hundred points each — but it's called
 * several times per operation (signals, alerts, cards, memos, the Ask box, every Markets
 * render), so the result is memoized (invalidated in saveSeriesPoints). CONTRACT: callers
 * must treat the returned array and its objects as read-only (they share one cached copy).
 */
export function marketSnapshot() {
  if (_snapshotCache) return _snapshotCache;
  const metas = db.prepare("SELECT series, label, unit, category FROM market_series_meta ORDER BY category, label").all();
  const out = [];
  for (const m of metas) {
    const pts = db.prepare("SELECT period, value FROM market_series WHERE series = ? ORDER BY period").all(m.series);
    const n = pts.length;
    if (!n) continue;
    const latest = pts[n - 1];
    const previous = n > 1 ? pts[n - 2] : null;
    const changeAbs = previous ? latest.value - previous.value : null;
    const changePct = previous && previous.value ? ((latest.value - previous.value) / Math.abs(previous.value)) * 100 : null;

    // Year-ago: the point closest to (latest date − 365d), if one lands within ~45 days.
    const latestMs = periodToMs(latest.period);
    let yearAgo = null;
    if (latestMs != null) {
      const target = latestMs - 365 * 864e5;
      let bestDiff = Infinity;
      for (const p of pts) {
        const ms = periodToMs(p.period);
        if (ms == null) continue;
        const d = Math.abs(ms - target);
        if (d < bestDiff) { bestDiff = d; yearAgo = p; }
      }
      if (bestDiff > 50 * 864e5) yearAgo = null; // no comparable point ~a year back
    }
    const yoyPct = yearAgo && yearAgo.value ? ((latest.value - yearAgo.value) / Math.abs(yearAgo.value)) * 100 : null;

    // Full-history range, average, and the latest's percentile within it.
    let min = pts[0], max = pts[0], sum = 0;
    for (const p of pts) { if (p.value < min.value) min = p; if (p.value > max.value) max = p; sum += p.value; }
    const avg = sum / n;
    const percentile = Math.round((pts.filter((p) => p.value <= latest.value).length / n) * 100);

    // Seasonal: latest vs. the same calendar month averaged across all years.
    const lm = latest.period.slice(5, 7);
    const sameMonth = pts.filter((p) => p.period.slice(5, 7) === lm);
    let seasonalAvg = null, seasonalDeltaPct = null, seasonalPctile = null;
    if (sameMonth.length >= 3) {
      seasonalAvg = sameMonth.reduce((a, p) => a + p.value, 0) / sameMonth.length;
      seasonalDeltaPct = seasonalAvg ? ((latest.value - seasonalAvg) / Math.abs(seasonalAvg)) * 100 : null;
      seasonalPctile = Math.round((sameMonth.filter((p) => p.value <= latest.value).length / sameMonth.length) * 100);
    }

    out.push({
      series: m.series, label: m.label, unit: m.unit, category: m.category,
      latest, previous, changeAbs, changePct,
      yearAgo, yoyPct,
      min, max, avg, percentile,
      seasonalAvg, seasonalDeltaPct, seasonalPctile,
      count: n, firstPeriod: pts[0].period,
      trail: pts.slice(-12),
    });
  }
  _snapshotCache = out;
  return out;
}

/**
 * Full history for one series (+ meta) — for on-demand deep dives when a question
 * targets a specific series and the snapshot's summary stats aren't enough.
 */
export function seriesHistory(series) {
  const meta = db.prepare("SELECT series, label, unit, category FROM market_series_meta WHERE series = ?").get(series);
  if (!meta) return null;
  const points = db.prepare("SELECT period, value FROM market_series WHERE series = ? ORDER BY period").all(series);
  return { ...meta, points };
}

/**
 * Data-freshness check: for every series, how old its latest data point is vs. its own
 * cadence (inferred from the median spacing of recent points). A series is `stale` when its
 * newest point is overdue — that's how a silently-broken feed stops looking like a quiet
 * market. Returns rows sorted oldest-first.
 */
export function seriesFreshness() {
  const metas = db.prepare("SELECT series, label, category, updated_at FROM market_series_meta").all();
  const out = [];
  for (const m of metas) {
    const pts = db.prepare("SELECT period FROM market_series WHERE series = ? ORDER BY period DESC LIMIT 8").all(m.series);
    const latestMs = pts.length ? periodToMs(pts[0].period) : null;
    if (latestMs == null) continue;
    const ageDays = Math.round((Date.now() - latestMs) / 86400e3);
    const gaps = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = periodToMs(pts[i].period), b = periodToMs(pts[i + 1].period);
      if (a != null && b != null) gaps.push((a - b) / 86400e3);
    }
    gaps.sort((x, y) => x - y);
    const cadenceDays = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : 30;
    // Overdue only well past its own rhythm — so a source's normal publication lag (e.g. EIA
    // feedstocks run ~3 months behind) doesn't cry wolf; a genuinely-dead feed still flags.
    const stale = ageDays > Math.max(cadenceDays * 3.5, 18);
    out.push({ series: m.series, label: m.label, category: m.category, latest: pts[0].period, ageDays, cadenceDays, stale, refreshedAt: m.updated_at });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

// ---------- curriculum + glossary (BeanBrief education engine) ----------
// The knowledge base behind the "teach, don't tell" education layer: a rotating concept
// bank (drives the daily brief's teaching thread) + a plain-language glossary. See
// docs/beanbrief_education_engine.md §3/§5d.
db.exec(`
  CREATE TABLE IF NOT EXISTS concepts (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    domain        TEXT,
    season_window TEXT,        -- JSON array of months 1..12, or "*" = timely any time
    last_used     TEXT
  );
  CREATE TABLE IF NOT EXISTS glossary (
    term       TEXT PRIMARY KEY,
    definition TEXT NOT NULL
  );
`);

/** Insert/replace a concept, preserving its last_used across re-seeds (idempotent seeding). */
export function upsertConcept(c) {
  db.prepare(
    `INSERT INTO concepts (id, title, body, domain, season_window, last_used)
       VALUES (@id, @title, @body, @domain, @season_window, NULL)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, body = excluded.body,
       domain = excluded.domain, season_window = excluded.season_window`
  ).run({
    id: c.id,
    title: c.title,
    body: c.body,
    domain: c.domain ?? null,
    season_window: JSON.stringify(c.seasonWindow ?? c.season_window ?? "*"),
  });
  return c.id;
}

export function listConcepts() {
  return db.prepare("SELECT * FROM concepts ORDER BY domain, title").all();
}

/**
 * Season-aware, least-recently-used concept pick for the daily teaching thread.
 * Filters to concepts timely for `month` (1..12; season_window "*" = always eligible),
 * picks the least-recently-used, stamps last_used, and returns it.
 */
export function pickConcept(month = new Date().getUTCMonth() + 1) {
  const all = db.prepare("SELECT * FROM concepts").all();
  const eligible = all.filter((c) => {
    let w;
    try { w = JSON.parse(c.season_window); } catch { w = "*"; }
    return w === "*" || (Array.isArray(w) && w.includes(month));
  });
  const pool = eligible.length ? eligible : all;
  if (!pool.length) return null;
  pool.sort((a, b) => (a.last_used ?? "").localeCompare(b.last_used ?? "")); // never-used (NULL/"") first
  const pick = pool[0];
  db.prepare("UPDATE concepts SET last_used = ? WHERE id = ?").run(new Date().toISOString(), pick.id);
  return pick;
}

export function upsertGlossaryTerm(term, definition) {
  db.prepare(
    `INSERT INTO glossary (term, definition) VALUES (?, ?)
     ON CONFLICT(term) DO UPDATE SET definition = excluded.definition`
  ).run(term, definition);
}
export function getGlossary() {
  return db.prepare("SELECT term, definition FROM glossary ORDER BY term").all();
}
export function getTerm(term) {
  return db.prepare("SELECT term, definition FROM glossary WHERE term = ? COLLATE NOCASE").get(term);
}

// ---------- change alerts ("what changed" feed) + tiny kv state ----------
// Alerts fire when the market data materially moves (a signal flips, a series hits a multi-year
// extreme, a big single-period jump) — event-driven, not on a timer. kv_state holds the prior
// snapshot the detector compares against (see src/alerts.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    category   TEXT,
    title      TEXT NOT NULL,
    detail     TEXT,
    seen       INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS kv_state ( k TEXT PRIMARY KEY, v TEXT, updated_at TEXT );
`);

// ---------- storylines (named threads with memory) ----------
// The handful of ongoing THREADS the monitoring is really about (45Z, EUDR, Summit CO2 pipeline…).
// Auto-clustered from recent relevant items each run (see pipeline.generateStorylines), but PERSISTENT:
// a thread keeps its key + first_seen across updates, so "what changed this week" and the timeline
// accumulate rather than resetting. Extends the manual tracked_items pins with automatic threads.
db.exec(`
  CREATE TABLE IF NOT EXISTS storylines (
    key        TEXT PRIMARY KEY,   -- stable kebab slug (kept across updates)
    name       TEXT NOT NULL,
    focus      TEXT,               -- one-line what the thread is about
    summary    TEXT,               -- latest "what changed & why it matters"
    timeline   TEXT,               -- JSON array [{date, event, url}] most-recent-first
    item_count INTEGER DEFAULT 0,
    first_seen TEXT,               -- when the thread first appeared (never overwritten)
    updated_at TEXT NOT NULL
  );
`);
export function upsertStoryline(s) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO storylines (key, name, focus, summary, timeline, item_count, first_seen, updated_at)
       VALUES (@key, @name, @focus, @summary, @timeline, @item_count, @now, @now)
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name, focus = excluded.focus, summary = excluded.summary,
       timeline = excluded.timeline, item_count = excluded.item_count, updated_at = excluded.updated_at`
  ).run({
    key: s.key,
    name: s.name,
    focus: s.focus ?? null,
    summary: s.summary ?? null,
    timeline: JSON.stringify(s.timeline ?? []),
    item_count: s.itemCount ?? (Array.isArray(s.timeline) ? s.timeline.length : 0),
    now,
  });
  return s.key;
}
export function listStorylines(limit = 12) {
  return db
    .prepare("SELECT * FROM storylines ORDER BY updated_at DESC, item_count DESC LIMIT ?")
    .all(limit)
    .map((r) => {
      let timeline = [];
      try {
        timeline = JSON.parse(r.timeline || "[]");
      } catch {
        /* leave empty */
      }
      return { ...r, timeline };
    });
}
/** Drop threads not refreshed in `maxAgeDays` — a storyline that stopped developing ages off. */
export function pruneStorylines(maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400e3).toISOString();
  db.prepare("DELETE FROM storylines WHERE updated_at < ?").run(cutoff);
}
export function recordAlert(category, title, detail) {
  db.prepare("INSERT INTO alerts (created_at, category, title, detail, seen) VALUES (?, ?, ?, ?, 0)").run(
    new Date().toISOString(), category ?? null, title, detail ?? null
  );
}
export function listAlerts(limit = 40) {
  return db.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit);
}
export function unseenAlertCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE seen = 0").get().n;
}
export function markAlertsSeen() {
  db.prepare("UPDATE alerts SET seen = 1 WHERE seen = 0").run();
}
export function getState(k) {
  const r = db.prepare("SELECT v FROM kv_state WHERE k = ?").get(k);
  return r ? r.v : undefined;
}
export function setState(k, v) {
  db.prepare(
    "INSERT INTO kv_state (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
  ).run(k, String(v), new Date().toISOString());
}

const stmtIsSeen = db.prepare("SELECT 1 FROM seen_items WHERE uid = ?");
const stmtMarkSeen = db.prepare(`
  INSERT INTO seen_items (uid, source_id, first_seen_at, triage_verdict, triage_topics, title, url, jurisdiction, one_line,
                          comment_deadline, doc_type, published_at, entity_id, item_type, geo, body)
  VALUES (@uid, @sourceId, @firstSeenAt, @verdict, @topics, @title, @url, @jurisdiction, @oneLine,
          @commentDeadline, @docType, @publishedAt, @entityId, @itemType, @geo, @body)
  ON CONFLICT(uid) DO UPDATE SET
    triage_verdict = excluded.triage_verdict,
    triage_topics  = excluded.triage_topics,
    one_line       = excluded.one_line,
    entity_id      = COALESCE(excluded.entity_id, seen_items.entity_id),
    item_type      = COALESCE(excluded.item_type, seen_items.item_type),
    geo            = COALESCE(excluded.geo, seen_items.geo),
    body           = COALESCE(excluded.body, seen_items.body)
`);
const stmtGetSince = db.prepare("SELECT last_success_at FROM runs WHERE source_id = ?");
const stmtSetLastSuccess = db.prepare(`
  INSERT INTO runs (source_id, last_success_at) VALUES (?, ?)
  ON CONFLICT(source_id) DO UPDATE SET last_success_at = excluded.last_success_at
`);

export function isSeen(uid) {
  return stmtIsSeen.get(uid) !== undefined;
}

/**
 * Record an item so it is never processed again.
 * verdict: { relevant: boolean, topicIds: string[], oneLine: string } or null (seen but not triaged).
 */
export function markSeen(item, verdict = null) {
  stmtMarkSeen.run({
    uid: item.uid,
    sourceId: item.sourceId,
    firstSeenAt: new Date().toISOString(),
    verdict: verdict === null ? "unscored" : verdict.relevant ? "relevant" : "irrelevant",
    topics: JSON.stringify(verdict?.topicIds ?? []),
    title: item.title ?? null,
    url: item.url ?? null,
    jurisdiction: item.jurisdiction ?? null,
    oneLine: verdict?.oneLine ?? null,
    commentDeadline: item.raw?.commentsCloseOn ?? null,
    docType: item.docType ?? null,
    publishedAt: item.publishedAt ?? null,
    entityId: item.raw?.entityId ?? null,
    itemType: verdict?.type ?? item.raw?.itemType ?? null,
    geo: item.raw?.geo ? JSON.stringify(item.raw.geo) : null,
    body: item.summary ? String(item.summary).slice(0, 4000) : null,
  });
}

/**
 * The incremental window start for a source: its last successful run,
 * capped at `fallbackDays` ago on first run so we never fetch the whole archive.
 */
export function getSince(sourceId, fallbackDays = 7) {
  const fallback = new Date(Date.now() - fallbackDays * 24 * 60 * 60 * 1000);
  const row = stmtGetSince.get(sourceId);
  if (!row) return fallback.toISOString();
  const last = new Date(row.last_success_at);
  // Guard against a corrupted/future timestamp making the window empty forever.
  if (Number.isNaN(last.getTime()) || last > new Date()) return fallback.toISOString();
  return last.toISOString();
}

export function setLastSuccess(sourceId, iso = new Date().toISOString()) {
  stmtSetLastSuccess.run(sourceId, iso);
}

export function recordBrief(edition, filePath) {
  db.prepare("INSERT INTO briefs (edition, created_at, path) VALUES (?, ?, ?)").run(
    edition,
    new Date().toISOString(),
    filePath
  );
}

export function listBriefs(limit = 50) {
  // A re-run of the same edition overwrites the same file; show each file once.
  return db
    .prepare(
      `SELECT edition, MAX(created_at) AS created_at, path
         FROM briefs GROUP BY path ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit);
}

export function recordUsage(model, purpose, inputTokens, outputTokens) {
  db.prepare(
    "INSERT INTO token_usage (ts, model, purpose, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)"
  ).run(new Date().toISOString(), model, purpose, inputTokens ?? 0, outputTokens ?? 0);
}

/** Per-source item counts + last-success times, and this month's token usage, for `audit`. */
export function getAuditData() {
  const sourceCounts = db
    .prepare(
      `SELECT source_id,
              COUNT(*) AS total,
              SUM(CASE WHEN triage_verdict = 'relevant' THEN 1 ELSE 0 END) AS relevant
         FROM seen_items GROUP BY source_id ORDER BY source_id`
    )
    .all();
  const lastRuns = db.prepare("SELECT source_id, last_success_at FROM runs ORDER BY source_id").all();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthUsage = db
    .prepare(
      `SELECT model,
              SUM(input_tokens)  AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              COUNT(*)           AS calls
         FROM token_usage WHERE ts >= ? GROUP BY model ORDER BY model`
    )
    .all(monthStart.toISOString());
  const briefCount = db.prepare("SELECT COUNT(*) AS n FROM briefs").get().n;
  return { sourceCounts, lastRuns, monthUsage, briefCount };
}

/** Per-source activity for the web UI dashboard: items seen in the last N days + last successful check. */
export function getSourceStats(days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = {};
  for (const row of db
    .prepare(
      `SELECT source_id,
              COUNT(*) AS seen,
              SUM(CASE WHEN triage_verdict = 'relevant' THEN 1 ELSE 0 END) AS relevant
         FROM seen_items WHERE first_seen_at >= ? GROUP BY source_id`
    )
    .all(cutoff)) {
    stats[row.source_id] = { seen: row.seen, relevant: row.relevant ?? 0, lastSuccess: null };
  }
  for (const row of db.prepare("SELECT source_id, last_success_at FROM runs").all()) {
    stats[row.source_id] = { seen: 0, relevant: 0, ...stats[row.source_id], lastSuccess: row.last_success_at };
  }
  return stats;
}

/** Case-insensitive search over triaged items, newest first — used by the `query` command. */
export function searchSeenItems(term, limit = 30) {
  const like = `%${term}%`;
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, triage_verdict, triage_topics, one_line, first_seen_at
         FROM seen_items
        WHERE (title LIKE ? COLLATE NOCASE OR one_line LIKE ? COLLATE NOCASE)
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(like, like, limit);
}

// ---------------------------------------------------------------------------
// On-demand AI summaries (web UI "AI summary" panel)

/** Full stored row for one item, for the summarizer. */
export function getItemByUid(uid) {
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, one_line, triage_topics,
              comment_deadline, doc_type, published_at, entity_id, item_type, geo
         FROM seen_items WHERE uid = ?`
    )
    .get(uid);
}

/** A cached, non-expired AI summary for an item, or undefined. */
export function getSummary(uid) {
  const row = db
    .prepare("SELECT uid, summary, model, created_at, expires_at FROM item_summaries WHERE uid = ?")
    .get(uid);
  if (!row) return undefined;
  // Summaries are permanent once generated: re-opening the panel always returns the
  // stored summary (never a fresh AI call), and it survives version updates (DB is in /data).
  return row;
}

/** Store (or replace) an AI summary with an expiry timestamp. */
export function saveSummary(uid, summary, model, expiresAt = null) {
  db.prepare(
    `INSERT INTO item_summaries (uid, summary, model, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       summary = excluded.summary, model = excluded.model,
       created_at = excluded.created_at, expires_at = excluded.expires_at`
  ).run(uid, summary, model ?? null, new Date().toISOString(), expiresAt);
}

/** Set of item uids that currently have a cached, non-expired summary. */
export function summarizedUids() {
  // Any item that has a stored summary (permanent) — used to mark the 🧠 icon as "stored".
  return new Set(db.prepare("SELECT uid FROM item_summaries").all().map((r) => r.uid));
}

// ---------------------------------------------------------------------------
// Item browsing, feedback, and tracking (web UI)

/**
 * Filterable listing of stored items for the /items page.
 * filters: { q, topicId, sourceId, verdict, days, limit }
 */
export function listItems({ q = "", topicId = "", sourceId = "", sourceIds = null, verdict = "", days = 30, limit = 200, archived = null } = {}) {
  const clauses = ["first_seen_at >= ?"];
  const params = [new Date(Date.now() - days * 86400e3).toISOString()];
  if (archived !== null) {
    clauses.push("COALESCE(archived, 0) = ?");
    params.push(archived ? 1 : 0);
  }
  if (q) {
    clauses.push("(title LIKE ? COLLATE NOCASE OR one_line LIKE ? COLLATE NOCASE)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (topicId) {
    clauses.push("triage_topics LIKE ?");
    params.push(`%"${topicId}"%`);
  }
  if (sourceId) {
    clauses.push("source_id = ?");
    params.push(sourceId);
  }
  // Restrict to a set of sources (used to scope the Items/News/Markets tabs by class).
  if (sourceIds && sourceIds.length) {
    clauses.push(`source_id IN (${sourceIds.map(() => "?").join(",")})`);
    params.push(...sourceIds);
  }
  if (verdict) {
    clauses.push("triage_verdict = ?");
    params.push(verdict);
  }
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, doc_type, triage_verdict, triage_topics,
              one_line, comment_deadline, published_at, first_seen_at, feedback, feedback_note, entity_id, item_type, geo, body
         FROM seen_items WHERE ${clauses.join(" AND ")}
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(...params, Math.min(limit, 500));
}

export function setFeedback(uid, feedback, note) {
  // feedback: 'up' | 'down' | null (clear). note: optional free-text (undefined = leave as-is).
  if (note === undefined) {
    db.prepare("UPDATE seen_items SET feedback = ? WHERE uid = ?").run(feedback, uid);
  } else {
    db.prepare("UPDATE seen_items SET feedback = ?, feedback_note = ? WHERE uid = ?").run(feedback, note || null, uid);
  }
}

/** Set-aside / restore an item (archived items drop out of the main LRD list, recoverable). */
export function archiveItem(uid, on = true) {
  db.prepare("UPDATE seen_items SET archived = ? WHERE uid = ?").run(on ? 1 : 0, uid);
}
export function archivedCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM seen_items WHERE COALESCE(archived, 0) = 1").get().n;
}

/** Recent human corrections for the triage prompt: items where the human disagreed with Haiku,
 *  including any free-text note they left. */
export function getFeedbackExamples(limit = 8) {
  return db
    .prepare(
      `SELECT title, triage_verdict, feedback, feedback_note FROM seen_items
        WHERE feedback IS NOT NULL
          AND ((feedback = 'down' AND triage_verdict = 'relevant') OR (feedback = 'up' AND triage_verdict = 'irrelevant') OR feedback_note IS NOT NULL)
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(limit);
}

export function trackItem(uid) {
  const item = db.prepare("SELECT uid, title, url, jurisdiction FROM seen_items WHERE uid = ?").get(uid);
  if (!item) return false;
  // LegiScan uids look like legiscan:<bill_id>:<hash8> — the bill_id is the stable
  // identity across status changes, so track that; everything else tracks by uid.
  const m = uid.match(/^legiscan:(\d+):/);
  const trackKey = m ? `legiscan-bill:${m[1]}` : uid;
  db.prepare(
    "INSERT OR REPLACE INTO tracked_items (uid, track_key, title, url, jurisdiction, tracked_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(uid, trackKey, item.title, item.url, item.jurisdiction, new Date().toISOString());
  return true;
}

export function untrackItem(uid) {
  db.prepare("DELETE FROM tracked_items WHERE uid = ?").run(uid);
}

export function listTracked() {
  return db.prepare("SELECT * FROM tracked_items ORDER BY tracked_at DESC").all();
}

/** The set of stable track keys, for flagging movement during a run. */
export function trackedKeySet() {
  return new Set(db.prepare("SELECT track_key FROM tracked_items").all().map((r) => r.track_key));
}

/** Upcoming comment deadlines (for the .ics calendar + UI), soonest first. */
export function upcomingDeadlines(limit = 100) {
  const today = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT uid, title, url, comment_deadline, one_line, source_id FROM seen_items
        WHERE comment_deadline IS NOT NULL AND comment_deadline >= ?
        ORDER BY comment_deadline ASC LIMIT ?`
    )
    .all(today, limit);
}

/** Per-day item counts for sparklines: {topicId → number[days]} plus a total series. */
export function activitySeries(topics, days = 28) {
  const start = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = db
    .prepare("SELECT first_seen_at, triage_topics FROM seen_items WHERE first_seen_at >= ?")
    .all(start);
  const dayIndex = (iso) => Math.min(days - 1, Math.max(0, Math.floor((Date.parse(iso) - Date.parse(start)) / 86400e3)));
  const series = { __all__: new Array(days).fill(0) };
  for (const t of topics) series[t.id] = new Array(days).fill(0);
  for (const row of rows) {
    const d = dayIndex(row.first_seen_at);
    series.__all__[d]++;
    let ids = [];
    try {
      ids = JSON.parse(row.triage_topics ?? "[]");
    } catch {
      /* ignore */
    }
    for (const id of ids) if (series[id]) series[id][d]++;
  }
  return series;
}

/** Online, safe SQLite backup + copies of watchlist/.env into DATA_DIR/backups/<date>/. */
export async function backupNow() {
  const dateLabel = new Date().toISOString().slice(0, 10);
  const dir = path.join(DATA_DIR, "backups", dateLabel);
  fs.mkdirSync(dir, { recursive: true });
  await db.backup(path.join(dir, "polibrief.db"));
  for (const name of ["watchlist.json", ".env"]) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  // Keep the newest 14 backups.
  const backupsRoot = path.join(DATA_DIR, "backups");
  const all = fs
    .readdirSync(backupsRoot)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse();
  for (const old of all.slice(14)) {
    fs.rmSync(path.join(backupsRoot, old), { recursive: true, force: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Entity Registry (v2) — CRUD used by src/registry.js, the seeders, and the UI.
// Additive to the v1 pipeline; see src/registry.js for how the seed populates these.

const stmtUpsertEntity = db.prepare(`
  INSERT INTO entity (id, type, full_name, party, office, district, ocd_id, level,
                      counties, incumbent, status, external_ids, notes, source, created_at, updated_at)
  VALUES (@id, @type, @full_name, @party, @office, @district, @ocd_id, @level,
          @counties, @incumbent, @status, @external_ids, @notes, @source, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type, full_name = excluded.full_name, party = excluded.party,
    office = excluded.office, district = excluded.district, ocd_id = excluded.ocd_id,
    level = excluded.level, counties = excluded.counties, incumbent = excluded.incumbent,
    status = excluded.status,
    external_ids = COALESCE(excluded.external_ids, entity.external_ids),
    notes = COALESCE(excluded.notes, entity.notes),
    source = excluded.source, updated_at = excluded.updated_at
`);

/** Insert or update an entity by id. Null external_ids/notes never clobber existing. */
export function upsertEntity(e) {
  const now = new Date().toISOString();
  const extIds = e.external_ids ?? e.externalIds;
  stmtUpsertEntity.run({
    id: e.id,
    type: e.type,
    full_name: e.full_name ?? e.fullName ?? "",
    party: e.party ?? null,
    office: e.office ?? null,
    district: e.district ?? null,
    ocd_id: e.ocd_id ?? e.ocdId ?? null,
    level: e.level ?? null,
    counties: e.counties ? JSON.stringify(e.counties) : null,
    incumbent: e.incumbent == null ? null : e.incumbent ? 1 : 0,
    status: e.status ?? "active",
    external_ids: extIds ? JSON.stringify(extIds) : null,
    notes: e.notes ?? null,
    source: e.source ?? "manual",
    now,
  });
  return e.id;
}

const stmtUpsertChannel = db.prepare(`
  INSERT INTO channel (id, entity_id, kind, url_or_handle, org_id, active, created_at, updated_at)
  VALUES (@id, @entity_id, @kind, @url_or_handle, @org_id, @active, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    entity_id = excluded.entity_id, kind = excluded.kind,
    url_or_handle = excluded.url_or_handle, org_id = excluded.org_id,
    active = excluded.active, updated_at = excluded.updated_at
`);

/** Insert or update a channel. Deterministic id (entity::kind::target) unless provided. */
export function upsertChannel(c) {
  const now = new Date().toISOString();
  const entityId = c.entity_id ?? c.entityId;
  const target = c.url_or_handle ?? c.url ?? c.handle ?? "";
  const id = c.id ?? `${entityId}::${c.kind}::${target}`;
  stmtUpsertChannel.run({
    id,
    entity_id: entityId,
    kind: c.kind,
    url_or_handle: target,
    org_id: c.org_id ?? c.orgId ?? null,
    active: c.active === false ? 0 : 1,
    now,
  });
  return id;
}

export function getEntity(id) {
  return db.prepare("SELECT * FROM entity WHERE id = ?").get(id);
}

/** List entities. `county` matches the JSON counties array (or statewide '*'). */
export function listEntities({ type, level, status = "active", county, limit = 5000 } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }
  if (level) {
    clauses.push("level = ?");
    params.push(level);
  }
  if (county) {
    clauses.push("(counties LIKE ? OR counties LIKE ?)");
    params.push(`%"${county}"%`, '%"*"%');
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM entity ${where} ORDER BY full_name LIMIT ?`).all(...params, limit);
}

export function listChannels({ kind, entityId, active = 1 } = {}) {
  const clauses = [];
  const params = [];
  if (active != null) {
    clauses.push("active = ?");
    params.push(active ? 1 : 0);
  }
  if (kind) {
    clauses.push("kind = ?");
    params.push(kind);
  }
  if (entityId) {
    clauses.push("entity_id = ?");
    params.push(entityId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM channel ${where}`).all(...params);
}

/** Channel health: record a successful fetch, or an error, for a channel. */
export function markChannelHealth(id, ok, error = null) {
  if (ok) {
    db.prepare("UPDATE channel SET last_ok_at = ?, last_error = NULL WHERE id = ?").run(new Date().toISOString(), id);
  } else {
    db.prepare("UPDATE channel SET last_error = ? WHERE id = ?").run(String(error ?? "").slice(0, 300), id);
  }
}

/** Active channels never fetched, or not fetched in `days` — the silent-failure guard. */
export function staleChannels(days = 10) {
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  return db.prepare("SELECT * FROM channel WHERE active = 1 AND (last_ok_at IS NULL OR last_ok_at < ?)").all(cutoff);
}

export function entityCountsByType() {
  return db.prepare("SELECT type, COUNT(*) AS n FROM entity WHERE status = 'active' GROUP BY type ORDER BY type").all();
}

export function getGeoCache(key) {
  return db.prepare("SELECT * FROM geo_cache WHERE key = ?").get(key);
}

export function saveGeoCache(key, g) {
  db.prepare(
    `INSERT INTO geo_cache (key, county, county_fips, state, lat, lng, districts, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET county = excluded.county, county_fips = excluded.county_fips,
       state = excluded.state, lat = excluded.lat, lng = excluded.lng,
       districts = excluded.districts, resolved_at = excluded.resolved_at`
  ).run(
    key,
    g.county ?? null,
    g.county_fips ?? null,
    g.state ?? null,
    g.lat ?? null,
    g.lng ?? null,
    g.districts ? JSON.stringify(g.districts) : null,
    new Date().toISOString()
  );
}

export { DB_PATH, PROJECT_ROOT, DATA_DIR };
