// vegscape.js — USDA/NASS VegScape satellite crop-vegetation condition (VCI), keyless.
//
// VegScape (nassgeo.csiss.gmu.edu) serves MODIS-derived, 250m, weekly vegetation indices over
// U.S. cropland back to 2000. We read the **Vegetation Condition Index (VCI)** — already scaled
// 0–100 against each pixel's own 2000-present min/max, so a mean VCI IS a percentile-like read of
// "how is the crop doing vs. its own history," with no climatology math on our side. Low VCI =
// vegetation stress = a supply-risk read that supports price; high VCI = a lush crop that weighs
// on it. Because it lands ~4 days after each week closes, it FRONT-RUNS the Monday NASS crop-
// condition rating. "markets"-class (Markets tab + signals board, not the policy brief).
//
// No documented numeric-stat endpoint exists, so we take VegScape's FIPS-clipped GeoTIFF and
// average it ourselves. Those tiffs are uncompressed, 8-bit, single-band, grayscale (photometric
// BlackIsZero, no palette — verified) → a ~40-line reader below parses them with ZERO deps. Value
// domain: 0 = background outside the clipped shape; 1–100 = VCI%; codes >100 (≈200/250) = mask/
// nodata (non-crop / water / cloud). We average only 1..100.
//
// Endpoints (keyless; nassgeodata.gmu.edu 302-redirects to nassgeo.csiss.gmu.edu — follow it):
//   POST /VegScape/CheckDataAvailability  body: data=<token>   -> {success, availability:'1'|'0'}
//   GET  /VegService/GetFile?fips=<FIPS>&date=<token>          -> {success, url:'<clipped .tif>'}
// Token: weekly_vci_<weeknum>_<YYYY.MM.DD Mon>_<YYYY.MM.DD Sun>, weeks Mon–Sun.

import { fetchText, fetchBuffer } from "../util.js";
import * as store from "../store.js";

export const id = "vegscape";
export const label = "VegScape (crop vegetation)";

const HOST = "https://nassgeo.csiss.gmu.edu";
const AVAIL = `${HOST}/VegScape/CheckDataAvailability`;
const GETFILE = `${HOST}/VegService/GetFile`;

// Areas of interest: Iowa (the scored signal) + the core belt for context/Ask/Analyst.
const AOIS = [
  { key: "ia", fips: "19", name: "Iowa" },
  { key: "il", fips: "17", name: "Illinois" },
  { key: "mn", fips: "27", name: "Minnesota" },
  { key: "in", fips: "18", name: "Indiana" },
  { key: "ne", fips: "31", name: "Nebraska" },
];
const BACKFILL_WEEKS = 12; // seed a small trail on a cold start; steady-state fetches only new weeks.

const pad = (n) => String(n).padStart(2, "0");
const fmtDot = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`; };
const fmtIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;

// Monday (UTC) of the week containing `ms`.
function mondayOf(ms) {
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - back * DAY;
}
// VegScape week number for a given Monday: week 1's Monday is the Monday of the week containing
// Jan 1. (Verified: 2026-07-20 → 30.) Anchored+confirmed via CheckDataAvailability, so any off-by-
// one in their scheme is absorbed by the ±1 search in findLatestWeek().
function weekNum(mondayMs) {
  const year = new Date(mondayMs).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const firstMon = mondayOf(jan1);
  return Math.round((mondayMs - firstMon) / (7 * DAY)) + 1;
}
function tokenFor(index, mondayMs, kind = "vci") {
  const sunday = mondayMs + 6 * DAY;
  return { token: `weekly_${kind}_${index}_${fmtDot(mondayMs)}_${fmtDot(sunday)}`, period: fmtIso(sunday), mondayMs, index };
}

async function isAvailable(token) {
  try {
    const body = await fetchText(AVAIL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(token)}`,
    });
    return /availability'?\s*:\s*'?1/.test(body); // {success:'true', availability:'1'}
  } catch {
    return false;
  }
}

// Find the newest published week: start at the most recently ENDED Mon–Sun week and walk back,
// trying the computed week number and ±1 to absorb any numbering quirk. Returns {index, mondayMs}.
export async function findLatestWeek(nowMs) {
  const lastEndedMonday = mondayOf(nowMs) - 7 * DAY; // the week that has fully closed
  for (let back = 0; back < 6; back++) {
    const monday = lastEndedMonday - back * 7 * DAY;
    const base = weekNum(monday);
    for (const delta of [0, -1, 1]) {
      const idx = base + delta;
      if (idx < 1) continue;
      const t = tokenFor(idx, monday, "vci");
      if (await isAvailable(t.token)) return { index: idx, mondayMs: monday };
    }
  }
  return null;
}

