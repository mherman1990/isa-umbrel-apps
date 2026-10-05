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
import { pack, bargeLocations, effectiveBargeLocations } from "../pack.js";

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
    // ⚠️ RELABELLED 1.40.0: this is avg(price_per_ton) across EVERY reported location on each date — a
    // cross-river average, not "Mississippi" freight at any point a farmer ships from (Phase 0 audit
    // §4.3). Kept for chart continuity and alerts; the per-location series below are what the Member
    // Brief quotes.
    label: "Barge freight — average of all reported locations",
    unit: "$/ton",
    category: "barge_freight",
    dataset: "7spn-fbua",
    sql: `SELECT date, avg(price_per_ton) AS v WHERE date >= '${SINCE}' GROUP BY date ORDER BY date LIMIT 5000`,
    headline: (v, p) => `Barge freight (all-location average): $${v.toFixed(2)}/ton (${p})`,
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

// ---- barge freight BY RIVER SEGMENT (1.40.0; segments 1.41.1) --------------------------------------
// The Member Brief quotes barge freight in $/ton. USDA's dataset 7spn-fbua reports it per river SEGMENT
// in `river_system_location` — "Cape Girardeau – Grafton", "Dubuque – Genoa"… (26 segments, verified on
// the Pi 2026-10-04). It has NO "St. Louis" or "Illinois River" rows: those are the Grain Transportation
// Report's headline rate points, which this dataset does not carry. The segments come from the state pack
// (markets.barge.locations: USDA's exact segment name + a reader label) and match EXACTLY (case and dash
// style ignored) — a loose substring match would let "Grafton" pick up the wrong reach.
export const BARGE_DATASET = "7spn-fbua";
export const DEFAULT_BARGE_LOCATIONS = pack().markets?.barge?.locations ?? [];

const LOCATION_COLUMN = /^(river_system_location|location|loc|segment|river_segment|origin|port|city|river_location)$/i;
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const bargeSlug = (v) => norm(v).replace(/\s+/g, "-");

/** The column that names a location, from one sample row (or null). Exported for tests. */
export function findLocationColumn(row) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  return keys.find((k) => LOCATION_COLUMN.test(k)) ?? keys.find((k) => /location|segment/i.test(k)) ?? null;
}

/** The segments to fetch — the shared resolver (pack.effectiveBargeLocations: override unless legacy, else pack). */
export const wantedSegments = effectiveBargeLocations;

/** Group rows of {date, loc, v} into one series per WANTED segment (exact match). Exported for tests. */
export function bargeSeriesFromRows(rows, wanted = bargeLocations(DEFAULT_BARGE_LOCATIONS)) {
  const want = (wanted.length && typeof wanted[0] === "string" ? bargeLocations(wanted) : wanted).map((w) => ({ ...w, n: norm(w.segment) }));
  const bySeg = new Map();
  for (const r of rows ?? []) {
    const v = Number(r.v);
    if (!r.date || !Number.isFinite(v)) continue;
    const hit = want.find((w) => norm(r.loc) === w.n);
    if (!hit) continue;
    if (!bySeg.has(hit.series)) bySeg.set(hit.series, { hit, m: new Map() });
    bySeg.get(hit.series).m.set(String(r.date).slice(0, 10), v); // one value per date per segment
  }
  return [...bySeg.values()].map(({ hit, m }) => ({
    series: hit.series,
    meta: { label: `Barge freight — ${hit.label}`, unit: "$/ton", category: "barge_freight", family: `${id}:barge-freight` },
    points: [...m].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period)),
  }));
}

async function fetchBargeByLocation(env, wanted) {
  const tok = env.AGTRANSPORT_APP_TOKEN ? `&$$app_token=${encodeURIComponent(env.AGTRANSPORT_APP_TOKEN)}` : "";
  const sample = await fetchJSON(`${BASE}/${BARGE_DATASET}.json?$limit=1${tok}`);
  const col = findLocationColumn(Array.isArray(sample) ? sample[0] : null);
  if (!col) throw new Error(`barge dataset ${BARGE_DATASET} has no recognisable location column (columns: ${Object.keys(sample?.[0] ?? {}).join(", ") || "none"})`);
  const sql = `SELECT date, ${col} AS loc, avg(price_per_ton) AS v WHERE date >= '${SINCE}' GROUP BY date, ${col} ORDER BY date LIMIT 50000`;
  const rows = await fetchJSON(`${BASE}/${BARGE_DATASET}.json?$query=${encodeURIComponent(sql)}${tok}`);
  return bargeSeriesFromRows(rows, wanted);
}

/** Returns [{ series, meta:{label,unit,category}, points }] for store.saveSeriesPoints. */
export async function fetchSeries({ env = process.env, sourceConfig = {} } = {}) {
  const out = [];
  const errors = [];
  for (const s of SERIES) {
    let pts;
    try {
      pts = await fetchAgg(s, env);
    } catch (err) {
      errors.push(`${s.key}: ${err.message}`);
      continue;
    }
    if (pts.length) out.push({ series: `${id}:${s.key}`, meta: { label: s.label, unit: s.unit, category: s.category }, points: pts });
  }
  try {
    const wanted = wantedSegments(sourceConfig.bargeLocations);
    const byLoc = await fetchBargeByLocation(env, wanted);
    const missing = wanted.filter((w) => !byLoc.some((s) => s.series === w.series)).map((w) => w.segment);
    if (missing.length) errors.push(`barge by segment: ${missing.join(", ")} not found in ${BARGE_DATASET} (river_system_location)`);
    out.push(...byLoc);
  } catch (err) {
    errors.push(`barge by location: ${err.message}`);
  }
  // Partial failures used to vanish (`catch { continue }`). Log them; throw only when NOTHING came back,
  // so the source_health row records an error instead of a quiet "empty".
  if (errors.length) console.log(`⚠️  ${label}: ${errors.join("; ")}`);
  if (!out.length && errors.length) throw new Error(errors.join("; "));
  return out;
}
