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

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

// 1 bushel of soybeans = 60 lb = 0.03 short tons. NASS publishes crush as tons/mo (verified against
// the stored series meta), so tons ÷ 0.03 = bushels.
const TONS_PER_BU = 0.03;

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
  return {
    id: "crush_utilization",
    name: "Crush Utilization",
    direction: u.direction,
    value: Math.round(u.utilization * 1000) / 10,
    label: `${pct1(u.utilization)} (${u.z >= 0 ? "+" : ""}${u.z.toFixed(1)}σ)`,
    detail: `U.S. soybean crush at ${basisText} in ${mon}, ${vs}.${bench && u.basis === "nameplate" ? ` For scale, the industry's ~${pct1(benchRaw)}-of-nameplate working assumption is ~${pct1(bench)} restated per calendar day (it assumes ~${opDays} operating days), and crush is seasonally lightest in late spring/summer.` : ""} ${read}${divergence}`,
  };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m) => MON[(m || 1) - 1];

/** Narrative for the Analyst / Ask prompts — the crush chain, cause through effect. */
export function crushText() {
  const s = crushSignal();
  if (!s) return "";
  const lines = [`- ${s.name}: ${s.direction.toUpperCase()} — ${s.detail}`];
  const cap = loadCapacity();
  if (cap) {
    const ia = (cap.currentPlants ?? []).filter((p) => p.state === "IA").reduce((a, p) => a + p.buPerDay, 0);
    if (ia) {
      lines.push(
        `- Iowa holds ${(ia / 1e6).toFixed(2)}M bu/day of the ${(cap.currentTotalBuPerDay / 1e6).toFixed(2)}M bu/day U.S. installed base (${((ia / cap.currentTotalBuPerDay) * 100).toFixed(0)}%), the largest of any state — so national crush economics land disproportionately on Iowa basis.`
      );
    }
  }
  return lines.join("\n");
}

export const __test = { daysInMonth, capacityAt, utilizationSeries, crushUtilization, marginPercentile };
