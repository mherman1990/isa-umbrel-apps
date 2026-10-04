// health.js — READ-ONLY freshness audit for The Bean Brief (the core of scripts/audit-freshness.mjs
// and the /freshness page).
//
// Answers "which parts of the tool are actually updating?" from the evidence the app already keeps:
// the SQLite store (runs, market_runs, market_series, kv_state, token_usage, brief_runs, briefs,
// storylines, theses, policy_cards…), the live watchlist.json, and the .env (PRESENCE ONLY).
//
// Usage (on the Pi, inside the app container — the DB lives on the /data volume):
//   docker exec isa-polibrief_web_1 node scripts/audit-freshness.mjs
//   docker exec isa-polibrief_web_1 node scripts/audit-freshness.mjs --json > audit.json
// Optional: scan a captured log for the last error per source/panel. The in-app /logs page is a
// 500-line in-memory ring buffer and does not survive a restart, so capture Docker's log first:
//   docker logs isa-polibrief_web_1 > /tmp/pb.log 2>&1
//   docker cp /tmp/pb.log isa-polibrief_web_1:/tmp/pb.log
//   docker exec isa-polibrief_web_1 node scripts/audit-freshness.mjs --log /tmp/pb.log
// Bare-metal installs: logs/cron.log under the data dir or project root is scanned automatically.
//
// Flags: --db <path> · --data-dir <dir> · --log <file> · --json · --now <ISO> (reproducible runs)
//
// ⚠️ READ-ONLY BY CONSTRUCTION, NOT BY CARE:
//   - The database is opened with { readonly: true, fileMustExist: true }. A write would throw.
//   - It never imports src/store.js (which creates tables and runs ALTER TABLE migrations on import)
//     or any adapter (some adapters import store.js). Adapter facts are read from source TEXT.
//   - Key VALUES are never printed, returned, or logged — only set / missing.
//   - It creates no files. Output goes to stdout.
//
// The core is `auditFreshness()` (pure over an open DB handle + config), so the Phase 1 /health view
// can reuse it against the server's own connection instead of re-deriving any of this.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeSpend, monthlyBudget } from "./budgetcore.js";
import { calendarCoverage } from "./calendar.js";
import { pack, voice, seriesKey } from "./pack.js";
// State/org wording comes from the active state pack (docs/MULTI_STATE.md) — no state literals here.
const V = voice();

export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOUR = 3600e3;
const DAY = 24 * HOUR;

// How often the pipeline itself runs: AM + PM editions → every adapter is fetched ~every 12h.
const PIPELINE_CADENCE_H = 12;

// ---------------------------------------------------------------------------------------------
// What each source SHOULD look like. This is audit knowledge (publisher cadence, keys, series
// namespace), kept here rather than inferred, because "how often should this change" is exactly the
// fact the code does not record anywhere else.
//
//   required    env vars without which the adapter is inert / fails (any one of a `|`-group suffices)
//   optional    env vars that only lift a rate limit or add detail
//   prefixes    market_series namespaces this adapter writes (default: its own id)
//   dataCadenceD  publisher release cadence of the newest data point, in days (null = event-driven)
//   lagD        normal publication lag on top of the cadence (EIA feedstocks run ~2–3 months behind)
// A data point is STALE when its age > 2 × dataCadenceD + lagD.
// ---------------------------------------------------------------------------------------------
export const SOURCE_EXPECTATIONS = {
  // ---- official (policy pipeline) ----
  federal_register: { required: [], dataCadenceD: 1, note: "business-daily FR issues" },
  congress_gov: { required: ["CONGRESS_GOV_API_KEY"], dataCadenceD: null, note: "event-driven; quiet weeks are normal" },
  congress_hearings: { required: ["CONGRESS_GOV_API_KEY"], dataCadenceD: null, note: "event-driven" },
  legiscan: { required: ["LEGISCAN_API_KEY"], dataCadenceD: null, note: `event-driven${pack().legislature?.sessionNote ? `; ${pack().legislature.sessionNote}` : ""}` },
  eurlex_oj: { required: [], dataCadenceD: 1, note: "OJ L series, business-daily" },
  iowa_admin_rules: { required: [], dataCadenceD: 14, note: "Iowa Administrative Bulletin, biweekly" },
  regulations_gov: { required: ["REGULATIONS_GOV_API_KEY|CONGRESS_GOV_API_KEY"], dataCadenceD: 1 },
  courtlistener: { required: [], optional: ["COURTLISTENER_API_TOKEN"], dataCadenceD: null, note: "event-driven" },
  // ---- news ----
  rss: { required: [], dataCadenceD: 1, note: "registry channels; per-feed errors in channel.last_error" },
  email_intake: { required: ["EMAIL_INTAKE_USER", "EMAIL_INTAKE_PASS"], dataCadenceD: 1 },
  // ---- markets ----
  usda_nass: { required: ["NASS_API_KEY"], prefixes: ["nass"], dataCadenceD: 31, lagD: 35, note: "monthly prices received / crush (~45d lag on oil); condition weekly in season" },
  eia: { required: ["EIA_API_KEY"], prefixes: ["eia"], dataCadenceD: 31, lagD: 75, note: "monthly feedstock (~2–3 mo lag)" },
  cftc: { required: [], prefixes: ["cftc"], dataCadenceD: 7, lagD: 4, note: "COT disaggregated futures-only, Fri release as of Tue; SOYBEANS ONLY" },
  fas_export_sales: { required: ["FAS_API_KEY"], prefixes: ["fas"], dataCadenceD: 7, lagD: 7, note: "ESR, Thu release for prior week" },
  open_meteo: { required: [], prefixes: ["open_meteo"], dataCadenceD: 1, lagD: 1, note: "one point per run (ERA5 ~5d behind)" },
  usda_ams: { required: ["USDA_AMS_API_KEY"], prefixes: ["ams"], dataCadenceD: 1, lagD: 3, note: "2850 daily cash/basis; 3511 weekly feedstuffs" },
  agtransport: { required: [], optional: ["AGTRANSPORT_APP_TOKEN"], prefixes: ["agtransport"], dataCadenceD: 7, lagD: 7, note: "GTR weekly; barge-freight = avg price_per_ton across ALL locations" },
  drought_monitor: { required: [], prefixes: ["drought_monitor"], dataCadenceD: 7, lagD: 5 },
  ibge_brazil: { required: [], prefixes: ["ibge_brazil"], dataCadenceD: 31, lagD: 60, note: "LSPA by crop year" },
  fred: { required: ["FRED_API_KEY"], prefixes: ["fred"], dataCadenceD: 7, lagD: 5, note: "weekly ending Friday" },
  wasde: { required: [], prefixes: ["wasde"], dataCadenceD: 31, lagD: 5, note: "period = release month" },
  barchart: { required: ["BARCHART_API_KEY"], prefixes: ["barchart"], dataCadenceD: 1, lagD: 3, note: "scaffold" },
  vegscape: { required: [], prefixes: ["vegscape"], dataCadenceD: 7, lagD: 7, note: "in-season only — off-season staleness is normal" },
  cropcasma: { required: [], prefixes: ["cropcasma"], dataCadenceD: 7, lagD: 7, note: "new points only; off-season staleness is normal" },
  cbot_futures: { required: [], prefixes: ["cbot"], dataCadenceD: 1, lagD: 3, note: "Yahoo front-month continuous (ZS=F/ZM=F/ZL=F/ZC=F), keyless" },
  cme_settlements: { required: ["CME_SETTLEMENTS"], prefixes: ["cme"], dataCadenceD: 1, lagD: 3, note: "inert until CME_SETTLEMENTS set; one trade date per run, no backfill" },
  census_trade: { required: ["CENSUS_API_KEY"], prefixes: ["census"], dataCadenceD: 31, lagD: 40, note: "inert until CENSUS_API_KEY set" },
  cpc_outlook: { required: [], prefixes: ["cpc"], dataCadenceD: 31, lagD: 45, note: "ONI 3-month season → centre month" },
  river_stage: { required: [], prefixes: ["river"], dataCadenceD: 1, lagD: 2 },
  comexstat: { required: [], prefixes: ["comex"], dataCadenceD: 31, lagD: 20 },
  banyan_rin: { required: ["EMAIL_INTAKE_USER", "EMAIL_INTAKE_PASS"], prefixes: ["rin"], dataCadenceD: 1, lagD: 4, note: "from the EcoEngineers snapshot email" },
  carbon_prices: { required: ["EMAIL_INTAKE_USER", "EMAIL_INTAKE_PASS"], prefixes: ["lcfs"], dataCadenceD: 1, lagD: 4, note: "LCFS/CFP only (EU ETS moved to eu_ets)" },
  eu_ets: { required: [], prefixes: ["euets"], dataCadenceD: 7, lagD: 7, note: "CBAM cert quarterly in 2026; daily ref only when fresh" },
};

