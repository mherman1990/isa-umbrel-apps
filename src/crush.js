// crush.js — the crush-demand engine: capacity utilization, not crush volume.
//
// WHY THIS REPLACES THE OLD SIGNAL. The previous `crushDemand` scorer ranked U.S. monthly crush
// VOLUME against its own full history and fired bullish above the 80th percentile. Crush capacity
// grew ~1.06 million bu/day between March 2023 and May 2026 (the renewable-diesel buildout — 12% of
// today's nameplate), so volume ratchets to a new record almost every year regardless of whether
// demand is actually pulling beans through the plants. Measured against the stored series, the last
// eight monthly prints ranked 100th, 99th, 99th, 98th, 95th, 99th, 95th and 92nd percentile — so the
// board printed "BULLISH — record-strong domestic demand" for eight consecutive months while crush
// itself FELL about 10% (7.09M → 6.39M tons/mo). A signal that reads bullish while its own series
// declines is not merely noisy, it is anti-informative.
//
// The fix is the ratio a processor actually cares about: how hard is the installed base running?
// Rising volume on a much larger plant base with FALLING utilization is a bearish read — margins are
// not good enough to keep plants at rate — and that is exactly the case the old signal inverted.
//
// Utilization has its own denominator trap, so both are handled explicitly:
//   - A new plant coming online dents utilization mechanically while it ramps. Comparing
//     like-month-to-like-month (May against prior Mays) rather than month-to-month absorbs both
//     that and the strong seasonal pattern in crush (heavy post-harvest, light in summer downtime).
//   - Capacity is time-varying, so `capacityAt()` walks the additions list backward from today's
//     nameplate instead of applying one present-day number to six years of history.
//
// Cause vs effect: utilization is the EFFECT. Crush margin is the cause, and it now exists as a
// series (board from cbot_futures, Iowa cash from usda_ams). When the two disagree — fat margin,
// soft utilization — that divergence is the interesting read, so it is surfaced in the detail text
// rather than being averaged away.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "./store.js";
import { CRUSH_YIELDS } from "./adapters/cbot_futures.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

// 1 bushel of soybeans = 60 lb = 0.03 short tons. NASS publishes crush as tons/mo (verified against
// the stored series meta), so tons ÷ 0.03 = bushels.
const TONS_PER_BU = 0.03;

// crush_capacity.json is hand-maintained — reissued from the Denny workbook only a few times a year — so
// it can silently go stale, and a stale table UNDERSTATES nameplate, which OVERSTATES utilization: the
// exact inversion that retired the old volume-percentile scorer (a soft market reading bullish). The old
// code degraded gracefully only when the table was MISSING; a present-but-stale table was trusted in
// silence. capacityStaleness() below makes that failure loud instead. Warn once the table hasn't been
// refreshed in this many months (capacity changes ~quarterly, so ~9 months has likely missed additions):
const STALE_AGE_MONTHS = 9;
const MS_PER_MONTH = 30.44 * 864e5;
let _staleWarned = false; // console-warn once per process, not on every scorer call

let _cap = null;
/** The shipped capacity table, or null when absent/unreadable (the proxy path then takes over). */
export function loadCapacity() {
  if (_cap !== null) return _cap || null;
  try {
    _cap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "crush_capacity.json"), "utf8"));
  } catch {
    _cap = false; // remember the miss so we don't re-read a missing file every call
    return null;
  }
  return _cap;
}

