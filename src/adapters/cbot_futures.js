// cbot_futures.js — daily CBOT settles for the soybean complex + corn, and the derived
// BOARD CRUSH MARGIN. Keyless. "markets"-class.
//
// WHY THIS EXISTS: until this adapter, the only price series in the whole system was
// `nass:us:price` — a MONTHLY state/national average published with a ~6-week lag. The signal
// board issued a bull/bear read for soybean price twice a day against a price it could only
// observe monthly, two months late, which made it impossible to score any signal against a
// subsequent price move (build-queue #2, "signals that learn"). A daily settle is the
// prerequisite for measuring whether this tool is right about anything.
//
// This is the KEYLESS INTERIM ahead of Barchart OnDemand (see barchart.js). When that key
// lands, Barchart supersedes this for the forward curve and true local basis; the series
// names here are deliberately distinct (`cbot:*` vs `barchart:*`) so both can coexist and be
// compared rather than one silently overwriting the other.
//
// SOURCE: Yahoo's chart endpoint. Keyless and stable, returns parallel timestamp/close arrays.
//   Requires *a* User-Agent (util.js always sends one; a bare request gets HTTP 429).
//   (Stooq was evaluated first and rejected: it now sits behind a JavaScript proof-of-work
//   browser check, which a zero-dep Node fetch cannot clear. Don't re-attempt it.)
//
// ⚠️ TWO ASSUMPTIONS WORTH KNOWING, because they bound how far to trust the margin series:
//   1. `ZS=F` and friends are Yahoo's FRONT-MONTH CONTINUOUS contracts, so the series carries
//      roll discontinuities at each contract change. Fine for levels, percentiles, and trend
//      (it is what "the board" informally means); NOT a substitute for a specific contract
//      month when doing precise spread arithmetic.
//   2. The three crush legs are each their own front month and are not always the same
//      delivery period (e.g. Nov beans against Dec meal/oil). That pairing is close to the
//      conventional crush spread — products trade one month behind the beans that make them —
//      but it is a convention, not an identity. Treat the margin as the board's indicative
//      processing margin, not a tradeable spread quote.

import { fetchJSON, sleep } from "../util.js";

export const id = "cbot_futures";
export const label = "CBOT futures (daily settles)";

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// 5 years of daily settles ≈ 1,250 points per leg — enough history for percentiles, seasonal
// reads across five distinct years, and the lead-lag scan, without a heavy backfill.
const RANGE = "5y";

const LEGS = [
  { key: "zs", symbol: "ZS=F", label: "CBOT soybeans (front month)", unit: "¢/bu", category: "soy_futures" },
  { key: "zm", symbol: "ZM=F", label: "CBOT soybean meal (front month)", unit: "$/ton", category: "soy_products" },
  { key: "zl", symbol: "ZL=F", label: "CBOT soybean oil (front month)", unit: "¢/lb", category: "soy_products" },
  { key: "zc", symbol: "ZC=F", label: "CBOT corn (front month)", unit: "¢/bu", category: "corn_futures" },
];

// --- Crush yield coefficients -------------------------------------------------------------
// These are NOT textbook approximations. They are the coefficients from the "Cash Margin" tab
// of the Gordon Denny US Soybean Crush workbook (the reference sheet ISA staff already read),
// so this series ties out to the number Matt sees there rather than diverging by a few cents:
//   meal  0.0221 short ton per bushel
//   oil  11.710  pounds per bushel
//   hulls 0.0018 short ton per bushel
// Validation against that sheet's 2026-07-15 board figures (meal 319.10, oil $0.729, beans
// 12.020): 319.10*0.0221 + 0.729*11.710 + 140*0.0018 - 12.020 = $3.82/bu board margin, against
// its $3.58/bu CASH margin after basis (meal -10, oil +0.02, beans +0.25). Consistent.
const MEAL_TON_PER_BU = 0.0221;
const OIL_LB_PER_BU = 11.71;
const HULLS_TON_PER_BU = 0.0018;
// Hulls have no futures market, so this leg is a static assumption, not a quote. Denny's note:
// "$130 loose, $150 pelleted" — 140 splits it. Override per-deployment via the watchlist
// (`sources.cbot_futures.hullsUsdPerTon`) without touching code. It contributes ~$0.25/bu, so
// getting it wrong shifts the level slightly and the TREND not at all.
// (A LIVE hulls price does exist — `ams:ia:hulls-loose` / `ams:ia:hulls-pellet` from AMS report
// 3511, see usda_ams.js — and the Iowa CASH crush margin there uses it. It is deliberately not
// imported here: adapters stay independent of each other's stored output, so the board margin
// remains computable from this one HTTP source alone. Iowa loose hulls were $117.86/ton on
// 2026-07-20 against this $140 default, i.e. ~4¢/bu of level difference.)
const HULLS_USD_PER_TON_DEFAULT = 140;

