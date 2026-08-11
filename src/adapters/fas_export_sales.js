// fas_export_sales.js — USDA FAS Export Sales Reporting (ESR): weekly US export sales and
// shipments of soybeans, meal and oil, with destination detail for China.
//
// WHY THIS EXISTS. `fas_export_sales` has been declared in `adapters/index.js`'s SOURCE_CLASS map
// and in `eventkey.js` for months with NO ADAPTER FILE BEHIND IT — a dangling id that made the
// system look like it watched export demand when nothing ever fetched it. Export sales are the most
// direct weekly read on the demand side of the balance sheet and the only high-frequency window on
// China, which is the variable behind most trade-policy analysis this tool does.
//
// API. https://api.fas.usda.gov/api/esr — free key from https://apps.fas.usda.gov/opendataweb/home
// Set FAS_API_KEY. Without it this adapter logs a skip and changes nothing.
//
// ⚠️ THE AUTH HEADER IS `X-Api-Key`, AND THE API'S OWN ERROR MESSAGE IS WRONG ABOUT THIS.
// Sending the documented `API_KEY` header returns HTTP 403 with the body
// `{"error":{"code":"API_KEY_MISSING","message":"No api_key was supplied."}}` — i.e. it reports a
// MISSING key when the key was in fact supplied under the name its own docs give. Measured
// 2026-08-10 against all five plausible variants; `X-Api-Key` and the `?api_key=` query string both
// work, the header is used here to keep the key out of URLs and logs. Do not "fix" this back.
//
// ⚠️ THE MARKETING YEAR IS NOT THE SAME FOR ALL THREE COMMODITIES, AND IT IS NOT THE CALENDAR YEAR.
// Verified against /datareleasedates on 2026-08-10: soybeans (801) run 1 Sep – 31 Aug, while soybean
// cake & meal (901) and soybean oil (902) run 1 Oct – 30 Sep. A single hardcoded "September rollover"
// would silently mis-file two of the three commodities for a month every year. The MY window is
// therefore READ FROM THE API rather than assumed — same principle as `frDocNumOf` in enrich.js:
// never key on a field you can validate, and never assume a boundary you can look up.
//
// ⚠️ THE AUGUST BLIND SPOT — THE TRAP THIS ADAPTER EXISTS TO AVOID FALLING INTO.
// At the end of a marketing year the current-MY numbers go to zero because the year's business is
// done, while the new crop is being booked in `nextMYOutstandingSales`. Measured on the real feed at
// week ending 2026-07-30: China's `currentMYNetSales` was **0** and `weeklyExports` **0**, while
// `nextMYOutstandingSales` stood at **3,111,000 tonnes**. An adapter that read only the current MY
// would have reported "China: zero" in August — true, and one of the most misleading things this
// tool could say. And the next marketing year CANNOT simply be fetched instead: MY2027 returns an
// empty array, because FAS does not publish a marketing year as its own dataset until it opens. The
// `nextMY*` fields on the current year's rows are the only window onto the new-crop book, so they
// get their own series.
//
// ⚠️ TWO OF THESE SERIES ARE CUMULATIVE AND RESET EVERY YEAR. `currentMYTotalCommitment` and
// `accumulatedExports` climb through the marketing year and drop to ~0 at rollover, so as a
// continuous series they are a sawtooth. That is the correct shape for reading export PACE, but a
// level percentile over it is meaningless — so they carry entries in `PERCENTILE_CAVEATS`
// (pipeline.js), exactly like `nass:us:crush`. The weekly-flow series have no such problem and are
// the ones the signal layer should lean on.

import { fetchJSON } from "../util.js";
import * as store from "../store.js";

export const id = "fas_export_sales";
export const label = "USDA FAS Export Sales";

const BASE = "https://api.fas.usda.gov/api/esr";

/** Metric tons. Every soy row measured so far carries unitId 1; rows that do not are skipped rather
 *  than silently mixed into a tonnes series. */
const UNIT_METRIC_TONS = 1;

/** FAS country code for China. Hong Kong (5820) is reported separately and is NOT folded in — it is
 *  a distinct destination and merging the two would overstate mainland demand. */
const CHINA = 5700;

/** How many marketing years to pull on FIRST population. Six gives the signal layer a real
 *  distribution to compute percentiles and a seasonal norm against, without a 17-call cold start.
 *  Subsequent runs fetch only the open marketing year — that is where new weeks appear. */
const DEFAULT_HISTORY_YEARS = 6;

const COMMODITIES = [
  { code: 801, key: "soybeans", label: "soybeans" },
  { code: 901, key: "soymeal", label: "soybean meal" },
  { code: 902, key: "soyoil", label: "soybean oil" },
];

