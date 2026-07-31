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

import { eventKeyFor } from "./eventkey.js";

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
  "deadline_archived INTEGER DEFAULT 0", // dismissed comment deadlines — separate archive from `archived`
  "triage_tier TEXT", // must_read | worth_knowing | background — graded relevance (NULL = triaged before tiers existed)
  // The cross-source identity of the government ACTION this row reports on (see eventkey.js).
  // NULL for everything stored before it existed; store.eventKeyOf() derives one on read so old
  // rows group correctly too, and `backfillEventKeys()` fills the column in on boot.
  "event_key TEXT",
  // WHEN the human gave feedback, as opposed to when the ITEM was collected.
  //
  // ⚠️ THIS FIXES A SILENT LOSS IN THE ONLY CHANNEL BY WHICH 👍/👎 CHANGES ANYTHING.
  // getFeedbackExamples used to order by `first_seen_at` — the item's collection date — while
  // selecting the most recent N. So a correction made TODAY on a three-week-old item sorted below
  // every newer item that happened to carry feedback, and never reached the triage prompt at all.
  // The analyst's most recent judgement was the one most likely to be dropped.
  "feedback_at TEXT",
]) {
  try {
    db.exec(`ALTER TABLE seen_items ADD COLUMN ${columnDef}`);
  } catch {
    /* column already exists */
  }
}

// Same additive pattern for token_usage. Separate loop because the one above is seen_items-specific.
for (const columnDef of [
  "cache_read_tokens INTEGER DEFAULT 0", // prompt-cache hits, billed at ~0.1x input
  "cache_write_tokens INTEGER DEFAULT 0", // prefix written to the cache, billed at ~1.25x (5-min TTL)
]) {
  try {
    db.exec(`ALTER TABLE token_usage ADD COLUMN ${columnDef}`);
  } catch {
    /* column already exists */
  }
}

// Indexes for the common seen_items scan patterns. listItems, getSourceStats,
// getAuditData, and activitySeries all filter or GROUP BY on first_seen_at / source_id /
// triage_verdict — without these, each is a full table scan that degrades as the table
// grows. IF NOT EXISTS + additive, so this auto-applies to existing databases (locally and
// on the Pi on the next container start after an Update). The composite (source_id,
// first_seen_at) covers the frequent source-scoped, time-ordered queries.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_seen_first_seen  ON seen_items(first_seen_at);
  CREATE INDEX IF NOT EXISTS idx_seen_source_seen ON seen_items(source_id, first_seen_at);
  CREATE INDEX IF NOT EXISTS idx_seen_verdict     ON seen_items(triage_verdict);
  CREATE INDEX IF NOT EXISTS idx_seen_deadline    ON seen_items(comment_deadline);
  CREATE INDEX IF NOT EXISTS idx_seen_doctype     ON seen_items(doc_type);
  CREATE INDEX IF NOT EXISTS idx_seen_event       ON seen_items(event_key);
`);

// Cached on-demand AI document summaries (web UI "AI summary" panel). Summaries are
// PERMANENT by design: a document doesn't change, so re-opening the panel always returns
// the stored summary and never pays for a fresh call. (Older schemas had an unused expires_at
// column — getSummary always ignored it; the migration below drops it.)
db.exec(`
  CREATE TABLE IF NOT EXISTS item_summaries (
    uid        TEXT PRIMARY KEY,
    summary    TEXT NOT NULL,
    model      TEXT,
    created_at TEXT NOT NULL
  );
