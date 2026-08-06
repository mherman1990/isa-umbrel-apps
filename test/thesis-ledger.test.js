// Ledger parity between the two forecast-filing paths (Phase 3a).
//
// WHY THIS FILE EXISTS, SEPARATELY FROM thesis.test.js. thesis.js is pure and tests offline with no
// DB. This file is the opposite: it exists to prove that the NEW filing path writes a `forecasts`
// row indistinguishable from the one the OLD path wrote, so `resolveForecasts()` needs zero changes
// and the track record stays continuous across the cutover.
//
// The risk being locked down is subtle. Phase 3 gives the analyst note a second filing path
// (theses → fileForecastFromClaim). If that path applied even slightly different guards — a
// different horizon default, a missing not_measurable coercion, a skipped baseline capture — the
// ledger would quietly start mixing rows scored under two different rules, and the "track record"
// fed back into later prompts would be measuring two things at once. That is why the plan required
// the filing body to be lifted out VERBATIM rather than reimplemented for theses.
//
// Zero deps (node --test), no network, temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-thesis-ledger-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const store = await import("../src/store.js");
const { fileForecastFromClaim } = await import("../src/pipeline.js");
const { applyBounds } = await import("../src/thesis.js");

const SERIES = "ams:iowa:basis";
const bySeries = new Map([[SERIES, { series: SERIES, latest: { value: 2.44, period: "2026-08-05" } }]]);

/** The shape the legacy Haiku extractor produces (FORECAST_SCHEMA, flat). */
const EXTRACTOR_CLAIM = {
  claim: "Iowa cash crush margin stays above $2.00 through Q4.",
  comparator: "stays_above",
  threshold: 2.0,
  direction: "n/a",
  series: SERIES,
  horizonDays: 90,
  confirmingEvent: "Monthly NOPA crush report",
  confidence: "high",
};

/** The same logical claim as it arrives from a thesis — horizon and confidence live on the THESIS,
 *  not on the claim, so the caller has to flatten. This test is what proves that flattening right. */
const THESIS = {
  thesis: "Crush margins hold above trend into Q4.",
  narrative: "Utilization is at a record for the month.",
  horizon_days: 90,
  mechanism_chain: ["Record utilization", "Margins stay wide"],
  supporting_evidence: ["signal:crush_demand"],
  counterevidence: [],
  alternative_explanations: ["Soybean oil alone is carrying the margin."],
  confidence: "high",
  confirm: "September NOPA print above 200 million bushels.",
  invalidate: "Board crush falls below $1.20 for two weeks.",
  falsifiable_claim: {
    claim: "Iowa cash crush margin stays above $2.00 through Q4.",
    comparator: "stays_above",
    threshold: 2.0,
    direction: "n/a",
    series: SERIES,
    confirmingEvent: "Monthly NOPA crush report",
  },
};

const UNIVERSE = { itemUids: new Set(), seriesIds: new Set([SERIES]), signalIds: new Set(["crush_demand"]), briefPaths: new Set(), reportKeys: new Set() };

/** Flatten a bounded thesis the way generateMemo does before filing. */
function claimFromThesis(t) {
  return { ...t.falsifiableClaim, horizonDays: t.horizonDays, confidence: t.confidence };
}

/** Everything about a stored row except the identity columns that are expected to differ. */
function scoringShape(row) {
  return {
    claim: row.claim,
    comparator: row.comparator,
    threshold: row.threshold,
    direction: row.direction,
    series: row.series,
    horizon_days: row.horizon_days,
    resolve_by: row.resolve_by,
    confirming_event: row.confirming_event,
    confidence: row.confidence,
    baseline_value: row.baseline_value,
    baseline_period: row.baseline_period,
  };
}

