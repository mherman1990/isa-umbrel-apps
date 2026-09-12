// cme_settlements.js — CME end-of-day settlements for the soybean complex + corn: the FULL FORWARD
// CURVE and OPEN INTEREST per contract month, daily. Keyless. "markets"-class. GATED OFF by default.
//
// WHY (§1.1 of the data-pipeline-expansion plan). cbot_futures.js gives only a front-month CONTINUOUS
// settle (Yahoo ZS=F …), so the system has no curve: no carry, no old-crop/new-crop or calendar
// spreads, no correctly-paired crush legs, and `basis_carry_state` cannot fire for lack of a carry
// spread. One CME settlements pull per product gives every listed contract month's settle + open
// interest — the raw material for all of those.
//
// ⚠️ ACCESS WAS THE OPEN QUESTION, AND THE PROBE ANSWERED IT. CME IP-blocks cloud/dev IPs (403 from the
// workstation), but scripts/probe-cme-settlements.mjs confirmed FROM THE PI that the CmeWS JSON endpoint
// is reachable there (HTTP 200) — the "defer to the Pi" bet. The endpoint REQUIRES a `tradeDate` param
// (MM/DD/YYYY); a date with no session returns 200 + empty, so we step back to the last settled day.
// The plan's ftp/pub/settle/stlags text file is DEAD (real 404 from the Pi, not a block) and is dropped.
//
// This adapter still ships OFF until a human flips it on, because CME's IP policy could change and the
// data terms are CME's call: set CME_SETTLEMENTS=1 in .env (keyless, no API key) to enable. Until then
// fetchItems/fetchSeries return [] with no network call (same pattern as barchart.js).
//
// SERIES NAMESPACE is deliberately `cme:*`, distinct from `cbot:*` (Yahoo continuous) and `barchart:*`,
// so the real CME curve coexists with — and can be compared against — the interim continuous series.
//
// Response shape (confirmed on the Pi, tradeDate 09/11/2026): top-level { settlements[], tradeDate,
// updateTime, reportType, … }; each settlements row { month:"NOV 26", open, high, low, last, change,
// settle:"1296'4", volume:"245,874", openInterest:"491,712" }, plus a trailing "Total" row. Beans/corn
// quote points'eighths ("1296'4" = 1296.5); meal/oil quote decimals. Settle is clean; open/high/low/last
// can carry an A(ask)/B(bid) indicator suffix, which parsePrice strips defensively.

import { fetchJSON } from "../util.js";

export const id = "cme_settlements";
export const label = "CME settlements (curve + open interest)";

// CmeWS product ids, all confirmed reachable + correct by the Pi probe.
const PRODUCTS = [
  { key: "zs", productId: 320, label: "CBOT soybeans", unit: "¢/bu", category: "soy_curve" },
  { key: "zm", productId: 310, label: "CBOT soybean meal", unit: "$/ton", category: "soy_products_curve" },
  { key: "zl", productId: 312, label: "CBOT soybean oil", unit: "¢/lb", category: "soy_products_curve" },
  { key: "zc", productId: 300, label: "CBOT corn", unit: "¢/bu", category: "corn_curve" },
];

const CMEWS_BASE = "https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements";
// CME blocks the bot-ish default UA (util.js sends "polibrief/1.0 …"); the settlements surface expects a
// browser one. Kept here so the probe and the adapter send the same one.
export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Enabled only once a human sets CME_SETTLEMENTS (the Pi probe having confirmed reachability first). */
export function isEnabled(env = process.env) {
  const v = env.CME_SETTLEMENTS;
  return !!v && v !== "0" && String(v).toLowerCase() !== "false";
}

const MONTHS3 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const MONTH_CODES = "FGHJKMNQUVXZ"; // CME single-letter month codes, Jan..Dec
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Parse a CME price string to a number. Grains (ZS/ZC) quote "points'eighths" — "1296'4" is
 * 1296 + 4/8 = 1296.5; products (ZM/ZL) quote plain decimals ("352.8", "69.68"). Strips thousands
 * commas, a leading sign, and a trailing settlement indicator letter (A=ask / B=bid, e.g. "509'4B").
 * Empty/dash/"N/A" → null. Detection of eighths is by the apostrophe, so no per-product flag is needed.
 */