/** Days in the calendar month of a "YYYY-MM" or "YYYY-MM-DD" period. */
function daysInMonth(period) {
  const [y, m] = String(period).split("-").map(Number);
  if (!y || !m) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Installed nameplate (bu/day) as of `period`, walking today's total backward by removing every
 * addition that had not yet come online. Closures are NOT added back — their capacities are not
 * reliably parseable from the source workbook (see _closuresNote in crush_capacity.json), which
 * makes historical capacity a slight under-estimate and therefore historical utilization a slight
 * over-estimate. That errs in the conservative direction: it understates how soft current
 * utilization looks against history, rather than manufacturing a bearish signal.
 */
export function capacityAt(period) {
  const cap = loadCapacity();
  if (!cap) return null;
  const asOf = `${period}`.length === 7 ? `${period}-15` : String(period);
  let total = cap.currentTotalBuPerDay;
  for (const a of cap.capacityAdditions ?? []) {
    if (!a.effective || !a.buPerDay) continue;
    // Year-only effective dates (pre-2023 additions) are stamped Jan 1; treating them as
    // already-online for any date in that year or later is right for our comparison window.
    if (a.effective > asOf) total -= a.buPerDay;
  }
  return total > 0 ? total : null;
}

/**
 * Monthly crush utilization from the stored NASS series.
 * @returns {{period, month, buPerDay, capacity, utilization, basis}[]} oldest first, or []
 */
export function utilizationSeries() {
  let pts = [];
  try {
    pts = store.getSeries("nass:us:crush");
  } catch {
    return [];
  }
  if (pts.length < 13) return [];

  // Normalize to a DAILY rate first. A 28-day February against a 31-day March is a ~10% swing that
  // is pure calendar, and the raw monthly totals carry it straight into any comparison.
  const rates = pts.map((p) => ({
    period: p.period,
    month: Number(String(p.period).slice(5, 7)) || 0,
    buPerDay: p.value / TONS_PER_BU / daysInMonth(p.period),
  }));

  const out = [];
  for (let i = 0; i < rates.length; i++) {
    const r = rates[i];
    const nameplate = capacityAt(r.period);
    if (nameplate) {
      out.push({ ...r, capacity: nameplate, utilization: r.buPerDay / nameplate, basis: "nameplate" });
      continue;
    }
    // FALLBACK when the capacity table is missing or doesn't reach this period: rate against the
    // best daily rate achieved in the trailing 12 months — "are we running as hard as we recently
    // proved we can?". Self-updating as capacity comes online, needs no external data, and is
    // directionally the same measure; it just can't state a true % of nameplate.
    if (i < 11) continue;
    const best = Math.max(...rates.slice(i - 11, i + 1).map((x) => x.buPerDay));
    if (best > 0) out.push({ ...r, capacity: best, utilization: r.buPerDay / best, basis: "trailing-max" });
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const stdev = (a, mu) => (a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - mu) ** 2, 0) / a.length) : null);

/**
 * The crush-demand read. Scores the latest utilization against the SAME CALENDAR MONTH in prior
 * years — the only comparison that survives both the seasonal pattern and the capacity buildout.
 * Needs at least three prior same-month observations; below that it returns null rather than
 * pretending a two-point "norm" means something (the same mistake the seasonal guard in store.js
 * now prevents elsewhere).
 * @returns {{utilization, z, latest, priorMean, priorYears, basis, direction, marginDivergence}|null}
 */
export function crushUtilization() {
  const series = utilizationSeries();
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const prior = series.slice(0, -1).filter((r) => r.month === latest.month).map((r) => r.utilization);
  if (prior.length < 3) return null;
  const mu = mean(prior);
  const sd = stdev(prior, mu);
  if (!sd) return null;
  const z = (latest.utilization - mu) / sd;

  // Strong utilization = the installed base is pulling beans through = supportive of price.
  // Soft utilization = plants idling despite capacity = the demand pull is weaker than it looks.
  const direction = z >= 0.75 ? "bullish" : z <= -0.75 ? "bearish" : "neutral";

  // Cause-side cross-check. A fat margin with soft utilization is a genuine puzzle worth naming
  // (capacity still ramping, downtime, or bean availability) rather than smoothing over.
  let marginDivergence = null;
  const margin = marginPercentile();
  if (margin != null) {
    if (margin >= 70 && z <= -0.5) marginDivergence = "high-margin-soft-utilization";
    else if (margin <= 30 && z >= 0.5) marginDivergence = "low-margin-firm-utilization";
  }
  return { utilization: latest.utilization, z, latest, priorMean: mu, priorYears: prior.length, basis: latest.basis, direction, marginDivergence, marginPctile: margin };
}

/** Percentile of the newest crush-margin reading within its own history, preferring Iowa cash. */
function marginPercentile() {
  for (const name of ["ams:ia:cash-crush-margin", "cbot:crush:board-margin"]) {
    let pts = [];
    try {
      pts = store.getSeries(name);
    } catch {
      continue;
    }
    if (pts.length < 24) continue;
    const last = pts[pts.length - 1].value;
    return Math.round((pts.filter((p) => p.value <= last).length / pts.length) * 100);
  }
  return null;
}