// The four market inputs the Member Brief (Phase 2) will quote, with the series each would read today.
// `need` documents what the brief requires that the store does not yet hold.
export const MEMBER_BRIEF_INPUTS = [
  {
    id: "fund_positioning",
    label: "Fund positioning (CFTC managed money)",
    series: ["cftc:soybeans:mm-net", "cftc:soymeal:mm-net", "cftc:soyoil:mm-net"],
    maxAgeD: 11, // last Friday's release, as of the prior Tuesday
    need: "wk/wk and 52-wk percentile computed from the stored series at render (1.40.0)",
  },
  {
    id: "oil_share",
    label: "Oil share of crush",
    series: ["cme:zl:front", "cme:zm:front", seriesKey("ams", "oil"), seriesKey("ams", "meal")],
    maxAgeD: 7,
    need: `member-facing: CME settlements first, USDA AMS ${V.state} cash second — never the Yahoo board legs`,
  },
  {
    id: "soy_corn_ratio",
    label: "Soy:corn price ratio",
    series: ["cme:zs:*-11 ÷ cme:zc:*-12", seriesKey("nass", "soy-corn-ratio")],
    maxAgeD: 4,
    need: `new-crop Nov/Dec needs CME_SETTLEMENTS on (no backfill — history starts the day it is set); NASS ${V.state} monthly is dated context`,
  },
  {
    id: "barge_freight",
    label: "Barge freight by location",
    series: ["agtransport:barge-freight:st-louis", "agtransport:barge-freight:illinois-river"],
    maxAgeD: 14,
    need: "per-location $/ton (1.40.0); 3-yr same-week average computed at render",
  },
];

// Model calls with a fixed max_tokens. A call whose output_tokens reaches its cap was TRUNCATED; for
// the schema-constrained JSON calls that means JSON.parse fails and the caller silently returns
// null/0 — the response is paid for and thrown away. These caps mirror src/pipeline.js.
// Every max_tokens each purpose has run with (old caps kept, so pre-1.39.0 rows are still judged).
// Rows written since 1.39.0 carry token_usage.stop_reason and are judged by it directly; the cap ratio
// is only the fallback for older rows that have no stop_reason.
export const OUTPUT_CAPS = {
  storylines: [4500, 9000],
  cards: [2500, 8000],
  news_digest: [1600, 2400],
  market_intel: [1500, 2400],
  expectations: [2500],
  forecast_extract: [3000],
};
const TRUNCATION_RATIO = 0.98;

// Inputs of the live-computed panels (src/signals.js SIGNAL_CHART, src/crush.js). Their freshness IS
// the freshness of these series.
const SIGNAL_INPUTS = [
  "nass:us:condition",
  seriesKey("vegscape", "vci"),
  seriesKey("cropcasma", "rootzone-sm"),
  seriesKey("drought_monitor", "d1"),
  "agtransport:soy-net-export-sales",
  "wasde:us:soy-stocks-to-use",
  "cftc:soybeans:mm-net",
  "ibge_brazil:soy-production",
  seriesKey("nass", "soy-corn-ratio"),
  "nass:us:crush",
  "open_meteo:us:precip-pctile",
  "open_meteo:sa:precip-pctile",
];
const CRUSH_INPUTS = ["cbot:zs:front", "cbot:zm:front", "cbot:zl:front", "cbot:crush:board-margin", seriesKey("ams", "meal"), seriesKey("ams", "oil"), seriesKey("ams", "cash-crush-margin"), "nass:us:crush"];

// ---------------------------------------------------------------------------------------------
// Small, defensive DB helpers — the audit must run on any DB vintage, so every query tolerates a
// missing table or column and reports "n/a" instead of crashing.
// ---------------------------------------------------------------------------------------------
function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}
function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}
function q(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}
function q1(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}
function kv(db, key) {
  const row = q1(db, "SELECT v, updated_at FROM kv_state WHERE k = ?", key);
  if (!row) return null;
  let value = row.v;
  try {
    value = JSON.parse(row.v);
  } catch {
    /* plain string */
  }
  return { value, updatedAt: row.updated_at };
}