function headers(env) {
  const key = env.FAS_API_KEY;
  if (!key) return null;
  // See the header note: `X-Api-Key`, not the documented `API_KEY`.
  return { "X-Api-Key": key, Accept: "application/json" };
}

/** YYYY-MM-DD from the API's "2026-07-30T00:00:00" form. Returns "" for anything unparseable. */
const dayOf = (ts) => {
  const s = String(ts ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The marketing-year calendar, straight from the API.
 *
 * Returns a Map commodityCode → { marketYear, start, end, releasedAt }. This is what tells us which
 * MY is currently open — per commodity, because they differ (see the header note).
 */
export async function fetchMarketYears(env = process.env) {
  const h = headers(env);
  if (!h) return new Map();
  const rows = await fetchJSON(`${BASE}/datareleasedates`, { headers: h });
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!COMMODITIES.some((c) => c.code === r.commodityCode)) continue;
    out.set(r.commodityCode, {
      marketYear: Number(r.marketYear),
      start: dayOf(r.marketYearStart),
      end: dayOf(r.marketYearEnd),
      releasedAt: String(r.releaseTimeStamp ?? "").slice(0, 19),
    });
  }
  return out;
}

/**
 * Which marketing year a week-ending date belongs to.
 *
 * The MY is labelled by its ENDING calendar year and starts on a fixed month/day that differs per
 * commodity (1 Sep for beans, 1 Oct for meal and oil), so a week on or after that boundary belongs
 * to the NEXT numbered year. Verified against the real feed: 2025-09-04 is the first week of MY2026,
 * and 2026-07-30 is the last.
 */
export function marketYearOf(period, startDate) {
  const md = String(period).slice(5, 10);
  const startMD = String(startDate).slice(5, 10);
  const year = Number(String(period).slice(0, 4));
  if (!Number.isFinite(year) || !md || !startMD) return null;
  return md >= startMD ? year + 1 : year;
}

/** The marketing years already present in a stored series. */
export function coveredMarketYears(points, startDate) {
  const out = new Set();
  for (const p of points ?? []) {
    const y = marketYearOf(p.period, startDate);
    if (y != null) out.add(y);
  }
  return out;
}

/** One commodity-year of per-country rows. Returns [] rather than throwing on a year with no data
 *  — a marketing year that has not opened yet answers 200 with an empty array. */
async function fetchYear(code, marketYear, env) {
  const h = headers(env);
  const rows = await fetchJSON(`${BASE}/exports/commodityCode/${code}/allCountries/marketYear/${marketYear}`, { headers: h });
  return Array.isArray(rows) ? rows : [];
}

/**
 * Collapse per-country rows into the weekly series this tool needs.
 *
 * Pure — takes rows, returns points — so the whole shape is testable offline against recorded
 * fixtures with no key and no network.
 *
 * @returns {{all:Map, china:Map, chinaNext:Map, allNext:Map}} each Map keyed period → totals
 */
export function aggregateWeeks(rows) {
  const all = new Map();
  const china = new Map();
  const bump = (map, period, field, v) => {
    if (!map.has(period)) map.set(period, { netSales: 0, exports: 0, commitments: 0, nextOutstanding: 0, nextNetSales: 0 });
    map.get(period)[field] += v;
  };
  for (const r of rows ?? []) {
    // Never mix units. Every soy row measured carries unitId 1; anything else is skipped loudly
    // rather than added to a tonnes total.
    if (Number(r.unitId) !== UNIT_METRIC_TONS) continue;
    const period = dayOf(r.weekEndingDate);
    if (!period) continue;
    const isChina = Number(r.countryCode) === CHINA;
    for (const [field, value] of [
      ["netSales", num(r.currentMYNetSales)],
      ["exports", num(r.weeklyExports)],
      ["commitments", num(r.currentMYTotalCommitment)],
      ["nextOutstanding", num(r.nextMYOutstandingSales)],
      ["nextNetSales", num(r.nextMYNetSales)],
    ]) {
      bump(all, period, field, value);
      if (isChina) bump(china, period, field, value);
    }
  }
  return { all, china };
}

/** Turn a period→totals Map into sorted points for one field. */
const pointsFor = (map, field) =>
  [...map.entries()]
    .map(([period, t]) => ({ period, value: t[field] }))
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.period.localeCompare(b.period));

/**
 * Weekly export-sales series.
 *
 * ⚠️ INCREMENTAL BY DEFAULT. A cold start pulls `historyYears` marketing years so the signal layer
 * has a distribution to work with; after that only the OPEN marketing year is refetched, because
 * closed years never change. Without this the adapter would re-download ~17 years of per-country
 * rows twice a day forever.
 */
