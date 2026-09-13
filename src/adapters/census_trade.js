// census_trade.js — U.S. Census Bureau international-trade series: actual monthly exports (to check
// against FAS commitments) and imports of the fats/oils feedstocks that compete with soybean oil for
// 45Z gallons (used cooking oil, tallow, distillers corn oil, biodiesel, soy oil). Free key:
// CENSUS_API_KEY (https://api.census.gov/data/key_signup.html). "markets"-class.
//
// WHY (§2 row 2 of the data-pipeline-expansion plan). FAS gives export COMMITMENTS (sold, not all
// shipped); Census gives what actually CROSSED THE BORDER — the realized side of the export story. And
// the 45Z feedstock-competition read ("what is displacing soy oil in the RD stack") lives in the import
// lines for UCO / tallow / DCO / biodiesel, which nothing in the stack currently sees.
//
// ⚠️ GATED + PENDING PI VALIDATION. The intltrade timeseries API requires a key (a keyless call 302s to
// a "Missing Key" page — verified), so the exact response shape and the HS codes below cannot be
// confirmed from the dev environment. This adapter follows Census's documented intltrade API and is
// INERT until CENSUS_API_KEY is set; run scripts/probe-45z-sources.mjs ON THE PI (with the key) to
// confirm the field names + HS codes, then trust the series. Fail-soft per commodity — a bad code emits
// no points rather than throwing. (Same "build-then-validate-on-the-Pi" pattern as the CME adapter.)

import { fetchJSON } from "../util.js";

export const id = "census_trade";
export const label = "Census international trade (exports & feedstock imports)";

const BASE = "https://api.census.gov/data/timeseries/intltrade";

// HS codes are best-known and marked for probe confirmation. `flow` picks the endpoint + value field:
// exports report ALL_VAL_MO, imports report GEN_VAL_MO (general imports), both in USD for the month.
// ⚠️ CONFIRM ON THE PI: UCO and distillers-corn-oil both fall under the broad HS 1518 ("fats/oils
// chemically modified"); the 10-digit break-outs (…4000 UCO, etc.) are what actually separate them, so
// the probe should dump HS10 rows to pin these before the competing-feedstock read is trusted.
const COMMODITIES = [
  { key: "exports:soybeans", label: "U.S. soybean exports (Census)", flow: "exports", hs: "1201", commLvl: "HS4" },
  { key: "exports:soyoil", label: "U.S. soybean oil exports (Census)", flow: "exports", hs: "150710", commLvl: "HS6" },
  { key: "imports:soyoil", label: "U.S. soybean oil imports (Census)", flow: "imports", hs: "150710", commLvl: "HS6" },
  { key: "imports:uco", label: "U.S. used-cooking-oil / modified fats imports (Census, HS1518)", flow: "imports", hs: "1518", commLvl: "HS4" },
  { key: "imports:tallow", label: "U.S. tallow imports (Census)", flow: "imports", hs: "1502", commLvl: "HS4" },
  { key: "imports:biodiesel", label: "U.S. biodiesel/renewable-diesel imports (Census, HS3826)", flow: "imports", hs: "3826", commLvl: "HS4" },
];

const valueField = (flow) => (flow === "exports" ? "ALL_VAL_MO" : "GEN_VAL_MO");
const commodityField = (flow) => (flow === "exports" ? "E_COMMODITY" : "I_COMMODITY");

/**
 * Parse Census's array-of-arrays payload ([[header...],[row...],...]) into row objects keyed by header.
 * Pure/exported for tests. Returns [] for anything that isn't the documented array-of-arrays shape.
 */
export function parseCensus(json) {
  if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[0])) return [];
  const header = json[0];
  return json.slice(1).map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]])));
}

/**
 * Collapse per-country rows into one monthly total per period (summing the value field, skipping any
 * "TOTAL FOR ALL COUNTRIES" aggregate row so it isn't double-counted). Pure/exported for tests.
 * @returns {{period, value}[]} ascending by period.
 */
export function monthlyTotals(rows, vField) {
  const byPeriod = new Map();
  for (const r of rows) {
    const period = r.time; // "YYYY-MM"
    const v = Number(r[vField]);
    if (!period || !Number.isFinite(v)) continue;
    if (String(r.CTY_NAME ?? "").toUpperCase().includes("TOTAL")) continue; // skip the all-countries aggregate
    byPeriod.set(period, (byPeriod.get(period) ?? 0) + v);
  }
  return [...byPeriod.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
}

/** Fetch one commodity's monthly totals for a calendar year. */
async function commodityYear(c, year, apiKey) {
  const vField = valueField(c.flow);
  const cField = commodityField(c.flow);
  const url =
    `${BASE}/${c.flow}/hs?get=${vField},CTY_NAME,${cField}` +
    `&${cField}=${encodeURIComponent(c.hs)}&COMM_LVL=${c.commLvl}&time=${year}&key=${apiKey}`;
  return monthlyTotals(parseCensus(await fetchJSON(url)), vField);
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. [] until CENSUS_API_KEY is set. */
export async function fetchSeries({ env = process.env, sourceConfig = {} } = {}) {
  const apiKey = env.CENSUS_API_KEY;
  if (!apiKey) return [];
  const years = recentYears(Number(sourceConfig.years) || 3);
  const out = [];
  for (const c of COMMODITIES) {
    const merged = new Map();
    for (const year of years) {
      try {
        for (const p of await commodityYear(c, year, apiKey)) merged.set(p.period, p.value);
      } catch {
        /* a year/commodity that errors never kills the rest */
      }
    }
    const points = [...merged.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
    if (points.length) out.push({ series: `census:${c.key}`, meta: { label: c.label, unit: "USD", category: c.flow === "exports" ? "trade_exports" : "trade_imports" }, points });
  }
  return out;
}

/** No item surface — this is a pure market-data source. */
export async function fetchItems() {
  return [];
}

function recentYears(n) {
  const y = new Date().getUTCFullYear();
  return Array.from({ length: n }, (_, i) => y - i); // Census trade lags ~5 weeks; current year covers YTD
}

export const __internal = { COMMODITIES, BASE, valueField, commodityField, recentYears };