const pct1 = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * Is the hand-maintained capacity table stale? Two independent tells, either of which fires:
 *   1. AGE — asOf older than STALE_AGE_MONTHS. Capacity is added a few times a year, so a table not
 *      refreshed in ~9 months has probably missed a plant, which understates nameplate.
 *   2. EMPIRICAL — observed crush reached the workbook's own realistic-max daily rate within the last
 *      six months. Utilization here is per CALENDAR day, so hitting ~91% of nameplate every day of a
 *      month is physically implausible (plants take downtime) UNLESS the nameplate is understated — a
 *      basis-independent, self-checking tell that catches staleness even inside the age window.
 * Pure given its inputs (cap + series + now injectable for tests). Returns the reasons so the caller
 * can surface them; an absent table is NOT "stale" (that path already falls back to trailing-max).
 * @returns {{present:boolean, stale:boolean, ageMonths:number|null, asOf:string|null, reasons:string[]}}
 */
export function capacityStaleness({ now = new Date(), cap = loadCapacity(), series } = {}) {
  if (!cap) return { present: false, stale: false, ageMonths: null, asOf: null, reasons: [] };
  const reasons = [];
  const asOfMs = Date.parse(cap.asOf);
  const ageMonths = Number.isFinite(asOfMs) ? Math.round((now.getTime() - asOfMs) / MS_PER_MONTH) : null;
  if (ageMonths == null) {
    reasons.push("the capacity table has no readable asOf date, so its freshness can't be checked");
  } else if (ageMonths >= STALE_AGE_MONTHS) {
    reasons.push(
      `the capacity table was last refreshed ${ageMonths} months ago (asOf ${cap.asOf}); crush capacity is added a few times a year, so it likely understates today's nameplate and therefore OVERSTATES utilization`
    );
  }
  const ceiling = cap.benchmarks?.realisticMax ?? 0.91;
  const recent = (series ?? utilizationSeries()).filter((r) => r.basis === "nameplate").slice(-6);
  const over = recent.filter((r) => r.utilization >= ceiling);
  if (over.length) {
    const worst = Math.max(...over.map((r) => r.utilization));
    reasons.push(
      `observed crush reached ${pct1(worst)} of nameplate within the last 6 months — at or above the ${pct1(ceiling)} realistic-max daily ceiling, which is physically implausible per calendar day unless the table is missing a plant`
    );
  }
  return { present: true, stale: reasons.length > 0, ageMonths, asOf: cap.asOf, reasons };
}