test("thesis: a thesis-filed row is scored identically to an extractor-filed one", () => {
  const createdAt = new Date().toISOString();
  fileForecastFromClaim(EXTRACTOR_CLAIM, { briefPath: "briefings/a-extractor.md", edition: "analyst", createdAt, bySeries });
  const bounded = applyBounds(THESIS, UNIVERSE);
  fileForecastFromClaim(claimFromThesis(bounded), { briefPath: "briefings/b-thesis.md", edition: "analyst", createdAt, bySeries });

  const rows = store.listForecasts({ limit: 50 });
  const fromExtractor = rows.find((r) => r.brief_path === "briefings/a-extractor.md");
  const fromThesis = rows.find((r) => r.brief_path === "briefings/b-thesis.md");
  assert.ok(fromExtractor && fromThesis, "both paths must file a row");

  // Every column the resolver reads must match. If this fails, resolveForecasts is about to score
  // two populations under one heading.
  assert.deepEqual(scoringShape(fromThesis), scoringShape(fromExtractor));
  // Including the baseline, which is what makes the comparison at resolution time meaningful.
  assert.equal(fromThesis.baseline_value, 2.44);
  assert.equal(fromThesis.baseline_period, "2026-08-05");
});

test("thesis: the horizon comes off the THESIS, not the claim — a wrong flatten defaults to 30 days", () => {
  // The failure this catches: `falsifiable_claim` has no horizonDays field, so passing it straight
  // through silently files every thesis with the 30-day default and resolves 90-day calls two
  // months early.
  const bounded = applyBounds(THESIS, UNIVERSE);
  assert.equal(bounded.horizonDays, 90);
  const createdAt = new Date().toISOString();
  fileForecastFromClaim(claimFromThesis(bounded), { briefPath: "briefings/c-horizon.md", edition: "analyst", createdAt, bySeries });
  const row = store.listForecasts({ limit: 50 }).find((r) => r.brief_path === "briefings/c-horizon.md");
  assert.equal(row.horizon_days, 90);

  // And the unflattened shape is exactly the bug — asserted so the flatten is not "simplified" away.
  fileForecastFromClaim(bounded.falsifiableClaim, { briefPath: "briefings/d-unflattened.md", edition: "analyst", createdAt, bySeries });
  const bad = store.listForecasts({ limit: 50 }).find((r) => r.brief_path === "briefings/d-unflattened.md");
  assert.equal(bad.horizon_days, 30, "this is what a missing flatten looks like");
});

test("thesis: a demoted thesis files at its POST-grounding confidence, not what the model claimed", () => {
  // The ledger must record what we actually believe after grounding. Filing the model's stated
  // confidence would let an ungrounded thesis enter the track record as a high-confidence call and
  // flatter the scorecard.
  const ungrounded = applyBounds({ ...THESIS, supporting_evidence: ["signal:invented"] }, UNIVERSE);
  assert.equal(ungrounded.confidence, "low");
  assert.equal(ungrounded.confidenceStated, "high");
  const createdAt = new Date().toISOString();
  fileForecastFromClaim(claimFromThesis(ungrounded), { briefPath: "briefings/e-demoted.md", edition: "analyst", createdAt, bySeries });
  const row = store.listForecasts({ limit: 50 }).find((r) => r.brief_path === "briefings/e-demoted.md");
  assert.equal(row.confidence, "low");
});

test("thesis: a claim naming a series that is not stored files as not_measurable, both paths alike", () => {
  const createdAt = new Date().toISOString();
  const t = applyBounds({ ...THESIS, falsifiable_claim: { ...THESIS.falsifiable_claim, series: "no:such:series" } }, UNIVERSE);
  fileForecastFromClaim(claimFromThesis(t), { briefPath: "briefings/f-noseries.md", edition: "analyst", createdAt, bySeries });
  const row = store.listForecasts({ limit: 50 }).find((r) => r.brief_path === "briefings/f-noseries.md");
  assert.equal(row.comparator, "not_measurable", "a claim nothing can settle must not resolve as a hit");
  assert.equal(row.series, null);
});

test("thesis: a level claim with no usable threshold cannot masquerade as a direction call", () => {
  const createdAt = new Date().toISOString();
  const t = applyBounds({ ...THESIS, falsifiable_claim: { ...THESIS.falsifiable_claim, threshold: null } }, UNIVERSE);
  fileForecastFromClaim(claimFromThesis(t), { briefPath: "briefings/g-nothreshold.md", edition: "analyst", createdAt, bySeries });
  const row = store.listForecasts({ limit: 50 }).find((r) => r.brief_path === "briefings/g-nothreshold.md");
  assert.equal(row.comparator, "not_measurable");
});
