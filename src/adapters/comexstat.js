// comexstat.js — Brazil foreign-trade stats from SECEX / ComexStat (api-comexstat.mdic.gov.br), keyless.
//
// Brazil is the U.S.'s main soybean-export competitor, so its EXPORT PACE is a demand-side signal for
// U.S. soy — and its export DESTINATIONS answer the question the stack couldn't: how much of Brazil's
// crop China is taking (the "China bought Brazil, not the U.S." read). ibge_brazil already has the crop
// SIZE (production/area); this adds the flow. "markets"-class (Markets tab, not the policy brief).
//
// API — POST /general with:
//   { flow, monthDetail, period:{from,to}, filters:[{filter,values}], details:[...], metrics:[...] }
// metricKG is net kilograms, metricFOB is US$; their ratio is the realized FOB unit value ($/t), a usable
// Brazil FOB-price proxy. (The "FOB premium vs. Gulf" the plan names needs a U.S. Gulf FOB counterpart,
// which the keyless stack doesn't carry yet — deferred, noted in the PR. CONAB's more-timely production
// survey is the other row-5 piece; its portal is a JS dashboard with no confirmed data API, so it's
// deferred too — ibge_brazil already carries Brazil production/area in the meantime.)
//
// Soybeans = NCM 12019000 (99%+ of the soybean line; the seed code 12011000 is negligible). China = 160.
// Two small queries (monthly TOTAL, and China via the country filter) — no country-detail row explosion.

import { fetchJSON, sleep } from "../util.js";

export const id = "comexstat";
export const label = "Brazil trade (SECEX/ComexStat)";

const API = "https://api-comexstat.mdic.gov.br/general";
const SOYBEAN_NCM = "12019000";
const CHINA_CODE = "160";
const START = "2013-01"; // ComexStat has monthly data back to 1997; a decade is plenty for percentile/seasonal.
// ComexStat sporadically drops a request under rapid repeats (observed: two calls succeed, a third can
// fail, then recover) — the same shape as MARS in usda_ams. Retry with backoff, and space the two
// queries, so a transient blip doesn't cost the whole refresh. In production the two calls run at
// separate times anyway (market-refresh vs collect), so real load is well within tolerance.
const RETRIES = 2;
const BACKOFF_MS = 1500;

const nowYm = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** POST a ComexStat export query (one retry-with-backoff); returns the raw row list. Throws only after
 *  the last attempt (caller fail-softs). */
async function query({ filters, details = [], metrics }) {
  const body = { flow: "export", monthDetail: true, period: { from: START, to: nowYm() }, filters, details, metrics };
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const d = await fetchJSON(API, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      return d?.data?.list ?? [];
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await sleep(BACKOFF_MS * (attempt + 1));
    }
  }
  return [];
}

/** Rows → sorted [{period:"YYYY-MM", value}] via a per-row extractor. Pure; skips malformed rows. */
export function rowsToPoints(rows, valueFn) {
  const out = [];
  for (const r of rows ?? []) {
    const y = String(r?.year ?? "");
    const m = String(r?.monthNumber ?? "").padStart(2, "0");
    if (!/^\d{4}$/.test(y) || !/^(0[1-9]|1[0-2])$/.test(m)) continue;
    const v = valueFn(r);
    if (v == null || !Number.isFinite(v)) continue;
    out.push({ period: `${y}-${m}`, value: v });
  }
  out.sort((a, b) => (a.period < b.period ? -1 : 1));
  return out;
}

// ⚠️ Number("") === 0, not NaN — so a blank metric must be rejected BEFORE Number(), or a missing value
// would become a false zero (0 tonnes / $0) and pollute the series. Hence the explicit empty guards.
const num = (raw) => (raw == null || raw === "" ? null : Number(raw));

/** kg → metric tonnes (rounded); null for a blank/absent value. */
export function kgToTonnes(r) {
  const kg = num(r?.metricKG);
  return kg != null && Number.isFinite(kg) ? Math.round(kg / 1000) : null;
}

