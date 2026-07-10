// studio.js — The Bean Brief "Studio" charting tab (desktop-only chart workbench).
//
// Server side of the Studio: the catalog / series / events JSON that the vendored client
// (assets/studio.js) draws from, plus the page skeleton. Kept in its own module on purpose —
// the Studio touches server.js at only a few marked seams (one nav link, three routes, one
// asset-allowlist line). This ships alongside a separately-built map tab, so the shared-file
// footprint is deliberately tiny to keep the merge trivial. See docs/STUDIO_TAB_PLAN.md.
//
// Design: a "chart spec" (which series, transform, range, overlays, focus) is the single source
// of truth; the client renders it with the already-vendored uPlot. This module never draws — it
// only serves the data the app already collects. Charts stay secondary: the value is making the
// existing analytical layer (marketSnapshot stats, the report calendar, alerts) explorable.

import fs from "node:fs";
import * as store from "./store.js";
import { EDUCATION_FOOTER } from "./compliance.js";

const MAX_SERIES = 8; // guardrail: a spec can't request an unbounded number of series

// Friendly group labels + display order for the catalog rail. Unknown categories fall through to
// the end and use their own id as the label (so a newly-added market source still shows up).
const CAT_LABEL = {
  soy_price: "Soybean price", corn_price: "Corn price", soy_corn_ratio: "Soybean : corn ratio",
  soy_crush: "Soybean crush", soy_stocks: "Soybean stocks", soy_balance: "Ending stocks (WASDE)",
  soy_balance_stu: "Stocks-to-use (WASDE)", soy_condition: "Crop condition", drought: "Iowa drought",
  weather_us: "U.S. crop weather", weather_sa: "S. America crop weather", soy_exports: "Exports (weekly)",
  barge_freight: "Barge freight", positioning: "Fund positioning (CFTC)", macro_usd: "U.S. dollar index",
  macro_rates: "10-year Treasury", brazil_production: "Brazil production",
};
const CAT_ORDER = [
  "soy_price", "corn_price", "soy_corn_ratio", "soy_crush", "soy_stocks", "soy_balance",
  "soy_balance_stu", "soy_condition", "weather_us", "weather_sa", "drought", "soy_exports",
  "barge_freight", "positioning", "macro_usd", "macro_rates", "brazil_production",
];

export const STUDIO_TRANSFORMS = [
  { id: "none", label: "None" },
  { id: "rebase100", label: "Rebase to 100" },
  { id: "yoy", label: "YoY %" },
  { id: "ratio", label: "Ratio A ÷ B" },
  { id: "seasonal", label: "Seasonality" },
];

/** The left-rail catalog: every market series grouped by category, plus the transform list. */
export function studioCatalog() {
  const groups = new Map();
  for (const m of store.listSeriesMeta()) {
    if (!groups.has(m.category)) groups.set(m.category, []);
    groups.get(m.category).push({ id: m.series, label: m.label || m.series, unit: m.unit || "" });
  }
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  return {
    categories: cats.map((c) => ({ category: c, label: CAT_LABEL[c] || c, series: groups.get(c) })),
    transforms: STUDIO_TRANSFORMS,
  };
}

/**
 * The points + trend stats for a set of series ids. One call feeds a whole spec: `series` carries
 * the raw points (the client applies transforms), `stats` carries the marketSnapshot row per id
 * (latest / change / YoY / percentile / seasonal) for the right-hand panel. Server never invents
 * data — it hands back exactly what's stored.
 */
export function studioSeries(idsRaw) {
  const ids = uniq((idsRaw || []).map((s) => String(s).trim()).filter(Boolean)).slice(0, MAX_SERIES);
  const snapById = new Map(store.marketSnapshot().map((s) => [s.series, s]));
  const metaById = new Map(store.listSeriesMeta().map((m) => [m.series, m]));
  const series = [];
  const stats = {};
  for (const id of ids) {
    const meta = metaById.get(id);
    if (!meta) continue;
    const points = store.getSeries(id);
    if (!points.length) continue;
    series.push({ id, label: meta.label || id, unit: meta.unit || "", category: meta.category || "", points });
    const s = snapById.get(id);
    if (s) {
      stats[id] = {
        label: s.label, unit: s.unit, latest: s.latest, changePct: s.changePct, yoyPct: s.yoyPct,
        min: s.min, max: s.max, avg: s.avg, percentile: s.percentile, count: s.count,
        firstPeriod: s.firstPeriod, seasonalDeltaPct: s.seasonalDeltaPct, seasonalPctile: s.seasonalPctile,
      };
    }
  }
  return { series, stats };
}