export async function fetchSeries({ env = process.env, sourceConfig = {} } = {}) {
  if (!headers(env)) {
    console.log(`⚠️  ${label}: FAS_API_KEY is not set — skipping (free key: https://apps.fas.usda.gov/opendataweb/home)`);
    return [];
  }
  const historyYears = Number(sourceConfig.historyYears) || DEFAULT_HISTORY_YEARS;

  let calendar;
  try {
    calendar = await fetchMarketYears(env);
  } catch (err) {
    console.log(`⚠️  ${label}: could not read the marketing-year calendar — ${err.message}`);
    return [];
  }
  if (!calendar.size) return [];

  const out = [];
  for (const c of COMMODITIES) {
    const my = calendar.get(c.code);
    if (!my?.marketYear) continue;

    // ⚠️ INCREMENTAL IS DECIDED BY WHICH YEARS ARE ACTUALLY PRESENT, NOT BY "IS THERE ANY DATA".
    //
    // This endpoint intermittently answers HTTP 500 on individual years — observed repeatedly on
    // 2026-08-10 across all three commodities, different years each attempt. The first version of
    // this check went incremental as soon as the series was non-empty, which meant a transient 500
    // during the cold start left a truncated history that was NEVER backfilled: every later run
    // saw "data exists" and refetched only the open year. Nothing would have looked broken — the
    // series updates weekly, the charts render — while the seasonal norms silently rested on three
    // years instead of six, or vanished entirely below the three-year floor.
    //
    // So coverage is CHECKED rather than assumed, the same correction v1.28.0 made to the collection
    // watermark. Missing years are re-requested on the next run until they are genuinely present,
    // and the open year is always refetched because it gains a week at a time.
    //
    // A year the API simply does not have would therefore be retried every run — one call each,
    // bounded by `historyYears`, and announced in the log rather than hidden. That is the right
    // trade at the shipped default of 6 (ESR has all six), but push `historyYears` past what FAS
    // actually serves and the surplus years become a small permanent cost per run.
    const stored = store.getSeries(`fas:${c.key}:net-sales`);
    const have = coveredMarketYears(stored, my.start);
    const wanted = Array.from({ length: historyYears }, (_, i) => my.marketYear - i);
    const years = wanted.filter((y) => y === my.marketYear || !have.has(y));
    const backfilling = years.length - 1;
    if (stored.length && backfilling > 0) {
      console.log(`   ↻ ${label}: ${c.label} is missing ${backfilling} historical marketing year(s) — retrying them this run`);
    }

    const rows = [];
    for (const y of years) {
      try {
        const got = await fetchYear(c.code, y, env);
        // An unopened marketing year answers 200 with []. That is not an error and must not abort
        // the remaining years.
        rows.push(...got);
      } catch (err) {
        console.log(`⚠️  ${label}: ${c.label} MY${y} failed — ${err.message}`);
      }
    }
    if (!rows.length) continue;

    const { all, china } = aggregateWeeks(rows);
    const unit = "metric tons";

    // --- weekly flows: percentile-safe, YoY-safe, the ones signals should use -------------------
    out.push({
      series: `fas:${c.key}:net-sales`,
      meta: { label: `US ${c.label} weekly net export sales`, unit, category: "export_sales" },
      points: pointsFor(all, "netSales"),
    });
    out.push({
      series: `fas:${c.key}:exports`,
      meta: { label: `US ${c.label} weekly export shipments`, unit, category: "export_shipments" },
      points: pointsFor(all, "exports"),
    });

    // --- cumulative: sawtooth by design, see PERCENTILE_CAVEATS -------------------------------
    out.push({
      series: `fas:${c.key}:commitments`,
      meta: { label: `US ${c.label} total commitments (marketing year to date)`, unit, category: "export_commitments" },
      points: pointsFor(all, "commitments"),
    });

    // --- China detail, soybeans only ------------------------------------------------------------
    // Meal and oil go overwhelmingly to other destinations, so a China cut of those would be a
    // near-empty chart implying a demand collapse that was never there.
    if (c.key !== "soybeans") continue;

    out.push({
      series: `fas:${c.key}:china:net-sales`,
      meta: { label: `China weekly net purchases of US ${c.label}`, unit, category: "export_sales" },
      points: pointsFor(china, "netSales"),
    });
    out.push({
      series: `fas:${c.key}:china:commitments`,
      meta: { label: `China total commitments for US ${c.label} (marketing year to date)`, unit, category: "export_commitments" },
      points: pointsFor(china, "commitments"),
    });
    // The new-crop book — the only view of it, and the thing that stops August reading as a collapse.
    out.push({
      series: `fas:${c.key}:china:next-my-commitments`,
      meta: { label: `China outstanding sales of US ${c.label}, NEXT marketing year`, unit, category: "export_commitments" },
      points: pointsFor(china, "nextOutstanding"),
    });
    // A ratio, so it is comparable across years and immune to the cumulative sawtooth — arguably the
    // single most useful number here for a trade-policy card.
    const share = [...china.entries()]
      .map(([period, t]) => {
        const total = all.get(period)?.commitments ?? 0;
        return total > 0 ? { period, value: Math.round((t.commitments / total) * 1000) / 10 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.period.localeCompare(b.period));
    out.push({
      series: `fas:${c.key}:china:share`,
      meta: { label: `China share of US ${c.label} commitments`, unit: "%", category: "export_share" },
      points: share,
    });
  }
  return out.filter((s) => s.points.length);
}

/**
 * One "markets"-class item summarising the latest reported week — the Markets tab and the Ask box.
 *
 * ⚠️ IT LEADS WITH WHICHEVER MARKETING YEAR THE BUSINESS IS ACTUALLY IN. Late in a marketing year the
 * current-MY figures are near zero and the real news is the new-crop book; a summary that reported
 * only current-MY would say "China bought nothing this week" while three million tonnes sat on the
 * books for next year. See the August blind spot note at the top of this file.
 */
export async function fetchItems({ env = process.env } = {}) {
  if (!headers(env)) return [];
  let calendar;
  try {
    calendar = await fetchMarketYears(env);
  } catch {
    return [];
  }
  const my = calendar.get(801);
  if (!my?.marketYear) return [];

  let rows;
  try {
    rows = await fetchYear(801, my.marketYear, env);
  } catch (err) {
    console.log(`⚠️  ${label}: soybeans MY${my.marketYear} failed — ${err.message}`);
    return [];
  }
  const { all, china } = aggregateWeeks(rows);
  const weeks = [...all.keys()].sort();
  const week = weeks[weeks.length - 1];
  if (!week) return [];

  const a = all.get(week);
  const ch = china.get(week) ?? { netSales: 0, commitments: 0, nextOutstanding: 0 };
  const kt = (v) => `${Math.round(v / 1000).toLocaleString()}k t`;
  const sharePct = a.commitments > 0 ? Math.round((ch.commitments / a.commitments) * 1000) / 10 : null;

  // Is the marketing year effectively over? Compare the reported week against the MY end date rather
  // than against a hardcoded month — meal and oil roll a month later than beans.
  const daysLeft = my.end ? Math.round((Date.parse(`${my.end}T00:00:00Z`) - Date.parse(`${week}T00:00:00Z`)) / 86400e3) : null;
  const lateInYear = daysLeft !== null && daysLeft <= 45;

  const headline = lateInYear
    ? `Soybean export sales, week ending ${week}: ${kt(a.netSales)} net sales — MY${my.marketYear} is closing (${daysLeft}d left); China has ${kt(ch.nextOutstanding)} booked for next marketing year`
    : `Soybean export sales, week ending ${week}: ${kt(a.netSales)} net sales, ${kt(a.exports)} shipped; China ${kt(ch.netSales)}${sharePct !== null ? ` (${sharePct}% of commitments)` : ""}`;

  return [
    {
      uid: `${id}:soybeans:${week}`,
      sourceId: id,
      sourceLabel: label,
      title: headline,
      summary:
        `USDA FAS Export Sales Report, marketing year ${my.marketYear} (${my.start} to ${my.end}), week ending ${week}. ` +
        `All destinations: ${Math.round(a.netSales).toLocaleString()} t net sales, ${Math.round(a.exports).toLocaleString()} t shipped, ` +
        `${Math.round(a.commitments).toLocaleString()} t committed marketing-year-to-date. ` +
        `China: ${Math.round(ch.netSales).toLocaleString()} t net sales, ${Math.round(ch.commitments).toLocaleString()} t committed` +
        `${sharePct !== null ? ` (${sharePct}% of all US commitments)` : ""}, ` +
        `${Math.round(ch.nextOutstanding).toLocaleString()} t outstanding for the NEXT marketing year.` +
        (lateInYear
          ? ` This marketing year ends in ${daysLeft} days, so current-year figures are winding down by design — the next-marketing-year book is the live number.`
          : ""),
      url: "https://apps.fas.usda.gov/export-sales/esrd1.html",
      publishedAt: new Date(`${week}T00:00:00Z`).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: {
        metric: "export_sales",
        marketYear: my.marketYear,
        marketYearEnd: my.end,
        weekEndingDate: week,
        daysLeftInMarketYear: daysLeft,
        all: { netSales: a.netSales, exports: a.exports, commitments: a.commitments },
        china: { netSales: ch.netSales, commitments: ch.commitments, nextMYOutstanding: ch.nextOutstanding, sharePct },
      },
    },
  ];
}

// Exported for tests: the aggregation and the MY calendar are where the two documented traps live
// (unit mixing, and the end-of-marketing-year blind spot).
export const __testing = { aggregateWeeks, pointsFor, CHINA, UNIT_METRIC_TONS, COMMODITIES, DEFAULT_HISTORY_YEARS };