`);
// Drop the vestigial expires_at from databases created before summaries were permanent.
// Fails harmlessly if already gone (fresh DB) or unsupported (old SQLite → stays a null column).
try { db.exec("ALTER TABLE item_summaries DROP COLUMN expires_at"); } catch { /* already dropped / not present */ }

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
/**
 * Everything the signal-card sparkline needs, in one pass: the last `n` points to draw, plus the
 * p10/p90 "normal range" and min/max computed over the series' FULL history (a band drawn from only
 * the visible tail would say nothing about whether today is unusual). Returns null for an unknown or
 * empty series so the caller can just omit the chart.
 */
export function seriesSpark(series, n = 24) {
  const pts = db.prepare("SELECT period, value FROM market_series WHERE series = ? ORDER BY period").all(series);
  if (!pts.length) return null;
  const meta = db.prepare("SELECT label, unit, category FROM market_series_meta WHERE series = ?").get(series) || {};
  const sorted = pts.map((p) => p.value).filter((v) => v != null).sort((a, b) => a - b);
  const q = (f) => {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * f, base = Math.floor(pos), rest = pos - base;
    return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
  };
  return {
    series,
    label: meta.label ?? series,
    unit: meta.unit ?? "",
    category: meta.category ?? "",
    points: pts.slice(-n),
    count: pts.length,
    firstPeriod: pts[0].period,
    p10: q(0.1),
    p90: q(0.9),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
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
    // changePct / yoyPct are assigned after `spread` is known, so the zero-crossing guard below can
    // suppress them the same way it suppresses seasonalDeltaPct.
    let changePct = null;
    let yoyPct = null;

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
    // (yoyPct assigned below, once the zero-crossing guard is available.)

    // Full-history range, average, and the latest's percentile within it.
    let min = pts[0], max = pts[0], sum = 0;
    for (const p of pts) { if (p.value < min.value) min = p; if (p.value > max.value) max = p; sum += p.value; }
    const avg = sum / n;
    const percentile = Math.round((pts.filter((p) => p.value <= latest.value).length / n) * 100);

    // ⚠️ PERCENT CHANGE IS NONSENSE ON A SERIES THAT CROSSES ZERO. Basis is the live example:
    // ams:ia:basis swings either side of zero, so a seasonal average near 0 produced
    // seasonalDeltaPct = -394.91 — a number that reads as a catastrophic move and goes straight into
    // the LLM prompt via formatMarketSnapshot. Suppress any percent whose denominator is tiny
    // relative to the series' own full-history spread; the absolute change (changeAbs) is still
    // reported and is the meaningful figure for these series.
    const spread = Math.abs(max.value - min.value);
    const pctMeaningful = (denom) => spread > 0 && Math.abs(denom) >= spread * 0.05;
    if (previous && pctMeaningful(previous.value)) changePct = ((latest.value - previous.value) / Math.abs(previous.value)) * 100;
    if (yearAgo && pctMeaningful(yearAgo.value)) yoyPct = ((latest.value - yearAgo.value) / Math.abs(yearAgo.value)) * 100;

    // --- MOMENTUM, in units of the series' OWN volatility -------------------------------------
    // Everything above is a level or a ratio; none of it says whether a series is accelerating.
    // Two additions, both scale-free so they're comparable across series:
    //   changeSigma — the typical size of one period-over-period move (stdev of consecutive diffs)
    //   changeZ     — the latest move measured in those sigmas
    //   slopePerSigma — trailing linear-regression slope, expressed in sigmas per period
    // Why sigma rather than percent: a flat "±20% is a big move" rule (which alerts.js used) is
    // meaningless across a portfolio this heterogeneous — 20% on barge freight is a normal week,
    // 20% on stocks-to-use is a regime change. Sigma makes "unusual" mean the same thing everywhere.
    const diffs = [];
    for (let i = 1; i < n; i++) diffs.push(pts[i].value - pts[i - 1].value);
    let changeSigma = null, changeZ = null, slopePerSigma = null;
    if (diffs.length >= 8) {
      const dMean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - dMean) ** 2, 0) / diffs.length);
      if (sd > 0) {
        changeSigma = sd;
        if (changeAbs != null) changeZ = changeAbs / sd;
        // Ordinary least squares over the trailing window, x = 0..k-1 (evenly spaced periods).
        // Deliberately index-spaced rather than time-spaced: it keeps the maths simple and the
        // series here are individually regular, even though their cadences differ from each other.
        const win = pts.slice(-Math.min(12, n));
        const k = win.length;
        if (k >= 4) {
          const xBar = (k - 1) / 2;
          const yBar = win.reduce((a, p) => a + p.value, 0) / k;
          let num = 0, den = 0;
          for (let i = 0; i < k; i++) { num += (i - xBar) * (win[i].value - yBar); den += (i - xBar) ** 2; }
          if (den > 0) slopePerSigma = num / den / sd;
        }
      }
    }

    // Seasonal: latest vs. the same calendar month averaged across all years.
    //
    // ⚠️ THE DISTINCT-YEAR REQUIREMENT IS LOAD-BEARING, don't relax it back to a bare count. The
    // guard used to be `sameMonth.length >= 3`, which says nothing about how many YEARS those
    // observations span. On a young weekly series every same-month point comes from the same month
    // of the SAME year: cropcasma:ia:rootzone-sm had exactly four July-2026 points, so the "seasonal
    // norm" was the mean of the three preceding weeks, and the delta against it got labelled
    // "vs. the seasonal norm" downstream. Worse, on a monotonically drying series that construction
    // GUARANTEES a negative delta — a permanent bullish bias manufactured out of nothing. It hit
    // vegscape VCI identically, i.e. both of the newest satellite feeds.
    //
    // Requiring observations from ≥3 distinct years costs nothing on the mature series (a weekly
    // series with 9 years of history has ~36 same-month points across 9 years) and correctly returns
    // null on a young one, which routes callers to their honest recent-trajectory fallback instead.
    const lm = latest.period.slice(5, 7);
    const sameMonth = pts.filter((p) => p.period.slice(5, 7) === lm);
    const seasonalYears = new Set(sameMonth.map((p) => p.period.slice(0, 4))).size;
    let seasonalAvg = null, seasonalDeltaPct = null, seasonalPctile = null;
    if (sameMonth.length >= 3 && seasonalYears >= 3) {
      seasonalAvg = sameMonth.reduce((a, p) => a + p.value, 0) / sameMonth.length;
      seasonalDeltaPct = pctMeaningful(seasonalAvg) ? ((latest.value - seasonalAvg) / Math.abs(seasonalAvg)) * 100 : null;
      // The seasonal PERCENTILE stays valid on a zero-crossing series — it's a rank, not a ratio.
      seasonalPctile = Math.round((sameMonth.filter((p) => p.value <= latest.value).length / sameMonth.length) * 100);
    }

    out.push({
      series: m.series, label: m.label, unit: m.unit, category: m.category,
      latest, previous, changeAbs, changePct,
      yearAgo, yoyPct,
      min, max, avg, percentile,
      // seasonalYears = how many distinct years the seasonal comparison actually spans. Exposed so
      // consumers (and the prompt context) can weigh a 9-year norm differently from a 3-year one.
      seasonalAvg, seasonalDeltaPct, seasonalPctile, seasonalYears,
      changeSigma, changeZ, slopePerSigma,
      // Distinct calendar years the WHOLE series spans. Consumers need this to judge `percentile`:
      // a 5th-percentile reading over 21 observations that all fall in one summer is "the lowest
      // we have recorded", not a historical extreme — and the first Analyst Note on real data
      // compressed exactly that into "root-zone moisture at the 5th percentile".
      historyYears: new Set(pts.map((p) => String(p.period).slice(0, 4))).size,
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

// ---------- ask log ----------
// What was asked, what came back, and whether the stored data could answer it.
//
// WHY THIS EXISTS. `answerQuery` persisted NOTHING — not the question, not the hit count, not whether
// the web-search tool was reached for. So the most direct evidence of what this tool cannot answer was
// generated twice a day and thrown away. "Which questions do we keep failing?" and "where do we keep
// going to the web for the same gap?" are the highest-signal inputs to deciding what data source to add
// next, and neither was answerable.
//
// Deliberately cheap: one row per answered question, written after the answer is assembled, with
// `unanswered` derived from deterministic signals rather than a model judgement.
db.exec(`
  CREATE TABLE IF NOT EXISTS ask_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    asked_at      TEXT NOT NULL,
    question      TEXT NOT NULL,
    norm_question TEXT NOT NULL,   -- lowercased, punctuation-stripped: groups repeat askings
    source        TEXT,            -- 'ui' | 'cli'
    hits          INTEGER,
    web_searches  INTEGER,         -- server_tool_use blocks; previously available and discarded
    answer_chars  INTEGER,
    unanswered    INTEGER DEFAULT 0,
    answer        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ask_norm ON ask_log(norm_question);
  CREATE INDEX IF NOT EXISTS idx_ask_at   ON ask_log(asked_at);
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

// --- forecast ledger -------------------------------------------------------------------------
// The feedback loop the tool was missing entirely. The Analyst prompt already demands a falsifiable
// read — "the setup, the RISK to that read, and the DATA OR REPORT THAT WOULD CONFIRM OR KILL IT" —
// and then that read was rendered to a markdown file and forgotten. Nothing was dated, stored, or
// revisited, so (a) nobody could say whether the tool had ever been right, and (b) each new Analyst
// Note started blind to what the last one claimed.
//
// Each row is ONE falsifiable claim extracted from a saved brief, with the series and date that
// settle it. A scheduled resolver marks hit/miss/unresolved, and the resolved record is fed back
// into later prompts as a track record. `dedupe_key` is a stable hash of the claim so re-running
// extraction over the same brief updates rather than duplicating.
db.exec(`
  CREATE TABLE IF NOT EXISTS forecasts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key       TEXT UNIQUE,       -- stable per (brief, claim) so re-extraction is idempotent
    brief_path       TEXT,              -- which saved brief this came from
    edition          TEXT,              -- analyst / pulse / weekly …
    created_at       TEXT NOT NULL,     -- when the claim was made (not when extracted)
    claim            TEXT NOT NULL,     -- the falsifiable statement, verbatim-ish
    direction        TEXT,              -- up | down | flat | n/a  (direction of the series below)
    -- comparator/threshold added after the first live run: most real analyst claims are LEVEL claims
    -- ("holds above 200,000 MT", "stays above the 90th percentile"), and with only up/down/flat
    -- available the extractor coerced them into directions the resolver then judged wrongly — a
    -- claim of "holds above 200k" from a 302k baseline scores MISS on a fall to 250k that actually
    -- satisfied it. rises | falls | stays_flat | stays_above | stays_below.
    comparator       TEXT,
    threshold        REAL,              -- the level for stays_above / stays_below
    series           TEXT,              -- market_series id that settles it, when one does
    horizon_days     INTEGER,           -- how far out the claim reaches
    resolve_by       TEXT,              -- ISO date after which it can be judged
    confirming_event TEXT,              -- the report/data the model said would confirm or kill it
    confidence       TEXT,              -- low | medium | high, as stated by the model
    baseline_value   REAL,              -- series value at creation, captured so drift is measurable
    baseline_period  TEXT,
    -- resolution
    -- pending | hit | miss | inconclusive | unresolvable | expired.
    -- inconclusive = the series stayed inside its own flat band, so a directional call can't be
    -- judged; unresolvable = no stored series could settle it. Both are excluded from the hit rate.
    outcome          TEXT,
    resolved_at      TEXT,
    observed_value   REAL,
    observed_period  TEXT,
    resolution_note  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_forecasts_outcome ON forecasts(outcome);
  CREATE INDEX IF NOT EXISTS idx_forecasts_resolve ON forecasts(resolve_by);
`);
// Additive migration for DBs created before comparator/threshold existed (same pattern as the rest
// of the schema: adding an existing column throws, which means it's already there).
for (const col of ["comparator TEXT", "threshold REAL"]) {
  try {
    db.exec(`ALTER TABLE forecasts ADD COLUMN ${col};`);
  } catch {
    /* already migrated */
  }
}