/** Wide CSV (period + one column per series) for the current spec — mirrors /markets/csv. */
export function studioSeriesCSV(idsRaw) {
  const { series } = studioSeries(idsRaw);
  const periods = uniq(series.flatMap((c) => c.points.map((p) => p.period))).sort();
  const lookup = series.map((c) => new Map(c.points.map((p) => [p.period, p.value])));
  const csvEsc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = ["period", ...series.map((c) => csvEsc(c.label))].join(",");
  const lines = periods.map((p) => [p, ...lookup.map((m) => (m.has(p) ? m.get(p) : ""))].join(","));
  return [header, ...lines].join("\n");
}

// Dated events to flag on the x-axis: authoritative USDA/CME report dates (the calendar data file)
// + recent "what changed" alerts, both within [fromISO, toISO]. Overlaying policy/report context
// ON the fundamental series is the Studio's differentiator — no price terminal does this for beans.
let _CAL = null;
function calEvents() {
  if (_CAL) return _CAL;
  try {
    const raw = JSON.parse(fs.readFileSync(new URL("./data/calendar_events.2026.json", import.meta.url), "utf8"));
    _CAL = (raw.events || [])
      .filter((e) => e && e.date && e.title)
      .map((e) => ({ date: e.date, label: e.title, kind: "report", impact: e.impact || "medium" }));
  } catch { _CAL = []; }
  return _CAL;
}
export function studioEvents(fromISO, toISO) {
  const from = fromISO || "0000-00-00", to = toISO || "9999-99-99";
  const reports = calEvents().filter((e) => e.date >= from && e.date <= to);
  let alerts = [];
  try {
    alerts = store.listAlerts(60)
      .map((a) => ({ date: String(a.created_at || "").slice(0, 10), label: a.title || "", kind: "alert", impact: a.category || "" }))
      .filter((a) => a.date && a.label && a.date >= from && a.date <= to)
      .slice(0, 20);
  } catch { alerts = []; }
  return [...reports, ...alerts].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 60);
}

function uniq(a) { return [...new Set(a)]; }
function attr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

/**
 * The page body: a desktop-gated three-pane skeleton (catalog rail · chart · stats) + toolbar.
 * The client (assets/studio.js) fills the rail/chart/stats and wires every control. If a ?spec=
 * is present it's handed to the client via a data attribute so a shared link rehydrates the view.
 */
