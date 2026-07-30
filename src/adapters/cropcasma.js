// cropcasma.js — Crop-CASMA (USDA-NASS + NASA + GMU) SMAP soil moisture, keyless.
//
// Root-zone (and surface) soil moisture over U.S. cropland from NASA SMAP, 9 km, weekly. This is
// the CAUSE-side companion to the VegScape VCI feed (which is the vegetation EFFECT) and to the
// Open-Meteo weather inputs: a physically-measured read of the water actually available to the
// crop's roots. Low root-zone moisture in a yield-sensitive window is supply risk → supportive of
// price; a well-charged profile that buffers a dry spell weighs on it. Because it leads the
// canopy's visible response, it can front-run both the VCI and the NASS condition rating.
// "markets"-class (Markets tab + signals board, not the policy brief).
//
// Access: an open, keyless PyWPS service (no account/token — the CropSmart *app* has a login, the
// developer WPS does not). Unlike VegScape, it has a numeric zonal-stats process, so there is NO
// raster to parse — the stats come back as a tiny histogram CSV that we collapse to a mean.
//
//   GET  cloud.csiss.gmu.edu/smap_service?service=WPS&version=1.0.0&request=Execute
//        &identifier=GetStatByFips&DataInputs=layer=<L>;minValue=0;maxValue=1;step=0.02;fips=<FIPS>
//   -> WPS XML whose <wps:LiteralData> is a URL to a CSV: "category,pixels" rows (moisture bins).
//   Weighted mean of bin midpoints = mean volumetric soil moisture (m³/m³) for that FIPS/week.
//
// Layer name: SMAP-9KM-WEEKLY-<TOP|SUB>_<year>_<weeknum>_<YYYY.MM.DD Mon>_<YYYY.MM.DD Sun>_AVERAGE
// (TOP = surface, SUB = root zone; weeks Mon–Sun, same numbering as VegScape). We store the
// absolute moisture and let store.marketSnapshot() derive the seasonal anomaly / percentile in-app,
// exactly like the other series — no dependence on Crop-CASMA's own anomaly layer.

import { fetchText, sleep } from "../util.js";
import * as store from "../store.js";

export const id = "cropcasma";
export const label = "Crop-CASMA (soil moisture)";

const WPS = "https://cloud.csiss.gmu.edu/smap_service";
const IA = { key: "ia", fips: "19", name: "Iowa" };
const BELT = [
  { key: "il", fips: "17", name: "Illinois" },
  { key: "mn", fips: "27", name: "Minnesota" },
  { key: "in", fips: "18", name: "Indiana" },
  { key: "ne", fips: "31", name: "Nebraska" },
];
const BACKFILL_WEEKS = 30; // ~7 months on a cold start → a seasonal baseline + a trend; tiny CSVs.
const THROTTLE_MS = 200;   // be polite to the academic WPS server between calls.