// --- report expectations & surprise ----------------------------------------------------------
// Markets move on SURPRISE versus expectation, not on levels. The tool stored WASDE/NASS actuals but
// never the pre-report trade estimate, so it could never say whether a release was bullish or
// bearish — only what the number was. The education prompt even instructs "if a move was driven by a
// surprise vs. expectations, teach that" with no expectations in context to do it with.
//
// ⚠️ SOURCING CAVEAT, verified honestly rather than assumed: the original plan was to mine pre-report
// analyst surveys out of the collector inbox. Checked against the stored bodies and the evidence is
// NOT there — of 68 news items only 7 carry a substantive body and none contain trade-survey language
// ("analysts expected", "survey average", "trade guess"). That may be a thin local dev snapshot rather
// than a true absence, so newsletter extraction is implemented and will populate this table if the
// language does appear on the Pi. But the schema deliberately does not depend on it: `source` records
// where an expectation came from, so a figure entered from an authoritative source is a first-class
// citizen. Run `node src/index.js expectations --scan` on the Pi to see which path is actually working.
db.exec(`
  CREATE TABLE IF NOT EXISTS report_expectations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key     TEXT UNIQUE,     -- report + item + source, so re-extraction updates in place
    report         TEXT NOT NULL,   -- e.g. "WASDE 2026-08" / "Grain Stocks 2026-09"
    report_date    TEXT,            -- expected release date (ISO)
    item           TEXT NOT NULL,   -- e.g. "U.S. soybean ending stocks"
    series         TEXT,            -- market_series id holding the ACTUAL, when one does
    unit           TEXT,
    est_low        REAL,
    est_avg        REAL,
    est_high       REAL,
    source         TEXT,            -- publication / provenance of the estimate
    source_date    TEXT,
    created_at     TEXT NOT NULL,
    -- settled after the release
    actual_value   REAL,
    actual_period  TEXT,
    surprise       REAL,            -- actual − est_avg, in the item's own unit
    surprise_sigma REAL,            -- the same, scaled by the estimate range (see computeSurprises)
    resolved_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_expect_report ON report_expectations(report_date);
  CREATE INDEX IF NOT EXISTS idx_expect_open   ON report_expectations(resolved_at);
`);

export function upsertExpectation(e) {
  db.prepare(
    `INSERT INTO report_expectations (dedupe_key, report, report_date, item, series, unit,
        est_low, est_avg, est_high, source, source_date, created_at)
     VALUES (@dedupe_key, @report, @report_date, @item, @series, @unit,
        @est_low, @est_avg, @est_high, @source, @source_date, @created_at)
     ON CONFLICT(dedupe_key) DO UPDATE SET
        est_low=excluded.est_low, est_avg=excluded.est_avg, est_high=excluded.est_high,
        report_date=excluded.report_date, series=excluded.series, unit=excluded.unit`
  ).run({
    dedupe_key: e.dedupeKey,
    report: e.report,
    report_date: e.reportDate ?? null,
    item: e.item,
    series: e.series ?? null,
    unit: e.unit ?? null,
    est_low: e.estLow ?? null,
    est_avg: e.estAvg ?? null,
    est_high: e.estHigh ?? null,
    source: e.source ?? null,
    source_date: e.sourceDate ?? null,
    created_at: new Date().toISOString(),
  });
}

/** Expectations not yet joined to an actual. */
export function openExpectations() {
  return db.prepare(`SELECT * FROM report_expectations WHERE resolved_at IS NULL ORDER BY report_date`).all();
}

export function settleExpectation(id, { actualValue, actualPeriod, surprise, surpriseSigma }) {
  db.prepare(
    `UPDATE report_expectations SET actual_value=?, actual_period=?, surprise=?, surprise_sigma=?, resolved_at=? WHERE id=?`
  ).run(actualValue, actualPeriod, surprise, surpriseSigma, new Date().toISOString(), id);
}

export function listExpectations({ settledOnly = false, limit = 40 } = {}) {
  return settledOnly
    ? db.prepare(`SELECT * FROM report_expectations WHERE resolved_at IS NOT NULL ORDER BY report_date DESC LIMIT ?`).all(limit)
    : db.prepare(`SELECT * FROM report_expectations ORDER BY report_date DESC LIMIT ?`).all(limit);
}

/** Insert a forecast, or update it in place if this exact claim was already extracted. */
export function upsertForecast(f) {
  db.prepare(
    `INSERT INTO forecasts (dedupe_key, brief_path, edition, created_at, claim, direction, comparator,
        threshold, series, horizon_days, resolve_by, confirming_event, confidence, baseline_value,
        baseline_period, outcome)
     VALUES (@dedupe_key, @brief_path, @edition, @created_at, @claim, @direction, @comparator,
        @threshold, @series, @horizon_days, @resolve_by, @confirming_event, @confidence,
        @baseline_value, @baseline_period, 'pending')
     ON CONFLICT(dedupe_key) DO UPDATE SET
        claim=excluded.claim, direction=excluded.direction, comparator=excluded.comparator,
        threshold=excluded.threshold, series=excluded.series,
        horizon_days=excluded.horizon_days, resolve_by=excluded.resolve_by,
        confirming_event=excluded.confirming_event, confidence=excluded.confidence`
  ).run({
    dedupe_key: f.dedupeKey,
    brief_path: f.briefPath ?? null,
    edition: f.edition ?? null,
    created_at: f.createdAt,
    claim: f.claim,
    direction: f.direction ?? null,
    comparator: f.comparator ?? null,
    threshold: Number.isFinite(f.threshold) ? f.threshold : null,
    series: f.series ?? null,
    horizon_days: f.horizonDays ?? null,
    resolve_by: f.resolveBy ?? null,
    confirming_event: f.confirmingEvent ?? null,
    confidence: f.confidence ?? null,
    baseline_value: f.baselineValue ?? null,
    baseline_period: f.baselinePeriod ?? null,
  });
}

