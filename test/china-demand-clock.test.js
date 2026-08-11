// Tests for the china_demand_clock trigger's data wiring.
//
// ⚠️ THE DEFECT THIS LOCKS. The trigger read `agtransport:soy-net-export-sales`, which is
// `sum(netsalescmy)` across ALL DESTINATIONS. On a card whose entire purpose is "has China shown up
// for U.S. new crop yet?", it printed the world total. Measured against the real feed on 2026-08-10,
// with the trigger firing: the card said weekly net export sales were **+10% vs. a year ago** while
// China's own commitments were **-44.7%** (12.43M t against 22.48M t) and China's share of the U.S.
// book had fallen from 43.7% to 29.8%. An analyst reading it would have concluded Chinese demand was
// fine. That is the specific wrong answer these tests exist to prevent recurring.
//
// ⚠️ AND THE WINDOW IS THE WORST POSSIBLE ONE FOR A SINGLE NUMBER. The trigger fires 1 Aug – 30 Sep,
// straddling the soybean marketing-year rollover on 31 Aug. Old-crop figures wind down for calendar
// reasons that have nothing to do with demand, while the new crop is booked in a different field. On
// the real data the two legs currently point in OPPOSITE directions — old crop -45%, new crop 3.11M t
// against zero a year ago — so any collapse to one number misinforms whichever number is chosen.
//
// PROVENANCE: every figure below is the real value from api.fas.usda.gov for week ending 2026-07-30
// and the corresponding week of 2025.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-clock-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const { evaluateTriggers, triggersText } = await import("../src/triggers.js");

/**
 * ⚠️ EVERY TEST MUST START FROM A CLEAN SET OF SERIES, AND `saveSeriesPoints` CANNOT GIVE IT.
 *
 * It UPSERTS points and never deletes, so a test that seeds 2024–2025 after one that seeded
 * 2019–2025 silently inherits the older years — and the seasonal norm is computed over whatever is
 * in the table. Three tests here failed exactly that way on first run, each producing a plausible
 * wrong number rather than an error: a "2-year" norm reported as 8 years, and a deliberately
 * engineered seasonal-vs-yearly disagreement that quietly resolved itself.
 *
 * A second connection is the simplest honest fix. `_snapshotCache` inside store.js is not cleared by
 * this, but every reset is followed by a `saveSeriesPoints` which does clear it — so the ordering is
 * load-bearing: always reset THEN seed.
 */
const rawDb = new Database(path.join(DIR, "polibrief.db"));
function resetSeries() {
  rawDb.prepare("DELETE FROM market_series WHERE series LIKE 'fas:%' OR series LIKE 'agtransport:%'").run();
  rawDb.prepare("DELETE FROM market_series_meta WHERE series LIKE 'fas:%' OR series LIKE 'agtransport:%'").run();
}
test.beforeEach(() => resetSeries());

/** Inside the 1 Aug – 30 Sep window the trigger fires in. */
const IN_WINDOW = new Date("2026-08-15T12:00:00Z");
const OUT_OF_WINDOW = new Date("2026-04-15T12:00:00Z");

/** Two points a year apart is all `marketSnapshot` needs to compute a year-ago comparison. */
function seed(series, meta, thisYear, lastYear) {
  store.saveSeriesPoints(series, meta, [
    { period: "2025-07-31", value: lastYear },
    { period: "2026-07-30", value: thisYear },
  ]);
}

/** The real state of the world on 2026-07-30. */
function seedRealChina() {
  seed("fas:soybeans:china:commitments", { label: "China commitments", unit: "metric tons", category: "export_commitments" }, 12432209, 22478500);
  seed("fas:soybeans:china:next-my-commitments", { label: "China next MY", unit: "metric tons", category: "export_commitments" }, 3111000, 0);
  seed("fas:soybeans:china:share", { label: "China share", unit: "%", category: "export_share" }, 29.8, 43.7);
}

