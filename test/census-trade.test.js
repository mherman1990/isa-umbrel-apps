// Unit tests for the Census trade adapter's pure parsers + gating (§2 row 2).
//
// These lock the array-of-arrays parsing and the country-collapse; the live HS codes / field names are
// confirmed on the Pi via scripts/probe-45z-sources.mjs (the intltrade API key-gates, so the exact
// response can't be seen from CI).

import test from "node:test";
import assert from "node:assert/strict";

const cx = await import("../src/adapters/census_trade.js");

const EXPORTS = [
  ["ALL_VAL_MO", "CTY_NAME", "E_COMMODITY", "time"],
  ["1000", "CHINA", "1201", "2026-06"],
  ["500", "MEXICO", "1201", "2026-06"],
  ["9999", "TOTAL FOR ALL COUNTRIES", "1201", "2026-06"], // aggregate row — must be skipped
  ["800", "CHINA", "1201", "2026-05"],
  ["", "GERMANY", "1201", "2026-06"], // non-numeric value — skipped
];

test("parseCensus turns the array-of-arrays into header-keyed row objects", () => {
  const rows = cx.parseCensus(EXPORTS);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { ALL_VAL_MO: "1000", CTY_NAME: "CHINA", E_COMMODITY: "1201", time: "2026-06" });
});

test("parseCensus returns [] for anything that isn't the documented shape", () => {
  assert.deepEqual(cx.parseCensus(null), []);
  assert.deepEqual(cx.parseCensus({ error: "missing key" }), []);
  assert.deepEqual(cx.parseCensus([["only", "header"]]), []);
});

test("monthlyTotals sums per period across countries, skips the TOTAL aggregate and blanks", () => {
  const pts = cx.monthlyTotals(cx.parseCensus(EXPORTS), "ALL_VAL_MO");
  assert.deepEqual(pts, [
    { period: "2026-05", value: 800 },
    { period: "2026-06", value: 1500 }, // 1000 + 500, not the 9999 TOTAL row, not the blank
  ]);
});

test("valueField / commodityField switch by flow", () => {
  assert.equal(cx.__internal.valueField("exports"), "ALL_VAL_MO");
  assert.equal(cx.__internal.valueField("imports"), "GEN_VAL_MO");
  assert.equal(cx.__internal.commodityField("exports"), "E_COMMODITY");
  assert.equal(cx.__internal.commodityField("imports"), "I_COMMODITY");
});

test("adapter is inert without CENSUS_API_KEY (no network call)", async () => {
  assert.deepEqual(await cx.fetchSeries({ env: {} }), []);
  assert.deepEqual(await cx.fetchItems({ env: {} }), []);
});