/** Forecasts still pending whose resolve_by date has passed. */
export function forecastsDueForResolution(nowISO = new Date().toISOString().slice(0, 10)) {
  return db
    .prepare(`SELECT * FROM forecasts WHERE outcome = 'pending' AND resolve_by IS NOT NULL AND resolve_by <= ? ORDER BY resolve_by`)
    .all(nowISO);
}

export function resolveForecast(id, { outcome, observedValue = null, observedPeriod = null, note = null }) {
  db.prepare(
    `UPDATE forecasts SET outcome=?, resolved_at=?, observed_value=?, observed_period=?, resolution_note=? WHERE id=?`
  ).run(outcome, new Date().toISOString(), observedValue, observedPeriod, note, id);
}

export function listForecasts({ outcome = null, limit = 50 } = {}) {
  return outcome
    ? db.prepare(`SELECT * FROM forecasts WHERE outcome = ? ORDER BY created_at DESC LIMIT ?`).all(outcome, limit)
    : db.prepare(`SELECT * FROM forecasts ORDER BY created_at DESC LIMIT ?`).all(limit);
}

/** Hit rate over judged forecasts (hit + miss only — pending/unresolvable are excluded). */
export function forecastScorecard() {
  const rows = db.prepare(`SELECT outcome, confidence, COUNT(*) n FROM forecasts GROUP BY outcome, confidence`).all();
  const total = {};
  for (const r of rows) total[r.outcome] = (total[r.outcome] ?? 0) + r.n;
  const hit = total.hit ?? 0;
  const miss = total.miss ?? 0;
  const judged = hit + miss;
  const byConfidence = {};
  for (const r of rows) {
    if (r.outcome !== "hit" && r.outcome !== "miss") continue;
    const c = r.confidence || "unstated";
    byConfidence[c] = byConfidence[c] ?? { hit: 0, miss: 0 };
    byConfidence[c][r.outcome] += r.n;
  }
  return {
    hit, miss, judged,
    pending: total.pending ?? 0,
    inconclusive: total.inconclusive ?? 0,
    unresolvable: total.unresolvable ?? 0,
    expired: total.expired ?? 0,
    hitRate: judged ? hit / judged : null,
    byConfidence,
  };
}
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

/**
 * Commit a detection pass: insert its alert rows AND advance its comparison snapshot, atomically.
 *
 * ⚠️ THE ATOMICITY IS THE FEATURE. `detectChanges({commit:false})` deliberately writes nothing, so
 * that a delivery failure leaves the snapshot untouched and the next run re-detects the same change
 * instead of losing it forever. That guarantee only holds if the rows and the snapshot land together —
 * committing the snapshot without the rows would drop the alert; committing the rows without the
 * snapshot would re-insert it (there is no dedupe key on `alerts`) every run thereafter.
 *
 * Safe to call with an empty `changes` list: that is the ordinary "nothing moved, but track the new
 * values" path.
 */
export function commitAlerts(changes = [], pendingState = []) {
  const insertAlert = db.prepare("INSERT INTO alerts (created_at, category, title, detail, seen) VALUES (?, ?, ?, ?, 0)");
  const putState = db.prepare(
    "INSERT INTO kv_state (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const a of changes) insertAlert.run(now, a.category ?? null, a.title, a.detail ?? null);
    for (const [k, v] of pendingState) putState.run(k, String(v), now);
  })();
  return { alerts: changes.length, state: pendingState.length };
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
// ---- homepage calendar: per-event hiding -------------------------------------------------------
// USDA report dates and policy milestones come from data files shipped inside the image, so there's
// no row to flag — the dismissals live here as a set of stable keys (kind:date:label). Comment
// deadlines and hearings already have their own item-level archives and don't need this.
const CAL_HIDDEN_KEY = "calendar_hidden";
export function calendarHidden() {
  try {
    const v = JSON.parse(getState(CAL_HIDDEN_KEY) || "[]");
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}
export function setCalendarHidden(key, on = true) {
  const set = calendarHidden();
  if (on) set.add(String(key));
  else set.delete(String(key));
  setState(CAL_HIDDEN_KEY, JSON.stringify([...set]));
  return set.size;
}
export function clearCalendarHidden() {
  setState(CAL_HIDDEN_KEY, "[]");
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
                          comment_deadline, doc_type, published_at, entity_id, item_type, geo, body, triage_tier, event_key)
  VALUES (@uid, @sourceId, @firstSeenAt, @verdict, @topics, @title, @url, @jurisdiction, @oneLine,
          @commentDeadline, @docType, @publishedAt, @entityId, @itemType, @geo, @body, @tier, @eventKey)
  ON CONFLICT(uid) DO UPDATE SET
    triage_verdict = excluded.triage_verdict,
    triage_topics  = excluded.triage_topics,
    triage_tier    = COALESCE(excluded.triage_tier, seen_items.triage_tier),
    one_line       = excluded.one_line,
    entity_id      = COALESCE(excluded.entity_id, seen_items.entity_id),
    item_type      = COALESCE(excluded.item_type, seen_items.item_type),
    geo            = COALESCE(excluded.geo, seen_items.geo),
    body           = COALESCE(excluded.body, seen_items.body),
    -- The event key can only IMPROVE on re-write: enrichment may resolve a Federal Register
    -- document number on a later run that the first pass didn't have, which upgrades a
    -- docket-scoped key to the fr: key that groups it with the notice itself.
    event_key      = COALESCE(excluded.event_key, seen_items.event_key)
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
    body: item.summary ? String(item.summary).slice(0, 8000) : null,
    // Graded relevance. NULL for an untriaged/failed item and for everything triaged before tiers
    // existed — the LRD filter treats NULL as "worth knowing" so no history disappears.
    tier: verdict?.tier ?? null,
    // The action this row is about (eventkey.js). Always derivable, so never NULL for new rows.
    eventKey: item.raw?.eventKey ?? eventKeyFor(item),
  });
}

/**
 * Store document/article text on a row that was saved without it.
 *
 * WHY THIS EXISTS. News grounding (enrich.js) runs at ingest, so it only ever helps items collected
 * from now on — and the history that matters lives on the Pi, where a month of news rows hold a
 * ~180-character RSS teaser. The news digest already fetches those articles' text once a run; this
 * lets it keep what it fetched, so existing rows heal as they're read rather than needing a backfill
 * job. Idempotent and strictly additive: it refuses to shorten a body, so a paywall stub can never
 * overwrite real text, and a re-run is a no-op.
 *
 * @returns {boolean} whether the row was actually updated
 */
export function groundItemBody(uid, text) {
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!uid || !body) return false;
  const info = db
    .prepare("UPDATE seen_items SET body = ? WHERE uid = ? AND LENGTH(COALESCE(body,'')) < ?")
    .run(body.slice(0, 8000), uid, body.length);
  return info.changes > 0;
}

