// cpc_outlook.js — NOAA CPC climate priors, keyless. Starts with the Oceanic Niño Index (ONI): the
// ENSO state the grain trade actually trades, and the cheapest useful prior on South American weather
// risk (La Niña → dry Argentina + southern Brazil; El Niño → wetter). Open-Meteo (open_meteo.js) says
// what the weather IS right now; this says the seasonal ANOMALY the market is pricing months ahead.
// "markets"-class (Markets tab, not the policy brief).
//
// Source: https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt — a whitespace table published by
// CPC (the ONI_v5 product), keyless and tiny:
//     SEAS  YR   TOTAL   ANOM
//      DJF 1950  25.01  -1.32
// One row per overlapping 3-month season (12 per year), so mapping each SEAS to its CENTRE month yields
// a clean monthly series. ANOM is the ONI itself (already the 3-month running SST anomaly for Niño-3.4);
// the ±0.5 °C convention marks El Niño / La Niña.
//
// (The 6–10 / 8–14 day CPC outlooks named alongside ONI in the plan are spatial probability grids that
// need a corn-belt reduction to become a scalar series — deferred; ONI is the high-value keyless prior
// and lands first, under this same source id so an outlook series can join later.)

import { fetchText } from "../util.js";

export const id = "cpc_outlook";
export const label = "NOAA CPC (ENSO / ONI)";

const ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt";

// 3-month season code → its centre month (MM). DJF is centred on Jan; NDJ on Dec.
const SEASON_MONTH = {
  DJF: "01", JFM: "02", FMA: "03", MAM: "04", AMJ: "05", MJJ: "06",
  JJA: "07", JAS: "08", ASO: "09", SON: "10", OND: "11", NDJ: "12",
};

/** Parse the ONI ascii table → sorted [{period:"YYYY-MM", value:ONI}]. Pure; skips the header + junk. */
export function parseOni(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [seas, yr, , anom] = cols;
    const mm = SEASON_MONTH[seas];
    if (!mm || !/^\d{4}$/.test(yr)) continue; // header row ("SEAS YR …") and anything malformed fall out here
    const v = Number(anom);
    if (!Number.isFinite(v)) continue;
    out.push({ period: `${yr}-${mm}`, value: v });
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

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. Fail-soft. */
export async function fetchSeries() {
  let text;
  try { text = await fetchText(ONI_URL); } catch { return []; }
  const pts = parseOni(text);
  if (!pts.length) return [];
  return [
    { series: "cpc:oni", meta: { label: "ENSO — Oceanic Niño Index (ONI)", unit: "°C anomaly", category: "climate_enso" }, points: pts },
  ];
}

export async function fetchItems() {
  let text;
  try { text = await fetchText(ONI_URL); } catch { return []; }
  const pts = parseOni(text);
  if (!pts.length) return [];
  const last = pts[pts.length - 1];
  const phase = ensoPhase(last.value);
  return [
    {
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
    },
  ];
}

export const __test = { parseOni, ensoPhase, SEASON_MONTH };