export function parsePrice(s) {
  if (s == null) return null;
  let str = String(s).trim().replace(/,/g, "");
  if (str === "" || /^-+$/.test(str) || /^n\/?a$/i.test(str)) return null;
  str = str.replace(/[A-Za-z]+$/, ""); // drop an A/B settlement indicator suffix
  if (str === "") return null;
  let sign = 1;
  if (str[0] === "+") str = str.slice(1);
  else if (str[0] === "-") { sign = -1; str = str.slice(1); }
  if (str.includes("'")) {
    const [whole, frac] = str.split("'");
    const w = Number(whole), f = frac === "" ? 0 : Number(frac);
    if (!Number.isFinite(w) || !Number.isFinite(f)) return null;
    return sign * (w + f / 8);
  }
  const v = Number(str);
  return Number.isFinite(v) ? sign * v : null;
}

/** Contract label → "YYYY-MM". Accepts "SEP 26", "SEP26", "SEP 2026" and single-letter codes ("X26"). */
export function parseContractMonth(m) {
  if (!m) return null;
  const s = String(m).trim().toUpperCase();
  let mo = s.match(/^([A-Z]{3})\s*'?(\d{2,4})$/);
  if (mo && MONTHS3[mo[1]]) return `${expandYear(mo[2])}-${MONTHS3[mo[1]]}`;
  mo = s.match(/^([FGHJKMNQUVXZ])(\d{2})$/);
  if (mo) return `${expandYear(mo[2])}-${String(MONTH_CODES.indexOf(mo[1]) + 1).padStart(2, "0")}`;
  return null;
}

function expandYear(y) {
  const s = String(y);
  if (s.length === 4) return s;
  return Number(s) >= 70 ? `19${s}` : `20${s}`; // 2-digit: 70-99 → 19xx, else 20xx
}

/** CME trade-date string → "YYYY-MM-DD". Accepts "09/11/2026" (CmeWS), "12 Sep 2026", and ISO. */
export function parseTradeDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // MM/DD/YYYY — the CmeWS tradeDate format
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (m && MONTHS3[m[2].toUpperCase()]) return `${m[3]}-${MONTHS3[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Parse a CmeWS Futures/Settlements JSON payload → { tradeDate, rows[] }, nearest contract first.
 * Skips the trailing "Total" row and any row without a usable settle. Pure and exported for tests.
 */
export function parseSettlementsJson(json) {
  const tradeDate = parseTradeDate(json?.tradeDate);
  const rows = [];
  for (const r of json?.settlements ?? []) {
    const month = String(r?.month ?? "").trim();
    if (!month || /^total$/i.test(month)) continue;
    const contractMonth = parseContractMonth(month);
    const settle = parsePrice(r?.settle);
    if (!contractMonth || settle == null) continue;
    rows.push({ contractMonth, settle, openInterest: parsePrice(r?.openInterest), volume: parsePrice(r?.volume) });
  }
  rows.sort((a, b) => (a.contractMonth < b.contractMonth ? -1 : a.contractMonth > b.contractMonth ? 1 : 0));
  return { tradeDate, rows };
}

/** { tradeDate, rows } for one product → store series (per-contract settle + OI, lead front, carry). */
export function buildProductSeries(product, parsed, maxContracts = 8) {
  const period = parsed.tradeDate;
  const rows = (parsed.rows ?? []).slice(0, maxContracts);
  if (!period || !rows.length) return [];
  const out = [];
  for (const row of rows) {
    out.push({ series: `cme:${product.key}:${row.contractMonth}`, meta: { label: `${product.label} ${row.contractMonth} settle`, unit: product.unit, category: product.category }, points: [{ period, value: row.settle }] });
    if (row.openInterest != null) {
      out.push({ series: `cme:${product.key}:${row.contractMonth}:oi`, meta: { label: `${product.label} ${row.contractMonth} open interest`, unit: "contracts", category: `${product.category}_oi` }, points: [{ period, value: row.openInterest }] });
    }
  }
  // The ACTIVE lead contract = the one carrying the most open interest, NOT the nearest calendar month —
  // the nearest is often an expiring stub with ~0 OI (e.g. SEP beans at OI 5 on a mid-September date
  // while NOV, the real lead, carried 491,712). Traders watch the lead month, so `front` mirrors it.
  const withOI = rows.filter((r) => r.openInterest != null);
  const front = (withOI.length ? withOI : rows).reduce((a, b) => ((b.openInterest ?? 0) > (a.openInterest ?? 0) ? b : a));
  out.push({ series: `cme:${product.key}:front`, meta: { label: `${product.label} front-month settle (CME lead)`, unit: product.unit, category: product.category }, points: [{ period, value: front.settle }] });
  // Nearby carry = the next listed contract after the lead, minus the lead. Positive = the market is
  // paying to store (carry); flat/inverted = it wants beans now. This is the `carry_spread` leg
  // basis_carry_state needs to fire.
  const after = rows.filter((r) => r.contractMonth > front.contractMonth)[0];
  if (after) {
    out.push({ series: `cme:${product.key}:carry`, meta: { label: `${product.label} nearby carry (next − lead)`, unit: product.unit, category: `${product.category}_carry` }, points: [{ period, value: round3(after.settle - front.settle) }] });
  }
  return out;
}

/** MM/DD/YYYY strings for the last `n` calendar days, most recent first (to find the last settled day). */
function recentTradeDates(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    out.push(`${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`);
  }
  return out;
}

/** Fetch one product's settlements JSON for a tradeDate (MM/DD/YYYY), with the browser UA. */
export async function fetchProductJson(product, tradeDate) {
  const q = tradeDate ? `?tradeDate=${tradeDate}` : "";
  return fetchJSON(`${CMEWS_BASE}/${product.productId}/FUT${q}`, { headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
}

/** Step back from today to the most recent day soybeans actually settled. → { tradeDate, soyParsed } | null */
async function resolveLatest(maxLookbackDays) {
  for (const d of recentTradeDates(maxLookbackDays)) {
    try {
      const parsed = parseSettlementsJson(await fetchProductJson(PRODUCTS[0], d));
      if (parsed.rows.length) return { tradeDate: d, soyParsed: parsed };
    } catch {
      /* weekend/holiday/transient — try the prior day */
    }
  }
  return null;
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. [] until CME_SETTLEMENTS is set. */
export async function fetchSeries({ env = process.env, sourceConfig = {} } = {}) {
  if (!isEnabled(env)) return [];
  const maxContracts = Number(sourceConfig.maxContracts) || 8;
  const maxLookbackDays = Number(sourceConfig.maxLookbackDays) || 7;
  const latest = await resolveLatest(maxLookbackDays);
  if (!latest) {
    console.log(`⚠️  ${label}: no settled trade date found in the last ${maxLookbackDays} days`);
    return [];
  }
  const out = [...buildProductSeries(PRODUCTS[0], latest.soyParsed, maxContracts)];
  for (const product of PRODUCTS.slice(1)) {
    try {
      out.push(...buildProductSeries(product, parseSettlementsJson(await fetchProductJson(product, latest.tradeDate)), maxContracts));
    } catch (err) {
      // One product failing shouldn't cost the others; the rest of the curve still lands.
      console.log(`⚠️  ${label}: ${product.label} (id ${product.productId}) failed — ${err.message}`);
    }
  }
  return out;
}

/** A single markets-class item summarizing the soybean curve. [] until CME_SETTLEMENTS is set. */
export async function fetchItems({ env = process.env, sourceConfig = {} } = {}) {
  if (!isEnabled(env)) return [];
  try {
    const latest = await resolveLatest(Number(sourceConfig.maxLookbackDays) || 7);
    if (!latest) return [];
    const rows = latest.soyParsed.rows.slice(0, 6);
    const lead = rows.filter((r) => r.openInterest != null).reduce((a, b) => ((b.openInterest ?? 0) > (a.openInterest ?? 0) ? b : a), rows[0]);
    const after = rows.filter((r) => r.contractMonth > lead.contractMonth)[0];
    const carry = after ? round3(after.settle - lead.settle) : null;
    return [{
      uid: `${id}:zs:${latest.soyParsed.tradeDate}`,
      sourceId: id,
      sourceLabel: label,
      title: `CME soybean curve ${latest.soyParsed.tradeDate}: lead ${lead.contractMonth} ${lead.settle}¢/bu${carry != null ? `, nearby carry ${carry >= 0 ? "+" : ""}${carry.toFixed(2)}¢` : ""}`,
      summary: `CME settlements: ${rows.map((r) => `${r.contractMonth} ${r.settle}`).join(" · ")}. Positive nearby carry = the market is paying to store; flat/inverted = it wants beans now.`,
      url: "https://www.cmegroup.com/markets/agriculture/oilseeds/soybean.settlements.html",
      publishedAt: new Date(`${latest.soyParsed.tradeDate}T21:00:00Z`).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: { tradeDate: latest.soyParsed.tradeDate, curve: rows },
    }];
  } catch {
    return [];
  }
}

// Exported for the probe script and tests.
export const __internal = { PRODUCTS, CMEWS_BASE, buildProductSeries, resolveLatest, recentTradeDates };