// --- minimal GeoTIFF reader: uncompressed, 8-bit, single-band, grayscale, strip-organized ---
const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
export function readGrayTiff(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let le;
  const bom = dv.getUint16(0, false);
  if (bom === 0x4949) le = true; else if (bom === 0x4d4d) le = false; else throw new Error("not a TIFF");
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error("bad TIFF magic");
  const ifd = u32(4);
  const count = u16(ifd);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), n = u32(e + 4);
    const size = TIFF_TYPE_SIZE[type] || 1;
    const total = size * n;
    const valOff = total <= 4 ? e + 8 : u32(e + 8);
    const read = (k) => (type === 3 ? u16(valOff + k * 2) : u32(valOff + k * 4));
    const vals = [];
    for (let k = 0; k < n; k++) vals.push(read(k));
    tags[tag] = vals;
  }
  const first = (t, d) => (tags[t] ? tags[t][0] : d);
  const compression = first(259, 1);
  const bits = first(258, 8);
  const samples = first(277, 1);
  if (compression !== 1) throw new Error(`unexpected TIFF compression ${compression}`);
  if (bits !== 8 || samples !== 1) throw new Error(`unexpected TIFF format bits=${bits} samples=${samples}`);
  const width = first(256), height = first(257);
  const offsets = tags[273] || [];
  const counts = tags[279] || [];
  const px = new Uint8Array(width * height);
  let pos = 0;
  for (let s = 0; s < offsets.length; s++) {
    const off = offsets[s], len = counts[s] ?? 0;
    for (let b = 0; b < len && pos < px.length; b++) px[pos++] = buf[off + b];
  }
  return { width, height, px };
}

// Mean VCI (1..100) over one FIPS for one week token. Returns { mean, valid } or null.
export async function meanVCI(fips, token) {
  const meta = await fetchText(`${GETFILE}?fips=${encodeURIComponent(fips)}&date=${encodeURIComponent(token)}`);
  const m = meta.match(/url\s*:\s*'([^']+\.tif)'/i);
  if (!m || !/success\s*:\s*'?true/i.test(meta)) return null;
  const buf = await fetchBuffer(m[1], { timeoutMs: 60_000 });
  const { px } = readGrayTiff(buf);
  let sum = 0, valid = 0;
  for (let i = 0; i < px.length; i++) { const v = px[i]; if (v >= 1 && v <= 100) { sum += v; valid++; } }
  if (!valid) return null;
  return { mean: sum / valid, valid };
}

/** Returns [{ series, meta:{label,unit,category}, points:[{period,value}] }] for store.saveSeriesPoints. */
export async function fetchSeries() {
  let anchor;
  try {
    anchor = await findLatestWeek(Date.now());
  } catch {
    return []; // fail-soft
  }
  if (!anchor) return [];

  // Weeks to (potentially) fetch: the anchor and the prior BACKFILL_WEEKS-1, numbered relative to
  // the confirmed anchor (sequential within the growing season).
  const weeks = [];
  for (let w = 0; w < BACKFILL_WEEKS; w++) {
    weeks.push(tokenFor(anchor.index - w, anchor.mondayMs - w * 7 * DAY, "vci"));
  }

  const out = [];
  for (const aoi of AOIS) {
    const series = `${id}:${aoi.key}:vci`;
    const have = new Set(store.getSeries(series).map((p) => p.period));
    const points = [];
    for (const wk of weeks) {
      if (have.has(wk.period)) continue; // already stored → don't re-download the tif
      let r;
      try { r = await meanVCI(aoi.fips, wk.token); } catch { r = null; }
      if (r) points.push({ period: wk.period, value: Math.round(r.mean * 10) / 10 });
    }
    if (points.length) {
      out.push({
        series,
        meta: { label: `${aoi.name} crop VCI`, unit: "VCI 0–100", category: "veg_condition" },
        points,
      });
    }
  }
  return out;
}

/** One summary item for the Markets feed — the latest Iowa VCI reading. */
export async function fetchItems() {
  const list = await fetchSeries().catch(() => []);
  const ia = list.find((s) => s.series === `${id}:ia:vci`);
  if (!ia || !ia.points.length) return [];
  const last = ia.points[ia.points.length - 1];
  return [
    {
      uid: `${id}:ia:${last.period}`,
      sourceId: id,
      sourceLabel: label,
      title: `Iowa crop VCI ${last.value.toFixed(0)}/100 (week ending ${last.period})`,
      summary: "VegScape satellite Vegetation Condition Index for Iowa cropland — 0–100 vs. the 2000-present range. A leading read on crop vigor, ahead of the weekly NASS condition rating.",
      url: "https://nassgeo.csiss.gmu.edu/VegScape/",
      publishedAt: new Date(last.period).toISOString(),
      jurisdiction: "Iowa",
      docType: "data",
      raw: { metric: "vci", value: last.value, period: last.period },
    },
  ];
}