/**
 * Fill `event_key` in for rows stored before the column existed. Cheap (one UPDATE per row, keyed on
 * the primary key, inside one transaction) and idempotent — it only touches NULLs, so it runs once
 * and then finds nothing. Called on boot so the grouped views work on existing history rather than
 * only on rows collected after the update, which is what would otherwise make the Pi behave
 * differently from a fresh install for a month.
 */
export function backfillEventKeys() {
  const rows = db
    .prepare("SELECT uid, source_id, title, jurisdiction FROM seen_items WHERE event_key IS NULL LIMIT 20000")
    .all();
  if (!rows.length) return 0;
  const upd = db.prepare("UPDATE seen_items SET event_key = ? WHERE uid = ?");
  const run = db.transaction((list) => {
    for (const r of list) {
      // No `raw` on a stored row, so this reaches the identifier-free tiers of eventKeyFor (title
      // normalization / uid). Rows re-seen after an update get the strong key written by markSeen.
      upd.run(eventKeyFor({ uid: r.uid, source_id: r.source_id, title: r.title, jurisdiction: r.jurisdiction }), r.uid);
    }
  });
  run(rows);
  return rows.length;
}

/**
 * Seed `feedback_at` for rows that carried feedback before the column existed.
 *
 * ⚠️ THIS WRITES THE WRONG DATA ON PURPOSE, AND THAT IS THE BEST AVAILABLE OPTION. The item's
 * `first_seen_at` is not when the human clicked — that moment was never recorded, so it cannot be
 * recovered. Seeding it preserves today's (mis)ordering for existing history while every NEW thumb
 * gets a true timestamp, so the ranking becomes correct going forward instead of on a flag day.
 *
 * The alternative — leave NULL and sort NULLS LAST — would bury every correction Matt has ever made
 * beneath the first new one, which is worse than imprecise. The COALESCE in getFeedbackExamples means
 * a read that beats this backfill still behaves correctly either way.
 *
 * Idempotent: touches only NULLs on rows that actually have feedback, so it runs once and then finds
 * nothing.
 */
export function backfillFeedbackAt() {
  const info = db
    .prepare(
      `UPDATE seen_items SET feedback_at = first_seen_at
        WHERE feedback_at IS NULL AND (feedback IS NOT NULL OR feedback_note IS NOT NULL)`
    )
    .run();
  return info.changes;
}

/**
 * Every stored row that shares an event key with one of `keys`, so a grouped view can show "also
 * filed in 3 other dockets" and link each one. Returns a Map(event_key → rows), newest first.
 */
export function eventSiblings(keys) {
  const list = [...new Set((keys ?? []).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = db
    .prepare(
      `SELECT uid, event_key, source_id, title, url, doc_type, comment_deadline, published_at, first_seen_at,
              triage_verdict, triage_tier, LENGTH(COALESCE(body,'')) AS body_len
         FROM seen_items
        WHERE event_key IN (${list.map(() => "?").join(",")})
        ORDER BY first_seen_at DESC`
    )
    .all(...list);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.event_key)) out.set(r.event_key, []);
    out.get(r.event_key).push(r);
  }
  return out;
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

/**
 * Record one model call's token usage.
 *
 * `usage` is the raw `response.usage` and is OPTIONAL — pass it on any call site that sets a
 * `cache_control` breakpoint. Without it the cache columns record 0, which is correct for the
 * uncached paths and keeps every existing 4-argument caller working unchanged.
 *
 * ⚠️ THIS IS THE ONLY WAY TO KNOW WHETHER CACHING WORKS. Prompt caching is a prefix match: a single
 * byte moving inside the cached prefix yields zero reads and NO error. So a silently broken
 * breakpoint looks exactly like a working one from the outside. `cache_read_tokens` staying at 0
 * across a resume loop is the signal, and it only exists if it is stored.
 */
export function recordUsage(model, purpose, inputTokens, outputTokens, usage = null) {
  db.prepare(
    "INSERT INTO token_usage (ts, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    new Date().toISOString(),
    model,
    purpose,
    inputTokens ?? 0,
    outputTokens ?? 0,
    usage?.cache_read_input_tokens ?? 0,
    usage?.cache_creation_input_tokens ?? 0
  );
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
              SUM(input_tokens)       AS input_tokens,
              SUM(output_tokens)      AS output_tokens,
              SUM(cache_read_tokens)  AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              COUNT(*)                AS calls
         FROM token_usage WHERE ts >= ? GROUP BY model ORDER BY model`
    )
    .all(monthStart.toISOString());
  const briefCount = db.prepare("SELECT COUNT(*) AS n FROM briefs").get().n;
  return { sourceCounts, lastRuns, monthUsage, briefCount };
}

/** Normalize a question so repeat askings group together: lowercased, punctuation and runs of
 *  whitespace collapsed. Not a semantic match — two differently-worded asks about the same gap stay
 *  separate rows, which is honest rather than clever. */
export function normalizeQuestion(q) {
  return (
    String(q ?? "")
      .toLowerCase()
      // Apostrophes are DELETED, not spaced: they sit inside words (contractions, possessives), so
      // "what's" must collapse to "whats" and group with someone who typed it without the apostrophe —
      // the single most common way the same question gets typed two ways. Both the ASCII and the
      // typographic form, since a browser or phone keyboard may substitute the latter.
      .replace(/['’ʼ]/g, "")
      // Everything else non-alphanumeric becomes a separator: a hyphen or slash joins two words that
      // should stay two words.
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Record one answered question.
 *
 * ⚠️ KNOWN UNDERCOUNT, documented rather than hidden: `answerQueryOnce` in server.js memoizes
 * identical questions for 15 minutes, so a repeat inside that window never reaches this function. That
 * is correct for "the same question already counted", but it means the repeat COUNT here is a floor,
 * not a total. Any analysis built on it should treat the counts as "at least this often".
 */
export function logAsk({ question, source = "ui", hits = 0, webSearches = 0, answer = "", unanswered = false }) {
  db.prepare(
    `INSERT INTO ask_log (asked_at, question, norm_question, source, hits, web_searches, answer_chars, unanswered, answer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    String(question ?? ""),
    normalizeQuestion(question),
    source,
    hits | 0,
    webSearches | 0,
    String(answer ?? "").length,
    unanswered ? 1 : 0,
    String(answer ?? "").slice(0, 4000)
  );
}

