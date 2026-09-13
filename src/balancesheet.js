// balancesheet.js — the assembled U.S. soybean supply/demand balance sheet, and the house nowcast
// derived from it (§1.6 + §1.2 of the data-pipeline-expansion plan).
//
// WHY. Stocks-to-use, crush, exports, condition and acreage all exist as separate scalars, but the
// model was never handed the ASSEMBLED S&D identity — so every card and signal had to re-derive the
// balance sheet from scratch, with no carryout to anchor a "this moves carryout by X" claim to. This
// builds that object once: it carries the current WASDE line, overlays observed run-rates where we can
// defensibly project them, and exposes an implied carryout + its delta from WASDE. That implied
// carryout is also the HOUSE NOWCAST for the next WASDE — filed as a `source:"house"` expectation so
// `pipeline.computeSurprises` scores it automatically once the release lands (surprise = actual − house,
// always computable, never dependent on anyone else publishing a consensus).
//
// ⚠️ THE OVERLAY IS A TUNABLE v1, AND IT IS ISOLATED ON PURPOSE (projectCrush / projectExports below).
// It does NOT invent ag-economics: it scales WASDE's OWN crush/export forecast by the observed
// year-over-year pace of NASS crush and FAS commitments — same marketing-year portion vs. same portion
// a year earlier, so seasonality cancels and WASDE stays the anchor. It is deliberately conservative
// (no adjustment unless the pace data is complete) and clearly labelled as directional in the prompt.
// Because it is now scored against reality, the method can be refined from measured error rather than
// argued about. Matt: this is the knob to turn — the projection functions are the whole model.

import * as store from "./store.js";

// NASS publishes soybean crush in short tons/month; 1 bu = 60 lb = 0.03 short tons (see crush.js).
const TONS_PER_BU = 0.03;
const toBuMln = (tons) => tons / TONS_PER_BU / 1e6; // tons → bushels → million bushels (WASDE units)

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * PURE core: assemble the identity and the house overlay from a WASDE component line + observed
 * projections. Exported for tests. `wasde` fields are million bushels (any may be null);
 * `observed.projectedCrush` / `.projectedExports` are full-marketing-year projections (mln bu) or null.
 */
export function assembleBalance(wasde = {}, observed = {}) {
  const sum = (...xs) => { let s = 0; for (const x of xs) { if (num(x) == null) return null; s += x; } return s; };
  const supply = sum(wasde.beginStocks, wasde.production, wasde.imports);
  const use = sum(wasde.crush, wasde.exports, wasde.seed, wasde.residual);
  const wasdeCarryout = num(wasde.endStocks);

  // Total use: WASDE's own if present, else derived from carryout + stocks-to-use, else the summed use.
  let totalUse = num(wasde.totalUse);
  if (totalUse == null && wasdeCarryout != null && num(wasde.stocksToUse)) totalUse = wasdeCarryout / (wasde.stocksToUse / 100);
  if (totalUse == null) totalUse = use;

  // Overlay deltas (mln bu): more observed crush/exports than WASDE forecast → more use → less carryout.
  const crushDelta = num(observed.projectedCrush) != null && num(wasde.crush) != null ? observed.projectedCrush - wasde.crush : 0;
  const exportsDelta = num(observed.projectedExports) != null && num(wasde.exports) != null ? observed.projectedExports - wasde.exports : 0;
  const hasOverlay = crushDelta !== 0 || exportsDelta !== 0;

  const impliedCarryout = wasdeCarryout != null ? wasdeCarryout - crushDelta - exportsDelta : null;
  const carryoutDelta = impliedCarryout != null && wasdeCarryout != null ? impliedCarryout - wasdeCarryout : null;
  const adjUse = totalUse != null ? totalUse + crushDelta + exportsDelta : null;
  const wasdeStocksToUse = num(wasde.stocksToUse) ?? (wasdeCarryout != null && totalUse ? (wasdeCarryout / totalUse) * 100 : null);
  const impliedStocksToUse = impliedCarryout != null && adjUse ? (impliedCarryout / adjUse) * 100 : null;

  // Transparency: supply − use should ≈ WASDE carryout. A gap means a component is missing or combined.
  const identityCarryout = supply != null && use != null ? supply - use : null;
  const identityGap = identityCarryout != null && wasdeCarryout != null ? Math.round((identityCarryout - wasdeCarryout) * 10) / 10 : null;

  return {
    supply, use, totalUse, wasdeCarryout, wasdeStocksToUse,
    crushDelta, exportsDelta, hasOverlay,
    impliedCarryout, carryoutDelta, impliedStocksToUse,
    identityCarryout, identityGap,
  };
}