/** Signal-board scorer. Shape matches the other scorers in signals.js. */
export function crushSignal() {
  const u = crushUtilization();
  if (!u) return null;
  const cap = loadCapacity();
  const mon = String(u.latest.period).slice(0, 7);
  // ⚠️ BASIS MISMATCH, do not compare these two numbers raw. Utilization here is per CALENDAR day
  // (NASS monthly crush ÷ days in month), while the workbook's 88% assumes ~350 OPERATING days a
  // year. Restate the benchmark on a calendar basis — 88% × 350/365 ≈ 84% — or the signal text reads
  // as though every month is running 8 points below industry normal when it isn't.
  const opDays = cap?.benchmarks?.operatingDaysPerYear ?? 350;
  const benchRaw = cap?.benchmarks?.workingUtilization;
  const bench = benchRaw ? benchRaw * (opDays / 365) : null;
  const basisText =
    u.basis === "nameplate"
      ? `${pct1(u.utilization)} of the ${(u.latest.capacity / 1e6).toFixed(2)}M bu/day installed base`
      : `${pct1(u.utilization)} of its best daily rate in the trailing year (capacity table unavailable, so this is a relative read)`;
  const vs = `${u.z >= 0 ? "+" : ""}${u.z.toFixed(2)}σ against ${u.priorYears} prior ${monthName(u.latest.month)}s (which averaged ${pct1(u.priorMean)})`;
  const read =
    u.direction === "bullish"
      ? "Plants running harder than normal for the season — the installed base is pulling beans through, which supports price and basis."
      : u.direction === "bearish"
        ? "Plants running softer than normal for the season. Crush VOLUME can still be near a record on a bigger plant base while utilization slips — it is utilization that says whether demand is actually pulling beans."
        : "Utilization about normal for the season.";
  const divergence =
    u.marginDivergence === "high-margin-soft-utilization"
      ? ` ⚠️ Crush margin is in the top third of its range (${u.marginPctile}th pctile) while utilization is soft — margins say run hard and plants are not, which points at a physical constraint (new capacity still ramping, downtime, or bean availability) rather than economics.`
      : u.marginDivergence === "low-margin-firm-utilization"
        ? ` ⚠️ Utilization is firm while crush margin sits in the bottom third (${u.marginPctile}th pctile) — plants running through thin margins, which is not usually sustained.`
        : "";
  // Capacity-staleness guard: a stale hand-maintained table overstates utilization (see
  // capacityStaleness). Fail LOUD — flag it in the signal the analyst/LLM reads, and once in the logs —
  // rather than presenting a confidently-wrong nameplate %. Only applies to the nameplate basis; the
  // trailing-max fallback is already a self-updating relative read.
  const stale = u.basis === "nameplate" ? capacityStaleness() : { stale: false, reasons: [] };
  if (stale.stale && !_staleWarned) {
    console.warn(`⚠️  crush_capacity.json looks stale: ${stale.reasons.join("; ")}. Refresh it from the Denny workbook.`);
    _staleWarned = true;
  }
  const staleWarn = stale.stale
    ? ` ⚠️ CAPACITY TABLE MAY BE STALE — ${stale.reasons.join("; ")}. Read the utilization % as a likely OVER-estimate until crush_capacity.json is refreshed.`
    : "";
  return {
    id: "crush_utilization",
    name: "Crush Utilization",
    direction: u.direction,
    value: Math.round(u.utilization * 1000) / 10,
    label: `${pct1(u.utilization)} (${u.z >= 0 ? "+" : ""}${u.z.toFixed(1)}σ)`,
    detail: `U.S. soybean crush at ${basisText} in ${mon}, ${vs}.${bench && u.basis === "nameplate" ? ` For scale, the industry's ~${pct1(benchRaw)}-of-nameplate working assumption is ~${pct1(bench)} restated per calendar day (it assumes ~${opDays} operating days), and crush is seasonally lightest in late spring/summer.` : ""} ${read}${divergence}${staleWarn}`,
  };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m) => MON[(m || 1) - 1];

/** Narrative for the Analyst / Ask prompts — the crush chain, cause through effect. */
export function crushText() {
  const s = crushSignal();
  const lines = s ? [`- ${s.name}: ${s.direction.toUpperCase()} — ${s.detail}`] : [];
  const cap = loadCapacity();
  if (s && cap) {
    const ia = (cap.currentPlants ?? []).filter((p) => p.state === "IA").reduce((a, p) => a + p.buPerDay, 0);
    if (ia) {
      lines.push(
        `- Iowa holds ${(ia / 1e6).toFixed(2)}M bu/day of the ${(cap.currentTotalBuPerDay / 1e6).toFixed(2)}M bu/day U.S. installed base (${((ia / cap.currentTotalBuPerDay) * 100).toFixed(0)}%), the largest of any state — so national crush economics land disproportionately on Iowa basis.`
      );
    }
  }
  // The composition of crush value — the utilization read above says HOW HARD plants run; this says
  // WHICH product is paying for it, and so how much of bean demand rests on the policy-set oil leg.
  const share = oilShareText();
  if (share) lines.push(share);
  return lines.join("\n");
}

// --- Oil / meal share of crush product value -------------------------------------------------
// The industry "oil share": oil's share of the (oil + meal) value a crushed bushel yields, at the same
// workbook yields as both margin series (cbot_futures.js CRUSH_YIELDS). Meal share is its complement.
// Hulls are left out of the denominator on purpose — they are ~2% of product value, one leg is a static
// assumption on the board side, and the conventional ratio is oil vs. meal so the two sum to 100.
//
// Derived at read time from the stored product legs rather than stored as its own series: the legs are
// already persisted (and backfilled), so the share has full history the moment this ships, and there is
// no second copy to drift from the margin it explains. Only dates carrying BOTH legs produce a point.
const { MEAL_TON_PER_BU: SHARE_MEAL_TON_PER_BU, OIL_LB_PER_BU: SHARE_OIL_LB_PER_BU } = CRUSH_YIELDS;

