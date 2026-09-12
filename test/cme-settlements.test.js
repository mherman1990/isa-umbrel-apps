// Unit tests for the CME settlements adapter's PURE parsers + series builder + gating (§1.1).
//
// The fixtures mirror CME's real CmeWS JSON shape as captured from the Pi (tradeDate 09/11/2026): rows
// carry { month, open, high, low, last, change, settle, volume, openInterest }; beans/corn quote
// points'eighths ("1296'4"), meal/oil decimals; open/high/low/last can carry an A/B indicator suffix;
// the nearest month can be an expiring near-zero-OI stub while the real lead is the max-OI contract.
// These do NOT hit CME (its IP policy makes that a Pi-only call — see scripts/probe-cme-settlements.mjs).

import test from "node:test";
import assert from "node:assert/strict";

const cme = await import("../src/adapters/cme_settlements.js");

test("parsePrice handles grain eighths, decimals, commas, signs, A/B suffixes, and placeholders", () => {
  assert.equal(cme.parsePrice("1296'4"), 1296.5); // 4/8
  assert.equal(cme.parsePrice("510'2"), 510.25); // corn, 2/8
  assert.equal(cme.parsePrice("1296'0"), 1296);
  assert.equal(cme.parsePrice("352.8"), 352.8); // meal decimal
  assert.equal(cme.parsePrice("69.68"), 69.68); // oil decimal
  assert.equal(cme.parsePrice("491,712"), 491712); // OI thousands comma
  assert.equal(cme.parsePrice("1282'2A"), 1282.25); // A (ask) settlement-indicator suffix
  assert.equal(cme.parsePrice("509'4B"), 509.5); // B (bid) suffix
  assert.equal(cme.parsePrice("346.2A"), 346.2);
  assert.equal(cme.parsePrice("-35'6"), -35.75); // signed change
  for (const empty of ["", "-", "N/A", null, undefined]) assert.equal(cme.parsePrice(empty), null);
});

test("parseContractMonth accepts 3-letter labels and single-letter codes", () => {
  assert.equal(cme.parseContractMonth("SEP 26"), "2026-09");
  assert.equal(cme.parseContractMonth("NOV 26"), "2026-11");
  assert.equal(cme.parseContractMonth("JAN 27"), "2027-01");
  assert.equal(cme.parseContractMonth("X26"), "2026-11"); // X = Nov
  assert.equal(cme.parseContractMonth("Total"), null);
  assert.equal(cme.parseContractMonth(""), null);
});

test("parseTradeDate normalizes CME's date formats to YYYY-MM-DD", () => {
  assert.equal(cme.parseTradeDate("09/11/2026"), "2026-09-11"); // CmeWS MM/DD/YYYY
  assert.equal(cme.parseTradeDate("12 Sep 2026"), "2026-09-12");
  assert.equal(cme.parseTradeDate("2026-09-11"), "2026-09-11");
  assert.equal(cme.parseTradeDate("garbage"), null);
});

// Real soybean shape: the nearest month (SEP) is an expiring stub (OI 5) while NOV is the lead (OI 491k).
const SOY_JSON = {
  tradeDate: "09/11/2026",
  settlements: [
    { month: "NOV 26", settle: "1296'4", volume: "245,874", openInterest: "491,712" },
    { month: "SEP 26", settle: "1280'2", volume: "3", openInterest: "5" },
    { month: "JAN 27", settle: "1312'0", volume: "83,177", openInterest: "196,718" },
    { month: "Total", settle: "", volume: "400,000", openInterest: "700,000" },
  ],
};

test("parseSettlementsJson parses rows nearest-first, skips Total, drops settle-less rows", () => {
  const p = cme.parseSettlementsJson(SOY_JSON);
  assert.equal(p.tradeDate, "2026-09-11");
  assert.deepEqual(p.rows.map((r) => r.contractMonth), ["2026-09", "2026-11", "2027-01"]); // sorted
  assert.deepEqual(p.rows[0], { contractMonth: "2026-09", settle: 1280.25, openInterest: 5, volume: 3 });
  assert.equal(p.rows[1].settle, 1296.5);
  assert.equal(p.rows[1].openInterest, 491712);
});

test("buildProductSeries: front = the OI lead (not the expiring stub), carry = next − lead", () => {
  const [zs] = cme.__internal.PRODUCTS;
  const series = cme.__internal.buildProductSeries(zs, cme.parseSettlementsJson(SOY_JSON), 8);
  const byId = new Map(series.map((s) => [s.series, s]));

  assert.equal(byId.get("cme:zs:2026-09").points[0].value, 1280.25);
  assert.equal(byId.get("cme:zs:2026-09").points[0].period, "2026-09-11");
  assert.equal(byId.get("cme:zs:2026-11:oi").points[0].value, 491712);
  assert.equal(byId.get("cme:zs:front").points[0].value, 1296.5, "front = NOV (max OI), not the SEP stub");
  assert.equal(byId.get("cme:zs:carry").points[0].value, 15.5, "carry = JAN (1312) − NOV lead (1296.5)");
});

test("buildProductSeries respects maxContracts and omits carry when nothing follows the lead", () => {
  const [zs] = cme.__internal.PRODUCTS;
  const series = cme.__internal.buildProductSeries(zs, cme.parseSettlementsJson(SOY_JSON), 1);
  const ids = series.map((s) => s.series);
  assert.ok(ids.includes("cme:zs:2026-09"));
  assert.ok(!ids.includes("cme:zs:2026-11"), "second contract excluded by maxContracts=1");
  assert.ok(ids.includes("cme:zs:front"));
  assert.ok(!ids.includes("cme:zs:carry"), "no contract follows the lead within the slice");
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
