// usda_nass.js — USDA NASS Quick Stats: latest soybean supply & price data points.
// Free key: https://quickstats.nass.usda.gov/api  → NASS_API_KEY.
//
// Not topic-driven (like email_intake/rss). Each configured query pulls one metric and
// we emit the single most-recent observation as a "markets"-class item (see SOURCE_CLASS
// in adapters/index.js) — it surfaces on the Markets tab, not the policy brief. The raw
// value/period is kept so the market-signal layer can read it later.

import { fetchJSON } from "../util.js";

export const id = "usda_nass";
export const label = "USDA NASS (supply & price)";

const BASE = "https://quickstats.nass.usda.gov/api/api_GET/";

// One metric per query. Keep these few and high-signal for Iowa soy.
const QUERIES = [
  { key: "ia-price", title: "Iowa soybean price received", unit: "$/bu",
    params: { commodity_desc: "SOYBEANS", state_alpha: "IA", statisticcat_desc: "PRICE RECEIVED" } },
  { key: "us-production", title: "U.S. soybean production", unit: "bu",
    params: { commodity_desc: "SOYBEANS", agg_level_desc: "NATIONAL", statisticcat_desc: "PRODUCTION", unit_desc: "BU" } },
  { key: "us-stocks", title: "U.S. soybean stocks", unit: "bu",
    params: { commodity_desc: "SOYBEANS", agg_level_desc: "NATIONAL", statisticcat_desc: "STOCKS", unit_desc: "BU" } },
];

// NASS records aren't pre-sorted; newest load_time (then year) wins.
function latestOf(records) {
  return [...records].sort((a, b) => {
    const t = (b.load_time || "").localeCompare(a.load_time || "");
    return t !== 0 ? t : (Number(b.year) || 0) - (Number(a.year) || 0);
  })[0];
}

export async function fetchItems({ sourceConfig = {}, env = process.env }) {
  const key = env.NASS_API_KEY;
  if (!key) throw new Error("NASS_API_KEY not set (free key: https://quickstats.nass.usda.gov/api)");
  const budget = sourceConfig.maxItemsPerRun ?? 20;
  const items = [];

  for (const q of QUERIES) {
    if (items.length >= budget) break;
    const p = new URLSearchParams({ key, format: "JSON", year__GE: String(new Date().getFullYear() - 1), ...q.params });
    let data;
    try {
      data = await fetchJSON(`${BASE}?${p}`);
    } catch {
      continue; // one bad metric never kills the source (fail-soft)
    }
    const rec = latestOf(data.data ?? []);
    if (!rec?.Value) continue;
    const period = [rec.reference_period_desc, rec.year].filter(Boolean).join(" ").trim();
    items.push({
      uid: `${id}:${q.key}:${rec.year}:${rec.reference_period_desc}`,
      sourceId: id,
      sourceLabel: label,
      title: `${q.title}: ${rec.Value} ${q.unit} (${period})`,
      summary: rec.short_desc || q.title,
      url: "https://quickstats.nass.usda.gov/",
      publishedAt: (rec.load_time ? new Date(rec.load_time.replace(" ", "T")) : new Date()).toISOString(),
      jurisdiction: rec.state_alpha === "IA" ? "Iowa" : "US",
      docType: "data",
      raw: { metric: q.key, value: rec.Value, unit: q.unit, period, shortDesc: rec.short_desc },
    });
  }

  // Current Iowa soybean crop condition (% good+excellent) — a member-facing "how's the crop
  // right now" read. In-season only (empty off-season → skipped).
  try {
    const p = new URLSearchParams({ key, format: "JSON", year__GE: String(new Date().getFullYear()), commodity_desc: "SOYBEANS", statisticcat_desc: "CONDITION", state_alpha: "IA" });
    const data = await fetchJSON(`${BASE}?${p}`);
    const ge = (data.data ?? []).filter((r) => r.unit_desc === "PCT GOOD" || r.unit_desc === "PCT EXCELLENT");
    const latestWeek = ge.map((r) => r.week_ending).filter(Boolean).sort().pop();
    if (latestWeek) {
      const pct = ge.filter((r) => r.week_ending === latestWeek).reduce((a, r) => a + (Number(r.Value) || 0), 0);
      items.push({
        uid: `${id}:ia-condition:${latestWeek}`,
        sourceId: id,
        sourceLabel: label,
        title: `Iowa soybeans ${pct}% good/excellent (week ending ${latestWeek})`,
        summary: "USDA NASS Crop Progress — Iowa soybean condition (% good + excellent).",
        url: "https://quickstats.nass.usda.gov/",
        publishedAt: new Date(latestWeek).toISOString(),
        jurisdiction: "Iowa",
        docType: "data",
        raw: { metric: "ia-condition", value: pct, unit: "% G/E", period: latestWeek },
      });
    }
  } catch {
    /* fail-soft — condition is in-season only */
  }
  return items;
}

