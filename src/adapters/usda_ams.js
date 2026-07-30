// usda_ams.js — USDA AMS "My Market News" (MARS API). Free key: https://mymarketnews.ams.usda.gov
// → USDA_AMS_API_KEY, sent as HTTP Basic auth (key as username, empty password).
//
// TWO reports, one key, one adapter (same source, same auth):
//
//   2850 "Iowa Daily Cash Grain Bids"  — DAILY. Iowa cash soybean price + basis, split by the six
//         Iowa districts and by delivery point (Country Elevators / Terminal Elevators / Mills and
//         Processors). ~1,478 daily dates back to 2020-08.
//   3511 "National Grain and Oilseed Processor Feedstuff Report" — WEEKLY. Cash soybean meal, oil
//         and hulls (loose + pellets) by trade location, Iowa among them. ~223 weekly dates back
//         to 2022-02.
//
// Together these give the piece the tool never had: an IOWA CASH CRUSH MARGIN — the same
// calculation as the "Cash Margin" tab of the Gordon Denny workbook ISA staff already read, but as
// a multi-year weekly series instead of a single-day snapshot. Board margin (see cbot_futures.js)
// says what the exchange implies; this says what Iowa plants are actually clearing.
//
// ⚠️ CORRECTION TO A PRIOR NOTE IN THIS FILE: it used to claim 2850's "structured rows are report
// metadata" and that only `report_narrative` was usable, so the old implementation regex-parsed a
// prose sentence and emitted a single item with no series at all. That is wrong — the report's
// "Report Detail" section carries fully structured rows (avg_price, basis Min/Max, futures month,
// delivery point, district). The narrative parse is kept for the headline item because it is the
// figure AMS itself publishes as the state average, but the SERIES now come from the structured
// rows.
//
// ⚠️ FIELD-NAME INCONSISTENCY BETWEEN THE TWO REPORTS — easy to trip over: 2850 uses snake_case
// (`trade_loc`) while 3511 uses a space (`trade Loc`); 2850's basis fields are Title Case With
// Spaces (`basis Min`, `basis Min Futures Month`). Read via the `pick()` helper, never dot access.

import { fetchJSON, sleep } from "../util.js";
import * as store from "../store.js";

export const id = "usda_ams";
export const label = "USDA AMS (Iowa cash, basis & feedstuffs)";

const BASE = "https://marsapi.ams.usda.gov/services/v1.2/reports";
const CASH_GRAIN = 2850;
const FEEDSTUFF = 3511;

// --- backfill vs incremental ---------------------------------------------------------------
// 2850's full "Report Detail" is 21,888 rows / ~29 MB — fine ONCE, wasteful twice a day forever.
// So: deep-pull only when the series is not yet populated, then switch to a short rolling window.
// Same self-healing shape as open_meteo's climatology cache — no operator step, no CLI flag to
// remember, and a wiped DB re-backfills itself.
//
// ⚠️ AND THE DEEP PULL IS CHUNKED, which is not premature caution. A single unfiltered request
// succeeds when run alone (~12s) but reliably throws a connection-level error inside
// refreshMarketSeries, where five other adapters are fetching concurrently — raising the timeout to
// 180s did NOT fix it, so it is the 29 MB transfer itself, not the clock. Walking back in ~6-month
// windows turns that into ~12 requests of roughly 1 MB (measured: a 30-day window is 416 KB /
// 1.7s), which is both robust under concurrency and much kinder to a free public service.
//
// MARS filters, both verified live:
//   ?lastDays=N                              → rolling window (lastDays=10 → 135 rows, 178 KB, 0.9s)
//   ?q=report_date=MM/DD/YYYY:MM/DD/YYYY     → explicit range (a July window → 315 rows, 416 KB)
const INCREMENTAL_DAYS_DEFAULT = 45;
// Below this many stored points a series is treated as un-backfilled. 2850 posts ~250 dates/yr and
// 3511 ~52, so 60 clears the "3511 is fully backfilled" bar while still catching a truncated 2850.
const BACKFILL_THRESHOLD_POINTS = 60;
const BACKFILL_CHUNK_DAYS = 180;
// 7 years of 180-day chunks. Also the loop's hard stop, so a filter that silently stops narrowing
// can never spin: worst case it makes this many requests and gives up.
const BACKFILL_MAX_CHUNKS = 15;
const AMS_RETRIES = 2;
const AMS_RETRY_BACKOFF_MS = 1200;

