// eia.js — U.S. Energy Information Administration (EIA) v2 API: biofuel feedstock usage
// (soybean oil → biodiesel / renewable diesel), plus diesel. Free key: EIA_API_KEY
// (https://www.eia.gov/opendata/register.php).
//
// Soybean-oil feedstock demand is the biofuel demand-pull signal for soy — how much of
// the crush is being consumed by the biodiesel/renewable-diesel industry. Not topic-driven;
// emits "markets"-class items (Markets tab, not the policy brief). Each series pulls its
// single most-recent monthly/weekly value.

import { fetchJSON } from "../util.js";

export const id = "eia";
export const label = "EIA (biofuels & diesel)";

const BASE = "https://api.eia.gov/v2";

// route = EIA v2 data route; facets pin the exact series; freq = its native frequency.
const SERIES = [
  { key: "soyoil-biodiesel", title: "Soybean oil → biodiesel (feedstock)",
    route: "petroleum/pnp/feedbiofuel", facets: { product: "EPOOBDSO", duoarea: "NUS" }, freq: "monthly" },
  { key: "soyoil-renewdiesel", title: "Soybean oil → renewable diesel (feedstock)",
    route: "petroleum/pnp/feedbiofuel", facets: { product: "EPOOBDSOR", duoarea: "NUS" }, freq: "monthly" },
  { key: "diesel-retail", title: "U.S. No. 2 diesel retail price",
    route: "petroleum/pri/gnd", facets: { product: "EPD2D", duoarea: "NUS" }, freq: "weekly" },
];

async function latest(s, apiKey) {
  // Build the query manually: EIA's bracketed param NAMES (data[0], facets[x][], sort[0][…])
  // must stay literal; only the VALUES are encoded.
  const q =
    `${BASE}/${s.route}/data/?api_key=${apiKey}` +
    `&frequency=${s.freq}&data[0]=value` +
    Object.entries(s.facets).map(([f, v]) => `&facets[${f}][]=${encodeURIComponent(v)}`).join("") +
    `&sort[0][column]=period&sort[0][direction]=desc&length=1`;
  const d = await fetchJSON(q);
  return d?.response?.data?.[0] ?? null;
}

export async function fetchItems({ sourceConfig = {}, env = process.env }) {
  const apiKey = env.EIA_API_KEY;
  if (!apiKey) throw new Error("EIA_API_KEY not set (free key: https://www.eia.gov/opendata/register.php)");
  const budget = sourceConfig.maxItemsPerRun ?? 20;
  const items = [];

  for (const s of SERIES) {
    if (items.length >= budget) break;
    let rec;
    try {
      rec = await latest(s, apiKey);
    } catch {
      continue; // fail-soft per series
    }
    if (rec?.value == null) continue;
    const units = rec.units || "";
    const period = rec.period; // "YYYY-MM" (monthly) or "YYYY-MM-DD" (weekly)
    items.push({
      uid: `${id}:${s.key}:${period}`,
      sourceId: id,
      sourceLabel: label,
      title: `${s.title}: ${rec.value} ${units} (${period})`,
      summary: rec["product-name"] || s.title,
      url: "https://www.eia.gov/opendata/",
      publishedAt: new Date(period.length === 7 ? `${period}-01` : period).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: { metric: s.key, value: rec.value, units, period, productName: rec["product-name"] },
    });
  }
  return items;
}

// ── Timeseries (v1.5 Markets charts) ────────────────────────────────────────
// ALL lipid feedstocks consumed by the biodiesel + renewable-diesel industry — the
// feedstock market-share picture (soy vs. its competitors). BD + RD summed per feedstock.
const FEEDSTOCKS = [
  { key: "soybean-oil", label: "Soybean oil", products: ["EPOOBDSO", "EPOOBDSOR"] },
  { key: "corn-oil", label: "Corn oil (DCO)", products: ["EPOOBDCNO", "EPOOBDCNOR"] },
  { key: "canola-oil", label: "Canola oil", products: ["EPOOBDCO", "EPOOBDCOR"] },
  { key: "used-cooking-oil", label: "Used cooking oil", products: ["EPOOBDFSYG"] },
  { key: "tallow", label: "Tallow", products: ["EPOOBDFSTL"] },
  { key: "white-grease", label: "White grease", products: ["EPOOBDFSWG"] },
  { key: "poultry-fat", label: "Poultry fat", products: ["EPOOBDFSPT"] },
  { key: "other-animal-fat", label: "Other animal fats", products: ["EPOOBDAFO"] },
  { key: "other-veg-oil", label: "Other veg oils", products: ["EPOOBDVOO"] },
];

async function productHistory(product, apiKey) {
  const q =
    `${BASE}/petroleum/pnp/feedbiofuel/data/?api_key=${apiKey}` +
    `&frequency=monthly&data[0]=value&facets[product][]=${product}&facets[duoarea][]=NUS` +
    `&sort[0][column]=period&sort[0][direction]=asc&length=300`;
  const d = await fetchJSON(q);
  const map = new Map();
  let unit = "";
  for (const r of d?.response?.data ?? []) {
    if (r.value != null) {
      map.set(r.period, Number(r.value));
      unit = r.units || unit;
    }
  }
  return { map, unit };
}

/** Returns [{ series, meta:{label,unit,category}, points:[{period,value}] }] for store.saveSeriesPoints. */
export async function fetchSeries({ env = process.env } = {}) {
  const apiKey = env.EIA_API_KEY;
  if (!apiKey) return [];
  const out = [];
  for (const fs of FEEDSTOCKS) {
    const merged = new Map();
    let unit = "MMLB";
    for (const product of fs.products) {
      try {
        const { map, unit: u } = await productHistory(product, apiKey);
        if (u) unit = u;
        for (const [period, val] of map) merged.set(period, (merged.get(period) ?? 0) + val);
      } catch {
        /* a missing product never kills the series */
      }
    }
    const points = [...merged.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
    if (points.length) out.push({ series: `eia:feedstock:${fs.key}`, meta: { label: fs.label, unit, category: "biofuel_feedstock" }, points });
  }
  return out;
}