/** The misleading proxy the trigger used to read. */
function seedProxy() {
  seed("agtransport:soy-net-export-sales", { label: "Soybean net export sales", unit: "metric tons", category: "soy_exports" }, 302260, 273564);
}

const clockDetail = (now = IN_WINDOW) => evaluateTriggers(now).find((t) => t.id === "china_demand_clock")?.detail ?? null;

// ── the defect ────────────────────────────────────────────────────────────────────────────────────

test("⚠️ the China card never presents an all-destinations total as if it were a China number", () => {
  seedProxy();
  seedRealChina();
  const detail = clockDetail();
  assert.ok(detail, "the trigger fires in the window");
  // The world total for that week. Its presence unlabelled is the bug.
  assert.doesNotMatch(detail, /302,260/, "the all-destinations weekly figure must not appear on the China card");
  assert.doesNotMatch(detail, /\+10%/, "and neither must its reassuring year-on-year, which was the wrong answer");
  assert.match(detail, /China/, "the detail is about China");
});

test("⚠️ both marketing-year legs are reported, because in this window they disagree", () => {
  seedProxy();
  seedRealChina();
  const detail = clockDetail();
  // New crop: ahead of last year.
  assert.match(detail, /3\.11M t/, "the new-crop book is stated");
  // Old crop: sharply behind. Reporting only the new-crop leg would be the mirror-image error.
  assert.match(detail, /12\.43M t/, "old-crop commitments are stated");
  assert.match(detail, /-45%/, "with the decline that the old proxy hid");
  assert.match(detail, /29\.8%/, "and China's share of the U.S. book");
  assert.match(detail, /week ending 2026-07-30/, "as-of date, so a stale read is visible");
});

test("⚠️ a year-ago baseline of ZERO is stated in absolute terms, not dropped and not infinity", () => {
  // China's next-marketing-year book really was 0 on 2025-07-31 and 3,111,000 t on 2026-07-30.
  // marketSnapshot correctly returns yoyPct: null there, and a renderer that only prints percentages
  // silently loses the single most interesting comparison on the card.
  seedRealChina();
  const detail = clockDetail();
  assert.match(detail, /against none at all a year ago/);
  assert.doesNotMatch(detail, /Infinity|NaN|null|undefined/);
});

// ── it must keep firing when the news is bad ──────────────────────────────────────────────────────

test("⚠️ the clock still fires when China is absent — that is the year it matters most", () => {
  // Zero on both legs: China has bought nothing, old crop or new.
  seed("fas:soybeans:china:commitments", { label: "c", unit: "metric tons", category: "export_commitments" }, 0, 22478500);
  seed("fas:soybeans:china:next-my-commitments", { label: "n", unit: "metric tons", category: "export_commitments" }, 0, 1500000);
  seed("fas:soybeans:china:share", { label: "s", unit: "%", category: "export_share" }, 0, 43.7);
  const fired = evaluateTriggers(IN_WINDOW).find((t) => t.id === "china_demand_clock");
  assert.ok(fired, "a data-gated version of this trigger would go silent here, which is backwards");
  assert.match(fired.detail, /China has bought NO U\.S\. new-crop soybeans/, "the absence leads, in words");
  // ⚠️ -100% alone would state the direction and hide the SCALE. Against 1.5M t and against 22.5M t
  // are very different absences, so last year's absolute must survive on both legs.
  assert.match(fired.detail, /against 1\.50M t a year ago/, "new-crop absence is sized against last year");
  assert.match(fired.detail, /against 22\.48M t a year ago/, "old-crop absence is sized against last year");
  assert.doesNotMatch(fired.detail, /0\.00M t/, "zero must not render as a rounded decimal");
});

test("outside the seasonal window the clock does not fire at all", () => {
  seedRealChina();
  assert.equal(clockDetail(OUT_OF_WINDOW), null);
});

// ── the seasonal norm ─────────────────────────────────────────────────────────────────────────────

