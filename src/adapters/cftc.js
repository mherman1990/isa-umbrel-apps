// cftc.js — CFTC Commitments of Traders: managed-money "fund positioning" for the CBOT soybean complex.
// Free Socrata API, no key. Disaggregated Futures-Only report (72hh-3qpy).
//
// Powers the Fund Positioning signal (soybeans) and, since 1.40.0, the Member Brief's fund-positioning
// section, which needs all three legs: soybeans, soybean meal, soybean oil. Before 1.40.0 only
// soybeans was fetched (Phase 0 audit §4.3).
//
// One series per market (`cftc:<market>:mm-net`, managed-money long − short, up to 520 weeks) and one
// "markets"-class item per market. Week-over-week change and the 52-week percentile are derivable from
// the stored series (see memberbrief.js), so the item text and the brief cannot disagree.
//
// MARKETS are matched by CFTC contract-market code OR exchange name: the name strings have changed in
// the past, the codes have not. The soybeans name is the one this adapter has always used.

import { fetchJSON } from "../util.js";

export const id = "cftc";
export const label = "CFTC (fund positioning)";

const RESOURCE = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";
export const MARKETS = [
  { key: "soybeans", label: "Soybeans", code: "005602", name: "SOYBEANS - CHICAGO BOARD OF TRADE" },
  { key: "soymeal", label: "Soybean meal", code: "026603", name: "SOYBEAN MEAL - CHICAGO BOARD OF TRADE" },
  { key: "soyoil", label: "Soybean oil", code: "007601", name: "SOYBEAN OIL - CHICAGO BOARD OF TRADE" },
];
export const SOURCE_URL = "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm";

const whereFor = (m) => encodeURIComponent(`cftc_contract_market_code='${m.code}' OR market_and_exchange_names='${m.name}'`);
const netOf = (r) => Number(r.m_money_positions_long_all) - Number(r.m_money_positions_short_all);

async function rowsFor(m, limit, fetcher = fetchJSON) {
  const order = encodeURIComponent("report_date_as_yyyy_mm_dd DESC");
  let rows;
  try {
    rows = await fetcher(`${RESOURCE}?$where=${whereFor(m)}&$order=${order}&$limit=${limit}`);
  } catch {
    // Socrata rejects the WHOLE query if a column in $where doesn't exist. The name-only form is the
    // query soybeans has always used, so a schema surprise can never cost us the feed that works today.
    rows = await fetcher(`${RESOURCE}?$where=${encodeURIComponent(`market_and_exchange_names='${m.name}'`)}&$order=${order}&$limit=${limit}`);
  }
  return Array.isArray(rows) ? rows : [];
}
export const __test = { rowsFor };

export async function fetchItems() {
  const out = [];
  const errors = [];
  for (const m of MARKETS) {
    let rows;
    try {
      rows = await rowsFor(m, 60);
    } catch (err) {
      errors.push(`${m.label}: ${err.message}`);
      continue;
    }
    if (!rows.length) continue;
    const nets = rows.map(netOf);
    const net = nets[0];
    const weekChange = Number(rows[0].change_in_m_money_long_all) - Number(rows[0].change_in_m_money_short_all);
    const window = nets.slice(0, 52);
    const percentile52Week = Math.round((window.filter((v) => v <= net).length / window.length) * 100);
    const date = String(rows[0].report_date_as_yyyy_mm_dd).slice(0, 10);
    const dir = net >= 0 ? "net long" : "net short";
    const arrow = weekChange >= 0 ? "▲" : "▼";
    out.push({
      uid: `${id}:${m.key}:${date}`,
      sourceId: id,
      sourceLabel: label,
      title: `${m.label} — managed money ${dir} ${Math.abs(net).toLocaleString()} contracts (${percentile52Week}th pctile of 52 wks, ${arrow}${Math.abs(weekChange).toLocaleString()} wk/wk, ${date})`,
      summary: `CBOT ${m.label.toLowerCase()}, CFTC Disaggregated Commitments of Traders (futures only), week ending ${date}.`,
      url: SOURCE_URL,
      publishedAt: new Date(rows[0].report_date_as_yyyy_mm_dd).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: { metric: "fund_positioning", market: m.key, net, weekChange, percentile52Week, long: Number(rows[0].m_money_positions_long_all), short: Number(rows[0].m_money_positions_short_all), reportDate: date },
    });
  }
  // Items are informational; a total failure is still a failure and must be visible.
  if (!out.length && errors.length) throw new Error(`CFTC fetch failed — ${errors.join("; ")}`);
  return out;
}

/** Managed-money net position history per market (Markets chart, fund-positioning signal, Member Brief). */
export async function fetchSeries() {
  const out = [];
  const errors = [];
  for (const m of MARKETS) {
    let rows;
    try {
      rows = await rowsFor(m, 520);
    } catch (err) {
      errors.push(`${m.label}: ${err.message}`);
      continue;
    }
    const points = rows
      .map((r) => ({ period: String(r.report_date_as_yyyy_mm_dd).slice(0, 10), value: netOf(r) }))
      .filter((p) => p.period && Number.isFinite(p.value));
    if (!points.length) continue;
    out.push({
      series: `cftc:${m.key}:mm-net`,
      // Soybeans keeps its original label so the existing signal card and chart read the same.
      meta: { label: m.key === "soybeans" ? "Managed money net position" : `${m.label} — managed money net`, unit: "contracts", category: "positioning" },
      points,
    });
  }
  // This used to `catch { return [] }`, which recorded nothing — a dead feed looked like a quiet one.
  // Throwing when EVERY market failed lets refreshMarketSeries record the error in source_health.
  if (!out.length && errors.length) throw new Error(`CFTC series fetch failed — ${errors.join("; ")}`);
  return out;
}
