// Tests for carbon_prices' pure parsing (state LCFS/CFP credit prices out of the EcoEngineers "Carbon
// Markets Snapshot"). The LCFS block text is the real emailBodyToText layout confirmed on the Pi via
// scripts/probe-carbon-prices.mjs (uid 1043, 2026-09-11). EU ETS is NOT parsed from the email (it's an
// image there) — it has its own adapter/test (test/eu_ets.test.js).

import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/adapters/carbon_prices.js");
const { parseCarbonPrices, parseLcfs, toSeriesRows } = mod.__test;

// A full snapshot: RIN headline block, then the LCFS section (Oregon CFP + California LCFS), then the EU ETS
// label (no value — it's an image), then the RIN matrix. The LCFS scan must ignore the RIN dollar figures
// and stop before the EU ETS section.
const SNAP =
  "Carbon Markets Snapshot September 11, 2026 " +
  "US$ per RIN (Renewable Fuel Standard) 2026 D3 $2.370 D4 $2.169 D5 $2.160 D6 $2.112 " +
  "US$ per Metric Ton of CO2e (State LCFS Programs) " +
  "Oregon Clean Fuels Program (CFP) Credit $122.00 " +
  "California Low Carbon Fuel Standard (LCFS) Credit $84.50 " +
  "EU€ per Metric Ton of CO2e (EU ETS Allowance) Source: EMBER " +
  "Daily Full RIN Update D-Code US$ per RIN (Renewable Fuel Standard) 2024 2025 2026 " +
  "D3 $2.300 $2.350 $2.370 D4 $2.105 $2.140 $2.169 " +
  "EcoEngineers provides this data for information purposes only.";

test("parseLcfs captures California + Oregon credit prices, mapped to state tokens", () => {
  const lcfs = parseLcfs(SNAP.replace(/\s+/g, " "));
  const get = (t) => lcfs.find((c) => c.token === t)?.value;
  assert.equal(lcfs.length, 2);
  assert.equal(get("CA"), 84.5);
  assert.equal(get("OR"), 122);
  assert.ok(lcfs.every((c) => /^LCFS credit — /.test(c.label)), "each carries a family-friendly label");
});

test("parseLcfs does not mistake a RIN price or a bare '$' figure for an LCFS credit", () => {
  const lcfs = parseLcfs(SNAP.replace(/\s+/g, " "));
  // RIN prices (2.169 etc.) live in a different section and lack a '<State> … Credit $' shape.
  assert.ok(lcfs.every((c) => c.value !== 2.169 && c.value !== 2.37), "no RIN value leaks into LCFS");
  // Only the two real programs — nothing from the EU ETS section (which has no $ value anyway).
  assert.deepEqual(lcfs.map((c) => c.token).sort(), ["CA", "OR"]);
});

test("parseCarbonPrices returns the LCFS block (no EU-ETS key — that's eu_ets's job now)", () => {
  const p = parseCarbonPrices(SNAP);
  assert.equal(p.lcfs.length, 2);
  assert.ok(!("euets" in p), "EU ETS is not parsed from the email");
});

test("parseCarbonPrices is fail-soft on a non-snapshot email (webinar invite)", () => {
  const p = parseCarbonPrices("Join Us for Our Upcoming Webinars! Register here for our next session.");
  assert.deepEqual(p.lcfs, []);
});

test("toSeriesRows shapes the §1.3 LCFS family (CA + OR), one point per program", () => {
  const rows = toSeriesRows(parseCarbonPrices(SNAP), "2026-09-11");
  const byId = Object.fromEntries(rows.map((r) => [r.series, r]));

  assert.deepEqual(rows.map((r) => r.series).sort(), ["lcfs:by-program:CA", "lcfs:by-program:OR"]);
  for (const t of ["CA", "OR"]) {
    assert.equal(byId[`lcfs:by-program:${t}`].meta.family, "lcfs:by-program");
    assert.equal(byId[`lcfs:by-program:${t}`].meta.unit, "$/t CO2e");
    assert.equal(byId[`lcfs:by-program:${t}`].meta.category, "carbon_prices");
    assert.equal(byId[`lcfs:by-program:${t}`].period, "2026-09-11");
  }
});

test("toSeriesRows emits nothing for an empty parse (so fetchSeries skips the email)", () => {
  assert.deepEqual(toSeriesRows({ lcfs: [] }, "2026-09-11"), []);
});