const toMs = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
/** Period strings in market_series: "YYYY", "YYYY-MM", "YYYY-MM-DD" (same rule as store.periodToMs). */
function periodToMs(p) {
  const m = String(p).split("-");
  if (!/^\d{4}$/.test(m[0])) return null;
  const t = Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1);
  return Number.isNaN(t) ? null : t;
}
export function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const h = ms / HOUR;
  if (h < 1) return `${Math.max(0, Math.round(h * 60))}m`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(h / 24 < 10 ? 1 : 0)}d`;
}
const isoShort = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 16) : "—");

// ---------------------------------------------------------------------------------------------
// Static facts read from source TEXT (never by importing — see the header).
// ---------------------------------------------------------------------------------------------
export function discoverAdapters(projectRoot = PROJECT_ROOT) {
  const dir = path.join(projectRoot, "src", "adapters");
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "index.js");
  } catch {
    return out;
  }
  let indexText = "";
  try {
    indexText = fs.readFileSync(path.join(dir, "index.js"), "utf8");
  } catch {
    /* no registry → nothing is registered */
  }
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const id = text.match(/export const id\s*=\s*["']([^"']+)["']/)?.[1];
    if (!id) continue;
    const label = text.match(/export const label\s*=\s*["']([^"']+)["']/)?.[1] ?? id;
    const hasItems = /export\s+(async\s+)?function\s+fetchItems\b/.test(text);
    const hasSeries = /export\s+(async\s+)?function\s+fetchSeries\b/.test(text);
    const registered = new RegExp(`\\[${id}\\.id\\]`).test(indexText);
    const cls = indexText.match(new RegExp(`^\\s*${id}:\\s*"(official|news|markets)"`, "m"))?.[1] ?? "official";
    out.push({ id, label, file: `src/adapters/${f}`, hasItems, hasSeries, registered, cls });
  }
  return out.sort((a, b) => (a.cls + a.id).localeCompare(b.cls + b.id));
}

/** Parse a .env file into { KEY: hasValue } — values are NEVER kept, only whether one exists. */
export function envPresence(files = [], processEnv = process.env) {
  const present = {};
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const raw = m[2].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
      if (raw) present[m[1]] = true;
      else if (!(m[1] in present)) present[m[1]] = false;
    }
  }
  for (const [k, v] of Object.entries(processEnv ?? {})) {
    if (v != null && String(v).trim() !== "") present[k] = true;
  }
  return present;
}

/** "set" when any alternative in a `A|B` group is set, else "MISSING". */
function keyGroupState(group, present) {
  const alts = group.split("|");
  const hit = alts.find((k) => present[k]);
  return hit ? { group, ok: true, via: hit } : { group, ok: false, via: null };
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Last line in the log mentioning `needle` together with a warning/error marker. */
function lastLogError(logLines, needles) {
  if (!logLines.length) return null;
  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i];
    if (!/(⚠️|❌|failed|skipped|error)/i.test(line)) continue;
    if (needles.some((n) => n && line.includes(n))) return line.trim().slice(0, 220);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The audit.
// ---------------------------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {import("better-sqlite3").Database} o.db   an OPEN handle (read-only for the CLI)
 * @param {object|null} o.watchlist                  the LIVE watchlist (data-dir copy)
 * @param {object|null} o.defaultWatchlist           the shipped project watchlist.json
 * @param {Record<string, boolean>} o.envPresent     from envPresence() — booleans only
 * @param {string} o.dataDir
 * @param {string} [o.projectRoot]
 * @param {Date}   [o.now]
 * @param {string} [o.logText]                      optional captured log to mine for last errors
 */
export function auditFreshness({ db, watchlist, defaultWatchlist = null, envPresent = {}, dataDir, projectRoot = PROJECT_ROOT, now = new Date(), logText = "", budgetUsd = null }) {
  const nowMs = now.getTime();
  const logLines = logText ? logText.split(/\r?\n/) : [];
  const warnings = [];
  const ageMs = (iso) => {
    const t = toMs(iso);
    return t == null ? null : nowMs - t;
  };

  // ---------- run history (the scheduler's real record) ----------
  const runs = tableExists(db, "brief_runs")
    ? q(db, "SELECT id, edition, trigger, status, stage, started_at, finished_at, error, missing_layers FROM brief_runs WHERE started_at >= ? ORDER BY started_at DESC", new Date(nowMs - 45 * DAY).toISOString())
    : [];
  const lastRun = (edition, okOnly = false) => runs.find((r) => r.edition === edition && (!okOnly || r.status === "ok")) ?? null;

  // missing_layers names the evidence layers a run could not reach (skipped sources + failed market
  // refreshes). It is the ONLY persisted per-source failure record, so it doubles as "last error".
  const lastMissing = new Map(); // label → { at, edition }
  for (const r of [...runs].reverse()) {
    let layers = [];
    try {
      layers = JSON.parse(r.missing_layers || "[]");
    } catch {
      layers = [];
    }
    for (const l of layers) lastMissing.set(String(l).replace(/ \(market data\)$/, ""), { at: r.started_at, edition: r.edition });
  }

  // ---------- sources ----------
  const adapters = discoverAdapters(projectRoot);
  const itemRuns = new Map(q(db, "SELECT source_id, last_success_at FROM runs").map((r) => [r.source_id, r.last_success_at]));
  // The persisted last outcome per source (store.recordSourceAttempt) — survives a restart, unlike the
  // in-memory log. A source whose latest attempt (items or series) failed is reported as failing.
  const healthBySource = new Map();
  if (tableExists(db, "source_health")) {
    for (const h of q(db, "SELECT * FROM source_health")) {
      const prev = healthBySource.get(h.source_id);
      if (!prev || h.last_attempt_at > prev.last_attempt_at) healthBySource.set(h.source_id, h);
    }
  }
  const seriesRuns = tableExists(db, "market_runs")
    ? new Map(q(db, "SELECT source_id, last_success_at, series_count FROM market_runs").map((r) => [r.source_id, r]))
    : new Map();
  const newestItem = new Map(
    q(
      db,
      `SELECT source_id, MAX(first_seen_at) AS newest,
              SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS n7
         FROM seen_items GROUP BY source_id`,
      new Date(nowMs - 7 * DAY).toISOString()
    ).map((r) => [r.source_id, r])
  );

  // Every series with its newest period, grouped by namespace prefix.
  const seriesRows = q(
    db,
    `SELECT m.series, m.label, m.category, m.updated_at, MAX(s.period) AS latest, COUNT(s.period) AS n
       FROM market_series_meta m LEFT JOIN market_series s ON s.series = m.series
      GROUP BY m.series`
  );
  const prefixOf = (series) => String(series).split(":")[0];
  const prefixOwner = new Map();
  for (const a of adapters) {
    const exp = SOURCE_EXPECTATIONS[a.id] ?? {};
    for (const p of exp.prefixes ?? [a.id]) prefixOwner.set(p, a.id);
  }
  const seriesByAdapter = new Map();
  const unowned = new Map();
  for (const s of seriesRows) {
    const owner = prefixOwner.get(prefixOf(s.series));
    if (!owner) {
      unowned.set(prefixOf(s.series), (unowned.get(prefixOf(s.series)) ?? 0) + 1);
      continue;
    }
    if (!seriesByAdapter.has(owner)) seriesByAdapter.set(owner, []);
    seriesByAdapter.get(owner).push(s);
  }

  const liveSources = watchlist?.sources ?? {};
  const sources = adapters.map((a) => {
    const exp = SOURCE_EXPECTATIONS[a.id] ?? { required: [], dataCadenceD: null, note: "no cadence on file — add it to SOURCE_EXPECTATIONS" };
    const cfg = liveSources[a.id];
    const inDefault = Boolean(defaultWatchlist?.sources?.[a.id]);
    // collect.js SKIPS an item adapter with no watchlist entry; refreshMarketSeries treats a missing
    // entry as enabled (`enabled !== false`). The /sources page shows both as enabled. Report what
    // the code actually does.
    let enabled;
    let enabledNote = "";
    if (a.hasItems && !a.hasSeries) {
      enabled = Boolean(cfg?.enabled);
      if (!cfg) enabledNote = "NO WATCHLIST ENTRY — collect.js skips it every run (Sources page still shows it as on)";
    } else if (a.hasSeries && !a.hasItems) {
      enabled = cfg?.enabled !== false;
      if (!cfg) enabledNote = "no watchlist entry (series refresh treats as enabled)";
    } else {
      enabled = cfg ? cfg.enabled !== false : true;
      if (!cfg) enabledNote = "no watchlist entry — ITEMS skipped by collect.js; SERIES still refresh";
      else if (cfg.enabled !== false && !cfg.enabled) enabledNote = "`enabled` unset — ITEMS skipped by collect.js; SERIES still refresh";
    }
    if (!a.registered) enabledNote = `${enabledNote ? enabledNote + "; " : ""}NOT REGISTERED in adapters/index.js`;
    if (!cfg && inDefault) enabledNote += " (present in the shipped watchlist.json — the live /data copy was seeded before it existed)";

    const keys = (exp.required ?? []).map((g) => keyGroupState(g, envPresent));
    const optional = (exp.optional ?? []).map((g) => keyGroupState(g, envPresent));
    const keyOk = keys.every((k) => k.ok);

    const itemAt = itemRuns.get(a.id) ?? null;
    const sr = seriesRuns.get(a.id) ?? null;
    const lastFetch = [itemAt, sr?.last_success_at].filter(Boolean).sort().pop() ?? null;
    const fetchAge = ageMs(lastFetch);

    const mine = seriesByAdapter.get(a.id) ?? [];
    let newestPeriod = null;
    let newestSeries = null;
    for (const s of mine) {
      if (s.latest && (!newestPeriod || s.latest > newestPeriod)) {
        newestPeriod = s.latest;
        newestSeries = s.series;
      }
    }
    const dataAge = newestPeriod ? nowMs - periodToMs(newestPeriod) : null;
    const it = newestItem.get(a.id) ?? null;

    const failing = healthBySource.get(a.id)?.last_outcome === "error" && healthBySource.get(a.id).consecutive_failures > 0 ? healthBySource.get(a.id) : null;
    // Status precedence: off → no key → latest attempt failed → never fetched → stale fetch → stale data → ok.
    const fetchLimit = 2 * PIPELINE_CADENCE_H * HOUR;
    const dataLimit = exp.dataCadenceD != null ? (2 * exp.dataCadenceD + (exp.lagD ?? 0)) * DAY : null;
    let status;
    if (!enabled) status = "OFF";
    else if (!keyOk) status = "NO KEY";
    else if (failing) status = `FAILING (${failing.consecutive_failures}× — last ok ${failing.last_ok_at ? isoShort(failing.last_ok_at) : "never"})`;
    else if (!lastFetch) status = "NEVER";
    else if (fetchAge > fetchLimit) status = "STALE (fetch)";
    else if (a.hasSeries && dataLimit != null && dataAge != null && dataAge > dataLimit) status = "STALE (data)";
    else if (a.hasSeries && !mine.length) status = "NO SERIES";
    else status = "OK";

    const missing = lastMissing.get(a.label);
    const h = healthBySource.get(a.id);
    const lastError =
      lastLogError(logLines, [a.label, `${a.id}:`, `${a.id} `]) ??
      (h?.last_outcome === "error" && h.last_error ? `last attempt ${isoShort(h.last_attempt_at)} failed: ${h.last_error}` : null) ??
      (missing ? `named unavailable in the ${missing.edition} run of ${isoShort(missing.at)} (brief_runs.missing_layers)` : null);

    return {
      id: a.id,
      label: a.label,
      cls: a.cls,
      kind: a.hasItems && a.hasSeries ? "items+series" : a.hasSeries ? "series" : "items",
      enabled,
      enabledNote,
      keys,
      optional,
      keyOk,
      lastItemFetch: itemAt,
      lastSeriesFetch: sr?.last_success_at ?? null,
      seriesCount: mine.length,
      lastFetch,
      fetchAgeMs: fetchAge,
      expectedFetch: `${PIPELINE_CADENCE_H}h`,
      newestPeriod,
      newestSeries,
      dataAgeMs: dataAge,
      expectedData: exp.dataCadenceD != null ? `${exp.dataCadenceD}d${exp.lagD ? ` +${exp.lagD}d lag` : ""}` : "event-driven",
      newestItem: it?.newest ?? null,
      items7d: it?.n7 ?? 0,
      status,
      lastError,
      note: exp.note ?? "",
    };
  });
  for (const [p, n] of unowned) warnings.push(`${n} market series under prefix "${p}:" are not attributed to any adapter in SOURCE_EXPECTATIONS.`);

  // ---------- model-call evidence per purpose ----------
  const usageCols = columnsOf(db, "token_usage");
  const hasRunId = usageCols.has("run_id");
  const usageRows = q(
    db,
    `SELECT u.ts, u.model, u.purpose, u.input_tokens, u.output_tokens${hasRunId ? ", u.run_id" : ", NULL AS run_id"}${usageCols.has("stop_reason") ? ", u.stop_reason" : ", NULL AS stop_reason"}
       FROM token_usage u WHERE u.ts >= ? ORDER BY u.ts DESC`,
    new Date(nowMs - 45 * DAY).toISOString()
  );
  const runById = new Map(runs.map((r) => [r.id, r]));
  const usage = (purpose) => usageRows.filter((r) => r.purpose === purpose);
  const truncated = (r) =>
    r.stop_reason ? r.stop_reason === "max_tokens" : (OUTPUT_CAPS[r.purpose] ?? []).some((cap) => Math.abs(r.output_tokens - cap) <= cap * (1 - TRUNCATION_RATIO));

  // ---------- panels ----------
  const ed = watchlist?.briefEditions ?? {};
  const daySpecCadence = (spec) => (typeof spec === "string" && spec.trim() ? 7 * DAY : null);
  const brief = (edition) => q1(db, "SELECT MAX(created_at) AS at, COUNT(*) AS n FROM briefs WHERE edition = ?", edition);

  const panel = ({ id, label, where, writer, lastAt, expectedMs, expectedLabel, purpose = null, evidence = "", error = null, computed = false }) => {
    const age = ageMs(lastAt);
    let status;
    if (computed) status = "LIVE";
    else if (expectedMs == null) status = lastAt ? "ON DEMAND" : "NEVER (on demand)";
    else if (!lastAt) status = "NEVER";
    else status = age > 2 * expectedMs ? "STALE" : "OK";
    // Attempted-after-success: the model was called more recently than the panel last persisted. That
    // is the signature of a run that paid for a response and then threw it away (null / empty / truncated).
    let attempt = null;
    if (purpose) {
      const calls = usage(purpose);
      const after = calls.filter((c) => !lastAt || c.ts > lastAt);
      const trunc = calls.filter(truncated);
      attempt = {
        lastCall: calls[0]?.ts ?? null,
        lastOutputTokens: calls[0]?.output_tokens ?? null,
        cap: (OUTPUT_CAPS[purpose] ?? []).slice(-1)[0] ?? null,
        callsSinceLastSuccess: after.length,
        truncatedSinceLastSuccess: after.filter(truncated).length,
        truncated45d: trunc.length,
      };
      if (after.length && !computed) status += after.every(truncated) ? " · ATTEMPTS TRUNCATED" : " · ATTEMPTS NOT PERSISTED";
    }
    // Since 1.39.0 every cached panel records its own last attempt (src/panels.js) — the direct answer.
    const rec = kv(db, `panel_attempt:${id}`)?.value ?? null;
    if (rec && typeof rec === "object") {
      attempt = { ...(attempt ?? {}), lastAttemptAt: rec.lastAttemptAt, lastOutcome: rec.lastOutcome, lastError: rec.lastError, consecutiveFailures: rec.consecutiveFailures ?? 0 };
      if (rec.lastOutcome && rec.lastOutcome !== "ok" && (!lastAt || rec.lastAttemptAt > lastAt) && !/ATTEMPTS/.test(status)) {
        status += ` · LAST ATTEMPT ${String(rec.lastOutcome).toUpperCase()}`;
      }
    }
    const expected = expectedLabel ?? (computed ? "live (see inputs)" : expectedMs ? fmtAge(expectedMs) : "on demand");
    return { id, label, where, writer, lastAt, ageMs: age, expected, status, attempt, evidence, error };
  };

  const meta = kv(db, "storylines_meta");
  const storyRows = tableExists(db, "storylines") ? q(db, "SELECT key, name, updated_at, materiality, state FROM storylines ORDER BY updated_at DESC") : [];
  const nd = kv(db, "news_digest");
  const mi = kv(db, "market_intel");
  const mc = kv(db, "market_cards");
  const amOk = lastRun("am", true);
  const pmOk = lastRun("pm", true);
  const am = lastRun("am");
  const pm = lastRun("pm");
  const latestThesis = tableExists(db, "theses") ? q1(db, "SELECT MAX(created_at) AS at, COUNT(*) AS n FROM theses") : null;
  const latestCard = tableExists(db, "policy_cards") ? q1(db, "SELECT MAX(created_at) AS at, SUM(CASE WHEN status='kept' THEN 1 ELSE 0 END) AS kept FROM policy_cards") : null;
  const latestAlert = tableExists(db, "alerts") ? q1(db, "SELECT MAX(created_at) AS at, COUNT(*) AS n FROM alerts") : null;
  const alertFail = kv(db, "alerts:consecutive_delivery_failures");
  const latestPacket = tableExists(db, "evidence_packets") ? q1(db, "SELECT MAX(COALESCE(refreshed_at, created_at)) AS at FROM evidence_packets") : null;
  const latestExpect = tableExists(db, "report_expectations") ? q1(db, "SELECT MAX(created_at) AS at, SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open FROM report_expectations") : null;

  // Series-derived panels are computed live at render time, so their freshness IS their inputs'.
  const seriesLatest = new Map(seriesRows.map((s) => [s.series, s]));
  const inputs = (keys) =>
    keys.map((k) => {
      const s = seriesLatest.get(k);
      return s ? `${k} @ ${s.latest ?? "—"}` : `${k} (ABSENT)`;
    });
  const oldestInput = (keys) => {
    const periods = keys.map((k) => seriesLatest.get(k)?.latest).filter(Boolean).sort();
    return periods[0] ?? null;
  };

  // Calendar coverage (calendar.js merges every <prefix>.<year>.json — and has no store import).
  const cov = calendarCoverage(now);

  // Backups.
  let newestBackup = null;
  try {
    const root = path.join(dataDir, "backups");
    for (const d of fs.readdirSync(root)) {
      const st = fs.statSync(path.join(root, d));
      if (!newestBackup || st.mtimeMs > newestBackup) newestBackup = st.mtimeMs;
    }
  } catch {
    /* no backups dir */
  }

  const panels = [
    panel({ id: "brief_am", label: "Daily policy brief — AM run", where: "Home · Saved briefs · email", writer: "scheduler → runPipeline(am)", lastAt: amOk?.started_at, expectedMs: DAY, purpose: null, evidence: am ? `last AM run ${isoShort(am.started_at)} status=${am.status}` : "no AM run in 45d", error: am?.status === "failed" ? am.error : null }),
    panel({ id: "brief_pm", label: "Daily policy brief — PM run", where: "Home · Saved briefs · email", writer: "scheduler → runPipeline(pm)", lastAt: pmOk?.started_at, expectedMs: DAY, evidence: pm ? `last PM run ${isoShort(pm.started_at)} status=${pm.status}` : "no PM run in 45d", error: pm?.status === "failed" ? pm.error : null }),
    panel({ id: "policy_cards", label: "Policy cards", where: "daily brief body", writer: "generateBrief → policycards.js", lastAt: latestCard?.at, expectedMs: null, expectedLabel: "per run with relevant items (quiet days write none)", evidence: latestCard ? `${latestCard.kept ?? 0} kept cards all-time` : "" }),
    panel({ id: "storylines", label: "Storylines", where: "News tab (🧵 panel)", writer: "generateStorylines — AM edition only", lastAt: meta?.value?.generatedAt, expectedMs: DAY, purpose: "storylines", evidence: `${storyRows.length} threads stored; newest thread update ${isoShort(storyRows[0]?.updated_at)}`, error: lastLogError(logLines, ["Storylines"]) }),
    panel({ id: "news_digest", label: "News digest", where: "News tab", writer: "generateNewsDigest — every run", lastAt: nd?.value?.createdAt, expectedMs: PIPELINE_CADENCE_H * HOUR, purpose: "news_digest", error: lastLogError(logLines, ["News digest"]) }),
    panel({ id: "market_intel", label: "Market intel (inbox)", where: "News tab · Analyst/Ask context", writer: "extractMarketIntel — every run", lastAt: mi?.value?.createdAt, expectedMs: PIPELINE_CADENCE_H * HOUR, purpose: "market_intel", error: lastLogError(logLines, ["Market-intel"]) }),
    panel({ id: "market_cards", label: "Signal cards", where: "Markets tab", writer: "generateMarketCards — every run", lastAt: mc?.value?.createdAt, expectedMs: PIPELINE_CADENCE_H * HOUR, purpose: "cards", error: lastLogError(logLines, ["Market cards"]) }),
    panel({ id: "signals", label: "Signal board", where: "Markets tab", writer: "computeSignals (live)", lastAt: null, computed: true, evidence: `oldest input period ${oldestInput(SIGNAL_INPUTS) ?? "—"}; ${inputs(SIGNAL_INPUTS).join("; ")}` }),
    panel({ id: "crush", label: "Crush margin / oil share", where: "Markets charts + signal", writer: "crush.js (live)", lastAt: null, computed: true, evidence: inputs(CRUSH_INPUTS).join("; ") }),
    panel({ id: "balance_sheet", label: "Balance sheet + house nowcast", where: "Ask box context (not the Analyst Note)", writer: "balancesheet.js (live)", lastAt: latestExpect?.at, computed: true, evidence: [...inputs(["wasde:us:soy-endstocks", "wasde:us:soy-stocks-to-use", "nass:us:crush", "fas:soybeans:commitments"]), `open expectations ${latestExpect?.open ?? 0}`].join("; ") }),
    panel({ id: "calendar", label: "Report / policy calendar", where: "Home calendar · Markets 'Coming up'", writer: "authored src/data/{calendar,policy}_events.<year>.json", lastAt: null, computed: true, evidence: `fixed USDA events ahead: ${cov.fixedAhead} (next 60d: ${cov.fixedWithinWarn}); last fixed event ${cov.lastFixedEvent ?? "—"}${cov.warn ? " ⚠️ authored USDA dates end within 60 days — add next year's calendar file" : ""}` }),
    panel({ id: "alerts", label: "What-changed alerts", where: "Home", writer: "runAlertsCheck — every run (event-driven)", lastAt: latestAlert?.at, expectedMs: null, evidence: `${latestAlert?.n ?? 0} alerts stored; consecutive delivery failures ${alertFail?.value ?? 0}` }),
    panel({ id: "thesis", label: "Thesis ledger", where: "Analyst Note", writer: "Analyst Note (thesis.js + challenger.js)", lastAt: latestThesis?.at, expectedMs: daySpecCadence(ed.analyst), evidence: `${latestThesis?.n ?? 0} theses; analyst schedule ${ed.analyst || "off (on demand)"}` }),
    panel({ id: "weekly", label: "Weekly memo", where: "Saved briefs · email", writer: "runMemo(weekly)", lastAt: brief("weekly")?.at, expectedMs: daySpecCadence(ed.weekly), evidence: `schedule ${ed.weekly || "off"}` }),
    panel({ id: "monthly", label: "Monthly review", where: "Saved briefs", writer: "runMemo(monthly)", lastAt: brief("monthly")?.at, expectedMs: daySpecCadence(ed.monthly), evidence: `schedule ${ed.monthly || "off"}` }),
    panel({ id: "education", label: "Market-education brief", where: "Saved briefs · email", writer: "runMemo(education)", lastAt: brief("education")?.at, expectedMs: daySpecCadence(ed.education), evidence: `schedule ${ed.education || "off"}` }),
    panel({ id: "analyst", label: "Analyst Note", where: "Saved briefs", writer: "runMemo(analyst)", lastAt: brief("analyst")?.at, expectedMs: daySpecCadence(ed.analyst), evidence: `schedule ${ed.analyst || "off"}` }),
    panel({ id: "member", label: `${V.short} Member Brief`, where: "member email (BCC) · Saved briefs", writer: "runMemberBrief — Mon/Wed/Fri", lastAt: brief("member")?.at, expectedMs: 3 * DAY, expectedLabel: "Mon/Wed/Fri", evidence: `${brief("member-draft")?.n ?? 0} failed-closed draft(s) all-time; previews ${brief("member-preview")?.n ?? 0}` }),
    panel({ id: "packets", label: "Evidence packets", where: "brief/Ask/Analyst context", writer: "buildPackets — each relevant run", lastAt: latestPacket?.at, expectedMs: null, evidence: "built only when must_read/worth_knowing items exist" }),
    panel({ id: "backup", label: "Nightly backup", where: "/data/backups", writer: "scheduler 03:15", lastAt: newestBackup ? new Date(newestBackup).toISOString() : null, expectedMs: DAY }),
  ];

  // ---------- market series health (same rule as store.seriesFreshness, re-implemented read-only) ----------
  const seriesHealth = [];
  for (const s of seriesRows) {
    const pts = q(db, "SELECT period FROM market_series WHERE series = ? ORDER BY period DESC LIMIT 8", s.series).map((p) => p.period).reverse();
    if (!pts.length) continue;
    const latestMs = periodToMs(pts[pts.length - 1]);
    if (latestMs == null) continue;
    const ageDays = Math.round((nowMs - latestMs) / DAY);
    const gaps = [];
    for (let i = 1; i < pts.length; i++) {
      const a = periodToMs(pts[i - 1]);
      const b = periodToMs(pts[i]);
      if (a != null && b != null) gaps.push((b - a) / DAY);
    }
    gaps.sort((x, y) => x - y);
    const cadenceDays = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : 30;
    seriesHealth.push({ series: s.series, label: s.label, latest: pts[pts.length - 1], ageDays, cadenceDays, stale: ageDays > Math.max(cadenceDays * 3.5, 18), refreshedAt: s.updated_at });
  }
  seriesHealth.sort((a, b) => b.ageDays - a.ageDays);

  // ---------- storylines root-cause evidence ----------
  const since = meta?.value?.generatedAt ?? null;
  const runsSince = runs.filter((r) => !since || r.started_at > since);
  const amSince = runsSince.filter((r) => r.edition === "am");
  const storyCalls = usage("storylines").map((c) => ({
    ts: c.ts,
    model: c.model,
    input: c.input_tokens,
    output: c.output_tokens,
    truncated: truncated(c),
    run: c.run_id != null ? runById.get(c.run_id)?.edition ?? `run ${c.run_id}` : "manual/CLI",
  }));
  const callsSince = storyCalls.filter((c) => !since || c.ts > since);
  const relevant21 = q1(
    db,
    "SELECT COUNT(*) AS n FROM seen_items WHERE triage_verdict='relevant' AND first_seen_at >= ? AND source_id IN (" +
      adapters.filter((a) => a.cls === "official").map(() => "?").join(",") +
      ")",
    new Date(nowMs - 21 * DAY).toISOString(),
    ...adapters.filter((a) => a.cls === "official").map((a) => a.id)
  )?.n;
  const news21 = q1(
    db,
    "SELECT COUNT(*) AS n FROM seen_items WHERE first_seen_at >= ? AND source_id IN (" +
      adapters.filter((a) => a.cls === "news").map(() => "?").join(",") +
      ")",
    new Date(nowMs - 21 * DAY).toISOString(),
    ...adapters.filter((a) => a.cls === "news").map((a) => a.id)
  )?.n;

  let verdict;
  if (!since) verdict = "Storylines have never been generated successfully on this database.";
  else if (!amSince.length && !callsSince.length) verdict = "NO AM RUN since the last success — the AM edition is not firing (check the scheduler / briefEditions.am / container uptime).";
  else if (callsSince.length && callsSince.every((c) => c.truncated))
    verdict = `TRUNCATION: all ${callsSince.length} storylines call(s) since the last success hit max_tokens (${OUTPUT_CAPS.storylines}). The JSON is cut mid-object, JSON.parse fails, generateStorylines returns null without touching storylines_meta — and pruneStorylines never runs, so the stale threads stay on screen and stay in the next prompt.`;
  else if (callsSince.length && callsSince.some((c) => c.truncated))
    verdict = `MOSTLY TRUNCATION: ${callsSince.filter((c) => c.truncated).length}/${callsSince.length} calls since the last success hit max_tokens; the rest returned zero threads.`;
  else if (callsSince.length) verdict = "Model called but returned zero threads (or unparseable output below the cap) — null return, meta untouched.";
  else if ((relevant21 ?? 0) + (news21 ?? 0) < 3) verdict = "NULL RETURN: fewer than 3 items in the 21-day window, so generateStorylines exits before calling the model.";
  else verdict = "AM runs happened but no storylines call was recorded — generateStorylines THREW before recordUsage (API error / auth / bad model id). Check the log for '⚠️  Storylines skipped:'.";

  const storylines = {
    meta: meta?.value ?? null,
    metaUpdatedAt: meta?.updatedAt ?? null,
    threads: storyRows.length,
    newestThreadUpdate: storyRows[0]?.updated_at ?? null,
    oldestThreadUpdate: storyRows[storyRows.length - 1]?.updated_at ?? null,
    runsSinceLastSuccess: {
      am: amSince.length,
      amFailed: amSince.filter((r) => r.status === "failed").length,
      pm: runsSince.filter((r) => r.edition === "pm").length,
      firstAmErrors: [...new Set(amSince.filter((r) => r.error).map((r) => String(r.error).slice(0, 160)))].slice(0, 3),
    },
    items21d: { officialRelevant: relevant21 ?? null, news: news21 ?? null },
    calls: storyCalls.slice(0, 20),
    verdict,
    logLine: lastLogError(logLines, ["Storylines"]),
  };

  // ---------- scheduler coverage: did AM and PM fire each day? ----------
  const tz = ed.timezone ?? V.tz;
  const dayOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = dayOf(new Date(nowMs - i * DAY).toISOString());
    const onDay = runs.filter((r) => dayOf(r.started_at) === d);
    const cell = (e) => {
      const rs = onDay.filter((r) => r.edition === e);
      if (!rs.length) return "—";
      return rs.map((r) => (r.status === "ok" ? "ok" : r.status)).join("/");
    };
    days.push({ day: d, am: cell("am"), pm: cell("pm"), storylines: storyCalls.filter((c) => dayOf(c.ts) === d).map((c) => (c.truncated ? "TRUNC" : `${c.output}t`)).join(",") || "—" });
  }

  // ---------- Member Brief market inputs (Phase 2 readiness) ----------
  const memberInputs = MEMBER_BRIEF_INPUTS.map((inp) => {
    const rows = inp.series.map((key) => {
      if (key.startsWith("cme:zs:*")) {
        // New-crop ratio: the nearest Nov soybean contract over the nearest Dec corn contract that
        // BOTH have stored settles. cme_settlements keys contracts as cme:<prod>:<YYYY-MM>.
        const nov = seriesRows.filter((s) => /^cme:zs:\d{4}-11$/.test(s.series)).map((s) => s.series.slice(7, 11));
        const dec = new Set(seriesRows.filter((s) => /^cme:zc:\d{4}-12$/.test(s.series)).map((s) => s.series.slice(7, 11)));
        const year = nov.filter((y) => dec.has(y)).sort()[0];
        if (!year) return { key, present: false, latest: null, ageD: null, current: false };
        const latest = [seriesLatest.get(`cme:zs:${year}-11`)?.latest, seriesLatest.get(`cme:zc:${year}-12`)?.latest].filter(Boolean).sort()[0] ?? null;
        const ageD = latest ? Math.round((nowMs - periodToMs(latest)) / DAY) : null;
        return { key: `cme:zs:${year}-11 ÷ cme:zc:${year}-12`, present: true, latest, ageD, current: ageD != null && ageD <= inp.maxAgeD };
      }
      const s = seriesLatest.get(key);
      if (!s || !s.latest) return { key, present: false, latest: null, ageD: null, current: false };
      const ageD = Math.round((nowMs - periodToMs(s.latest)) / DAY);
      return { key, present: true, latest: s.latest, ageD, current: ageD <= inp.maxAgeD, points: s.n };
    });
    return { ...inp, rows };
  });

  // ---------- configuration drift ----------
  if (defaultWatchlist) {
    const missing = Object.keys(defaultWatchlist.sources ?? {}).filter((k) => !(k in liveSources));
    if (missing.length) warnings.push(`Live watchlist lacks ${missing.length} source entr${missing.length === 1 ? "y" : "ies"} that ship in the default watchlist.json: ${missing.join(", ")}. seedDataDir() only copies the file when absent, so new sources never reach an existing install.`);
  }
  const noEntry = adapters.filter((a) => !(a.id in liveSources)).map((a) => a.id);
  if (noEntry.length) warnings.push(`Adapters with no entry in the live watchlist: ${noEntry.join(", ")}.`);
  if (!logLines.length) warnings.push("No log supplied — 'last error' comes only from brief_runs (missing_layers / error). Pass --log to mine a captured docker log.");

  return {
    generatedAt: now.toISOString(),
    dataDir,
    sources,
    panels,
    seriesHealth,
    storylines,
    schedule: days,
    memberInputs,
    sourceHealth: tableExists(db, "source_health") ? q(db, "SELECT * FROM source_health ORDER BY source_id, kind") : [],
    budget: (() => {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const rows = q(
        db,
        `SELECT purpose, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens, SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens
           FROM token_usage WHERE ts >= ? GROUP BY purpose, model`,
        start
      );
      return summarizeSpend(rows, budgetUsd ?? monthlyBudget({}, watchlist), now);
    })(),
    calendar: cov,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const cell = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(r) {
  const out = [];
  out.push(`# Bean Brief freshness audit — ${isoShort(r.generatedAt)} UTC`);
  out.push("");
  out.push(`Data dir: \`${r.dataDir}\`. STALE = age > 2 × expected cadence (+ publication lag for data). Keys: presence only.`);
  out.push("");
  out.push("## Sources");
  out.push("");
  out.push("| Source | Class | Kind | Enabled | Keys | Last fetch (age) | Expected | Newest data | Data age / expected | Items 7d | Status | Last error / note |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.sources) {
    const keys = s.keys.length ? s.keys.map((k) => `${k.group.replace(/\|/g, " or ")}: ${k.ok ? "set" : "MISSING"}`).join(", ") : "none needed";
    const opt = s.optional.length ? ` (opt ${s.optional.map((k) => `${k.group}:${k.ok ? "set" : "–"}`).join(", ")})` : "";
    out.push(
      `| ${cell(s.id)} | ${s.cls} | ${s.kind} | ${s.enabled ? "yes" : "no"} | ${cell(keys + opt)} | ${isoShort(s.lastFetch)} (${fmtAge(s.fetchAgeMs)}) | ${s.expectedFetch} | ${cell(s.newestPeriod ?? (s.newestItem ? `item ${isoShort(s.newestItem)}` : "—"))} | ${fmtAge(s.dataAgeMs)} / ${s.expectedData} | ${s.items7d} | **${s.status}** | ${cell([s.enabledNote, s.lastError].filter(Boolean).join(" · ") || s.note)} |`
    );
  }
  out.push("");
  out.push("## Panels and outputs");
  out.push("");
  out.push("| Panel | Shown on | Writer | Last generated (age) | Expected | Status | Model-call evidence | Notes |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const p of r.panels) {
    const a = p.attempt;
    const ev = a
      ? `last call ${isoShort(a.lastCall)} · ${a.lastOutputTokens ?? "—"}/${a.cap ?? "—"} out · ${a.callsSinceLastSuccess} call(s) since success, ${a.truncatedSinceLastSuccess} at cap`
      : "—";
    out.push(`| ${cell(p.label)} | ${cell(p.where)} | ${cell(p.writer)} | ${isoShort(p.lastAt)} (${fmtAge(p.ageMs)}) | ${cell(p.expected)} | **${cell(p.status)}** | ${cell(ev)} | ${cell([p.evidence, p.error].filter(Boolean).join(" · "))} |`);
  }
  out.push("");
  out.push("## Storylines — root-cause evidence");
  out.push("");
  const st = r.storylines;
  out.push(`- storylines_meta: \`${JSON.stringify(st.meta)}\` (kv updated ${isoShort(st.metaUpdatedAt)})`);
  out.push(`- threads stored: ${st.threads}; newest thread update ${isoShort(st.newestThreadUpdate)}; oldest ${isoShort(st.oldestThreadUpdate)}`);
  out.push(`- runs since last success: AM ${st.runsSinceLastSuccess.am} (${st.runsSinceLastSuccess.amFailed} failed), PM ${st.runsSinceLastSuccess.pm}${st.runsSinceLastSuccess.firstAmErrors.length ? `; AM errors: ${st.runsSinceLastSuccess.firstAmErrors.join(" | ")}` : ""}`);
  out.push(`- 21-day window: ${st.items21d.officialRelevant ?? "?"} relevant official + ${st.items21d.news ?? "?"} news items (needs ≥ 3)`);
  out.push(`- **verdict:** ${st.verdict}`);
  if (st.logLine) out.push(`- last log line: \`${st.logLine}\``);
  out.push("");
  if (st.calls.length) {
    out.push("| storylines call (UTC) | run | model | in | out | at cap? |");
    out.push("|---|---|---|---|---|---|");
    for (const c of st.calls) out.push(`| ${isoShort(c.ts)} | ${cell(c.run)} | ${cell(c.model)} | ${c.input} | ${c.output} | ${c.truncated ? "**YES**" : "no"} |`);
    out.push("");
  }
  out.push("## Scheduler coverage — last 14 days (brief_runs)");
  out.push("");
  out.push("| Day | AM | PM | storylines calls |");
  out.push("|---|---|---|---|");
  for (const d of r.schedule) out.push(`| ${d.day} | ${d.am} | ${d.pm} | ${d.storylines} |`);
  out.push("");
  out.push("## Member Brief market inputs");
  out.push("");
  out.push("| Input | Series | Present | Latest period | Age (d) | Allowed (d) | Current? | Gap for Phase 2 |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const inp of r.memberInputs) {
    inp.rows.forEach((row, i) => {
      out.push(`| ${i ? "" : cell(inp.label)} | ${cell(row.key)} | ${row.present ? "yes" : "**no**"} | ${row.latest ?? "—"} | ${row.ageD ?? "—"} | ${inp.maxAgeD} | ${row.present ? (row.current ? "yes" : "**STALE**") : "—"} | ${i ? "" : cell(inp.need)} |`);
    });
  }
  out.push("");
  const stale = r.seriesHealth.filter((s) => s.stale);
  out.push(`## Market series — ${stale.length} of ${r.seriesHealth.length} overdue (store.seriesFreshness rule)`);
  out.push("");
  if (stale.length) {
    out.push("| Series | Latest period | Age (d) | Own cadence (d) | Last refreshed |");
    out.push("|---|---|---|---|---|");
    for (const s of stale) out.push(`| ${cell(s.series)} | ${s.latest} | ${s.ageDays} | ${s.cadenceDays} | ${isoShort(s.refreshedAt)} |`);
    out.push("");
  }
  if (r.budget) {
    const b = r.budget;
    out.push(`## Anthropic spend — month to date $${b.spent.toFixed(2)} of $${b.budget.toFixed(2)} (projected $${b.projected.toFixed(2)})`);
    out.push("");
    out.push("| Group | Allocation | Spent | Kind |");
    out.push("|---|---|---|---|");
    for (const g of b.groups) out.push(`| ${cell(g.label)} | $${g.allocation.toFixed(2)} | $${g.spent.toFixed(2)} | ${g.essential ? "essential" : "discretionary"} |`);
    out.push("");
  }
  if (r.sourceHealth?.length) {
    out.push("## Source health (recorded attempts)");
    out.push("");
    out.push("| Source | Kind | Last attempt | Outcome | Last non-empty | Fails in a row | Last error |");
    out.push("|---|---|---|---|---|---|---|");
    for (const h of r.sourceHealth) out.push(`| ${h.source_id} | ${h.kind} | ${isoShort(h.last_attempt_at)} | ${h.last_outcome} | ${isoShort(h.last_nonempty_at)} | ${h.consecutive_failures} | ${cell(h.last_error ?? "")} |`);
    out.push("");
  }
  if (r.warnings.length) {
    out.push("## Warnings");
    out.push("");
    for (const w of r.warnings) out.push(`- ${w}`);
    out.push("");
  }
  return out.join("\n");
}