/** True when the store has little or no history for `series` — i.e. we still owe a deep pull. */
function needsBackfill(series) {
  try {
    return store.getSeries(series).length < BACKFILL_THRESHOLD_POINTS;
  } catch {
    return true; // no store / fresh DB → treat as un-backfilled
  }
}
const MONTHS = { F: "Jan", G: "Feb", H: "Mar", J: "Apr", K: "May", M: "Jun", N: "Jul", Q: "Aug", U: "Sep", V: "Oct", X: "Nov", Z: "Dec" };

// Crush yields — Gordon Denny workbook "Cash Margin" tab. Kept in sync with cbot_futures.js
// (CRUSH_YIELDS); duplicated rather than imported so each adapter stays independently runnable.
const MEAL_TON_PER_BU = 0.0221;
const OIL_LB_PER_BU = 11.71;
const HULLS_TON_PER_BU = 0.0018;

/** Read a field that may be snake_case, "Title Case", or spaced across the two reports. */
function pick(row, ...names) {
  for (const n of names) if (row[n] != null && row[n] !== "") return row[n];
  return null;
}

/** AMS "MM/DD/YYYY" → "YYYY-MM-DD". Returns null on anything unexpected. */
function amsDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s ?? ""));
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function authHeader(env) {
  const key = env.USDA_AMS_API_KEY;
  if (!key) throw new Error("USDA_AMS_API_KEY not set (free: https://mymarketnews.ams.usda.gov)");
  return { Authorization: "Basic " + Buffer.from(`${key}:`).toString("base64") };
}

const sectionPath = (reportId, sectionName) =>
  `${BASE}/${reportId}${sectionName ? `/${encodeURIComponent(sectionName)}` : ""}`;

/** MM/DD/YYYY, the only date format the MARS `q=report_date` filter accepts. */
function usDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

/**
 * GET with one retry. MARS intermittently drops a connection when refreshMarketSeries has six
 * adapters in flight — observed on the small 45-day incremental request, not just the big backfill,
 * so it is concurrency rather than payload size. Without this, a whole refresh silently loses the
 * Iowa basis + cash-margin series roughly one run in three.
 */
async function getWithRetry(url, env) {
  for (let attempt = 0; attempt <= AMS_RETRIES; attempt++) {
    try {
      return await fetchJSON(url, { headers: authHeader(env) });
    } catch (err) {
      if (attempt >= AMS_RETRIES) throw err;
      await sleep(AMS_RETRY_BACKOFF_MS);
    }
  }
  return {};
}

/** One request: a report section over a rolling `lastDays` window (or unfiltered when null). */
async function section(reportId, sectionName, env, lastDays = null) {
  const base = sectionPath(reportId, sectionName);
  const url = lastDays == null ? base : `${base}?lastDays=${lastDays}`;
  const d = await getWithRetry(url, env);
  return d.results ?? [];
}

/**
 * Deep history, fetched in ~6-month chunks walking backward from today. Stops early once a chunk
 * comes back empty (we've run off the start of the report) and hard-stops at BACKFILL_MAX_CHUNKS.
 * A failed chunk is logged and skipped rather than aborting the whole backfill — a gap in 2022 is
 * far better than no history at all, and the next run's threshold check will try again.
 */
async function sectionHistory(reportId, sectionName, env) {
  const base = sectionPath(reportId, sectionName);
  const rows = [];
  let end = new Date();
  for (let i = 0; i < BACKFILL_MAX_CHUNKS; i++) {
    const start = new Date(end.getTime() - BACKFILL_CHUNK_DAYS * 864e5);
    const url = `${base}?q=report_date=${encodeURIComponent(`${usDate(start)}:${usDate(end)}`)}`;
    let chunk = [];
    try {
      const d = await getWithRetry(url, env);
      chunk = d.results ?? [];
    } catch (err) {
      console.log(`   ⚠️  ${label}: backfill chunk ${usDate(start)}–${usDate(end)} failed (${err.message}) — skipping`);
      end = start;
      continue;
    }
    if (!chunk.length) break; // ran off the beginning of the report
    rows.push(...chunk);
    end = start;
  }
  return rows;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, p = 4) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);

/** Group rows into a Map keyed by ISO date. */
function byDate(rows) {
  const m = new Map();
  for (const r of rows) {
    const d = amsDate(pick(r, "report_date", "report_begin_date"));
    if (!d) continue;
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(r);
  }
  return m;
}

