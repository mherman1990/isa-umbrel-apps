// fred.js — FRED (St. Louis Fed) macro overlay, free key: FRED_API_KEY.
//
// The macro layer that quietly shapes soybean export competitiveness and carrying costs — a
// strong U.S. dollar caps U.S. export competitiveness vs. Brazil; rates set the cost of
// storage. Weekly frequency keeps the series light. "markets"-class.

import { fetchJSON } from "../util.js";

export const id = "fred";
export const label = "FRED (macro)";

const BASE = "https://api.stlouisfed.org/fred/series/observations";

const SERIES = [
  { key: "usd-broad", fredId: "DTWEXBGS", label: "U.S. broad dollar index", unit: "index", category: "macro_usd", title: "U.S. broad dollar index" },
  { key: "ust-10y", fredId: "DGS10", label: "10-year Treasury yield", unit: "%", category: "macro_rates", title: "10-year Treasury yield" },
];

async function history(fredId, apiKey) {
  // Weekly (ending Friday) since 2016 keeps ~500 points per series.
  const url = `${BASE}?series_id=${fredId}&api_key=${apiKey}&file_type=json&frequency=wef&observation_start=2016-01-01&sort_order=asc`;
  const d = await fetchJSON(url);
  return (d.observations ?? [])
    .filter((o) => o.value != null && o.value !== ".")
    .map((o) => ({ period: o.date, value: Number(o.value) }))
    .filter((p) => Number.isFinite(p.value));
}

export async function fetchItems({ env = process.env } = {}) {
  const apiKey = env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY not set (free key: https://fredaccount.stlouisfed.org/apikeys)");
  const items = [];
  for (const s of SERIES) {
    let pts;
    try {
      pts = await history(s.fredId, apiKey);
    } catch {
      continue;
    }
    if (!pts.length) continue;
    const last = pts[pts.length - 1];
    items.push({
      uid: `${id}:${s.key}:${last.period}`,
      sourceId: id,
      sourceLabel: label,
      title: `${s.title}: ${last.value} ${s.unit} (${last.period})`,
      summary: `FRED ${s.fredId} — macro context for soybean export competitiveness and carry.`,
      url: `https://fred.stlouisfed.org/series/${s.fredId}`,
      publishedAt: new Date(last.period).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: { metric: s.key, value: last.value, unit: s.unit, period: last.period },
    });
  }
  return items;
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. */
export async function fetchSeries({ env = process.env } = {}) {
  const apiKey = env.FRED_API_KEY;
  if (!apiKey) return [];
  const out = [];
  for (const s of SERIES) {
    let pts;
    try {
      pts = await history(s.fredId, apiKey);
    } catch {
      continue;
    }
    if (pts.length) out.push({ series: `fred:${s.key}`, meta: { label: s.label, unit: s.unit, category: s.category }, points: pts });
  }
  return out;
}