/** Pure: [{period, value}] oil share (%) from date-aligned meal ($/ton) and oil (¢/lb) points. */
function oilSharePoints(mealPts, oilPts) {
  const oil = new Map(oilPts.map((p) => [p.period, p.value]));
  const out = [];
  for (const m of mealPts) {
    const o = oil.get(m.period);
    if (o == null || !(o > 0) || !(m.value > 0)) continue;
    const oilVal = (o / 100) * SHARE_OIL_LB_PER_BU;
    const mealVal = m.value * SHARE_MEAL_TON_PER_BU;
    out.push({ period: m.period, value: Math.round((oilVal / (oilVal + mealVal)) * 10000) / 100 });
  }
  return out.sort((a, b) => (a.period < b.period ? -1 : 1));
}

const SHARE_SOURCES = [
  { key: "board", label: "Board", meal: "cbot:zm:front", oil: "cbot:zl:front" },
  { key: "cash", label: "Iowa cash", meal: "ams:ia:meal", oil: "ams:ia:oil" },
];

/**
 * Oil and meal share of crush product value, board and Iowa cash, for the Markets chart + CSV.
 * @returns {{label, unit, points}[]} oil/meal pairs per source that has both legs stored; [] if none
 */
export function productShareSeries() {
  const out = [];
  for (const src of SHARE_SOURCES) {
    let oil;
    try {
      oil = oilSharePoints(store.getSeries(src.meal), store.getSeries(src.oil));
    } catch {
      continue;
    }
    if (!oil.length) continue;
    out.push({ label: `${src.label} oil share`, unit: "%", points: oil });
    out.push({ label: `${src.label} meal share`, unit: "%", points: oil.map((p) => ({ period: p.period, value: Math.round((100 - p.value) * 100) / 100 })) });
  }
  return out;
}

// --- Oil-share signal ----------------------------------------------------------------------------
// The share on its own is a COMPOSITION read, and the same move means opposite things depending on
// which leg caused it: oil share rising because oil value climbed is the renewable-diesel pull carrying
// the crush (supportive of bean demand), but oil share rising because meal value collapsed is a meal
// glut (bearish). So direction comes from the leg that DROVE the month's move — whichever product
// value changed more, in percent — not from the share's level or sign. The level (percentile) rides in
// the detail as the policy-exposure read: the higher it is, the more crush economics hang on RVO/45Z.
// Scored from the daily BOARD legs (5y of settles); Iowa cash is weekly and too short to rank.
const SHARE_WINDOW_DAYS = 30; // compare to ~one month back
const SHARE_MOVE_PTS = 1.5; // share move (pts) below which the composition reads as steady
const SHARE_FRESH_DAYS = 10; // a board point older than this is a dead feed, not a quiet market

/**
 * Pure scorer over date-aligned board legs. `now` injectable for tests.
 * @returns {{share, prevShare, change, pctile, oilChgPct, mealChgPct, driver, direction, latest, prev, trail, count, firstPeriod, p10, p90}|null}
 */
/** Date-aligned per-bushel oil/meal values + oil share (%), oldest first. */
function shareRows(mealPts, oilPts) {
  const oil = new Map(oilPts.map((p) => [p.period, p.value]));
  const rows = [];
  for (const m of mealPts) {
    const o = oil.get(m.period);
    if (o == null || !(o > 0) || !(m.value > 0)) continue;
    const oilVal = (o / 100) * SHARE_OIL_LB_PER_BU;
    const mealVal = m.value * SHARE_MEAL_TON_PER_BU;
    rows.push({ period: m.period, oilVal, mealVal, share: (oilVal / (oilVal + mealVal)) * 100 });
  }
  return rows.sort((a, b) => (a.period < b.period ? -1 : 1));
}