/** Turn a Map<date, number> into sorted [{period, value}] points. */
function toPoints(map) {
  return [...map.entries()]
    .filter(([, v]) => v != null && Number.isFinite(v))
    .map(([period, value]) => ({ period, value: round(value, 4) }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}

// --- 2850: Iowa daily cash price + basis --------------------------------------------------

/**
 * Basis rows on a given day reference different futures months (old-crop Aug vs new-crop Nov),
 * and averaging across them mixes two different things. Use the MODAL futures month for the day —
 * the one the trade is actually quoting most — and average only within it. The reference month
 * therefore rolls through the year, the same caveat that applies to any nearby-basis series.
 */
function modalMonthBasis(rows) {
  const counts = new Map();
  for (const r of rows) {
    const fm = pick(r, "basis Min Futures Month", "basis Max Futures Month");
    if (fm) counts.set(fm, (counts.get(fm) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const mids = [];
  for (const r of rows) {
    if (pick(r, "basis Min Futures Month", "basis Max Futures Month") !== modal) continue;
    const lo = Number(pick(r, "basis Min"));
    const hi = Number(pick(r, "basis Max"));
    if (Number.isFinite(lo) && Number.isFinite(hi)) mids.push((lo + hi) / 2);
    else if (Number.isFinite(lo)) mids.push(lo);
  }
  return mean(mids);
}

function cashGrainSeries(rows) {
  const soy = rows.filter((r) => /soybean/i.test(String(r.commodity ?? "")));
  if (!soy.length) return [];
  const days = byDate(soy);
  const price = new Map();
  const basis = new Map();
  const basisProc = new Map();
  for (const [d, rs] of days) {
    const prices = rs.map((r) => Number(r.avg_price)).filter((v) => Number.isFinite(v) && v > 0);
    if (prices.length) price.set(d, mean(prices));
    const b = modalMonthBasis(rs);
    if (b != null) basis.set(d, b);
    // "Mills and Processors" = the crush plants' own bid. When processors bid up relative to
    // country elevators they are pulling beans in — a demand read that no other series carries.
    const proc = rs.filter((r) => /mills and processors/i.test(String(pick(r, "delivery_point") ?? "")));
    if (proc.length) {
      const bp = modalMonthBasis(proc);
      if (bp != null) basisProc.set(d, bp);
    }
  }
  const out = [];
  // Cash price rides the EXISTING soy_price chart ($/bu, alongside the monthly NASS price-received
  // series) rather than a chart of its own — same unit, and the daily-cash-vs-monthly-received
  // contrast is the useful comparison. The two basis series get their own chart because they are
  // ¢/bu and would wreck a $/bu axis.
  if (price.size) out.push({ series: "ams:ia:cash-price", meta: { label: "Iowa cash soybean price (daily)", unit: "$/bu", category: "soy_price" }, points: toPoints(price) });
  if (basis.size) out.push({ series: "ams:ia:basis", meta: { label: "Iowa soybean basis (nearby)", unit: "¢/bu", category: "soy_basis" }, points: toPoints(basis) });
  if (basisProc.size) out.push({ series: "ams:ia:basis-processor", meta: { label: "Iowa soybean basis — processors", unit: "¢/bu", category: "soy_basis" }, points: toPoints(basisProc) });
  return out;
}

// --- 3511: Iowa cash product values + the cash crush margin -------------------------------

const IOWA = (r) => /^iowa$/i.test(String(pick(r, "trade Loc", "trade_loc") ?? ""));

function feedstuffSeries(rows) {
  const iowa = rows.filter(IOWA);
  const pull = (commodity, filterFn) => {
    const sel = iowa.filter((r) => String(r.commodity ?? "") === commodity && (filterFn ? filterFn(r) : true));
    const m = new Map();
    for (const [d, rs] of byDate(sel)) {
      const v = mean(rs.map((r) => Number(r.avg_price)).filter((x) => Number.isFinite(x) && x > 0));
      if (v != null) m.set(d, v);
    }
    return m;
  };
  // Hulls split loose vs pellets: `variety` is "Pellets" on the pelleted quote and null on loose.
  // Denny's sheet assumes $130 loose / $150 pelleted; the live feed is materially different
  // (2026-07-20 Iowa: loose 117.86, pellets 130.00), which is the whole reason to feed it.
  const isPellet = (r) => /pellet/i.test(String(pick(r, "variety") ?? ""));
  const meal = pull("Soybean Meal");
  const oil = pull("Soybean Oil");
  const hullsLoose = pull("Soybean Hulls", (r) => !isPellet(r));
  const hullsPellet = pull("Soybean Hulls", isPellet);

  const out = [];
  if (meal.size) out.push({ series: "ams:ia:meal", meta: { label: "Iowa cash soybean meal (46.5–48%)", unit: "$/ton", category: "soy_products_cash" }, points: toPoints(meal) });
  if (oil.size) out.push({ series: "ams:ia:oil", meta: { label: "Iowa cash soybean oil", unit: "¢/lb", category: "soy_products_cash" }, points: toPoints(oil) });
  if (hullsLoose.size) out.push({ series: "ams:ia:hulls-loose", meta: { label: "Iowa soybean hulls (loose)", unit: "$/ton", category: "soy_products_cash" }, points: toPoints(hullsLoose) });
  if (hullsPellet.size) out.push({ series: "ams:ia:hulls-pellet", meta: { label: "Iowa soybean hulls (pellets)", unit: "$/ton", category: "soy_products_cash" }, points: toPoints(hullsPellet) });
  return { out, meal, oil, hullsLoose, hullsPellet };
}

/**
 * Iowa CASH crush margin, $/bu — Denny's "Cash Margin" tab as a series.
 *
 *   (meal $/ton × 0.0221) + (oil ¢/lb ÷ 100 × 11.71) + (hulls $/ton × 0.0018) − beans $/bu
 *
 * The product legs are WEEKLY (3511) and the bean leg is DAILY (2850), so a point is emitted on
 * each product date using the bean price from that same date when the market was open, else the
 * most recent prior bean price within a week. Anything staler is skipped rather than carried —
 * a margin built from a two-week-old bean price is a fabricated number.
 *
 * The bean leg is the UNION of this run's fetch and whatever is already stored. That is not
 * belt-and-braces: the two reports backfill independently, so on the run where 2850 deep-pulls,
 * 3511 is already past its threshold and only returns a 45-day window (and vice versa). Reading
 * beans from this run alone produced a 6-point margin series against 223 points of products.
 * Unioning with the store lets the margin fill in completely on whichever run comes second.
 *
 * ⚠️ 3511's Soybean Oil rows carry quote_type "Basis", yet avg_price reads as an outright ¢/lb
 * (2026-07-20 Iowa 77.61¢ against a ~73¢ board — a few cents over, which is what crude degummed
 * oil FOB a plant should look like). Treated as outright here. Worth re-validating against the
 * board if the margin series ever drifts implausibly from the workbook.
 *
 * ⚠️ EXPECT THIS TO READ ~$1/bu ABOVE THE WORKBOOK'S CASH MARGIN, and know why before calling it
 * a bug. On 2026-07-20 this series is $4.74/bu; the workbook's 2026-07-15 "Net Margin" cell is
 * $3.584. The gap is not an error in either — the two use different cash legs:
 *   - The workbook builds SYNTHETIC cash from the board plus assumed basis (its own note says
 *     "Synthetic CME spot board crush"): meal 319.10−10, oil 0.729+0.02, beans 12.020+0.25.
 *   - This series uses OBSERVED AMS Iowa cash: meal 334.50, oil 77.61¢, beans ~11.95.
 * Every one of those three differences pushes the observed margin higher (meal +$25/ton, oil
 * +2.7¢/lb, beans −32¢/bu). Observed cash is the better input for a signal — it is what plants
 * actually face — but the BOARD margin in cbot_futures.js is the series that ties to his sheet
 * (validated to within $0.01). Keep both: board for continuity with the workbook, cash for the
 * real economics.
 */
function cashCrushMargin({ meal, oil, hullsLoose, hullsPellet }, cashPricePoints) {
  const beans = new Map();
  try {
    for (const p of store.getSeries("ams:ia:cash-price")) beans.set(p.period, p.value);
  } catch {
    /* no store yet → this run's fetch is all we have */
  }
  for (const p of cashPricePoints) beans.set(p.period, p.value); // this run wins on overlap
  const beanDates = [...beans.keys()].sort();
  const beanNearOrBefore = (d) => {
    if (beans.has(d)) return beans.get(d);
    let best = null;
    for (const bd of beanDates) {
      if (bd > d) break;
      best = bd;
    }
    if (!best) return null;
    const ageDays = (Date.parse(d) - Date.parse(best)) / 864e5;
    return ageDays <= 7 ? beans.get(best) : null;
  };
  const out = new Map();
  for (const [d, m] of meal) {
    const o = oil.get(d);
    // Prefer loose hulls (the commodity form most plants move); fall back to pellets.
    const h = hullsLoose.get(d) ?? hullsPellet.get(d);
    const b = beanNearOrBefore(d);
    if (o == null || h == null || b == null) continue;
    const gross = m * MEAL_TON_PER_BU + (o / 100) * OIL_LB_PER_BU + h * HULLS_TON_PER_BU;
    out.set(d, gross - b);
  }
  return out;
}

// --- items ---------------------------------------------------------------------------------

export async function fetchItems({ env = process.env } = {}) {
  // Headline item stays on the narrative's state-average line — that's the figure AMS itself
  // publishes as "the" Iowa average, so it matches what a member would read on the report page.
  const header = await section(CASH_GRAIN, null, env);
  const r = header[0];
  const narrative = r?.report_narrative ?? "";
  const m = narrative.match(/Soybeans?\s*--\s*\$([\d.]+)\s*\(([-+]?\.?\d+)([A-Z])\)\s*(Up|Down)?\s*([\d.]+)?/i);
  if (!m) return []; // format changed → skip rather than emit garbage

  const [, price, basis, month, dir = "", chg = ""] = m;
  const date = amsDate(pick(r, "report_date", "published_date")) ?? "";
  const change = dir ? `${dir} ${chg}¢` : "";

  return [
    {
      uid: `${id}:soybeans:${date}`,
      sourceId: id,
      sourceLabel: label,
      title: `Iowa avg soybean cash $${price}, basis ${basis} vs ${MONTHS[month] ?? month} futures${change ? ` (${change})` : ""} — ${date}`,
      summary: narrative.split("\n")[0].slice(0, 300),
      url: "https://mymarketnews.ams.usda.gov/viewReport/2850",
      publishedAt: new Date(r.published_date ?? Date.now()).toISOString(),
      jurisdiction: "Iowa",
      docType: "data",
      raw: { metric: "basis", price: Number(price), basis: Number(basis), futuresMonth: month, change: chg ? Number(chg) : null, direction: dir },
    },
  ];
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. Fail-soft per report. */
export async function fetchSeries({ env = process.env, sourceConfig = {} } = {}) {
  const window = Number(sourceConfig.incrementalDays) || INCREMENTAL_DAYS_DEFAULT;
  const out = [];
  let cashPricePoints = [];
  try {
    const deep = needsBackfill("ams:ia:cash-price");
    if (deep) console.log(`   ${label}: first run for Iowa cash/basis — backfilling 2850 in ${BACKFILL_CHUNK_DAYS}-day chunks (one time)`);
    const rows = deep
      ? await sectionHistory(CASH_GRAIN, "Report Detail", env)
      : await section(CASH_GRAIN, "Report Detail", env, window);
    const s = cashGrainSeries(rows);
    out.push(...s);
    cashPricePoints = s.find((x) => x.series === "ams:ia:cash-price")?.points ?? [];
  } catch (err) {
    console.log(`⚠️  ${label}: cash grain (2850) series failed — ${err.message}`);
  }
  try {
    // Also deep-pull when the MARGIN is thin even though the legs are populated — that's the
    // second-run case where 2850 backfilled after 3511 had already passed its threshold.
    const deep = needsBackfill("ams:ia:meal") || needsBackfill("ams:ia:cash-crush-margin");
    if (deep) console.log(`   ${label}: backfilling 3511 in ${BACKFILL_CHUNK_DAYS}-day chunks (one time)`);
    const rows = deep
      ? await sectionHistory(FEEDSTUFF, "Report Detail", env)
      : await section(FEEDSTUFF, "Report Detail", env, window);
    const legs = feedstuffSeries(rows);
    out.push(...legs.out);
    if (cashPricePoints.length) {
      const margin = cashCrushMargin(legs, cashPricePoints);
      if (margin.size) {
        out.push({
          series: "ams:ia:cash-crush-margin",
          meta: { label: "Iowa cash crush margin", unit: "$/bu", category: "soy_crush_margin" },
          points: toPoints(margin),
        });
      }
    }
  } catch (err) {
    console.log(`⚠️  ${label}: feedstuff (3511) series failed — ${err.message}`);
  }
  return out;
}

export const __test = { amsDate, modalMonthBasis, cashGrainSeries, feedstuffSeries, cashCrushMargin, pick };