/** Repeatedly-asked questions the stored data could not answer — the Phase-6 data-gap input. */
export function unansweredAsks({ days = 90, minTimes = 2 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  return db
    .prepare(
      `SELECT norm_question,
              COUNT(*)               AS times,
              SUM(web_searches)      AS web_searches,
              SUM(unanswered)        AS unanswered_times,
              MAX(asked_at)          AS last_asked,
              MAX(question)          AS example
         FROM ask_log
        WHERE asked_at >= ?
        GROUP BY norm_question
       HAVING COUNT(*) >= ? AND (SUM(unanswered) > 0 OR SUM(web_searches) >= 2)
        ORDER BY times DESC, last_asked DESC`
    )
    .all(cutoff, minTimes);
}

/**
 * Token + cache totals grouped by PURPOSE (and model), for the `tokens` CLI.
 *
 * Grouping by purpose rather than model is what makes prompt caching verifiable: one model serves
 * both cached and uncached purposes, so a per-model zero can't distinguish "the breakpoint broke"
 * from "this purpose never had one".
 */
export function getUsageByPurpose(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT purpose,
              model,
              SUM(input_tokens)       AS input_tokens,
              SUM(output_tokens)      AS output_tokens,
              SUM(cache_read_tokens)  AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              COUNT(*)                AS calls
         FROM token_usage WHERE ts >= ? GROUP BY purpose, model ORDER BY purpose, model`
    )
    .all(cutoff);
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
      `SELECT uid, source_id, title, url, jurisdiction, triage_verdict, triage_topics, one_line, first_seen_at, event_key, body
         FROM seen_items
        WHERE (title LIKE ? COLLATE NOCASE OR one_line LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE)
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(like, like, like, limit);
}

// ---------------------------------------------------------------------------
// Ranked retrieval for the Ask box (replaces the recency-ordered LIKE fallback)
//
// WHAT WAS WRONG. The Ask box ran `searchSeenItems(question)` — one LIKE on the ENTIRE question
// string, which matches nothing for any real question — and then fell back to
// `searchSeenItemsAny(question.split(/\s+/))`, which kept only words longer than 3 characters and
// OR-ed them, ordered by `first_seen_at DESC`. Three consequences, all measurable:
//   1. Every acronym this domain runs on — 45Z, RFS, RIN, EPA, EU, SAF, WOTUS, ESR — is 2–3
//      characters and was SILENTLY DROPPED. "What's happening with 45Z?" searched for
//      "what's", "happening", "with"; none of the surviving terms had anything to do with 45Z.
//   2. Those surviving terms are stopwords, so the OR matched a large slice of the table and the
//      `ORDER BY first_seen_at DESC LIMIT 30` turned retrieval into "the 30 newest rows".
//   3. `body` was never searched, so document text the pipeline had stored was unreachable.
//
// WHY NOT FTS5/EMBEDDINGS YET. FTS5 is the right next step and better-sqlite3 ships it, but it
// needs a shadow table kept in sync on the hot write path, and the gain over correct tokenization +
// field-weighted scoring on a table this size (hundreds to low thousands of rows/month, ~2 TB of
// NVMe headroom) is ranking quality, not reachability. Fix the reachability bug first, measure, then
// decide. Nothing here changes the schema or the write path, so it is fully reversible.

// Ordinary English that carries no retrieval signal. Deliberately short: a domain stoplist that
// swallowed "farm" or "trade" would be worse than none.
const STOPWORDS = new Set(
  ("a an and any are as at be been but by can did do does for from had has have how i if in into is it its may " +
    "me might must my no not of on or our should so than that the their them then there these they this those to " +
    "us was we were what when where which who why will with would you your about tell show give me latest new news " +
    "happening happened update please").split(" ")
);

/**
 * Turn a natural-language question into scored search terms.
 *   - "quoted phrases" survive as phrases and score highest
 *   - ALL-CAPS / alphanumeric tokens (45Z, RFS, HF2571, EPA) are kept at ANY length — these are the
 *     highest-signal terms in this domain and were exactly what the old length filter deleted
 *   - ordinary words are kept at ≥4 characters and de-stopworded
 * @returns {{phrases: string[], terms: string[]}}
 */
export function parseQuery(question) {
  const q = String(question ?? "");
  const phrases = [...q.matchAll(/"([^"]{3,80})"/g)].map((m) => m[1].trim()).filter(Boolean);
  const rest = q.replace(/"[^"]*"/g, " ");
  const terms = [];
  for (const rawTok of rest.split(/[^A-Za-z0-9§%.-]+/)) {
    const tok = rawTok.replace(/^[.-]+|[.-]+$/g, "");
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    // An acronym or alphanumeric code: any length. Distinguished by containing a digit or by being
    // written in caps in the original question.
    const isCode = /\d/.test(tok) || (tok === tok.toUpperCase() && tok.length >= 2);
    if (isCode || tok.length >= 4) terms.push(lower);
  }
  return { phrases, terms: [...new Set(terms)].slice(0, 12) };
}

/**
 * Retrieve stored items for a question, ranked by where and how often the terms hit rather than by
 * recency. One table scan; scoring happens in SQL so the LIMIT applies to the ranked list.
 *
 * Field weights encode what a match MEANS: a hit in the title is the item being about the term, a
 * hit in `one_line` is the triager saying so, a hit in `body` is the document containing it.
 * Recency is a tie-breaker, not the sort key.
 */
export function searchItemsRanked(question, { limit = 30, days = 400 } = {}) {
  const { phrases, terms } = parseQuery(question);
  const needles = [...phrases, ...terms];
  if (!needles.length) return [];
  const since = new Date(Date.now() - days * 86400e3).toISOString();

  // Phrases weigh more than single terms; title > one_line > body within each.
  const parts = [];
  const params = [];
  const gate = [];
  const gateParams = [];
  needles.forEach((n, i) => {
    const w = i < phrases.length ? 3 : 1;
    const like = `%${n}%`;
    parts.push(`(CASE WHEN title    LIKE ? COLLATE NOCASE THEN ${6 * w} ELSE 0 END)`);
    parts.push(`(CASE WHEN one_line LIKE ? COLLATE NOCASE THEN ${3 * w} ELSE 0 END)`);
    parts.push(`(CASE WHEN body     LIKE ? COLLATE NOCASE THEN ${2 * w} ELSE 0 END)`);
    params.push(like, like, like);
    // Cheap gate: one LIKE per needle against the three fields concatenated, instead of three. The
    // full field-weighted score is then computed only for rows that pass. `LIKE '%x%'` can never use
    // an index, so this is a scan either way — the gate just makes the scan a third as expensive.
    gate.push("(title || ' ' || COALESCE(one_line,'') || ' ' || COALESCE(body,'')) LIKE ? COLLATE NOCASE");
    gateParams.push(like);
  });
  const scoreExpr = parts.join(" + ");

  // ⚠️ COST NOTE, measured. Cloning the local corpus to 60,200 rows (≈5 years at the observed intake)
  // put one query at ~560 ms on a dev PC; at the real current table size (~10² rows locally, low 10³
  // on the Pi) it is ~2 ms and ~50 ms respectively. It scales linearly and runs once per Ask-box
  // question, ahead of a 10–20 s model call, so it is not the bottleneck today — but it will be
  // eventually, and FTS5 (already compiled into better-sqlite3) is the fix at that point, not a
  // narrower window. The old path was ~0.4 ms only because it stopped at the first 30 rows matching
  // any stopword, which is exactly why it returned "the newest rows" instead of an answer.
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, triage_verdict, triage_topics, triage_tier, one_line,
              first_seen_at, published_at, comment_deadline, doc_type, event_key, body,
              (${scoreExpr}) AS match_score
         FROM seen_items
        WHERE first_seen_at >= ? AND (${gate.join(" OR ")})
        ORDER BY match_score DESC, first_seen_at DESC
        LIMIT ?`
    )
    .all(...params, since, ...gateParams, limit)
    // The gate matches the three fields CONCATENATED, so a phrase can straddle a field boundary
    // (title ending "…pesticide", one_line opening "tolerance…") and pass the gate while scoring 0 in
    // every individual field. Dropped here rather than with a second copy of the score expression in
    // the WHERE clause: at most `limit` rows reach this point, so it costs nothing.
    .filter((r) => r.match_score > 0);
}

/**
 * Items matching ANY of the given words (title or one_line), newest first, in ONE scan — the
 * per-word fallback for the Ask box. Distinct words >3 chars are OR-combined so a multi-word
 * query does a single table pass instead of one LIKE scan per word.
 */
export function searchSeenItemsAny(terms, limit = 30) {
  const words = [...new Set((terms ?? []).filter((w) => w && w.length > 3))];
  if (!words.length) return [];
  const conds = words.map(() => "(title LIKE ? COLLATE NOCASE OR one_line LIKE ? COLLATE NOCASE)").join(" OR ");
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, triage_verdict, triage_topics, one_line, first_seen_at
         FROM seen_items WHERE ${conds} ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(...params, limit);
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

/** The cached AI summary for an item, or undefined. Summaries are permanent (see the table note). */
export function getSummary(uid) {
  return db
    .prepare("SELECT uid, summary, model, created_at FROM item_summaries WHERE uid = ?")
    .get(uid);
}

/** Store (or replace) an AI summary. Permanent — no expiry. */
export function saveSummary(uid, summary, model) {
  db.prepare(
    `INSERT INTO item_summaries (uid, summary, model, created_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       summary = excluded.summary, model = excluded.model, created_at = excluded.created_at`
  ).run(uid, summary, model ?? null, new Date().toISOString());
}

/** Set of item uids that currently have a cached, non-expired summary. */
export function summarizedUids() {
  // Any item that has a stored summary (permanent) — used to mark the 🧠 icon as "stored".
  return new Set(db.prepare("SELECT uid FROM item_summaries").all().map((r) => r.uid));
}

/**
 * "Did we see this?" — search the WHOLE firehose, not the curated feed.
 *
 * The point is diagnostic: when Matt knows about something the brief never showed him, the question
 * is *where* it was lost — never fetched at all, fetched and dropped by the local keyword score,
 * triaged irrelevant, or actually present and just not noticed. Every item is recorded in seen_items
 * regardless of outcome (locally-dropped ones land as `unscored`), so all four answers are here.
 *
 * Searches title AND body, across every verdict and both archives, oldest limit generous.
 */
export function diagnoseCoverage(term, { limit = 25, days = 365 } = {}) {
  const q = `%${String(term).trim()}%`;
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = db
    .prepare(
      `SELECT uid, source_id, title, url, first_seen_at, published_at, triage_verdict, triage_tier,
              one_line, comment_deadline, doc_type, COALESCE(archived,0) AS archived
         FROM seen_items
        WHERE first_seen_at >= ?
          AND (title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE OR one_line LIKE ? COLLATE NOCASE)
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(since, q, q, q, Math.min(limit, 100));
  const counts = { relevant: 0, irrelevant: 0, unscored: 0, archived: 0 };
  for (const r of rows) {
    if (r.archived) counts.archived++;
    const v = r.triage_verdict || "unscored";
    if (v in counts) counts[v]++;
  }
  return { term: String(term).trim(), rows, counts, days };
}

// ---------------------------------------------------------------------------
// Item browsing, feedback, and tracking (web UI)

/**
 * Filterable listing of stored items for the /items page.
 * filters: { q, topicId, sourceId, verdict, days, limit }
 */
// Grace period (days) after a comment period closes / a hearing date passes before the item retires
// out of the default LRD view. Non-destructive — a "closed" lifecycle view still shows them.
const RETIRE_GRACE_DAYS = 3;
// A rule/docket with NO comment deadline never had anything to expire, so it used to sit in the
// active feed forever — including the ones whose deadline we simply failed to parse. After this many
// days with no movement it retires into the same 🗂 Closed view. Long enough that a live rulemaking
// is never hidden mid-comment-period.
const STALE_NO_DEADLINE_DAYS = 120;

export function listItems({ q = "", topicId = "", sourceId = "", sourceIds = null, verdict = "", tier = "", days = 30, limit = 200, archived = null, sort = "newest", lifecycle = "all" } = {}) {
  const clauses = ["first_seen_at >= ?"];
  const params = [new Date(Date.now() - days * 86400e3).toISOString()];
  if (archived !== null) {
    clauses.push("COALESCE(archived, 0) = ?");
    params.push(archived ? 1 : 0);
  }
  // Lifecycle (Politico-Pro-style retirement): an item is "closed" once its comment period ended
  // (comment_deadline in the past) or, for a hearing, its meeting date passed — both beyond a short
  // grace. "active" hides those from the default feed; "closed" shows only them; "all" = no filter.
  if (lifecycle === "active" || lifecycle === "closed") {
    const graceISO = new Date(Date.now() - RETIRE_GRACE_DAYS * 86400e3).toISOString().slice(0, 10);
    const staleISO = new Date(Date.now() - STALE_NO_DEADLINE_DAYS * 86400e3).toISOString();
    const closedExpr =
      "((comment_deadline IS NOT NULL AND substr(comment_deadline,1,10) < ?) " +
      "OR (COALESCE(doc_type,'')='hearing' AND substr(COALESCE(published_at,'9999'),1,10) < ?) " +
      // …or it has no deadline at all and hasn't been touched in months (see STALE_NO_DEADLINE_DAYS).
      "OR (comment_deadline IS NULL AND COALESCE(doc_type,'')<>'hearing' AND first_seen_at < ?))";
    clauses.push(lifecycle === "active" ? `NOT ${closedExpr}` : closedExpr);
    params.push(graceISO, graceISO, staleISO);
  }
  // Graded relevance: "top" hides only the explicit background tier (and keeps NULL, i.e. anything
  // triaged before tiers existed, so no history vanishes when this ships).
  if (tier === "must_read") clauses.push("triage_tier = 'must_read'");
  else if (tier === "top") clauses.push("(triage_tier IS NULL OR triage_tier IN ('must_read','worth_knowing'))");
  else if (tier === "background") clauses.push("triage_tier = 'background'");
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
  // Sort: newest-seen (default) or by comment deadline (soonest open deadlines first, nulls last).
  const orderBy =
    sort === "deadline"
      ? "(comment_deadline IS NULL), comment_deadline ASC, first_seen_at DESC"
      : "first_seen_at DESC";
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, doc_type, triage_verdict, triage_topics, triage_tier,
              one_line, comment_deadline, published_at, first_seen_at, feedback, feedback_note, entity_id, item_type, geo, body,
              event_key
         FROM seen_items WHERE ${clauses.join(" AND ")}
        ORDER BY ${orderBy} LIMIT ?`
    )
    .all(...params, Math.min(limit, 500));
}

export function setFeedback(uid, feedback, note) {
  // feedback: 'up' | 'down' | null (clear). note: optional free-text (undefined = leave as-is).
  //
  // `feedback_at` tracks when the human last expressed a judgement on this row, and is cleared only
  // when NO signal is left.
  //
  // On the CASE for a remaining note: getFeedbackExamples gates everything behind
  // `feedback IS NOT NULL`, so a note WITHOUT a thumb is not selected today — its `feedback_note`
  // clause only broadens which *thumbed* rows qualify. Preserving the timestamp is therefore
  // defensive, not load-bearing: it costs nothing and stays correct if that query is ever widened,
  // which is the cheaper side of the bet. Do not read it as evidence that note-only rows are used.
  const now = new Date().toISOString();
  if (note === undefined) {
    db.prepare(
      `UPDATE seen_items
          SET feedback = @feedback,
              feedback_at = CASE
                WHEN @feedback IS NOT NULL      THEN @now          -- a fresh judgement
                WHEN feedback_note IS NOT NULL  THEN feedback_at   -- note remains: keep its time
                ELSE NULL                                          -- nothing left to rank on
              END
        WHERE uid = @uid`
    ).run({ feedback, now, uid });
  } else {
    db.prepare(
      `UPDATE seen_items
          SET feedback = @feedback,
              feedback_note = @note,
              feedback_at = CASE WHEN @feedback IS NOT NULL OR @note IS NOT NULL THEN @now ELSE NULL END
        WHERE uid = @uid`
    ).run({ feedback, note: note || null, now, uid });
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
      `SELECT title, triage_verdict, feedback, feedback_note, source_id, doc_type FROM seen_items
        WHERE feedback IS NOT NULL
          AND ((feedback = 'down' AND triage_verdict = 'relevant') OR (feedback = 'up' AND triage_verdict = 'irrelevant') OR feedback_note IS NOT NULL)
        ORDER BY COALESCE(feedback_at, first_seen_at) DESC LIMIT ?`
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

/**
 * Pinned items, newest first.
 *
 * ⚠️ BOUNDED SINCE 1.29.0. This was `SELECT *` with no LIMIT, and both prompt call sites interpolated
 * the whole result with no slice — the one genuinely unbounded block in any prompt this tool builds.
 * With two pins it was invisible; with a few hundred it would have quietly consumed the context the
 * retrieved items and market data need. Callers that render into a prompt must pass a limit and report
 * any remainder, because tracked items are the only USER-CURATED signal here and silently dropping
 * them is worse than dropping news.
 *
 * @param {number|null} limit `null` returns every row (for UI views that page or count themselves).
 */
export function listTracked(limit = null) {
  return limit == null
    ? db.prepare("SELECT * FROM tracked_items ORDER BY tracked_at DESC").all()
    : db.prepare("SELECT * FROM tracked_items ORDER BY tracked_at DESC LIMIT ?").all(limit);
}

/** Total pins, so a capped prompt block can state the true number rather than implying it sent all. */
export function trackedCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM tracked_items").get().n;
}

/** The set of stable track keys, for flagging movement during a run.
 *  ⚠️ Deliberately UNLIMITED — this is movement detection on the write path, not a prompt block.
 *  Capping it would silently stop flagging movement on older pins. */
export function trackedKeySet() {
  return new Set(db.prepare("SELECT track_key FROM tracked_items").all().map((r) => r.track_key));
}

/**
 * Upcoming comment deadlines (for the .ics calendar + UI), soonest first. Dismissed deadlines
 * (deadline_archived=1) drop out — pass {includeArchived:true} for the dismissed-archive view.
 *
 * ONE DEADLINE PER ACTION (see eventkey.js). A single Federal Register notice cross-filed into four
 * EPA dockets used to produce four identical rows here, and they landed on the homepage calendar,
 * in the LRD deadline panel, in `.ics`, and in every prompt's deadline block. Measured on the stored
 * feed: nine "Aug 6" rows were three notices. Grouping keeps the row an analyst can act on — the
 * Regulations.gov copy, because that is where the comment is filed — and reports how many
 * additional dockets carry the same deadline in `dupCount`.
 *
 * Pass {collapse:false} for the raw per-document list (the dismissed-archive view needs it, so that
 * dismissing one copy doesn't hide the group's other copies from the restore screen).
 */
export function upcomingDeadlines(limit = 100, { includeArchived = false, collapse = true } = {}) {
  const today = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT uid, title, url, comment_deadline, one_line, source_id, event_key, LENGTH(COALESCE(body,'')) AS body_len
         FROM seen_items
        WHERE comment_deadline IS NOT NULL AND comment_deadline >= ?
          ${includeArchived ? "" : "AND COALESCE(deadline_archived, 0) = 0"}
        ORDER BY comment_deadline ASC LIMIT ?`
    )
    // Over-fetch before collapsing so a limit of 20 still yields ~20 distinct actions rather than
    // 20 rows that turn out to be five.
    .all(today, collapse ? Math.min(limit * 4, 400) : limit);
  if (!collapse) return rows;

  const byKey = new Map();
  for (const r of rows) {
    const key = r.event_key || r.uid;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r, dupCount: 0 });
      continue;
    }
    prev.dupCount++;
    // Keep whichever copy carries real document text — that's the one whose summary is worth reading.
    if ((r.body_len ?? 0) > (prev.body_len ?? 0)) byKey.set(key, { ...r, dupCount: prev.dupCount });
  }
  return [...byKey.values()].slice(0, limit);
}

