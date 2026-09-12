// Unit tests for the CME settlements adapter's PURE parsers + series builder + gating (§1.1).
//
// These lock the parsing logic and the inert-by-default behavior. They do NOT hit CME (its IP block
// makes that impossible from CI anyway) — the fixtures encode CME's documented CmeWS JSON shape and an
// ASSUMED stlags text layout; the real formats are confirmed on the Pi via scripts/probe-cme-settlements.mjs,
// at which point the stlags fixture below should be replaced with a real captured sample.

import test from "node:test";
import assert from "node:assert/strict";

const cme = await import("../src/adapters/cme_settlements.js");

test("parsePrice handles grain eighths, product decimals, commas, signs, and placeholders", () => {
  assert.equal(cme.parsePrice("1052'2"), 1052.25); // 2/8
  assert.equal(cme.parsePrice("425'4"), 425.5); // 4/8
  assert.equal(cme.parsePrice("1052'0"), 1052);
  assert.equal(cme.parsePrice("319.10"), 319.1); // meal, decimal
  assert.equal(cme.parsePrice("54.32"), 54.32); // oil, decimal
  assert.equal(cme.parsePrice("1,234"), 1234); // thousands comma (volume/OI)
  assert.equal(cme.parsePrice("+2'4"), 2.5); // signed change
  assert.equal(cme.parsePrice("-3'2"), -3.25);
  for (const empty of ["", "-", "----", "N/A", null, undefined]) assert.equal(cme.parsePrice(empty), null);
});

test("parseContractMonth accepts 3-letter labels and single-letter codes", () => {
  assert.equal(cme.parseContractMonth("SEP 25"), "2025-09");
  assert.equal(cme.parseContractMonth("SEP25"), "2025-09");
  assert.equal(cme.parseContractMonth("NOV 2026"), "2026-11");
  assert.equal(cme.parseContractMonth("X26"), "2026-11"); // X = Nov
  assert.equal(cme.parseContractMonth("N26"), "2026-07"); // N = Jul
  assert.equal(cme.parseContractMonth("F27"), "2027-01"); // F = Jan
  assert.equal(cme.parseContractMonth("Total"), null);
  assert.equal(cme.parseContractMonth(""), null);
});

test("parseTradeDate normalizes CME's date formats to YYYY-MM-DD", () => {
  assert.equal(cme.parseTradeDate("12 Sep 2026"), "2026-09-12");
  assert.equal(cme.parseTradeDate("2026-09-12"), "2026-09-12");
  assert.equal(cme.parseTradeDate("garbage"), null);
});

const SOY_JSON = {
  tradeDate: "12 Sep 2026",
  settlements: [
    { month: "NOV 26", settle: "1061'0", volume: "80,000", openInterest: "250,000" },
    { month: "SEP 26", settle: "1052'2", volume: "12,345", openInterest: "5,000" },
    { month: "JAN 27", settle: "1072'4", volume: "10,000", openInterest: "90,000" },
    { month: "Total", settle: "", volume: "102,345", openInterest: "345,000" },
  ],
};

test("parseSettlementsJson parses rows nearest-first, skips Total, drops settle-less rows", () => {
  const p = cme.parseSettlementsJson(SOY_JSON);
  assert.equal(p.tradeDate, "2026-09-12");
  assert.deepEqual(p.rows.map((r) => r.contractMonth), ["2026-09", "2026-11", "2027-01"]); // sorted
  assert.deepEqual(p.rows[0], { contractMonth: "2026-09", settle: 1052.25, openInterest: 5000, volume: 12345 });
  assert.equal(p.rows[1].settle, 1061);
  assert.equal(p.rows[1].openInterest, 250000);
});

test("buildProductSeries emits curve settles + OI + front + nearby carry, all on the trade date", () => {
  const [zs] = cme.__internal.PRODUCTS;
  const parsed = cme.parseSettlementsJson(SOY_JSON);
  const series = cme.__internal.buildProductSeries(zs, parsed, 8);
  const byId = new Map(series.map((s) => [s.series, s]));

  assert.equal(byId.get("cme:zs:2026-09").points[0].value, 1052.25);
  assert.equal(byId.get("cme:zs:2026-09").points[0].period, "2026-09-12");
  assert.equal(byId.get("cme:zs:2026-11:oi").points[0].value, 250000);
  assert.equal(byId.get("cme:zs:front").points[0].value, 1052.25, "front = nearest contract");
  assert.equal(byId.get("cme:zs:carry").points[0].value, 8.75, "carry = 2nd (1061) − 1st (1052.25)");
});

test("buildProductSeries respects maxContracts and omits carry with a single contract", () => {
  const [zs] = cme.__internal.PRODUCTS;
  const series = cme.__internal.buildProductSeries(zs, cme.parseSettlementsJson(SOY_JSON), 1);
  const ids = series.map((s) => s.series);
  assert.ok(ids.includes("cme:zs:2026-09"));
  assert.ok(!ids.includes("cme:zs:2026-11"), "second contract excluded by maxContracts=1");
  assert.ok(ids.includes("cme:zs:front"));
  assert.ok(!ids.includes("cme:zs:carry"), "no carry with only one contract");
});

test("isEnabled gates on CME_SETTLEMENTS; the adapter is inert (no network) by default", async () => {
  assert.equal(cme.isEnabled({}), false);
  assert.equal(cme.isEnabled({ CME_SETTLEMENTS: "0" }), false);
  assert.equal(cme.isEnabled({ CME_SETTLEMENTS: "false" }), false);
  assert.equal(cme.isEnabled({ CME_SETTLEMENTS: "1" }), true);
  assert.equal(cme.isEnabled({ CME_SETTLEMENTS: "true" }), true);
  // With the gate off, fetchSeries/fetchItems must return [] WITHOUT making any request.
  assert.deepEqual(await cme.fetchSeries({ env: {} }), []);
  assert.deepEqual(await cme.fetchItems({ env: {} }), []);
});

// ── Provisional stlags parser. ⚠️ ASSUMED layout — replace with a real captured sample from the probe. ──
const STLAGS_SAMPLE = [
  "CME Group Settlements   Trade Date 12 Sep 2026",
  "SOYBEAN FUTURES",
  "SEP 26   1050'0  1060'0  1045'0  1052'2   +2'4   1052'2   12345   5000",
  "NOV 26   1058'0  1063'0  1055'0  1061'0   +3'0   1061'0   80000   250000",
  "TOTAL                                                      102345  345000",
  "CORN FUTURES",
  "DEC 26   420'0   424'0   418'0   422'2    +2'2   422'2    50000   400000",
].join("\n");

test("parseStlags (provisional) extracts soybean + corn contracts from the assumed text layout", () => {
  const p = cme.parseStlags(STLAGS_SAMPLE);
  assert.equal(p.tradeDate, "2026-09-12");
  const zs = p.byProduct.zs || [];
  assert.equal(zs.length, 2, "two soybean contracts");
  assert.deepEqual(zs[0], { contractMonth: "2026-09", settle: 1052.25, openInterest: 5000 });
  assert.equal(zs[1].openInterest, 250000);
  assert.ok((p.byProduct.zc || []).length >= 1, "corn block also parsed");
});
