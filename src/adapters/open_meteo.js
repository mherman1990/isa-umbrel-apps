// open_meteo.js — free global weather (no key). A soybean-growing-region crop-stress read
// for BOTH the U.S. Corn Belt (Iowa + neighbors — the domestic yield signal) and South
// America (Brazil/Argentina — the competitor-supply signal). Emits one "markets"-class item
// per region-group/day; raw carries per-region detail.
//
// Stress heuristic (transparent, refine later): drier-than-normal + hotter = more stress.
// A true climatology-based anomaly needs normals (e.g. PRISM) — deferred; these fixed
// thresholds are a usable current-conditions gauge in the meantime.

import { fetchJSON } from "../util.js";

export const id = "open_meteo";
export const label = "Open-Meteo (crop weather)";

// Key U.S. soybean-growing regions (Iowa-centric), weighted by rough soybean output share so
// an anomaly where the beans actually are counts more than a small area.
const US_REGIONS = [
  { name: "Illinois", lat: 40.0, lon: -89.0, w: 0.30 },
  { name: "Central Iowa", lat: 41.88, lon: -93.6, w: 0.22 },
  { name: "Minnesota", lat: 44.5, lon: -94.5, w: 0.18 },
  { name: "NW Iowa", lat: 43.0, lon: -95.6, w: 0.15 },
  { name: "SE Iowa", lat: 41.0, lon: -91.5, w: 0.15 },
];

// Key soybean-growing regions in Brazil + Argentina (competitor supply), production-weighted.
const SA_REGIONS = [
  { name: "Mato Grosso (BR)", lat: -12.55, lon: -55.71, w: 0.45 },
  { name: "Rio Grande do Sul (BR)", lat: -28.26, lon: -52.41, w: 0.30 },
  { name: "Pampas (AR)", lat: -33.89, lon: -60.57, w: 0.25 },
];

