// Tests for dimension families (§1.3 of the pipeline-expansion plan): dimensioned data that used to be
// averaged away at write time is kept as a FAMILY of per-dimension series, and the snapshot renders the
// family as one cross-section line instead of N. First family: Iowa cash basis split by crop-reporting
// district, out of the AMS 2850 rows the adapter already fetches.
//
// What these lock:
//   - store: saveSeriesPoints persists meta.family and marketSnapshot() surfaces it (null when absent).
//   - renderer: formatFamilyBlock is a pure one-line cross-section (values, spread, high/low, count);
//     formatMarketSnapshot collapses a present family into that one line and does NOT also list members.
//   - adapter: the district breakout resolves the district field (named or auto-detected), emits one
//     ¢/bu basis series per district under the shared family prefix, and is fail-safe (no district
//     field → no breakout, statewide series untouched).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-families-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const { formatFamilyBlock, formatMarketSnapshot } = await import("../src/pipeline.js");
const ams = await import("../src/adapters/usda_ams.js");

/** `count` ascending "YYYY-MM" periods ending at the current month. */
function monthlyPeriods(count) {
  const now = new Date();
  const end = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = end - i;
    out.push(`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// store: the family column
// ---------------------------------------------------------------------------
test("saveSeriesPoints persists meta.family; marketSnapshot surfaces it (null when absent)", () => {
  const p = monthlyPeriods(4);
  store.saveSeriesPoints(
    "fam:test:NW",
    { label: "Fam — NW", unit: "¢/bu", category: "fam_cat", family: "fam:test" },
    p.map((pp, i) => ({ period: pp, value: 10 + i }))
  );
  store.saveSeriesPoints(
    "solo:test",
    { label: "Solo", unit: "x", category: "fam_cat" }, // no family
    p.map((pp, i) => ({ period: pp, value: i }))
  );
  const snap = store.marketSnapshot();
  assert.equal(snap.find((s) => s.series === "fam:test:NW").family, "fam:test");
  assert.equal(snap.find((s) => s.series === "solo:test").family, null);
});

// ---------------------------------------------------------------------------
// renderer: the pure family block
// ---------------------------------------------------------------------------
const member = (series, value, label, extra = {}) => ({
  series, label, unit: "¢/bu", latest: { period: "2026-09-12", value }, stale: false, ...extra,
});

test("formatFamilyBlock: one-line cross-section with spread, high/low, count", () => {
  const members = [
    member("ams:ia:basis-by-district:NW", 18, "Iowa soybean basis — Northwest"),
    member("ams:ia:basis-by-district:SE", -6, "Iowa soybean basis — Southeast"),
    member("ams:ia:basis-by-district:C", 4, "Iowa soybean basis — Central"),
  ];
  const line = formatFamilyBlock("ams:ia:basis-by-district", members);
  assert.match(line, /Iowa soybean basis \(by district\):/); // label derived from members' shared prefix
  assert.match(line, /NW 18/);
  assert.match(line, /SE -6/);
  assert.match(line, /24 ¢\/bu spread/); // 18 − (−6)
  assert.match(line, /NW high, SE low/);
  assert.match(line, /3 districts/);
  // sorted high→low: NW before C before SE
  assert.ok(line.indexOf("NW 18") < line.indexOf("C 4"));
  assert.ok(line.indexOf("C 4") < line.indexOf("SE -6"));
});

test("formatFamilyBlock: null for fewer than two usable members (caller then renders them solo)", () => {
  assert.equal(formatFamilyBlock("f", [member("f:x", 1, "F — x")]), null);
  assert.equal(formatFamilyBlock("f", []), null);
  assert.equal(formatFamilyBlock("f", [member("f:x", null, "F — x"), member("f:y", 2, "F — y")]), null); // one usable
});

test("formatFamilyBlock: STALE when any member's feed is overdue", () => {
  const line = formatFamilyBlock("g:by-region", [
    member("g:by-region:A", 5, "G — A"),
    member("g:by-region:B", 1, "G — B", { stale: true }),
  ]);
  assert.match(line, /STALE/);
  assert.match(line, /2 regions/);
});

// ---------------------------------------------------------------------------
// renderer end-to-end: a family collapses to one line, members not listed twice
// ---------------------------------------------------------------------------
test("formatMarketSnapshot collapses a present family into one line, not N", () => {
  const p = monthlyPeriods(3);
  for (const [tok, val] of [["NW", 18], ["NC", 10], ["SE", -6]]) {
    store.saveSeriesPoints(
      `ams:ia:basis-by-district:${tok}`,
      { label: `Iowa soybean basis — ${tok}`, unit: "¢/bu", category: "soy_basis_fam", family: "ams:ia:basis-by-district" },
      p.map((pp, i) => ({ period: pp, value: val + i }))
    );
  }
  const out = formatMarketSnapshot(store.marketSnapshot(), new Date());
  assert.ok(out.includes("(by district):"), "family cross-section line present");
  // The three members are NOT each rendered as their own "- Iowa soybean basis — NW: …" line.
  const memberLines = out.split("\n").filter((l) => /^- Iowa soybean basis — (NW|NC|SE):/.test(l));
  assert.equal(memberLines.length, 0, "members collapsed into the family block, not listed individually");
});

test("formatMarketSnapshot: a lone-member family falls back to an ordinary series line", () => {
  const p = monthlyPeriods(3);
  store.saveSeriesPoints(
    "ams:ia:onlyone-by-district:NW",
    { label: "Only — NW", unit: "¢/bu", category: "lone_fam", family: "ams:ia:onlyone-by-district" },
    p.map((pp, i) => ({ period: pp, value: 5 + i }))
  );
  const out = formatMarketSnapshot(store.marketSnapshot(), new Date());
  assert.ok(out.split("\n").some((l) => l.startsWith("- Only — NW:")), "single-member family renders as a normal line");
  assert.ok(!out.includes("onlyone-by-district (by"), "no family block for a lone member");
});

// ---------------------------------------------------------------------------
// adapter: the district breakout out of the 2850 rows
// ---------------------------------------------------------------------------
const soyRow = (district, avg, bMin, bMax, date = "09/12/2026", fm = "X") => ({
  commodity: "Soybeans",
  report_date: date,
  avg_price: String(avg),
  "basis Min": String(bMin),
  "basis Max": String(bMax),
  "basis Min Futures Month": fm,
  delivery_point: "Country Elevators",
  district,
});

test("matchDistrictStrict maps Iowa district phrasings; rejects non-districts", () => {
  const M = ams.__test.matchDistrictStrict;
  assert.equal(M("Northwest").token, "NW");
  assert.equal(M("North Central").token, "NC"); // two-word compass name beats bare "Central"
  assert.equal(M("South East").token, "SE");
  assert.equal(M("Central").token, "C");
  assert.equal(M("Des Moines"), null);
  assert.equal(M(""), null);
  assert.equal(M(null), null);
});

test("cashGrainSeries emits a per-district basis family AND keeps the statewide series", () => {
  const rows = [
    soyRow("Northwest", 11.5, 15, 21),
    soyRow("Northwest", 11.4, 17, 19, "09/11/2026"),
    soyRow("Southeast", 11.2, -8, -4),
    soyRow("North Central", 11.6, 8, 12),
  ];
  const out = ams.__test.cashGrainSeries(rows);
  const fam = out.filter((s) => s.series.startsWith("ams:ia:basis-by-district:"));
  assert.deepEqual(fam.map((s) => s.series.split(":").at(-1)).sort(), ["NC", "NW", "SE"]);
  assert.ok(
    fam.every((s) => s.meta.family === "ams:ia:basis-by-district" && s.meta.category === "soy_basis" && s.meta.unit === "¢/bu"),
    "family members carry family + soy_basis category + ¢/bu unit"
  );
  // NW has two dates → two points; each date's mid-basis is 18.
  const nw = fam.find((s) => s.series.endsWith(":NW"));
  assert.equal(nw.points.length, 2);
  assert.ok(nw.points.every((pt) => pt.value === 18));
  // The statewide series are still emitted alongside the family.
  assert.ok(out.some((s) => s.series === "ams:ia:basis"));
  assert.ok(out.some((s) => s.series === "ams:ia:cash-price"));
});

test("no district field → no breakout, statewide untouched (fail-safe)", () => {
  const rows = [
    { commodity: "Soybeans", report_date: "09/12/2026", avg_price: "11.5", "basis Min": "15", "basis Max": "21", "basis Min Futures Month": "X", delivery_point: "Country Elevators" },
    { commodity: "Soybeans", report_date: "09/12/2026", avg_price: "11.6", "basis Min": "16", "basis Max": "20", "basis Min Futures Month": "X", delivery_point: "Terminal Elevators" },
  ];
  const out = ams.__test.cashGrainSeries(rows);
  assert.equal(out.filter((s) => s.series.startsWith("ams:ia:basis-by-district:")).length, 0);
  assert.ok(out.some((s) => s.series === "ams:ia:basis" || s.series === "ams:ia:cash-price"));
});

test("pickDistrictField finds the district under a non-standard key by its values", () => {
  const rows = [
    { commodity: "Soybeans", report_date: "09/12/2026", geo_area: "Northwest", avg_price: "1" },
    { commodity: "Soybeans", report_date: "09/12/2026", geo_area: "Southeast", avg_price: "1" },
    { commodity: "Soybeans", report_date: "09/12/2026", geo_area: "Central", avg_price: "1" },
  ];
  assert.equal(ams.__test.pickDistrictField(rows), "geo_area");
  // ...and nothing qualifies when no field carries district-like values.
  assert.equal(ams.__test.pickDistrictField([{ commodity: "Soybeans", avg_price: "1", city: "Ames" }]), null);
});