/** Fetch one symbol's daily closes as [{ period: "YYYY-MM-DD", value }], oldest first. */
async function history(symbol) {
  const d = await fetchJSON(`${BASE}/${encodeURIComponent(symbol)}?interval=1d&range=${RANGE}`);
  const chart = d?.chart;
  // Yahoo reports a bad symbol in-band as chart.error with a 200 — surface it as a throw so
  // the caller's per-leg catch treats it like any other fetch failure.
  if (chart?.error) throw new Error(`Yahoo chart error for ${symbol}: ${chart.error.description ?? chart.error.code}`);
  const r = chart?.result?.[0];
  if (!r) throw new Error(`Yahoo returned no result for ${symbol}`);
  const stamps = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const out = [];
  for (let i = 0; i < stamps.length; i++) {
    const v = closes[i];
    // Holidays and half-days come back as nulls interleaved with real settles — drop them
    // rather than carrying the prior value forward, which would fake trading activity.
    if (v == null || !Number.isFinite(Number(v))) continue;
    out.push({ period: new Date(stamps[i] * 1000).toISOString().slice(0, 10), value: Number(v) });
  }
  return out;
}

/**
 * Board crush margin in $/bu, per date, from date-aligned meal/oil/bean settles.
 * Only dates present in ALL THREE legs produce a point — a margin computed from a stale leg
 * would be a fabricated number, and the gap is more honest than the interpolation.
 */
function boardCrushMargin(byKey, hullsUsdPerTon) {
  const beans = new Map((byKey.zs ?? []).map((p) => [p.period, p.value]));
  const meal = new Map((byKey.zm ?? []).map((p) => [p.period, p.value]));
  const oil = new Map((byKey.zl ?? []).map((p) => [p.period, p.value]));
  const hulls = hullsUsdPerTon * HULLS_TON_PER_BU;
  const out = [];
  for (const [period, beanCents] of beans) {
    const m = meal.get(period);
    const o = oil.get(period);
    if (m == null || o == null) continue;
    // meal quotes $/short ton; oil quotes ¢/lb; beans quote ¢/bu → normalize all to $/bu.
    const gross = m * MEAL_TON_PER_BU + (o / 100) * OIL_LB_PER_BU + hulls;
    out.push({ period, value: Math.round((gross - beanCents / 100) * 1000) / 1000 });
  }
  out.sort((a, b) => (a.period < b.period ? -1 : 1));
  return out;
}

/** Soybean:corn price ratio from the daily board — the acreage-battle read, at daily cadence. */
function soyCornRatio(byKey) {
  const corn = new Map((byKey.zc ?? []).map((p) => [p.period, p.value]));
  const out = [];
  for (const p of byKey.zs ?? []) {
    const c = corn.get(p.period);
    if (c == null || !c) continue;
    out.push({ period: p.period, value: Math.round((p.value / c) * 1000) / 1000 });
  }
  return out;
}

// Standalone, all four legs return 6/6 in well under a second. Inside refreshMarketSeries — six
// adapters fetching at once — individual legs intermittently drop (one run landed 3 of 6), which
// silently costs the derived margin and ratio since those need every leg present. One retry with a
// short backoff clears it; a stagger between legs keeps a free endpoint from seeing four
// back-to-back requests. Cheap insurance against a partly-populated refresh.
const LEG_RETRIES = 1;
const LEG_RETRY_BACKOFF_MS = 900;
const LEG_STAGGER_MS = 150;