/** The last row on or before `daysBack` calendar days before the latest row, or null. */
function rowDaysBack(rows, daysBack) {
  const latestMs = Date.parse(`${rows[rows.length - 1].period}T00:00:00Z`);
  const cutoff = new Date(latestMs - daysBack * 864e5).toISOString().slice(0, 10);
  let hit = null;
  for (const r of rows) {
    if (r.period > cutoff) break;
    hit = r;
  }
  return hit;
}

function scoreOilShare(mealPts, oilPts, now = new Date()) {
  const rows = shareRows(mealPts, oilPts);
  if (rows.length < 60) return null; // too little history to rank or to have a month-back point
  const latest = rows[rows.length - 1];
  const latestMs = Date.parse(`${latest.period}T00:00:00Z`);
  if (now.getTime() - latestMs > SHARE_FRESH_DAYS * 864e5) return null;
  const prev = rowDaysBack(rows, SHARE_WINDOW_DAYS);
  if (!prev) return null;
  const change = latest.share - prev.share;
  const oilChgPct = ((latest.oilVal - prev.oilVal) / prev.oilVal) * 100;
  const mealChgPct = ((latest.mealVal - prev.mealVal) / prev.mealVal) * 100;
  const driver = Math.abs(oilChgPct) >= Math.abs(mealChgPct) ? "oil" : "meal";
  const driverChg = driver === "oil" ? oilChgPct : mealChgPct;
  const direction = Math.abs(change) < SHARE_MOVE_PTS ? "neutral" : driverChg > 0 ? "bullish" : "bearish";
  const shares = rows.map((r) => r.share);
  const sorted = [...shares].sort((a, b) => a - b);
  const q = (f) => {
    const pos = (sorted.length - 1) * f, base = Math.floor(pos), rest = pos - base;
    return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
  };
  const pctile = Math.round((shares.filter((v) => v <= latest.share).length / shares.length) * 100);
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    share: latest.share, prevShare: prev.share, change, pctile, oilChgPct, mealChgPct, driver, direction,
    latest: latest.period, prev: prev.period,
    trail: rows.slice(-24 * 5).filter((_, i, a) => (a.length - 1 - i) % 5 === 0).map((r) => ({ period: r.period, value: r2(r.share) })), // ~weekly, last ~6 months
    count: rows.length, firstPeriod: rows[0].period, p10: q(0.1), p90: q(0.9),
  };
}