/** "YYYY-MM" months of a marketing year (Sep..Aug) from Sep(startY) through `offset` months (0..11). */
function myMonthKeys(startY, offset) {
  const keys = [];
  for (let i = 0; i <= offset && i <= 11; i++) {
    const m0 = 9 + i; // Sep = 9
    keys.push(`${startY + Math.floor((m0 - 1) / 12)}-${String(((m0 - 1) % 12) + 1).padStart(2, "0")}`);
  }
  return keys;
}

/**
 * Project full-marketing-year crush by scaling WASDE's crush forecast by the observed YoY pace of NASS
 * crush over the SAME marketing-year-to-date window (so seasonality cancels). Returns null unless both
 * this MY-to-date and the same window a year earlier are complete — no partial-window guesses.
 */
export function projectCrush(wasdeCrush, getSeries = store.getSeries) {
  if (num(wasdeCrush) == null) return null;
  let pts;
  try { pts = getSeries("nass:us:crush"); } catch { return null; }
  if (!pts || pts.length < 14) return null;
  const byYM = new Map(pts.map((p) => [String(p.period).slice(0, 7), toBuMln(p.value)]));
  const [ly, lm] = String(pts[pts.length - 1].period).slice(0, 7).split("-").map(Number);
  const myStartYear = lm >= 9 ? ly : ly - 1;
  const offset = (ly - myStartYear) * 12 + (lm - 9); // months since Sep of the current MY
  const sumKeys = (keys) => { let s = 0; for (const k of keys) { if (!byYM.has(k)) return null; s += byYM.get(k); } return s; };
  const thisMY = sumKeys(myMonthKeys(myStartYear, offset));
  const lastMY = sumKeys(myMonthKeys(myStartYear - 1, offset));
  if (!(thisMY > 0) || !(lastMY > 0)) return null;
  const paceRatio = thisMY / lastMY;
  return { value: wasdeCrush * paceRatio, paceRatio, note: `NASS crush ${paceRatio >= 1 ? "+" : ""}${((paceRatio - 1) * 100).toFixed(1)}% vs same point last MY` };
}

/**
 * Project full-marketing-year exports by scaling WASDE's export forecast by the observed YoY pace of
 * cumulative FAS commitments at the same calendar week (commitments reset each Sep, so same-week is
 * same-MY-portion). Returns null without ~a year of history or a comparable prior-year week.
 */
export function projectExports(wasdeExports, getSeries = store.getSeries) {
  if (num(wasdeExports) == null) return null;
  let pts;
  try { pts = getSeries("fas:soybeans:commitments"); } catch { return null; }
  if (!pts || pts.length < 30) return null;
  const ms = (p) => { const s = String(p); return Date.parse(s.length === 7 ? `${s}-01` : s); };
  const latest = pts[pts.length - 1];
  const target = ms(latest.period) - 364 * 864e5;
  let best = null, bestDiff = Infinity;
  for (const p of pts) { const d = Math.abs(ms(p.period) - target); if (d < bestDiff) { bestDiff = d; best = p; } }
  if (!best || bestDiff > 21 * 864e5 || !(best.value > 0) || !(latest.value > 0)) return null;
  const paceRatio = latest.value / best.value;
  return { value: wasdeExports * paceRatio, paceRatio, note: `FAS commitments ${paceRatio >= 1 ? "+" : ""}${((paceRatio - 1) * 100).toFixed(1)}% vs same week last MY` };
}

const wasdeSeries = (comp) => `wasde:us:soy-${comp}`;

/** Assemble the live U.S. soybean balance sheet from the latest stored WASDE line + observed overlays. */
export function usSoyBalanceSheet() {
  const latest = (name) => { try { const p = store.getSeries(name); return p.length ? p[p.length - 1] : null; } catch { return null; } };
  const endPt = latest(wasdeSeries("endstocks"));
  if (!endPt) return null; // no WASDE line stored yet
  const v = (comp) => { const p = latest(wasdeSeries(comp)); return p ? p.value : null; };
  const wasde = {
    beginStocks: v("begin-stocks"), production: v("production"), imports: v("imports"),
    crush: v("crush"), exports: v("exports"), seed: v("seed"), residual: v("residual"),
    endStocks: endPt.value, stocksToUse: v("stocks-to-use"),
  };
  const projCrush = projectCrush(wasde.crush);
  const projExports = projectExports(wasde.exports);
  const assembled = assembleBalance(wasde, { projectedCrush: projCrush?.value ?? null, projectedExports: projExports?.value ?? null });
  return { ...assembled, wasde, asOf: endPt.period, projCrush, projExports };
}

