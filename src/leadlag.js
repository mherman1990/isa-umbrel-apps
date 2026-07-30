// leadlag.js — which stored series actually LEAD the soybean price, and by how long.
//
// Everything marketSnapshot reports is contemporaneous: level, change, YoY, percentile, seasonal.
// None of it says "when this moves, price tends to follow N days later" — which is the mechanical
// content of the question "where is the market heading". This module measures it instead of assuming
// it, so the Analyst prompt can reason with observed lead times rather than folk ones.
//
// FORMULATION. For each series X and each candidate lag L (in days), pair every observation of X
// with the price change over the FOLLOWING L days:
//     ΔX at date d   ↔   P(d + L) − P(d)
// then take the Pearson correlation. This is deliberately predictive rather than the textbook
// symmetric cross-correlation: a contemporaneous correlation between crush margin and price tells
// you they co-move, which is useless for positioning attention.
//
// ⚠️⚠️ THE MULTIPLE-COMPARISONS PROBLEM IS THE WHOLE DIFFICULTY HERE, and it is why this file is
// conservative to the point of usually reporting almost nothing. Scanning ~50 series × 5 lags is 250
// hypothesis tests. At a naive p<0.05 you would expect roughly a dozen "significant" leads from pure
// noise, and a tool that hands the model a dozen spurious leads as MEASURED FACT is worse than one
// that offers none — it launders randomness into confident-sounding analysis. So:
//   - the significance bar is Bonferroni-corrected across the whole scan, and
//   - every reported lead carries its own n and r so a human can audit it, and
//   - nothing is reported at all below the corrected threshold.
// If this returns an empty list, that is a real and honest answer: the stored history (daily price
// only goes back to 2021) is not yet long enough to establish leads at this bar. Do NOT relax the
// threshold to make the output look richer.
//
// Correlation is not causation, and a lead that holds in-sample can evaporate. Treated as a prior
// worth stating, never as a rule.

import * as store from "./store.js";

// Daily price is the target. cbot:zs:front is the only sub-monthly price series in the system;
// nass:us:price is monthly and ~6 weeks lagged, which cannot support this at all.
const TARGET = "cbot:zs:front";
const LAGS_DAYS = [5, 10, 20, 40, 60];
const MIN_PAIRS = 30; // below this, r is too unstable to be worth reporting at any threshold
// Two-sided Bonferroni z for α=0.05 over ~250 tests (0.05/250 = 2e-4 → z ≈ 3.54). Used with the
// Fisher transform: |r| is significant when |atanh(r)|·√(n−3) exceeds this.
const BONFERRONI_Z = 3.54;
// ⚠️ BUMP THIS SUFFIX whenever the scan's maths, lag set, or exclusion list changes. The cached
// value survives restarts, so without a bump a code change silently keeps serving the old answer —
// which bit during development: after adding the exclusions the scan correctly returned zero leads
// while leadLagText() went on reporting the four pre-exclusion artifacts.
const CACHE_KEY = "leadlag_v2";
const CACHE_TTL_MS = 7 * 864e5; // the answer moves on the scale of months; recompute weekly

// --- exclusions: series that CANNOT honestly be tested against price -------------------------
//
// This list is the difference between a useful scan and a misleading one. Without it the scan's top
// hits were Iowa cash crush margin (r=+0.56 at 5 days), Iowa cash meal (+0.47) and Iowa cash oil
// (+0.42) — all of which look like strong predictive leads and none of which are:
//
//   - The cash crush margin is DEFINED as products minus beans, so Δmargin contains −Δbeans. Against
//     a mean-reverting price that alone manufactures a positive correlation with the next move. It is
//     an algebraic identity partly regressed on itself, not a discovery.
//   - Iowa cash price IS the price, in cash form. Basis is cash MINUS futures — the target again,
//     with a sign flip.
//   - AMS cash meal/oil are weekly prints of the same soybean complex, published after the fact, so
//     they partly echo board moves that have already happened. "X leads price" then means "X is a
//     stale copy of price," which is the classic lead-lag false positive.
//   - The board legs and the soy:corn ratios are the same instrument or contain it.
//
// What remains testable is the genuinely independent fundamentals — crop condition, satellite VCI,
// soil moisture, drought, weather anomalies, export pace, freight, positioning, biofuel feedstocks,
// WASDE balance sheet, Brazilian supply, macro. Those are the series where a measured lead would
// actually tell you something you didn't already know from the price screen.
const EXCLUDE_EXACT = new Set([
  "ams:ia:cash-price", "ams:ia:cash-crush-margin", "ams:ia:basis", "ams:ia:basis-processor",
  "ams:ia:meal", "ams:ia:oil",
  "nass:us:price", "nass:ia:price", "nass:us:corn-price", "nass:ia:corn-price",
  "nass:ia:soy-corn-ratio",
]);
// Every cbot:* series is the same futures complex as the target (legs, derived margin, ratio).
const EXCLUDE_PREFIX = ["cbot:"];
const isExcluded = (series) => EXCLUDE_EXACT.has(series) || EXCLUDE_PREFIX.some((p) => series.startsWith(p));

const parseMs = (p) => {
  const m = String(p).split("-");
  const t = Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1);
  return Number.isNaN(t) ? null : t;
};

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** |r| that clears the corrected bar at this sample size, via the Fisher z transform. */
function criticalR(n) {
  if (n <= 4) return 1;
  const z = BONFERRONI_Z / Math.sqrt(n - 3);
  return Math.tanh(z);
}