// ── Timeseries (v1.5 Markets charts) ────────────────────────────────────────
// Demand/supply/price series most relevant to Iowa soybean farmers.
const NASS_SERIES = [
  { key: "nass:us:crush", label: "U.S. soybean crush", category: "soy_crush", unit: "tons/mo",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "CRUSHED", agg_level_desc: "NATIONAL" } },
  { key: "nass:us:price", label: "U.S. avg", category: "soy_price", unit: "$/bu",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "PRICE RECEIVED", agg_level_desc: "NATIONAL", unit_desc: "$ / BU" } },
  { key: "nass:ia:price", label: "Iowa avg", category: "soy_price", unit: "$/bu",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "PRICE RECEIVED", state_alpha: "IA", unit_desc: "$ / BU" } },
  { key: "nass:us:stocks", label: "U.S. soybean stocks", category: "soy_stocks", unit: "bu",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "STOCKS", agg_level_desc: "NATIONAL", unit_desc: "BU" } },
  { key: "nass:us:corn-price", label: "U.S. avg", category: "corn_price", unit: "$/bu",
    params: { commodity_desc: "CORN", statisticcat_desc: "PRICE RECEIVED", agg_level_desc: "NATIONAL", unit_desc: "$ / BU" } },
  { key: "nass:ia:corn-price", label: "Iowa avg", category: "corn_price", unit: "$/bu",
    params: { commodity_desc: "CORN", statisticcat_desc: "PRICE RECEIVED", state_alpha: "IA", unit_desc: "$ / BU" } },
];
const MM2 = /^(0[1-9]|1[0-2])$/;

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. */
export async function fetchSeries({ env = process.env } = {}) {
  const key = env.NASS_API_KEY;
  if (!key) return [];
  const yearGE = new Date().getFullYear() - 9;
  const out = [];
  for (const s of NASS_SERIES) {
    const p = new URLSearchParams({ key, format: "JSON", year__GE: String(yearGE), ...s.params });
    let data;
    try {
      data = await fetchJSON(`${BASE}?${p}`);
    } catch {
      continue;
    }
    const pts = new Map();
    for (const r of data.data ?? []) {
      if (r.freq_desc === "ANNUAL") continue; // skip marketing-year/annual rows
      const mm = r.end_code; // NASS period-end month code, "01".."12"
      if (!MM2.test(mm)) continue;
      const val = Number(String(r.Value).replace(/,/g, ""));
      if (!Number.isFinite(val)) continue; // skips "(D)"/"(NA)" suppressed values
      pts.set(`${r.year}-${mm}`, val);
    }
    const points = [...pts.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
    if (points.length) out.push({ series: s.key, meta: { label: s.label, unit: s.unit, category: s.category }, points });
  }

  // Crop condition (% Good + Excellent), weekly in-season — the primary in-season signal
  // (weather's fingerprint on yield). Reported per condition class per week_ending; we sum
  // PCT GOOD + PCT EXCELLENT for each week. Iowa vs. U.S. share one chart.
  const CONDITION_SCOPES = [
    { key: "nass:ia:condition", label: "Iowa", params: { state_alpha: "IA" } },
    { key: "nass:us:condition", label: "U.S.", params: { agg_level_desc: "NATIONAL" } },
  ];
  for (const s of CONDITION_SCOPES) {
    const p = new URLSearchParams({ key, format: "JSON", year__GE: String(yearGE), commodity_desc: "SOYBEANS", statisticcat_desc: "CONDITION", ...s.params });
    let data;
    try {
      data = await fetchJSON(`${BASE}?${p}`);
    } catch {
      continue;
    }
    const byWeek = new Map();
    for (const r of data.data ?? []) {
      if (r.unit_desc !== "PCT GOOD" && r.unit_desc !== "PCT EXCELLENT") continue;
      const wk = r.week_ending; // "YYYY-MM-DD"
      const val = Number(String(r.Value).replace(/,/g, ""));
      if (!wk || !Number.isFinite(val)) continue;
      byWeek.set(wk, (byWeek.get(wk) ?? 0) + val);
    }
    const points = [...byWeek.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
    if (points.length) out.push({ series: s.key, meta: { label: s.label, unit: "% good/excellent", category: "soy_condition" }, points });
  }

  // Computed: the soybean-to-corn price ratio (Iowa) — a classic relative-value / acreage
  // read farmers watch (roughly ~2.3–2.5 is the historical planting-decision pivot). Derived
  // from the two Iowa price series above, matched on shared months. No extra API call.
  const iaSoy = out.find((s) => s.series === "nass:ia:price");
  const iaCorn = out.find((s) => s.series === "nass:ia:corn-price");
  if (iaSoy && iaCorn) {
    const cornByPeriod = new Map(iaCorn.points.map((p) => [p.period, p.value]));
    const ratio = iaSoy.points
      .filter((p) => cornByPeriod.get(p.period) > 0)
      .map((p) => ({ period: p.period, value: Math.round((p.value / cornByPeriod.get(p.period)) * 100) / 100 }));
    if (ratio.length) out.push({ series: "nass:ia:soy-corn-ratio", meta: { label: "Iowa soybean:corn price ratio", unit: "ratio", category: "soy_corn_ratio" }, points: ratio });
  }
  return out;
}
