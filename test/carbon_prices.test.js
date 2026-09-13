// Tests for carbon_prices' pure parsing (LCFS/CFP + EU ETS out of the EcoEngineers "Carbon Markets
// Snapshot"). The LCFS block text is the real emailBodyToText layout confirmed alongside the RIN block
// (see test/banyan_rin.test.js); the EU-ETS value position is the part scripts/probe-carbon-prices.mjs
// confirms on the Pi, so both the value-present and value-absent (fail-soft) branches are locked here.

import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/adapters/carbon_prices.js");
const { parseCarbonPrices, parseLcfs, parseEuEts, toSeriesRows } = mod.__test;

// A full snapshot: RIN headline block, then the LCFS section (Oregon CFP + California LCFS), then EU ETS,
// then the RIN matrix. Mirrors the real inline layout so the LCFS scan must ignore the RIN dollar figures.
const SNAP =
  "Carbon Markets Snapshot September 11, 2026 " +
  "US$ per RIN (Renewable Fuel Standard) 2026 D3 $2.370 D4 $2.169 D5 $2.160 D6 $2.112 " +
  "US$ per Metric Ton of CO2e (State LCFS Programs) " +
  "Oregon Clean Fuels Program (CFP) Credit $122.00 " +
  "California Low Carbon Fuel Standard (LCFS) Credit $84.50 " +
  "EU€ per Metric Ton of CO2e (EU ETS Allowance) €60.43 Source: EMBER " +
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
});

test("parseEuEts reads the EU ETS allowance (€ optional), bounded to a sane €/t range", () => {
  assert.equal(parseEuEts(SNAP.replace(/\s+/g, " ")), 60.43);
  assert.equal(parseEuEts("EU€ per Metric Ton of CO2e (EU ETS Allowance) 60.43 Source: EMBER"), 60.43);
  assert.equal(parseEuEts("EU ETS Allowance €72,15 Source: EMBER"), 72.15); // European comma decimal
});

test("parseEuEts is fail-soft: null when the block has no value before the next section", () => {
  // The exact layout captured in the RIN fixture — anchor present, no number before "Source" / next block.
  assert.equal(parseEuEts("EU€ per Metric Ton of CO2e (EU ETS Allowance) Source: EMBER US$ per Voluntary"), null);
  assert.equal(parseEuEts("no eu ets block here"), null);
  // A bare year or the "CO2e" digit must never be read as a price.
  assert.equal(parseEuEts("EU ETS Allowance in 2026 for CO2e Daily Full RIN Update"), null);
});

test("parseCarbonPrices returns both blocks together", () => {
  const p = parseCarbonPrices(SNAP);
  assert.equal(p.lcfs.length, 2);
  assert.equal(p.euets, 60.43);
});

test("parseCarbonPrices is fail-soft on a non-snapshot email (webinar invite)", () => {
  const p = parseCarbonPrices("Join Us for Our Upcoming Webinars! Register here for our next session.");
  assert.deepEqual(p.lcfs, []);
  assert.equal(p.euets, null);
});

test("toSeriesRows shapes the §1.3 LCFS family + the EU-ETS series", () => {
  const rows = toSeriesRows(parseCarbonPrices(SNAP), "2026-09-11");
  const byId = Object.fromEntries(rows.map((r) => [r.series, r]));

  assert.deepEqual(
    rows.map((r) => r.series).sort(),
    ["euets:allowance", "lcfs:by-program:CA", "lcfs:by-program:OR"]
  );
  // LCFS members share the family prefix so the snapshot renders them as one cross-section line.
  for (const t of ["CA", "OR"]) {
    assert.equal(byId[`lcfs:by-program:${t}`].meta.family, "lcfs:by-program");
    assert.equal(byId[`lcfs:by-program:${t}`].meta.unit, "$/t CO2e");
    assert.equal(byId[`lcfs:by-program:${t}`].meta.category, "carbon_prices");
    assert.equal(byId[`lcfs:by-program:${t}`].period, "2026-09-11");
  }
  // EU-ETS is a standalone series (no family), in its own currency unit.
  assert.equal(byId["euets:allowance"].meta.family, undefined);
  assert.equal(byId["euets:allowance"].meta.unit, "€/t CO2e");
  assert.equal(byId["euets:allowance"].value, 60.43);
});

test("toSeriesRows emits nothing for an empty parse (so fetchSeries skips the email)", () => {
  assert.deepEqual(toSeriesRows({ lcfs: [], euets: null }, "2026-09-11"), []);
});