/** Realized FOB unit value, US$/t = FOB / kg × 1000 (the Brazil FOB-price proxy); null if either is blank. */
export function unitValue(r) {
  const fob = num(r?.metricFOB);
  const kg = num(r?.metricKG);
  return fob != null && kg != null && kg > 0 && Number.isFinite(fob) ? Math.round((fob / kg) * 1000 * 100) / 100 : null;
}

/** China's share of the monthly total (%), joined by period. Pure. */
export function chinaSharePoints(totalPts, chinaPts) {
  const total = new Map((totalPts ?? []).map((p) => [p.period, p.value]));
  const out = [];
  for (const c of chinaPts ?? []) {
    const t = total.get(c.period);
    if (t && t > 0) out.push({ period: c.period, value: Math.round((c.value / t) * 1000) / 10 }); // 0.1% precision
  }
  return out;
}

async function pull() {
  const total = await query({ filters: [{ filter: "ncm", values: [SOYBEAN_NCM] }], details: [], metrics: ["metricFOB", "metricKG"] });
  await sleep(300); // space the two calls — ComexStat dislikes rapid back-to-back POSTs
  const china = await query({ filters: [{ filter: "ncm", values: [SOYBEAN_NCM] }, { filter: "country", values: [CHINA_CODE] }], details: [], metrics: ["metricKG"] });
  return { total, china };
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. Fail-soft. */
export async function fetchSeries() {
  let total, china;
  try { ({ total, china } = await pull()); } catch { return []; }
  const totalVol = rowsToPoints(total, kgToTonnes);
  const price = rowsToPoints(total, unitValue);
  const chinaVol = rowsToPoints(china, kgToTonnes);
  const share = chinaSharePoints(totalVol, chinaVol);
  const out = [];
  if (totalVol.length) out.push({ series: "comex:br:soy-exports", meta: { label: "Brazil soybean exports", unit: "t", category: "brazil_exports" }, points: totalVol });
  if (chinaVol.length) out.push({ series: "comex:br:soy-exports-china", meta: { label: "Brazil soybean exports to China", unit: "t", category: "brazil_exports" }, points: chinaVol });
  if (share.length) out.push({ series: "comex:br:soy-exports-china-share", meta: { label: "Brazil soybean exports — China share", unit: "%", category: "brazil_export_share" }, points: share });
  if (price.length) out.push({ series: "comex:br:soy-export-price", meta: { label: "Brazil soybean FOB unit value", unit: "$/t", category: "brazil_export_price" }, points: price });
  return out;
}

export async function fetchItems() {
  let total, china;
  try { ({ total, china } = await pull()); } catch { return []; }
  const totalVol = rowsToPoints(total, kgToTonnes);
  const chinaVol = rowsToPoints(china, kgToTonnes);
  if (!totalVol.length) return [];
  const last = totalVol[totalVol.length - 1];
  const c = chinaVol.find((p) => p.period === last.period);
  const sharePct = c ? Math.round((c.value / last.value) * 100) : null;
  return [
    {
      uid: `${id}:soy-exports:${last.period}`,
      sourceId: id,
      sourceLabel: label,
      title: `Brazil soybean exports ${(last.value / 1e6).toFixed(2)}M t (${last.period})${sharePct != null ? `, ${sharePct}% to China` : ""}`,
      summary: "SECEX/ComexStat — Brazil monthly soybean exports and China's share: the competitor-supply pace and China-destination read.",
      url: "https://comexstat.mdic.gov.br/",
      publishedAt: new Date(`${last.period}-01T00:00:00Z`).toISOString(),
      jurisdiction: "International",
      docType: "data",
      raw: { metric: "br_soy_exports", tonnes: last.value, chinaSharePct: sharePct, period: last.period },
    },
  ];
}

export const __test = { rowsToPoints, chinaSharePoints, kgToTonnes, unitValue };