async function regionStress(r) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${r.lat}&longitude=${r.lon}` +
    `&daily=precipitation_sum,temperature_2m_max&past_days=14&forecast_days=7&timezone=auto`;
  const d = await fetchJSON(url);
  const precip = d.daily?.precipitation_sum ?? [];
  const tmax = d.daily?.temperature_2m_max ?? [];
  const precip14 = precip.slice(0, 14).reduce((a, b) => a + (b || 0), 0);
  const avgTmax = tmax.length ? tmax.reduce((a, b) => a + (b || 0), 0) / tmax.length : 0;
  const dryness = Math.max(0, Math.min(60, ((40 - precip14) / 40) * 60)); // <40mm/14d → dry
  const heat = Math.max(0, Math.min(40, ((avgTmax - 30) / 8) * 40)); // >30°C → hot
  const forecastPrecip = precip.slice(14).reduce((a, b) => a + (b || 0), 0);
  return {
    name: r.name,
    stressIndex: Math.round(dryness + heat),
    precip14mm: Math.round(precip14),
    avgTmaxC: Math.round(avgTmax * 10) / 10,
    forecast: forecastPrecip < 15 ? "dry outlook" : "rain in the forecast",
  };
}

/** Build one aggregated crop-weather item for a group of regions, or null if all failed. */
async function groupItem(regions, scopeLabel, metricTag, jurisdiction) {
  const results = [];
  for (const r of regions) {
    try {
      results.push(await regionStress(r));
    } catch {
      /* one region failing never kills the group */
    }
  }
  if (!results.length) return null;
  const overallIndex = Math.round(results.reduce((a, b) => a + b.stressIndex, 0) / results.length);
  const worst = results.reduce((a, b) => (b.stressIndex > a.stressIndex ? b : a));
  const date = new Date().toISOString().slice(0, 10);
  return {
    uid: `${id}:${metricTag}:${date}`,
    sourceId: id,
    sourceLabel: label,
    title: `${scopeLabel} soybean weather — stress index ${overallIndex}/100 (worst: ${worst.name} at ${worst.stressIndex})`,
    summary: results.map((r) => `${r.name}: stress ${r.stressIndex}, ${r.precip14mm}mm/14d, ${r.avgTmaxC}°C, ${r.forecast}`).join(" · "),
    url: "https://open-meteo.com/",
    publishedAt: new Date().toISOString(),
    jurisdiction,
    docType: "data",
    raw: { metric: metricTag, overallIndex, regions: results },
  };
}

export async function fetchItems() {
  const items = [];
  const us = await groupItem(US_REGIONS, "U.S. Corn Belt", "us_weather", "US");
  if (us) items.push(us);
  const sa = await groupItem(SA_REGIONS, "S. American", "sa", "International");
  if (sa) items.push(sa);
  return items;
}

// --- Anomaly-vs-normal layer (feeds the Markets charts + weather.js engine) ---
// Rather than a fixed-threshold gauge, compute where the recent 30-day precip and heat sit
// against ~27 years of ERA5 history for the SAME calendar window (Open-Meteo archive; free,
// no key — this is what dissolves the old "needs PRISM normals" blocker). Percentiles: low
// precip pctile = drier than normal (stress); high heat pctile = hotter than normal (stress).

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const WINDOW = 30; // trailing days
const pctile = (arr, v) => (arr.length ? Math.round((100 * arr.filter((x) => x < v).length) / arr.length) : null);

async function regionAnomaly(r) {
  const end = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10); // ERA5 lags ~5 days
  const url = `${ARCHIVE}?latitude=${r.lat}&longitude=${r.lon}&start_date=2005-01-01&end_date=${end}` +
    `&daily=precipitation_sum,temperature_2m_max&timezone=auto`;
  const d = await fetchJSON(url);
  const t = d.daily?.time ?? [], pr = d.daily?.precipitation_sum ?? [], tx = d.daily?.temperature_2m_max ?? [];
  if (t.length < 400) throw new Error(`${r.name}: thin archive`);
  const recentP = pr.slice(-WINDOW).reduce((a, b) => a + (b || 0), 0);
  const recentT = tx.slice(-WINDOW).reduce((a, b) => a + (b || 0), 0) / WINDOW;
  const endMD = t.at(-1).slice(5);
  const histP = [], histT = [];
  for (let i = WINDOW; i < t.length - 1; i++) {
    if (t[i].slice(5) !== endMD) continue;
    let sp = 0, st = 0;
    for (let j = i - WINDOW + 1; j <= i; j++) { sp += pr[j] || 0; st += tx[j] || 0; }
    histP.push(sp); histT.push(st / WINDOW);
  }
  const medP = [...histP].sort((a, b) => a - b)[Math.floor(histP.length / 2)] || 0;
  return {
    name: r.name, w: r.w,
    precipPctile: pctile(histP, recentP), heatPctile: pctile(histT, recentT),
    recentPrecipMm: Math.round(recentP), normalPrecipMm: Math.round(medP), recentTmaxC: Math.round(recentT * 10) / 10,
    years: histP.length,
  };
}

// Production-weighted aggregate over a region group. Returns null if all regions failed.
// SEQUENTIAL (not parallel) — the archive endpoint rate-limits per minute, and bursting a
// group of heavy multi-decade calls at once trips a 429. Twice-daily, a few serial calls is fine.
async function groupAnomaly(regions) {
  const rs = [];
  for (const r of regions) {
    try { rs.push(await regionAnomaly(r)); } catch { /* one region failing never kills the group */ }
  }
  if (!rs.length) return null;
  const wsum = rs.reduce((a, r) => a + r.w, 0) || 1;
  const wavg = (k) => Math.round(rs.reduce((a, r) => a + (r[k] ?? 50) * r.w, 0) / wsum);
  return { precipPctile: wavg("precipPctile"), heatPctile: wavg("heatPctile"), regions: rs };
}

/** Anomaly series for the Markets charts + the weather engine. One point per run (date-keyed). */
export async function fetchSeries() {
  const period = new Date().toISOString().slice(0, 10);
  const out = [];
  const push = (series, label, category, value) => {
    if (value != null) out.push({ series, meta: { label, unit: "pctile", category }, points: [{ period, value }] });
  };
  const us = await groupAnomaly(US_REGIONS).catch(() => null);
  if (us) {
    push("open_meteo:us:precip-pctile", "U.S. belt precip percentile", "weather_us", us.precipPctile);
    push("open_meteo:us:heat-pctile", "U.S. belt heat percentile", "weather_us", us.heatPctile);
  }
  const sa = await groupAnomaly(SA_REGIONS).catch(() => null);
  if (sa) {
    push("open_meteo:sa:precip-pctile", "S. America precip percentile", "weather_sa", sa.precipPctile);
    push("open_meteo:sa:heat-pctile", "S. America heat percentile", "weather_sa", sa.heatPctile);
  }
  return out;
}
