// cme_settlements.js — CME end-of-day settlements for the soybean complex + corn: the FULL FORWARD
// CURVE and OPEN INTEREST per contract month, daily. Keyless. "markets"-class. GATED OFF by default.
//
// WHY (§1.1 of the data-pipeline-expansion plan). cbot_futures.js gives only a front-month CONTINUOUS
// settle (Yahoo ZS=F …), so the system has no curve: no carry, no old-crop/new-crop or calendar
// spreads, no correctly-paired crush legs, and `basis_carry_state` cannot fire for lack of a carry
// spread. One CME settlements pull per product gives every listed contract month's settle + open
// interest — the raw material for all of those.
//
// ⚠️ ACCESS IS THE OPEN QUESTION, NOT THE CODE. CME IP-blocks cloud/dev IPs — the CmeWS JSON 403s from
// the workstation, and so does ftp/pub/settle/stlags (verified). The bet, per the "defer to the Pi"
// pattern in docs/overnight-queue.md, is that the Pi's residential/business IP is not blocked. So this
// adapter STAYS OFF until proven there:
//   1. Run  `scripts/probe-cme-settlements.mjs`  ON THE PI. It reports which route the Pi can reach and
//      dumps the real response shape.
//   2. Confirm the field names / product ids below against that output (they follow CME's documented
//      CmeWS shape, but the probe is the source of truth).
//   3. Set  CME_SETTLEMENTS=1  in .env to turn it on (no API key — CME is keyless).
// Until then fetchItems/fetchSeries return [] — no calls, no noise (same pattern as barchart.js).
//
// SERIES NAMESPACE is deliberately `cme:*`, distinct from `cbot:*` (Yahoo continuous) and `barchart:*`,
// so the real CME curve can coexist with — and be compared against — the interim continuous series
// rather than silently overwriting it (the plan is explicit about keeping the three distinct).
//
// ROUTE. Primary: the CmeWS JSON settlements endpoint per product id, which returns one row per
// contract month with settle + openInterest in a structured shape that parses deterministically. The
// plan's ftp/pub/settle/stlags text file is the alternative the probe also tests and dumps; parseStlags()
// below is a PROVISIONAL parser for it, to be finalized against a real sample once the probe reveals it.

import { fetchJSON } from "../util.js";

export const id = "cme_settlements";
export const label = "CME settlements (curve + open interest)";

// CmeWS product ids: soybeans 320 and corn 300 are confirmed in docs/overnight-queue.md; meal 310 and
// oil 312 follow CME's product numbering and are to be confirmed by the probe. `unit` matches the
// cbot_futures legs so the two namespaces are directly comparable.
const PRODUCTS = [
  { key: "zs", productId: 320, label: "CBOT soybeans", unit: "¢/bu", category: "soy_curve" },
  { key: "zm", productId: 310, label: "CBOT soybean meal", unit: "$/ton", category: "soy_products_curve" },
  { key: "zl", productId: 312, label: "CBOT soybean oil", unit: "¢/lb", category: "soy_products_curve" },
  { key: "zc", productId: 300, label: "CBOT corn", unit: "¢/bu", category: "corn_curve" },
];

const CMEWS_BASE = "https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements";
const STLAGS_URL = "https://www.cmegroup.com/ftp/pub/settle/stlags";
// CME blocks the bot-ish default UA (util.js sends "polibrief/1.0 …"); the settlements surfaces expect
// a browser one (see docs/overnight-queue.md). Kept here so the probe and the adapter send the same one.
export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Enabled only once the Pi probe has confirmed reachability and CME_SETTLEMENTS is set. */
export function isEnabled(env = process.env) {
  const v = env.CME_SETTLEMENTS;
  return !!v && v !== "0" && String(v).toLowerCase() !== "false";
}

const MONTHS3 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const MONTH_CODES = "FGHJKMNQUVXZ"; // CME single-letter month codes, Jan..Dec

/**
 * Parse a CME price string to a number. Grains (ZS/ZC) quote in "points'eighths" — "1052'2" is
 * 1052 + 2/8 = 1052.25; products (ZM/ZL) quote plain decimals ("319.10", "54.32"). Handles a leading
 * sign, thousands commas, and empty/dash placeholders (→ null). Detection is by the apostrophe, so no
 * per-product flag is needed.
 */