/** Price lookup: the most recent settle at or before `ms`, or null if none within a week. */
function priceAtOrBefore(priceMs, priceVal, ms) {
  let lo = 0, hi = priceMs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (priceMs[mid] <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  return ms - priceMs[best] <= 8 * 864e5 ? priceVal[best] : null;
}

/**
 * Scan every stored series for a predictive lead on price.
 * @returns {{ leads: object[], target, tested: number, note: string }}
 */
export function computeLeadLag() {
  let price = [];
  try {
    price = store.getSeries(TARGET);
  } catch {
    return { leads: [], target: TARGET, tested: 0, note: "target price series unavailable" };
  }
  if (price.length < 200) {
    return { leads: [], target: TARGET, tested: 0, note: `only ${price.length} price observations — too few to scan` };
  }
  const priceMs = price.map((p) => parseMs(p.period));
  const priceVal = price.map((p) => p.value);

  const metas = store.listSeriesMeta().filter((m) => m.series !== TARGET && !isExcluded(m.series));
  const excluded = store.listSeriesMeta().filter((m) => m.series === TARGET || isExcluded(m.series)).length;
  const leads = [];
  let tested = 0;
  let nearMiss = null; // strongest |r| seen anywhere, significant or not — diagnostics only

  for (const meta of metas) {
    let pts = [];
    try {
      pts = store.getSeries(meta.series);
    } catch {
      continue;
    }
    if (pts.length < MIN_PAIRS + 1) continue;

    // Series changes, paired with their date.
    const changes = [];
    for (let i = 1; i < pts.length; i++) {
      const ms = parseMs(pts[i].period);
      if (ms == null) continue;
      changes.push({ ms, d: pts[i].value - pts[i - 1].value });
    }

    let best = null;
    for (const lag of LAGS_DAYS) {
      const xs = [], ys = [];
      for (const c of changes) {
        const p0 = priceAtOrBefore(priceMs, priceVal, c.ms);
        const p1 = priceAtOrBefore(priceMs, priceVal, c.ms + lag * 864e5);
        if (p0 == null || p1 == null) continue;
        // Skip the degenerate pair where both lookups landed on the same settle (no elapsed
        // trading), which would otherwise inject a pile of zero price-changes and bias r toward 0.
        if (p1 === p0 && lag > 0) continue;
        xs.push(c.d);
        ys.push(p1 - p0);
      }
      tested++;
      if (xs.length < MIN_PAIRS) continue;
      const r = pearson(xs, ys);
      if (r == null) continue;
      const rc = criticalR(xs.length);
      // Track the strongest correlation regardless of significance, for the diagnostics channel —
      // it's how you tell "the scan ran and found nothing" apart from "the scan is broken". It is
      // deliberately NOT surfaced in leadLagText(): a near-miss shown to the model would get treated
      // as a lead, which is the exact failure this whole file is built to avoid.
      if (!nearMiss || Math.abs(r) > Math.abs(nearMiss.r)) nearMiss = { series: meta.series, label: meta.label, r, lagDays: lag, n: xs.length, criticalR: rc };
      if (Math.abs(r) < rc) continue; // fails the corrected bar → not reported at all
      if (!best || Math.abs(r) > Math.abs(best.r)) best = { r, lagDays: lag, n: xs.length, criticalR: rc };
    }
    if (best) {
      leads.push({
        series: meta.series,
        label: meta.label,
        category: meta.category,
        unit: meta.unit,
        ...best,
        direction: best.r > 0 ? "same-direction" : "inverse",
      });
    }
  }
  leads.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  return {
    leads,
    target: TARGET,
    tested,
    excluded,
    nearMiss,
    note: `${tested} series×lag combinations tested across independent fundamentals; ${excluded} price-derived or same-complex series were excluded as untestable; only leads clearing a Bonferroni-corrected |r| are listed.`,
  };
}

/** Cached wrapper — the scan is O(series × lags × points) and the answer barely moves week to week. */
export function leadLag({ force = false } = {}) {
  if (!force) {
    try {
      const raw = store.getState(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c.at && Date.now() - c.at < CACHE_TTL_MS) return c.value;
      }
    } catch {
      /* fall through and recompute */
    }
  }
  const value = computeLeadLag();
  try {
    store.setState(CACHE_KEY, JSON.stringify({ at: Date.now(), value }));
  } catch {
    /* cache is best-effort */
  }
  return value;
}

/**
 * Narrative for the Analyst / Ask prompts. Says plainly when nothing clears the bar, so the model
 * doesn't infer leads from silence — and states the caveats inline, because this block is exactly
 * the kind of output that reads more authoritative than it deserves to.
 */
export function leadLagText() {
  const { leads, target, tested } = leadLag();
  if (!leads.length) {
    return (
      `No series clears the significance bar for predicting ${target} at this sample size ` +
      `(${tested} series×lag combinations tested, Bonferroni-corrected). Treat any lead-lag claim as unverified — ` +
      `the daily price history only begins in 2021, which is not yet long enough to establish leads at a defensible threshold.`
    );
  }
  const lines = leads
    .slice(0, 8)
    .map(
      (l) =>
        `- ${l.label} → price over the following ~${l.lagDays} trading days: r=${l.r.toFixed(2)} (${l.direction}), n=${l.n}, bar was |r|>${l.criticalR.toFixed(2)}`
    );
  return (
    `Measured against ${target}, from stored history only. ${tested} series×lag combinations were tested and only these cleared a ` +
    `Bonferroni-corrected significance bar; everything else is omitted rather than reported weakly:\n${lines.join("\n")}\n` +
    `Caveats that matter: correlation is not causation, in-sample leads decay, and the price history begins in 2021. ` +
    `Use these as priors about where to look first, never as rules.`
  );
}

export const __test = { pearson, criticalR, priceAtOrBefore, computeLeadLag };