const pad = (n) => String(n).padStart(2, "0");
const DAY = 86400000;
const fmtDot = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`; };
const fmtIso = (ms) => new Date(ms).toISOString().slice(0, 10);

function mondayOf(ms) {
  const d = new Date(ms);
  const dow = d.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - back * DAY;
}
// VegScape/Crop-CASMA week number: week 1's Monday is the Monday of the week containing Jan 1.
// (Verified live: 2020-03-30 → wk14, 2026-07-20 → wk30.) Recomputed per-Monday so a backfill that
// crosses a year boundary numbers each week against its own year.
function weekNum(mondayMs) {
  const year = new Date(mondayMs).getUTCFullYear();
  const firstMon = mondayOf(Date.UTC(year, 0, 1));
  return Math.round((mondayMs - firstMon) / (7 * DAY)) + 1;
}
export function layerName(depth, mondayMs) {
  const sun = mondayMs + 6 * DAY;
  return `SMAP-9KM-WEEKLY-${depth}_${new Date(mondayMs).getUTCFullYear()}_${weekNum(mondayMs)}_${fmtDot(mondayMs)}_${fmtDot(sun)}_AVERAGE`;
}

// Execute GetStatByFips for one layer+FIPS → mean volumetric soil moisture, or null. The WPS
// hands back a URL to a "category,pixels" histogram CSV; the mean is the pixel-weighted average of
// the bin midpoints. Returns null on any failure / no data (fail-soft).
export async function meanSoilMoisture(layer, fips) {
  const di = `layer=${layer};minValue=0;maxValue=1;step=0.02;fips=${fips}`;
  let xml;
  try {
    xml = await fetchText(`${WPS}?service=WPS&version=1.0.0&request=Execute&identifier=GetStatByFips&DataInputs=${di}`, { timeoutMs: 60_000 });
  } catch { return null; }
  if (/ProcessFailed/i.test(xml)) return null;
  const m = xml.match(/https?:\/\/[^<\s]+\.csv/i);
  if (!m) return null;
  let csv;
  try { csv = await fetchText(m[0], { timeoutMs: 40_000 }); } catch { return null; }
  let sum = 0, pixels = 0;
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [cat, cnt] = line.split(",");
    const n = Number(cnt);
    if (!cat || !Number.isFinite(n) || n <= 0) continue;
    const [lo, hi] = cat.split("-").map(Number);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    sum += ((lo + hi) / 2) * n;
    pixels += n;
  }
  if (!pixels) return null;
  return sum / pixels;
}

// Find the newest published week by probing back from the most-recently-ended Mon–Sun week until
// a root-zone Iowa call returns data. Returns { mondayMs } or null.
export async function findLatestWeek(nowMs) {
  const lastEnded = mondayOf(nowMs) - 7 * DAY;
  for (let back = 0; back < 6; back++) {
    const monday = lastEnded - back * 7 * DAY;
    const v = await meanSoilMoisture(layerName("SUB", monday), IA.fips);
    if (v != null) return { mondayMs: monday };
    await sleep(THROTTLE_MS);
  }
  return null;
}

// One series across the recent weeks (skipping weeks already stored so steady-state does the
// minimum). depth: "SUB" (root zone) or "TOP" (surface).
async function buildSeries(aoi, depth, latestMonday) {
  const key = depth === "SUB" ? "rootzone-sm" : "surface-sm";
  const series = `${id}:${aoi.key}:${key}`;
  const have = new Set(store.getSeries(series).map((p) => p.period));
  const points = [];
  for (let w = 0; w < BACKFILL_WEEKS; w++) {
    const monday = latestMonday - w * 7 * DAY;
    const period = fmtIso(monday + 6 * DAY);
    if (have.has(period)) continue;
    const v = await meanSoilMoisture(layerName(depth, monday), aoi.fips);
    if (v != null) points.push({ period, value: Math.round(v * 1000) / 1000 });
    await sleep(THROTTLE_MS);
  }
  if (!points.length) return null;
  const zone = depth === "SUB" ? "root-zone" : "surface";
  return {
    series,
    meta: { label: `${aoi.name} ${zone} soil moisture`, unit: "m³/m³", category: "soil_moisture" },
    points,
  };
}

/** Returns [{ series, meta:{label,unit,category}, points:[{period,value}] }] for store.saveSeriesPoints. */
export async function fetchSeries() {
  let anchor;
  try { anchor = await findLatestWeek(Date.now()); } catch { return []; }
  if (!anchor) return [];
  const out = [];
  // Iowa: root zone (the scored signal) + surface (context). Belt states: root zone only.
  out.push(await buildSeries(IA, "SUB", anchor.mondayMs));
  out.push(await buildSeries(IA, "TOP", anchor.mondayMs));
  for (const st of BELT) out.push(await buildSeries(st, "SUB", anchor.mondayMs));
  return out.filter(Boolean);
}

/** One summary item for the Markets feed — the latest Iowa root-zone reading. */
export async function fetchItems() {
  const list = await fetchSeries().catch(() => []);
  const ia = list.find((s) => s.series === `${id}:ia:rootzone-sm`);
  if (!ia || !ia.points.length) return [];
  const last = ia.points[ia.points.length - 1];
  return [
    {
      uid: `${id}:ia:${last.period}`,
      sourceId: id,
      sourceLabel: label,
      title: `Iowa root-zone soil moisture ${last.value.toFixed(3)} m³/m³ (week ending ${last.period})`,
      summary: "Crop-CASMA / NASA SMAP root-zone soil moisture for Iowa — the water available to the crop's roots. A cause-side, leading read on crop stress vs. the vegetation and condition reports.",
      url: "https://nassgeo.csiss.gmu.edu/Crop-CASMA-User/",
      publishedAt: new Date(last.period).toISOString(),
      jurisdiction: "Iowa",
      docType: "data",
      raw: { metric: "rootzone_soil_moisture", value: last.value, period: last.period },
    },
  ];
}