const mb = (v) => (v == null ? "—" : `${Math.round(v)} mln bu`);

/** Compact balance-sheet block for the Analyst / Ask / memo prompts. "" when no WASDE line is stored. */
export function balanceSheetText() {
  const b = usSoyBalanceSheet();
  if (!b) return "";
  const lines = [
    "U.S. SOYBEAN BALANCE SHEET (assembled from the latest WASDE line — the anchor for any \"this moves carryout by X\" claim):",
    `- WASDE ${b.asOf}: beginning ${mb(b.wasde.beginStocks)} + production ${mb(b.wasde.production)} + imports ${mb(b.wasde.imports)} = supply ${mb(b.supply)}`,
    `  − crush ${mb(b.wasde.crush)} − exports ${mb(b.wasde.exports)} − seed ${mb(b.wasde.seed)} − residual ${mb(b.wasde.residual)} = use ${mb(b.use)}`,
    `  → ending stocks ${mb(b.wasdeCarryout)}${b.wasdeStocksToUse != null ? `, stocks-to-use ${b.wasdeStocksToUse.toFixed(1)}%` : ""}`,
  ];
  if (b.identityGap != null && Math.abs(b.identityGap) > 1) {
    lines.push(`  (identity check: supply−use = ${mb(b.identityCarryout)} vs WASDE ending stocks ${mb(b.wasdeCarryout)} — ${b.identityGap} mln bu gap, a component is likely missing or combined in this layout)`);
  }
  if (b.hasOverlay && b.impliedCarryout != null) {
    const notes = [b.projCrush?.note, b.projExports?.note].filter(Boolean).join("; ");
    const dir = b.carryoutDelta < 0 ? "TIGHTER" : b.carryoutDelta > 0 ? "LOOSER" : "unchanged";
    lines.push(
      `- HOUSE NOWCAST (a measured prior, scored against the next WASDE — not a borrowed consensus): implied carryout ${mb(b.impliedCarryout)} ` +
        `(${b.carryoutDelta >= 0 ? "+" : ""}${Math.round(b.carryoutDelta)} mln bu vs WASDE → ${dir})${b.impliedStocksToUse != null ? `, implied stocks-to-use ${b.impliedStocksToUse.toFixed(1)}%` : ""}. ` +
        `Basis: ${notes || "—"}. Method: v1 — scales WASDE crush/exports by observed YoY pace; directional, not a point forecast.`
    );
  } else {
    lines.push(`- HOUSE NOWCAST: no independent run-rate adjustment yet (crush/commitments pace data incomplete) — house carryout equals WASDE ${mb(b.wasdeCarryout)}.`);
  }
  return lines.join("\n");
}

/** "YYYY-MM" → first day of the following month ("2026-09" → "2026-10-01"). */
function firstOfNextMonth(ym) {
  let [y, m] = String(ym).slice(0, 7).split("-").map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/**
 * File the balance sheet's implied carryout as a house expectation for the NEXT WASDE, so it becomes a
 * scored surprise (actual − house) once that release lands. Only fires when the run-rate overlay is
 * active (otherwise the house number would just equal WASDE and measure nothing new). `reportDate` is
 * the first of the month AFTER the current release, so computeSurprises settles it against the NEXT
 * monthly ending-stocks print (a full release date would sort after that month's period and never match).
 */
export function houseNowcasts() {
  const b = usSoyBalanceSheet();
  if (!b || !b.hasOverlay || b.impliedCarryout == null) return { upserted: 0 };
  const reportDate = firstOfNextMonth(b.asOf);
  store.upsertExpectation({
    dedupeKey: `house:soy-carryout:${reportDate}`,
    report: `WASDE ${reportDate.slice(0, 7)}`,
    reportDate,
    item: "U.S. soybean ending stocks (house nowcast)",
    series: wasdeSeries("endstocks"),
    unit: "mln bu",
    estAvg: Math.round(b.impliedCarryout),
    source: "house",
    sourceDate: b.asOf,
  });
  return { upserted: 1, reportDate, estAvg: Math.round(b.impliedCarryout) };
}
