// Tests for the snapshot relevance gate + per-series latency metadata (§1.5 / §4 of the
// pipeline-expansion plan).
//
// What these lock:
//   - marketSnapshot() now carries how old each figure is (ageDays), the series' own cadence, and a
//     `stale` flag — so a quarterly print can't read in the prompt as this week's, and a dead feed
//     shows as STALE rather than a quiet market.
//   - formatMarketSnapshot() spends FULL detail only on series that are moving, at a multi-year
//     extreme, or referenced by a live signal / fired trigger / open expectation; the quiet middle
//     collapses to one value line. Nothing is dropped — every series still shows value + period + age.
//   - The relevance decision (seriesRelevance) and the next-release resolver (nextReleaseForSeries)
//     are pure and unit-tested against hand-built inputs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-relevance-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const { seriesRelevance, nextReleaseForSeries, formatMarketSnapshot } = await import("../src/pipeline.js");

const rawDb = new Database(path.join(DIR, "polibrief.db"));

/** `count` ascending "YYYY-MM" periods whose newest is `endOffsetMonths` months before now. */
function monthlyPeriods(count, endOffsetMonths = 0) {
  const now = new Date();
  const end = now.getUTCFullYear() * 12 + now.getUTCMonth() - endOffsetMonths; // month index
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = end - i;
    out.push(`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

const lineFor = (out, label) => out.split("\n").find((l) => l.startsWith(`- ${label}:`));

// ---------------------------------------------------------------------------
// §1.5 — per-series latency lands in marketSnapshot()
// ---------------------------------------------------------------------------
test("marketSnapshot exposes per-series latency (ageDays, cadenceDays, stale, refreshedAt)", () => {
  const periods = monthlyPeriods(6, 0); // recent, monthly
  store.saveSeriesPoints(
    "test:fresh:series",
    { label: "FreshSeries", unit: "x", category: "test_latency" },
    periods.map((p, i) => ({ period: p, value: 10 + i }))
  );
  const s = store.marketSnapshot().find((x) => x.series === "test:fresh:series");
  assert.ok(s, "series present in snapshot");
  assert.equal(typeof s.ageDays, "number");
  assert.ok(s.ageDays >= 0 && s.ageDays < 70, `fresh series has small ageDays, got ${s.ageDays}`);
  assert.ok(s.cadenceDays >= 28 && s.cadenceDays <= 31, `monthly series → ~30-day cadence, got ${s.cadenceDays}`);
  assert.equal(s.stale, false, "a current monthly series is not stale");
  assert.ok(s.refreshedAt, "refreshedAt carried from meta.updated_at");
});

test("marketSnapshot flags a series overdue vs. its own cadence as stale", () => {
  const periods = monthlyPeriods(6, 15); // newest point ~15 months old
  store.saveSeriesPoints(
    "test:stale:series",
    { label: "StaleSeries", unit: "x", category: "test_latency" },
    periods.map((p, i) => ({ period: p, value: 10 + i }))
  );
  const s = store.marketSnapshot().find((x) => x.series === "test:stale:series");
  assert.equal(s.stale, true, `overdue series is stale (ageDays=${s.ageDays}, cadence=${s.cadenceDays})`);
});

// ---------------------------------------------------------------------------
// §4 input — openExpectationSeries()
// ---------------------------------------------------------------------------
test("openExpectationSeries returns only series with an unresolved expectation", () => {
  rawDb.prepare("DELETE FROM report_expectations").run();
  const ins = rawDb.prepare(
    "INSERT INTO report_expectations (dedupe_key, report, item, series, created_at, resolved_at) VALUES (?,?,?,?,?,?)"
  );
  const now = new Date().toISOString();
  ins.run("k-open", "WASDE 2026-09", "US soybean ending stocks", "wasde:us:soy-stocks-to-use", now, null);
  ins.run("k-resolved", "WASDE 2026-08", "settled item", "nass:us:crush", now, now); // resolved → excluded
  ins.run("k-null", "WASDE 2026-09", "no series attached", null, now, null); // open but no series → excluded
  assert.deepEqual(store.openExpectationSeries().sort(), ["wasde:us:soy-stocks-to-use"]);
});

// ---------------------------------------------------------------------------
// §4 core — the pure relevance decision
// ---------------------------------------------------------------------------
const base = { series: "x:y:z", stale: false, changeZ: 0, percentile: 50, historyYears: 5 };

test("seriesRelevance: a quiet, fresh, unreferenced series is condensed (not full)", () => {
  assert.equal(seriesRelevance({ ...base }, new Set()).full, false);
});

test("seriesRelevance: a move ≥1σ on a fresh series earns full detail", () => {
  const r = seriesRelevance({ ...base, changeZ: 1.4 }, new Set());
  assert.equal(r.full, true);
  assert.ok(r.reasons.includes("moving"));
});

test("seriesRelevance: a move on a STALE feed does NOT count as moving", () => {
  assert.equal(seriesRelevance({ ...base, changeZ: 3, stale: true }, new Set()).full, false);
});

test("seriesRelevance: a multi-year percentile extreme (low or high) earns full detail", () => {
  assert.ok(seriesRelevance({ ...base, percentile: 2, historyYears: 4 }, new Set()).reasons.includes("extreme"));
  assert.ok(seriesRelevance({ ...base, percentile: 99, historyYears: 4 }, new Set()).reasons.includes("extreme"));
});

test("seriesRelevance: an extreme without enough history is not full on that basis", () => {
  assert.equal(seriesRelevance({ ...base, percentile: 1, historyYears: 1 }, new Set()).full, false);
});

test("seriesRelevance: a referenced series is full even when stale and flat", () => {
  const r = seriesRelevance({ ...base, changeZ: 0, stale: true }, new Set(["x:y:z"]));
  assert.equal(r.full, true);
  assert.ok(r.reasons.includes("referenced"));
});

// ---------------------------------------------------------------------------
// §1.5 — next-release resolver
// ---------------------------------------------------------------------------
const upcoming = [
  { type: "CROP_PROGRESS", name: "Crop Progress", date: "2026-09-14" },
  { type: "EXPORT_SALES", name: "Export Sales", date: "2026-09-18" },
  { type: "COT", name: "CFTC Commitments of Traders", date: "2026-09-19" },
  { type: "EXPORT_SALES", name: "Export Sales", date: "2026-09-25" }, // a later match — must not win
  { type: "WASDE", name: "WASDE", date: "2026-10-09" },
];

test("nextReleaseForSeries maps a series to the soonest release of its type", () => {
  assert.equal(nextReleaseForSeries("fas:soybeans:china:commitments", upcoming).date, "2026-09-18");
  assert.equal(nextReleaseForSeries("cftc:soybeans:mm-net", upcoming).type, "COT");
  assert.equal(nextReleaseForSeries("wasde:us:soy-stocks-to-use", upcoming).type, "WASDE");
  assert.equal(nextReleaseForSeries("nass:us:condition", upcoming).type, "CROP_PROGRESS");
  assert.equal(nextReleaseForSeries("nass:us:stocks", upcoming), null); // no GRAIN_STOCKS in this list
});

test("nextReleaseForSeries returns null for series with no scheduled USDA/CFTC release", () => {
  assert.equal(nextReleaseForSeries("eia:feedstock:soybean-oil", upcoming), null);
  assert.equal(nextReleaseForSeries("fred:usd-broad", upcoming), null);
  assert.equal(nextReleaseForSeries("cropcasma:ia:rootzone-sm", upcoming), null);
});

// ---------------------------------------------------------------------------
// §4 end-to-end — the rendered block
// ---------------------------------------------------------------------------
test("formatMarketSnapshot: quiet series condensed, moving series full, legend + age present", () => {
  // Quiet: 3 mid-range recent points under a custom id nothing references → one-liner.
  const qp = monthlyPeriods(3, 0);
  store.saveSeriesPoints(
    "test:quiet:one",
    { label: "QuietOne", unit: "u", category: "zzz_render" },
    [{ period: qp[0], value: 5 }, { period: qp[1], value: 20 }, { period: qp[2], value: 10 }]
  );
  // Moving: stable then a big jump over ≥9 diffs → high |changeZ|, fresh → full.
  const mp = monthlyPeriods(10, 0);
  const vals = [10, 10, 11, 9, 10, 11, 9, 10, 11, 25];
  store.saveSeriesPoints(
    "test:moving:one",
    { label: "MovingOne", unit: "u", category: "zzz_render" },
    mp.map((p, i) => ({ period: p, value: vals[i] }))
  );

  const out = formatMarketSnapshot(store.marketSnapshot(), new Date());

  assert.match(out, /Quiet, unreferenced series are condensed/, "legend line present");

  const quiet = lineFor(out, "QuietOne");
  const moving = lineFor(out, "MovingOne");
  assert.ok(quiet, "quiet line present");
  assert.ok(moving, "moving line present");

  // Quiet = one value line with period + age, but none of the full-detail stats.
  assert.match(quiet, /\(\d{4}-\d{2}, \d+d\)/, "quiet line carries (period, age)");
  assert.doesNotMatch(quiet, /pctile|range |σ/, "quiet line omits full stats");

  // Moving = full detail, and it also carries the age marker.
  assert.match(moving, /\(\d{4}-\d{2}, \d+d/, "moving line carries (period, age) too");
  assert.match(moving, /pctile/, "moving line has percentile/range detail");
  assert.match(moving, /σ/, "moving line has momentum");
});

test("formatMarketSnapshot: a stale, unreferenced series is flagged STALE and stays condensed", () => {
  const periods = monthlyPeriods(6, 18); // ~18 months overdue on a monthly cadence
  store.saveSeriesPoints(
    "test:stale:render",
    { label: "StaleRender", unit: "u", category: "zzz_render" },
    periods.map((p, i) => ({ period: p, value: 10 + i }))
  );
  const line = lineFor(formatMarketSnapshot(store.marketSnapshot(), new Date()), "StaleRender");
  assert.ok(line, "stale series line present");
  assert.match(line, /STALE/, "stale series flagged STALE in the line");
  assert.doesNotMatch(line, /pctile/, "stale unreferenced series stays condensed");
});
