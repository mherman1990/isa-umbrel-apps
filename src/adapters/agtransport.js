// agtransport.js — USDA AMS Agricultural Transportation Open Data (agtransport.usda.gov),
// a Socrata portal (same JSON/SoQL API as the CFTC adapter, no key required).
//
// Three demand/logistics signals for soybeans, emitted as "markets"-class items (Markets
// tab, not the policy brief) with chart history:
//   • Soybean export inspections — weekly actual loadings (metric tons). Export pace.
//   • Soybean net export sales   — weekly forward bookings (metric tons). Demand pull; this
//       is the FAS Export-Sales data mirrored here, so it stands in while the FAS OpenData
//       API is down.
//   • Mississippi barge freight  — $/ton to move grain down-river. A driver of Gulf export
//       basis (the transport wedge between farm-gate and export price).
//
// Optional AGTRANSPORT_APP_TOKEN (a free Socrata app token) raises the rate limit; the
// public endpoint works without one at our low volume.

import { fetchJSON } from "../util.js";

export const id = "agtransport";
export const label = "USDA Ag Transport";

const BASE = "https://agtransport.usda.gov/resource";
const SINCE = "2023-01-01T00:00:00"; // history window for the charts

// Each entry aggregates one dataset into a weekly series via a single SoQL `$query`
// statement (bracket-free, so the whole statement encodes cleanly).
const SERIES = [
  {
    key: "soy-export-inspections",
    label: "Soybean export inspections",
    unit: "metric tons",
    category: "soy_exports",
    dataset: "sruw-w49i",
    sql: `SELECT date, sum(mt) AS v WHERE grain='SOYBEANS' AND date >= '${SINCE}' GROUP BY date ORDER BY date LIMIT 5000`,
    headline: (v, p) => `Soybean export inspections: ${Math.round(v).toLocaleString()} MT (week of ${p})`,
  },
  {
    key: "soy-net-export-sales",
    label: "Soybean net export sales",
    unit: "metric tons",
    category: "soy_exports",
    dataset: "wnn7-29tu",
    sql: `SELECT date, sum(netsalescmy) AS v WHERE commodity='Soybeans' AND date >= '${SINCE}' GROUP BY date ORDER BY date LIMIT 5000`,
    headline: (v, p) => `Soybean net export sales: ${Math.round(v).toLocaleString()} MT (week of ${p})`,
  },
  {
    key: "barge-freight",
    label: "Mississippi barge freight",
    unit: "$/ton",
    category: "barge_freight",
    dataset: "7spn-fbua",
    sql: `SELECT date, avg(price_per_ton) AS v WHERE date >= '${SINCE}' GROUP BY date ORDER BY date LIMIT 5000`,
    headline: (v, p) => `Mississippi barge freight: $${v.toFixed(2)}/ton (${p})`,
  },
];

/** Run one series' SoQL aggregation → sorted [{period:"YYYY-MM-DD", value}]. */
async function fetchAgg(series, env) {
  let url = `${BASE}/${series.dataset}.json?$query=${encodeURIComponent(series.sql)}`;
  if (env.AGTRANSPORT_APP_TOKEN) url += `&$$app_token=${encodeURIComponent(env.AGTRANSPORT_APP_TOKEN)}`;
  const rows = await fetchJSON(url);
  return (rows ?? [])
    .filter((r) => r.date && r.v != null && !Number.isNaN(Number(r.v)))
    .map((r) => ({ period: String(r.date).slice(0, 10), value: Number(r.v) }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export async function fetchItems({ sourceConfig = {}, env = process.env } = {}) {
  const budget = sourceConfig.maxItemsPerRun ?? 10;
  const items = [];
  for (const s of SERIES) {
    if (items.length >= budget) break;
    let pts;
    try {
      pts = await fetchAgg(s, env);
    } catch {
      continue; // fail-soft per series
    }
    if (!pts.length) continue;
    const last = pts[pts.length - 1];
    items.push({
      uid: `${id}:${s.key}:${last.period}`,
      sourceId: id,
      sourceLabel: label,
      title: s.headline(last.value, last.period),
      summary: `${s.label} — USDA AMS Agricultural Transportation Open Data.`,
      url: `https://agtransport.usda.gov/d/${s.dataset}`,
      publishedAt: new Date(last.period).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: { metric: s.key, value: last.value, unit: s.unit, period: last.period },
    });
  }
  return items;
}

/** Returns [{ series, meta:{label,unit,category}, points }] for store.saveSeriesPoints. */
export async function fetchSeries({ env = process.env } = {}) {
  const out = [];
  for (const s of SERIES) {
    let pts;
    try {
      pts = await fetchAgg(s, env);
    } catch {
      continue;
    }
    if (pts.length) out.push({ series: `${id}:${s.key}`, meta: { label: s.label, unit: s.unit, category: s.category }, points: pts });
  }
  return out;
}
