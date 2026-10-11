// cpc_outlook.js — NOAA CPC climate priors, keyless. Two indices:
//
// 1. ONI (Oceanic Niño Index) — the ENSO state the grain trade actually trades.
//    Cheapest useful prior on South American weather risk (La Niña → dry Argentina +
//    southern Brazil; El Niño → wetter). Open-Meteo (open_meteo.js) says what the weather
//    IS right now; this says the seasonal ANOMALY the market is pricing months ahead.
//    Source: https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
//
// 2. DMI (Dipole Mode Index) — the Indian Ocean Dipole (IOD) state. (#52)
//    Positive IOD (DMI > +0.4°C) → dry conditions in southern Africa and parts of South
//    America even without an El Niño signal; negative IOD → wet anomaly. ENSO alone
//    does NOT fully predict Brazilian soy-growing-season rainfall; the IOD modulates it
//    independently, and several significant SA drought years have occurred during neutral
//    or weakly-negative ENSO. Together the two indices give a more complete prior.
//    Source: JAMSTEC (Japan Agency for Marine-Earth Science and Technology) — official DMI
//    http://www.jamstec.go.jp/frsgc/research/d1/iod/DATA/dmi.monthly.txt
//    Format: YEAR JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC (12 monthly values/row)
//    Fail-soft: returns [] if the URL is unreachable or format changes.

import { fetchText } from "../util.js";

export const id = "cpc_outlook";
export const label = "NOAA CPC / JAMSTEC (ENSO + IOD)";

const ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt";
const DMI_URL = "http://www.jamstec.go.jp/frsgc/research/d1/iod/DATA/dmi.monthly.txt";

// 3-month season code → its centre month (MM). DJF is centred on Jan; NDJ on Dec.
const SEASON_MONTH = {
  DJF: "01", JFM: "02", FMA: "03", MAM: "04", AMJ: "05", MJJ: "06",
  JJA: "07", JAS: "08", ASO: "09", SON: "10", OND: "11", NDJ: "12",
};

const MONTH_MM = ["01","02","03","04","05","06","07","08","09","10","11","12"];

/** Parse the ONI ascii table → sorted [{period:"YYYY-MM", value:ONI}]. Pure; skips header + junk. */
export function parseOni(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [seas, yr, , anom] = cols;
    const mm = SEASON_MONTH[seas];
    if (!mm || !/^\d{4}$/.test(yr)) continue;
    const v = Number(anom);
    if (!Number.isFinite(v)) continue;
    out.push({ period: `${yr}-${mm}`, value: v });
  }
  out.sort((a, b) => (a.period < b.period ? -1 : 1));
  return out;
}

/** Parse the JAMSTEC DMI monthly table → sorted [{period:"YYYY-MM", value:DMI}].
 *  Format: first token is a 4-digit year, followed by 12 monthly values (or -999.9 for missing). */
export function parseDmi(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 13) continue;      // need year + 12 months
    const yr = cols[0];
    if (!/^\d{4}$/.test(yr)) continue;  // header or malformed
    for (let m = 0; m < 12; m++) {
      const v = Number(cols[m + 1]);
      if (!Number.isFinite(v) || v < -100) continue; // -999.9 = missing
      out.push({ period: `${yr}-${MONTH_MM[m]}`, value: v });
    }
  }
  out.sort((a, b) => (a.period < b.period ? -1 : 1));
  return out;
}

/** ENSO phase for an ONI value, by the ±0.5 °C convention. */
export function ensoPhase(oni) {
  if (oni == null || !Number.isFinite(oni)) return "neutral";
  if (oni >= 0.5) return "El Niño";
  if (oni <= -0.5) return "La Niña";
  return "neutral";
}

/** IOD phase for a DMI value. Positive IOD (DMI > +0.4) adds independent drought risk
 *  in South America/southern Africa even during neutral ENSO. */
export function iodPhase(dmi) {
  if (dmi == null || !Number.isFinite(dmi)) return "neutral";
  if (dmi >= 0.4) return "positive";
  if (dmi <= -0.4) return "negative";
  return "neutral";
}

/** Returns [{series, meta, points}] for store.saveSeriesPoints. Fail-soft per index. */
export async function fetchSeries() {
  const out = [];

  // ONI
  try {
    const text = await fetchText(ONI_URL);
    const pts = parseOni(text);
    if (pts.length) {
      out.push({ series: "cpc:oni", meta: { label: "ENSO — Oceanic Niño Index (ONI)", unit: "°C anomaly", category: "climate_enso" }, points: pts });
    }
  } catch { /* fail-soft */ }

  // DMI
  try {
    const text = await fetchText(DMI_URL);
    const pts = parseDmi(text);
    if (pts.length) {
      out.push({ series: "cpc:dmi", meta: { label: "IOD — Dipole Mode Index (DMI)", unit: "°C anomaly", category: "climate_iod" }, points: pts });
    }
  } catch { /* fail-soft */ }

  return out;
}

export async function fetchItems() {
  const items = [];

  // ONI item
  try {
    const text = await fetchText(ONI_URL);
    const pts = parseOni(text);
    if (pts.length) {
      const last = pts[pts.length - 1];
      const phase = ensoPhase(last.value);
      items.push({
        uid: `${id}:oni:${last.period}`,
        sourceId: id,
        sourceLabel: label,
        title: `ENSO: ${phase} — ONI ${last.value >= 0 ? "+" : ""}${last.value.toFixed(1)}°C (${last.period})`,
        summary: "NOAA CPC Oceanic Niño Index — the ENSO prior on South American weather risk (La Niña → dry Argentina / southern Brazil).",
        url: "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php",
        publishedAt: new Date(`${last.period}-01T00:00:00Z`).toISOString(),
        jurisdiction: "Global",
        docType: "data",
        raw: { metric: "oni", value: last.value, phase, period: last.period },
      });
    }
  } catch { /* fail-soft */ }

  // DMI item
  try {
    const text = await fetchText(DMI_URL);
    const pts = parseDmi(text);
    if (pts.length) {
      const last = pts[pts.length - 1];
      const phase = iodPhase(last.value);
      const sign = last.value >= 0 ? "+" : "";
      items.push({
        uid: `${id}:dmi:${last.period}`,
        sourceId: id,
        sourceLabel: label,
        title: `IOD: ${phase} — DMI ${sign}${last.value.toFixed(2)}°C (${last.period})`,
        summary: `Indian Ocean Dipole — ${phase === "positive" ? "positive IOD adds drought risk in South America and southern Africa independent of ENSO" : phase === "negative" ? "negative IOD associated with wetter-than-normal South American conditions" : "neutral IOD — no independent climate forcing from Indian Ocean"}. Source: JAMSTEC.`,
        url: "http://www.jamstec.go.jp/frsgc/research/d1/iod/",
        publishedAt: new Date(`${last.period}-01T00:00:00Z`).toISOString(),
        jurisdiction: "Global",
        docType: "data",
        raw: { metric: "dmi", value: last.value, phase, period: last.period },
      });
    }
  } catch { /* fail-soft */ }

  return items;
}

export const __test = { parseOni, parseDmi, ensoPhase, iodPhase, SEASON_MONTH };
