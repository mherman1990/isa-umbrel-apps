// Tests for the RIN-price adapter's pure parsing. The fixture is the REAL emailBodyToText output of the
// EcoEngineers "Carbon Markets Snapshot" (uid 1043, 2026-09-11), confirmed on the Pi via
// scripts/probe-rin-email.mjs — inline "D<n> $<price>" pairs, not a separate header/values layout.

import test from "node:test";
import assert from "node:assert/strict";

const rin = await import("../src/adapters/banyan_rin.js");
const { parseRinPrices, snapshotDate } = rin.__test;

const SNAP =
  "Daily pricing insights of the latest RIN, LCFS, CFP, EU ETS, and Voluntary market trading prices. " +
  "Carbon Markets Snapshot September 11, 2026 " +
  "US$ per RIN (Renewable Fuel Standard) 2026 D3 $2.370 D4 $2.169 D5 $2.160 D6 $2.112 " +
  "US$ per Metric Ton of CO2e (State LCFS Programs) Oregon Clean Fuels Program (CFP) Credit $122.00 " +
  "California Low Carbon Fuel Standard (LCFS) Credit $84.50 " +
  "EU€ per Metric Ton of CO2e (EU ETS Allowance) Source: EMBER";

test("snapshotDate reads the headline date (timezone-proof); null when absent", () => {
  assert.equal(snapshotDate(SNAP), "2026-09-11");
  assert.equal(snapshotDate("no date here"), null);
});

test("parseRinPrices reads the inline D-code/price pairs for the block's vintage", () => {
  const cells = parseRinPrices(SNAP);
  assert.equal(cells.length, 4); // D3–D6, current vintage
  const get = (d) => cells.find((c) => c.dcode === d && c.vintage === "2026")?.value;
  assert.equal(get("d3"), 2.37);
  assert.equal(get("d4"), 2.169);
  assert.equal(get("d5"), 2.16);
  assert.equal(get("d6"), 2.112);
});

test("parseRinPrices does not mistake LCFS/CFP credits (2-decimal, no D-code) for RIN prices", () => {
  const cells = parseRinPrices(SNAP);
  assert.ok(cells.every((c) => c.value !== 122 && c.value !== 84.5), "no LCFS/CFP value leaks in");
  assert.ok(cells.every((c) => /^d[3-9]$/.test(c.dcode)), "every cell is a real D-code");
});

test("parseRinPrices captures multiple vintages when the report lists inline per-vintage blocks", () => {
  const t =
    "US$ per RIN (Renewable Fuel Standard) 2026 D3 $2.370 D4 $2.169 D5 $2.160 D6 $2.112 " +
    "Daily Full RIN Update US$ per RIN (Renewable Fuel Standard) 2025 D3 $2.350 D4 $2.140 D5 $2.130 D6 $2.079";
  const cells = parseRinPrices(t);
  assert.equal(cells.length, 8);
  assert.equal(cells.find((c) => c.vintage === "2025" && c.dcode === "d4")?.value, 2.14);
  assert.equal(cells.find((c) => c.vintage === "2026" && c.dcode === "d4")?.value, 2.169);
});

test("parseRinPrices is fail-soft when there is no RIN block", () => {
  assert.deepEqual(parseRinPrices("Upcoming Webinars — Register here for our next session"), []);
  assert.deepEqual(parseRinPrices(""), []);
});