/** Eight years of late-July points, so `marketSnapshot` can compute a same-month norm. */
function seedSeasonal(series, meta, valuesByYear, latest) {
  const points = Object.entries(valuesByYear).map(([y, v]) => ({ period: `${y}-07-25`, value: v }));
  points.push({ period: "2026-07-30", value: latest });
  store.saveSeriesPoints(series, meta, points);
}

test("⚠️ the seasonal norm leads, because a single prior year can itself be the anomaly", () => {
  // The real case. China's new-crop book was ZERO on 2025-07-31, so year-on-year reads "against none
  // at all a year ago" — which sounds extraordinary. Against the norm it is +7%, 61st percentile:
  // good, and thoroughly ordinary. The anomaly was last year. A card built only on year-on-year has
  // no way to tell which of the two years is the strange one.
  seedSeasonal(
    "fas:soybeans:china:next-my-commitments",
    { label: "n", unit: "metric tons", category: "export_commitments" },
    { 2019: 3200000, 2020: 2800000, 2021: 3400000, 2022: 2600000, 2023: 3100000, 2024: 2900000, 2025: 0 },
    3111000
  );
  const detail = clockDetail();
  assert.match(detail, /norm for this week/, "the seasonal anchor is present");
  assert.match(detail, /pctile/, "with its rank");
  assert.doesNotMatch(detail, /against none at all a year ago/, "the misleading year-on-year framing is not the headline");
});

test("year-on-year is KEPT when it disagrees with the seasonal norm — the disagreement is the finding", () => {
  // Above the norm but below last year: one of the two years is unusual, and hiding either half
  // would leave the reader with a confident half-truth.
  seedSeasonal(
    "fas:soybeans:china:commitments",
    { label: "c", unit: "metric tons", category: "export_commitments" },
    { 2019: 8000000, 2020: 9000000, 2021: 8500000, 2022: 9500000, 2023: 8200000, 2024: 8800000, 2025: 30000000 },
    12000000
  );
  const detail = clockDetail();
  assert.match(detail, /but /, "both comparisons survive when they point opposite ways");
  assert.match(detail, /vs\. a year ago/);
});

test("⚠️ a thin norm says so rather than presenting a three-year average as settled", () => {
  // `marketSnapshot` needs >=3 points across >=3 years; a prior release shipped a live-wrong seasonal
  // read built from ONE year, which is why seasonalYears is surfaced at all.
  seedSeasonal("fas:soybeans:china:share", { label: "s", unit: "%", category: "export_share" }, { 2023: 50, 2024: 48, 2025: 44 }, 29.8);
  const detail = clockDetail();
  assert.match(detail, /only 4 years — thin, treat as indicative/, "the caveat names the real span");
});

test("the sample size is stated once, and is the SMALLEST span across the legs", () => {
  // Taking the max (or the first leg's) would overstate how much history the weakest leg rests on.
  seedSeasonal("fas:soybeans:china:next-my-commitments", { label: "n", unit: "metric tons", category: "export_commitments" }, { 2019: 3e6, 2020: 3e6, 2021: 3e6, 2022: 3e6, 2023: 3e6, 2024: 3e6, 2025: 3e6 }, 3111000);
  seedSeasonal("fas:soybeans:china:share", { label: "s", unit: "%", category: "export_share" }, { 2024: 50, 2025: 44 }, 29.8);
  const detail = clockDetail();
  assert.equal((detail.match(/Norms are same-week averages/g) ?? []).length, 1, "stated exactly once");
  assert.match(detail, /only 3 years/, "and reflects the THINNEST leg, not the richest");
});

test("percentile ordinals read correctly — 61st, not 61th", () => {
  // The first live render produced "61th pctile".
  seedSeasonal("fas:soybeans:china:share", { label: "s", unit: "%", category: "export_share" }, { 2019: 10, 2020: 20, 2021: 30, 2022: 40, 2023: 50, 2024: 60, 2025: 70 }, 55);
  const detail = clockDetail();
  assert.doesNotMatch(detail, /\d+(?:1th|2th|3th)\b/, "no 61th / 22th / 33th");
  assert.match(detail, /\d+(st|nd|rd|th) pctile/);
});

