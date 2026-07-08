// cftc.js — CFTC Commitments of Traders: managed-money "fund positioning" for CBOT
// soybeans. Free Socrata API, no key. Disaggregated Futures-Only report (72hh-3qpy).
//
// Powers the Fund Positioning market signal (ported from the co-work app): managed-money
// net position, week-over-week change, and 52-week percentile. Emits one "markets"-class
// item (Markets tab, not the policy brief); raw carries the numbers for the signal layer.

import { fetchJSON } from "../util.js";

export const id = "cftc";
export const label = "CFTC (fund positioning)";

const RESOURCE = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";
const MARKET = "SOYBEANS - CHICAGO BOARD OF TRADE";

export async function fetchItems({ env = process.env } = {}) {
  const where = encodeURIComponent(`market_and_exchange_names='${MARKET}'`);
  const order = encodeURIComponent("report_date_as_yyyy_mm_dd DESC");
  const rows = await fetchJSON(`${RESOURCE}?$where=${where}&$order=${order}&$limit=60`);
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const netOf = (r) => Number(r.m_money_positions_long_all) - Number(r.m_money_positions_short_all);
  const nets = rows.map(netOf);
  const net = nets[0];
  const weekChange = Number(rows[0].change_in_m_money_long_all) - Number(rows[0].change_in_m_money_short_all);

  // 52-week percentile: where does the current net sit within the trailing year?
  const window = nets.slice(0, 52);
  const percentile52Week = Math.round((window.filter((v) => v <= net).length / window.length) * 100);

  const date = String(rows[0].report_date_as_yyyy_mm_dd).slice(0, 10);
  const dir = net >= 0 ? "net long" : "net short";
  const arrow = weekChange >= 0 ? "▲" : "▼";

  return [
    {
      uid: `${id}:soybeans:${date}`,
      sourceId: id,
      sourceLabel: label,
      title: `Soybeans — managed money ${dir} ${Math.abs(net).toLocaleString()} contracts (${percentile52Week}th pctile, ${arrow}${Math.abs(weekChange).toLocaleString()} wk/wk, ${date})`,
      summary: `CBOT soybeans, CFTC Disaggregated Commitments of Traders, week ending ${date}.`,
      url: "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm",
      publishedAt: new Date(rows[0].report_date_as_yyyy_mm_dd).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: {
        metric: "fund_positioning",
        net,
        weekChange,
        percentile52Week,
        long: Number(rows[0].m_money_positions_long_all),
        short: Number(rows[0].m_money_positions_short_all),
        reportDate: date,
      },
    },
  ];
}

/** Managed-money net position history (for the Markets chart + the fund-positioning signal). */
export async function fetchSeries() {
  const where = encodeURIComponent(`market_and_exchange_names='${MARKET}'`);
  const order = encodeURIComponent("report_date_as_yyyy_mm_dd DESC"); // most-recent 520 weeks
  let rows;
  try {
    rows = await fetchJSON(`${RESOURCE}?$where=${where}&$order=${order}&$limit=520`);
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || !rows.length) return [];
  const points = rows
    .map((r) => ({
      period: String(r.report_date_as_yyyy_mm_dd).slice(0, 10),
      value: Number(r.m_money_positions_long_all) - Number(r.m_money_positions_short_all),
    }))
    .filter((p) => p.period && Number.isFinite(p.value));
  return points.length ? [{ series: "cftc:soybeans:mm-net", meta: { label: "Managed money net position", unit: "contracts", category: "positioning" }, points }] : [];
}