/** Fetch every leg, fail-soft per leg (after retries). Returns { zs: [...], zm: [...], ... }. */
async function fetchLegs() {
  const byKey = {};
  for (const leg of LEGS) {
    for (let attempt = 0; attempt <= LEG_RETRIES; attempt++) {
      try {
        const pts = await history(leg.symbol);
        if (pts.length) byKey[leg.key] = pts;
        break;
      } catch (err) {
        if (attempt < LEG_RETRIES) {
          await sleep(LEG_RETRY_BACKOFF_MS);
          continue;
        }
        // One dead leg shouldn't cost the others; the margin simply won't compute without all three.
        console.log(`⚠️  ${label}: ${leg.symbol} failed after ${LEG_RETRIES + 1} attempts — ${err.message}`);
      }
    }
    await sleep(LEG_STAGGER_MS);
  }
  return byKey;
}

/** Latest board snapshot as a single markets-class item (for the Sources/News surfaces). */
export async function fetchItems() {
  const byKey = await fetchLegs();
  const beans = byKey.zs;
  if (!beans?.length) return [];
  const last = beans[beans.length - 1];
  const margin = boardCrushMargin(byKey, HULLS_USD_PER_TON_DEFAULT);
  const lastMargin = margin.length ? margin[margin.length - 1] : null;
  const parts = LEGS.filter((l) => byKey[l.key]?.length).map((l) => {
    const p = byKey[l.key][byKey[l.key].length - 1];
    return `${l.label.replace(" (front month)", "")} ${p.value} ${l.unit}`;
  });
  return [
    {
      uid: `${id}:board:${last.period}`,
      sourceId: id,
      sourceLabel: label,
      title: `CBOT board ${last.period}: soybeans ${last.value}¢/bu${lastMargin ? `, board crush margin $${lastMargin.value.toFixed(2)}/bu` : ""}`,
      summary: `${parts.join(" · ")}. Board crush margin uses the Gordon Denny workbook yields (meal 0.0221 t/bu, oil 11.71 lb/bu, hulls 0.0018 t/bu).`,
      url: "https://www.cmegroup.com/markets/agriculture/oilseeds/soybean.html",
      publishedAt: new Date(`${last.period}T21:00:00Z`).toISOString(),
      jurisdiction: "US",
      docType: "data",
      raw: {
        period: last.period,
        legs: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v[v.length - 1].value])),
        boardCrushMargin: lastMargin?.value ?? null,
      },
    },
  ];
}

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. */
export async function fetchSeries({ sourceConfig = {} } = {}) {
  const byKey = await fetchLegs();
  const out = [];
  for (const leg of LEGS) {
    const pts = byKey[leg.key];
    if (pts?.length) {
      out.push({ series: `cbot:${leg.key}:front`, meta: { label: leg.label, unit: leg.unit, category: leg.category }, points: pts });
    }
  }
  const hullsUsdPerTon = Number(sourceConfig.hullsUsdPerTon) || HULLS_USD_PER_TON_DEFAULT;
  const margin = boardCrushMargin(byKey, hullsUsdPerTon);
  if (margin.length) {
    out.push({
      series: "cbot:crush:board-margin",
      meta: { label: "Board crush margin", unit: "$/bu", category: "soy_crush_margin" },
      points: margin,
    });
  }
  const ratio = soyCornRatio(byKey);
  if (ratio.length) {
    out.push({
      series: "cbot:soy-corn:ratio",
      meta: { label: "Soybean:corn futures ratio", unit: "ratio", category: "soy_corn_ratio" },
      points: ratio,
    });
  }
  return out;
}

// Exported for the crush-utilization signal, which cross-checks physical utilization against
// the margin that should be driving it, and for tests.
export const CRUSH_YIELDS = { MEAL_TON_PER_BU, OIL_LB_PER_BU, HULLS_TON_PER_BU, HULLS_USD_PER_TON_DEFAULT };
export const __test = { boardCrushMargin, soyCornRatio };
