// barchart.js — Barchart OnDemand (CBOT futures + forward curve + local elevator basis).
//
// SCAFFOLD, pending API access. Matt has requested a Barchart OnDemand key; the moment it lands
// this is a config-flip (set BARCHART_API_KEY, enable in watchlist) + one live test to confirm the
// exact response field names against their docs. Until then fetchItems/fetchSeries return [] — no
// key, no calls, no noise. "markets"-class.
//
// What it unlocks (see the roadmap): the forward-curve carry read + local basis — which turns ON
// the `basis_carry` condition trigger (currently OFF for lack of a futures-carry feed) and powers
// basis-vs-board / the farmer margin & storage tools. Farmer-facing outputs stay education, never
// advice.
//
// Barchart OnDemand REST (confirm exact paths/fields with the key + their docs):
//   BASE = https://ondemand.websol.barchart.com
//   getQuote.json    ?apikey=..&symbols=ZSN26,ZSX26,..&fields=lastPrice,tradeTimestamp   (futures + curve)
//   getGrainBids.json?apikey=..&location=<zip>&grain=soybeans&radius=50                    (local cash bids → basis)
//   getHistory.json  ?apikey=..&symbol=ZSX26&type=daily&startDate=..                       (backfill)

import { fetchJSON } from "../util.js";

export const id = "barchart";
export const label = "Barchart (futures & basis)";

const BASE = "https://ondemand.websol.barchart.com";

// CBOT soybean complex — front several contract months make up the forward curve.
// (Continuous front month is ZS*1 in Barchart symbology; explicit months build the curve.)
const CURVE_SYMBOLS = ["ZS*1", "ZS*2", "ZS*3", "ZS*4"];
// Iowa reference points for local cash bids → basis (cash bid − nearby futures).
const BASIS_LOCATIONS = [{ name: "Central Iowa", zip: "50010" }, { name: "NW Iowa", zip: "51301" }];

function keyOf(env) {
  return env.BARCHART_API_KEY || null;
}

/** Latest futures + a basis summary as markets-class items. No key → []. */
export async function fetchItems({ env = process.env } = {}) {
  const apikey = keyOf(env);
  if (!apikey) return [];
  try {
    const q = await fetchJSON(`${BASE}/getQuote.json?apikey=${apikey}&symbols=${encodeURIComponent(CURVE_SYMBOLS.join(","))}&fields=lastPrice,tradeTimestamp`);
    const rows = q.results ?? [];
    const front = rows[0];
    if (!front) return [];
    // TODO(confirm-with-docs): field names — results[].lastPrice / symbol / tradeTimestamp.
    const date = String(front.tradeTimestamp ?? new Date().toISOString()).slice(0, 10);
    return [{
      uid: `barchart:zs:${date}`,
      sourceId: id, sourceLabel: label,
      title: `CBOT soybeans (front month) ${front.lastPrice} — ${rows.length}-contract curve`,
      summary: `Barchart futures: ${rows.map((r) => `${r.symbol} ${r.lastPrice}`).join(" · ")}. Curve shape = carry vs. inversion.`,
      url: "https://www.barchart.com/futures/quotes/ZS*0",
      publishedAt: new Date().toISOString(),
      jurisdiction: "US", docType: "data",
      raw: { curve: rows.map((r) => ({ symbol: r.symbol, price: r.lastPrice })) },
    }];
  } catch {
    return [];
  }
}

/** Series: front-month price + local basis. No key → []. */
export async function fetchSeries({ env = process.env } = {}) {
  const apikey = keyOf(env);
  if (!apikey) return [];
  const period = new Date().toISOString().slice(0, 10);
  const out = [];
  try {
    const q = await fetchJSON(`${BASE}/getQuote.json?apikey=${apikey}&symbols=ZS*1&fields=lastPrice`);
    const price = q.results?.[0]?.lastPrice;
    if (price != null) out.push({ series: "barchart:zs:front", meta: { label: "CBOT soybeans front month", unit: "¢/bu", category: "soy_futures" }, points: [{ period, value: Number(price) }] });
    // TODO(with-key): getGrainBids per BASIS_LOCATIONS → cash bid − front futures = basis series
    //   "barchart:basis:central-ia" etc. (category "soy_basis"), then wire a basis-trend signal
    //   and re-enable the basis_carry trigger in triggers.js from the curve carry.
  } catch {
    /* fail-soft */
  }
  return out;
}