export function parsePrice(s) {
  if (s == null) return null;
  let str = String(s).trim().replace(/,/g, "");
  if (str === "" || /^-+$/.test(str) || str.toUpperCase() === "N/A") return null;
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

/** Contract label → "YYYY-MM". Accepts "SEP 25", "SEP25", "SEP 2025" and single-letter codes ("X26"). */
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

/** CME trade-date string → "YYYY-MM-DD". Accepts "12 Sep 2026", ISO, and Date-parseable fallbacks. */
export function parseTradeDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (m && MONTHS3[m[2].toUpperCase()]) return `${m[3]}-${MONTHS3[m[2].toUpperCase()]}-${String(m[1]).padStart(2, "0")}`;
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

/**
 * PROVISIONAL parser for the ftp/pub/settle/stlags fixed-layout text file (the plan's preferred route).
 * The exact column layout is unknown from the blocked dev IP, so this is intentionally tolerant and
 * MUST be validated against a real sample from the probe before the text route is trusted: it walks
 * lines, tracks the current product from a header line naming SOYBEAN/CORN/etc., and reads any line
 * whose first token parses as a contract month, taking its settle and open interest by a configurable
 * column convention (settle = the SETTLE-labelled column when a header row is present, else best-effort).
 * @returns {{ tradeDate: string|null, byProduct: Record<string,{contractMonth,settle,openInterest}[]> }}
 */
export function parseStlags(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const byProduct = {};
  let tradeDate = null;
  let current = null;
  const productOf = (line) => {
    const u = line.toUpperCase();
    if (/\bSOYBEAN\s*MEAL\b/.test(u)) return "zm";
    if (/\bSOYBEAN\s*OIL\b/.test(u)) return "zl";
    if (/\bSOYBEAN/.test(u)) return "zs";
    if (/\bCORN\b/.test(u)) return "zc";
    return null;
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    const dateHit = line.match(/(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})|(\d{4}-\d{2}-\d{2})/);
    if (dateHit && !tradeDate) tradeDate = parseTradeDate(dateHit[0]);
    const prod = productOf(line);
    if (prod && !/^\s*[A-Z]{3}\s*\d{2}/.test(line)) { current = prod; byProduct[current] = byProduct[current] || []; continue; }
    if (!current) continue;
    const tokens = line.trim().split(/\s+/);
    const contractMonth = parseContractMonth(tokens[0]) || parseContractMonth(`${tokens[0]} ${tokens[1]}`);
    if (!contractMonth) continue;
    const nums = tokens.map(parsePrice).filter((n) => n != null);
    if (nums.length < 2) continue;
    // Best-effort until validated: settle is the last price-shaped column before the big integers, and
    // open interest is the largest trailing integer. The probe prints raw rows so this can be pinned.
    const openInterest = nums[nums.length - 1];
    const settle = nums[nums.length - 3] ?? nums[nums.length - 2] ?? nums[0];
    byProduct[current].push({ contractMonth, settle, openInterest });
  }
  for (const k of Object.keys(byProduct)) byProduct[k].sort((a, b) => (a.contractMonth < b.contractMonth ? -1 : 1));
  return { tradeDate, byProduct };
}

/** { tradeDate, rows } for one product → store series (settle + OI per contract, front, nearby carry). */
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
  out.push({ series: `cme:${product.key}:front`, meta: { label: `${product.label} front-month settle (CME)`, unit: product.unit, category: product.category }, points: [{ period, value: rows[0].settle }] });
  if (rows.length >= 2) {
    // Nearby carry = 2nd contract − 1st. Positive = the market is paying to store (carry); flat/inverted
    // = it wants beans now. This is the `carry_spread` leg basis_carry_state needs to fire.
    out.push({ series: `cme:${product.key}:carry`, meta: { label: `${product.label} nearby carry (2nd − 1st)`, unit: product.unit, category: `${product.category}_carry` }, points: [{ period, value: Math.round((rows[1].settle - rows[0].settle) * 1000) / 1000 }] });
  }
  return out;
}

/** Fetch one product's settlements JSON with the browser UA. Exported so the probe reuses it. */
export async function fetchProductJson(product) {
  return fetchJSON(`${CMEWS_BASE}/${product.productId}/FUT`, { headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. [] until CME_SETTLEMENTS is set. */
export async function fetchSeries({ env = process.env, sourceConfig = {} } = {}) {
  if (!isEnabled(env)) return [];
  const maxContracts = Number(sourceConfig.maxContracts) || 8;
  const out = [];
  for (const product of PRODUCTS) {
    try {
      const parsed = parseSettlementsJson(await fetchProductJson(product));
      out.push(...buildProductSeries(product, parsed, maxContracts));
    } catch (err) {
      // One product failing shouldn't cost the others; the curve for the rest still lands.
      console.log(`⚠️  ${label}: ${product.label} (id ${product.productId}) failed — ${err.message}`);
    }
  }
  return out;
}

/** A single markets-class item summarizing the soybean curve. [] until CME_SETTLEMENTS is set. */
export async function fetchItems({ env = process.env } = {}) {
  if (!isEnabled(env)) return [];
  try {
    const soy = PRODUCTS[0];
    const parsed = parseSettlementsJson(await fetchProductJson(soy));
    if (!parsed.tradeDate || !parsed.rows.length) return [];
    const rows = parsed.rows.slice(0, 6);
    const carry = rows.length >= 2 ? rows[1].settle - rows[0].settle : null;
    return [{
      uid: `${id}:zs:${parsed.tradeDate}`,
      sourceId: id,
      sourceLabel: label,
      title: `CME soybean curve ${parsed.tradeDate}: front ${rows[0].contractMonth} ${rows[0].settle}¢/bu${carry != null ? `, nearby carry ${carry >= 0 ? "+" : ""}${carry.toFixed(2)}¢` : ""}`,
      summary: `CME settlements: ${rows.map((r) => `${r.contractMonth} ${r.settle}`).join(" · ")}. Positive nearby carry = the market is paying to store; flat/inverted = it wants beans now.`,
      url: "https://www.cmegroup.com/markets/agriculture/oilseeds/soybean.settlements.html",
      publishedAt: new Date(`${parsed.tradeDate}T21:00:00Z`).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: { tradeDate: parsed.tradeDate, curve: rows },
    }];
  } catch {
    return [];
  }
}

// Exported for the probe script and tests.
export const __internal = { PRODUCTS, CMEWS_BASE, STLAGS_URL, buildProductSeries };