/** Upcoming congressional hearings (doc_type='hearing'), soonest first — the meeting date is stored
 *  in published_at. Powers the homepage calendar. Past meetings drop off automatically.
 *  🗄 Set-aside (archived) hearings are excluded: the LRD set-aside button is how a hearing gets
 *  removed from the calendar, and it silently didn't work before — the archive flag was ignored
 *  here, so a hearing you'd dismissed kept its calendar dot forever. */
export function upcomingHearings(limit = 100, { days = 120, includeArchived = false } = {}) {
  const today = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const endISO = new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT uid, title, url, published_at, one_line, source_id, jurisdiction FROM seen_items
        WHERE doc_type = 'hearing' AND published_at IS NOT NULL
          AND substr(published_at, 1, 10) >= ? AND substr(published_at, 1, 10) <= ?
          ${includeArchived ? "" : "AND COALESCE(archived, 0) = 0"}
        ORDER BY published_at ASC LIMIT ?`
    )
    .all(today, endISO, limit);
}

/** Dismiss / restore a comment deadline (separate archive from the LRD set-aside). */
export function setDeadlineArchived(uid, on = true) {
  db.prepare("UPDATE seen_items SET deadline_archived = ? WHERE uid = ?").run(on ? 1 : 0, uid);
}
/** Dismissed comment deadlines that are still in the future (the recoverable archive view). */
export function dismissedDeadlines(limit = 100) {
  const today = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT uid, title, url, comment_deadline, one_line, source_id FROM seen_items
        WHERE comment_deadline IS NOT NULL AND comment_deadline >= ? AND COALESCE(deadline_archived, 0) = 1
        ORDER BY comment_deadline ASC LIMIT ?`
    )
    .all(today, limit);
}
export function dismissedDeadlineCount() {
  const today = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM seen_items
        WHERE comment_deadline IS NOT NULL AND comment_deadline >= ? AND COALESCE(deadline_archived, 0) = 1`
    )
    .get(today).n;
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