/** Signal-board scorer for the oil share of crush value. Shape matches the other scorers. */
export function oilShareSignal() {
  let s;
  try {
    s = scoreOilShare(store.getSeries("cbot:zm:front"), store.getSeries("cbot:zl:front"));
  } catch {
    return null;
  }
  if (!s) return null;
  const ord = (n) => { const x = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${x[(v - 20) % 10] || x[v] || x[0]}`; };
  const sg = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  const move = `${s.change >= 0 ? "▲" : "▼"}${Math.abs(s.change).toFixed(1)}pts since ${s.prev}`;
  const legs = `oil value ${sg(s.oilChgPct)}%/bu vs. meal ${sg(s.mealChgPct)}%/bu`;
  const read =
    s.direction === "neutral"
      ? "Crush composition roughly steady over the month."
      : s.driver === "oil"
        ? s.oilChgPct > 0
          ? "Oil strength is driving the move — the renewable-diesel pull carrying the crush, which supports domestic bean demand."
          : "Oil weakness is driving the move — the biofuel leg of the margin is softening, which erodes the crush pull on beans."
        : s.mealChgPct > 0
          ? "Meal strength is driving the move — feed/export demand for meal firming, which supports the crush."
          : "Meal weakness is driving the move — a meal glut, not oil strength, so the higher oil share is not a demand signal.";
  const exposure =
    s.pctile >= 80
      ? ` At the ${ord(s.pctile)} percentile of its range, crush economics lean unusually hard on the policy-driven oil leg (RVO/45Z) — that is where the margin's risk sits.`
      : s.pctile <= 20
        ? ` At the ${ord(s.pctile)} percentile of its range, meal is carrying an unusually large share of crush value.`
        : "";
  return {
    id: "oil_share",
    name: "Oil Share of Crush",
    direction: s.direction,
    value: Math.round(s.share * 100) / 100,
    label: `${s.share.toFixed(1)}% oil (${sg(s.change)}pts)`,
    detail: `Soybean oil is ${s.share.toFixed(1)}% of board crush product value (${s.latest}), ${move}, driven by ${s.driver} (${legs}). ${read}${exposure}`,
    // The share is derived at read time (no stored series), so the card back gets its trail + rows here.
    spark: { label: "Board oil share of crush value", unit: "%", points: s.trail, count: s.count, firstPeriod: s.firstPeriod, p10: s.p10, p90: s.p90 },
    backRows: [
      ["Now", `${s.share.toFixed(1)}% · ${ord(s.pctile)} pctile`],
      ["1-month move", `${sg(s.change)}pts`],
      ["Driver", `${s.driver} (${sg(s.driver === "oil" ? s.oilChgPct : s.mealChgPct)}%/bu)`],
      ["Normal range", `${s.p10.toFixed(1)}–${s.p90.toFixed(1)}%`],
    ],
  };
}

/**
 * Oil-share context for the Analyst Note / Ask crush block: level + percentile, the 1/3/12-month
 * trajectory (the signal card only sees one month), the 1-month driver, Iowa cash vs. board, and how
 * to read it. Legs injectable for tests; defaults read the store. "" when the board read isn't live.
 */
export function oilShareText({ now = new Date(), board, cash } = {}) {
  const get = (name) => {
    try {
      return store.getSeries(name);
    } catch {
      return [];
    }
  };
  const b = board ?? { meal: get("cbot:zm:front"), oil: get("cbot:zl:front") };
  const s = scoreOilShare(b.meal, b.oil, now);
  if (!s) return "";
  const rows = shareRows(b.meal, b.oil);
  const ord = (n) => { const x = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${x[(v - 20) % 10] || x[v] || x[0]}`; };
  const sg = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
  const moves = [["1M", 30], ["3M", 91], ["12M", 365]]
    .map(([k, d]) => {
      const r = rowDaysBack(rows, d);
      return r ? `${k} ${sg(s.share - r.share)}pts (from ${r.share.toFixed(1)}% on ${r.period})` : null;
    })
    .filter(Boolean);
  const lines = [
    `- Oil share of crush value (BOARD, oil ÷ (oil+meal) per bu at workbook yields; series: cbot:zl:front vs. cbot:zm:front): ${s.share.toFixed(1)}% on ${s.latest}, ${ord(s.pctile)} percentile of ${s.count} daily points since ${s.firstPeriod} (10th–90th pctile ${s.p10.toFixed(1)}–${s.p90.toFixed(1)}%). Moves: ${moves.join("; ")}. 1-month driver: ${s.driver} (oil value ${sg(s.oilChgPct)}%/bu, meal ${sg(s.mealChgPct)}%/bu).`,
  ];
  // Iowa cash (weekly AMS 3511) — the share plants actually face. Only quoted when recent enough to
  // compare to the board, and against the board point nearest-before it so the gap isn't a date skew.
  const c = cash ?? { meal: get("ams:ia:meal"), oil: get("ams:ia:oil") };
  const cRows = shareRows(c.meal, c.oil);
  const cLast = cRows[cRows.length - 1];
  if (cLast && now.getTime() - Date.parse(`${cLast.period}T00:00:00Z`) <= 21 * 864e5) {
    const bAt = rows.filter((r) => r.period <= cLast.period).pop();
    const gap = bAt ? ` (${sg(cLast.share - bAt.share)}pts vs. board on ${bAt.period})` : "";
    lines.push(`- Iowa CASH oil share (series: ams:ia:oil vs. ams:ia:meal): ${cLast.share.toFixed(1)}% on ${cLast.period}${gap}.`);
  }
  lines.push(
    "- Reading oil share: it is COMPOSITION, not margin. Rising on oil strength = the renewable-diesel pull carrying the crush; rising because meal fell = a meal glut, not demand. The higher the share, the more of crush value — and so of the domestic bid for beans — rests on the policy-set oil leg (RVO volumes, SREs, 45Z), so size policy risk to it; meal is then the byproduct, and meal export competitiveness the release valve."
  );
  return lines.join("\n");
}

export const __test = { daysInMonth, capacityAt, utilizationSeries, crushUtilization, marginPercentile, capacityStaleness, oilSharePoints, scoreOilShare, shareRows, rowDaysBack };