export function studioBody(url) {
  const spec = url && url.searchParams ? url.searchParams.get("spec") || "" : "";
  return `
<style>
  body { max-width: 1360px; }
  #studio-gate { display: none; }
  .st-toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 6px 0 14px; }
  .st-prompt { flex: 1 1 260px; min-width: 240px; display: flex; align-items: center; gap: 8px;
    border: 1px solid var(--isa-dark-40); border-radius: 8px; padding: 7px 11px; background: #fff; color: var(--muted); }
  .st-prompt input { flex: 1; border: none; background: none; font-size: .9em; color: var(--ink); }
  .st-tag { font-size: .68em; font-weight: 700; padding: 2px 8px; border-radius: 999px;
    background: var(--isa-gold-40); color: var(--isa-rust); border: 1px solid var(--isa-gold); white-space: nowrap; }
  .st-range, .st-export { display: flex; gap: 5px; align-items: center; }
  .st-range button, .st-export button, .st-export a { background: #fff; color: var(--isa-dark);
    border: 1px solid var(--isa-dark-40); border-radius: 6px; padding: 5px 11px; font-size: .85em;
    font-weight: 600; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
  .st-range button.on { background: var(--isa-blue); color: #fff; border-color: var(--isa-blue); }
  .st-range button:hover, .st-export button:hover, .st-export a:hover { background: var(--isa-gold-40); }
  .st-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr) 236px; gap: 16px; align-items: start; }
  #studio-rail, #studio-stats { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: #fff; }
  #studio-rail { max-height: 78vh; overflow: auto; }
  .st-railhead { font-weight: 700; color: var(--isa-dark); font-size: .82em; text-transform: uppercase;
    letter-spacing: .04em; display: flex; align-items: center; gap: 6px; margin: 2px 0 4px; }
  .st-grp { font-size: .72em; font-weight: 700; color: var(--isa-dark); opacity: .75; margin: 12px 0 3px; }
  .st-item { display: flex; align-items: center; gap: 7px; font-size: .85em; padding: 2px 0; cursor: pointer; }
  .st-item input { margin: 0; }
  .st-sub { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 8px; }
  .st-radio { display: flex; align-items: center; gap: 7px; font-size: .85em; padding: 2px 0; cursor: pointer; }
  .st-chart { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; background: #fff; min-height: 340px; }
  .st-caption { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .st-caption .st-title { font-weight: 700; color: var(--isa-dark); }
  .st-caption .st-chip { font-size: .72em; font-weight: 600; color: var(--isa-dark); background: var(--isa-blue-40);
    border-radius: 999px; padding: 1px 9px; }
  #studio-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: .8em; color: var(--ink); }
  #studio-legend .lg-sw { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin-right: 5px; border-radius: 2px; }
  #studio-legend .lg-foc { text-decoration: underline; text-decoration-style: dotted; cursor: pointer; }
  .st-statshead { font-weight: 700; color: var(--isa-dark); font-size: .82em; text-transform: uppercase;
    letter-spacing: .04em; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
  .st-focussel { width: 100%; margin-bottom: 8px; }
  .st-stat { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .st-stat .k { font-size: .78em; color: var(--muted); }
  .st-stat .v { font-size: .92em; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
  .st-stat .v.up { color: #2f7d4e; } .st-stat .v.down { color: #b8481f; }
  .st-explain { margin: 12px 0 8px; }
  .st-explain button { width: 100%; justify-content: center; opacity: .8; }
  .st-foot { font-size: .74em; color: var(--muted); line-height: 1.45; margin-top: 8px; }
  .st-empty { color: var(--muted); text-align: center; padding: 60px 12px; }
  .uplot { font-family: system-ui, sans-serif; }
  @media (max-width: 999px) { #studio-app { display: none; } }
</style>
<h1>Chart studio <span class="muted" style="font-size:.55em;font-weight:700;letter-spacing:.03em">DESKTOP</span></h1>
<div id="studio-gate" class="banner">The chart studio is built for a wider screen — open The Bean Brief on a desktop, or widen this window, to use it. The <a href="/markets">Markets</a> tab works everywhere.</div>
<div id="studio-app" data-spec="${attr(spec)}">
  <div class="st-toolbar">
    <div class="st-prompt" title="Natural-language charting is coming next">
      <span aria-hidden="true">✦</span>
      <input type="text" disabled placeholder="Describe a chart — “crush vs. soybean-oil feedstock share, rebased, 3y”">
      <span class="st-tag">phase 2</span>
    </div>
    <div class="st-range" id="st-range">
      <span class="muted" style="font-size:.8em;font-weight:600">Range</span>
      <button data-months="6">6M</button><button data-months="12">1Y</button>
      <button data-months="36" class="on">3Y</button><button data-months="60">5Y</button>
      <button data-months="all">All</button>
    </div>
    <div class="st-export">
      <button id="st-png" type="button" title="Download a PNG for slides / Teams">⬇ PNG</button>
      <a id="st-csv" download href="#" title="Download the underlying data">⬇ CSV</a>
      <button id="st-share" type="button" title="Copy a link that reproduces this view">🔗 Share</button>
    </div>
  </div>
  <div class="st-grid">
    <aside id="studio-rail"><div class="muted" style="font-size:.85em">Loading…</div></aside>
    <main class="st-chart">
      <div class="st-caption" id="studio-caption"></div>
      <div id="studio-panes"><div class="st-empty">Pick one or more series on the left to build a chart.</div></div>
      <div id="studio-legend"></div>
    </main>
    <aside id="studio-stats"></aside>
  </div>
</div>
<link rel="stylesheet" href="/assets/uPlot.min.css">
<script src="/assets/uPlot.iife.min.js"></script>
<script src="/assets/studio.js"></script>`;
}