test("with too little history for a norm, the line falls back to year-on-year rather than inventing one", () => {
  // Two years cannot make a seasonal average, and a fabricated baseline is worse than none.
  store.saveSeriesPoints("fas:soybeans:china:commitments", { label: "c", unit: "metric tons", category: "export_commitments" }, [
    { period: "2025-07-31", value: 22478500 },
    { period: "2026-07-30", value: 12432209 },
  ]);
  store.saveSeriesPoints("fas:soybeans:china:next-my-commitments", { label: "n", unit: "metric tons", category: "export_commitments" }, [
    { period: "2025-07-31", value: 0 },
    { period: "2026-07-30", value: 3111000 },
  ]);
  store.saveSeriesPoints("fas:soybeans:china:share", { label: "s", unit: "%", category: "export_share" }, [
    { period: "2025-07-31", value: 43.7 },
    { period: "2026-07-30", value: 29.8 },
  ]);
  const detail = clockDetail();
  assert.doesNotMatch(detail, /norm for this week/, "no norm is claimed");
  assert.doesNotMatch(detail, /Norms are same-week averages/);
  assert.match(detail, /-45% vs\. a year ago/, "year-on-year still carries the line");
});

// ── graceful degradation ──────────────────────────────────────────────────────────────────────────

test("with no FAS data the fallback proxy is LABELLED as a world total, never passed off as China", () => {
  // A fresh store with only the proxy — i.e. FAS_API_KEY unset, or the first refresh not yet run.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bb-clock2-"));
  const res = spawnFresh(dir2, `
    store.saveSeriesPoints("agtransport:soy-net-export-sales", { label: "x", unit: "metric tons", category: "soy_exports" },
      [{ period: "2025-07-31", value: 273564 }, { period: "2026-07-30", value: 302260 }]);
    const t = triggers.evaluateTriggers(new Date("2026-08-15T12:00:00Z")).find((x) => x.id === "china_demand_clock");
    console.log(JSON.stringify(t.detail));
  `);
  assert.match(res, /No China-specific export-sales data available/, "it says the China data is missing");
  assert.match(res, /set FAS_API_KEY/, "and how to fix it");
  assert.match(res, /ALL-DESTINATIONS/, "the proxy is labelled for what it is");
  assert.match(res, /says nothing about China's share of it/, "and explicitly disclaims the China reading");
});

test("with no data at all the detail is empty rather than a fabricated reassurance", () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "bb-clock3-"));
  const res = spawnFresh(dir3, `
    const t = triggers.evaluateTriggers(new Date("2026-08-15T12:00:00Z")).find((x) => x.id === "china_demand_clock");
    console.log(JSON.stringify({ fired: Boolean(t), detail: t?.detail }));
  `);
  const { fired, detail } = JSON.parse(res.trim());
  assert.equal(fired, true, "the seasonal clock still fires");
  assert.equal(detail, "", "but says nothing rather than inventing a read");
});

test("the trigger text handed to the card prompt carries the China detail", () => {
  seedRealChina();
  const line = triggersText(IN_WINDOW).split("\n").find((l) => /China seasonal sourcing clock/.test(l));
  assert.ok(line, "the trigger reaches the prompt");
  assert.match(line, /current data: China has 3\.11M t/);
});

// ── helper ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run a snippet against a FRESH store in a child process.
 *
 * store.js opens its database at import time and this file has already imported it, so a
 * "what happens with an empty store" test cannot be written in-process — it would see the series the
 * earlier tests seeded. Learned the same way test/packets.test.js learned about shared event keys.
 */
function spawnFresh(dir, snippet) {
  const { execFileSync } = require("node:child_process");
  const script = `
    const store = await import("${new URL("../src/store.js", import.meta.url).href}");
    const triggers = await import("${new URL("../src/triggers.js", import.meta.url).href}");
    ${snippet}
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, POLIBRIEF_DATA_DIR: dir },
    encoding: "utf8",
  });
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
