// Tests for the RIN-price adapter's pure parsing. The fixture is the REAL emailBodyToText output of the
// EcoEngineers "Carbon Markets Snapshot" (uid 1043, 2026-09-11), confirmed on the Pi via
// scripts/probe-rin-email.mjs: a current-vintage headline block ("… 2026 D3 $x D4 $x …") plus the full
// D-code-major "Daily Full RIN Update" matrix ("… 2024 2025 2026 D3 $x $x $x …").

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
  "EU€ per Metric Ton of CO2e (EU ETS Allowance) Source: EMBER " +
  "Daily Full RIN Update D-Code US$ per RIN (Renewable Fuel Standard) 2024 2025 2026 " +
  "D3 $2.300 $2.350 $2.370 D4 $2.105 $2.140 $2.169 D5 $2.095 $2.130 $2.160 D6 $2.040 $2.079 $2.112 " +
  "EcoEngineers provides this data for information purposes only.";

test("snapshotDate reads the headline date (timezone-proof); null when absent", () => {
  assert.equal(snapshotDate(SNAP), "2026-09-11");
  assert.equal(snapshotDate("no date here"), null);
});

test("parseRinPrices captures every vintage × D-code cell from the full matrix (incl. 2025)", () => {
  const cells = parseRinPrices(SNAP);
  assert.equal(cells.length, 12, "3 vintages × 4 D-codes, deduped across headline + matrix");
  const get = (v, d) => cells.find((c) => c.vintage === v && c.dcode === d)?.value;
  // 2024
  assert.equal(get("2024", "d3"), 2.3);
  assert.equal(get("2024", "d6"), 2.04);
  // 2025 — the vintage 1.37.1 silently dropped
  assert.equal(get("2025", "d3"), 2.35);
  assert.equal(get("2025", "d4"), 2.14);
  assert.equal(get("2025", "d6"), 2.079);
  // 2026 (headline + matrix agree)
  assert.equal(get("2026", "d3"), 2.37);
  assert.equal(get("2026", "d4"), 2.169);
  assert.equal(get("2026", "d6"), 2.112);
  // exactly one 2026:d4 (headline/matrix dedup)
  assert.equal(cells.filter((c) => c.vintage === "2026" && c.dcode === "d4").length, 1);
});

test("parseRinPrices does not mistake LCFS/CFP credits (2-decimal, no D-code) for RIN prices", () => {
  const cells = parseRinPrices(SNAP);
  assert.ok(cells.every((c) => c.value !== 122 && c.value !== 84.5), "no LCFS/CFP value leaks in");
  assert.ok(cells.every((c) => /^d[3-9]$/.test(c.dcode)), "every cell is a real D-code");
});

test("parseRinPrices handles a headline-only block (single vintage, one price per D-code)", () => {
  const t = "US$ per RIN (Renewable Fuel Standard) 2026 D3 $2.370 D4 $2.169 D5 $2.160 D6 $2.112 US$ per Metric Ton";
  const cells = parseRinPrices(t);
  assert.equal(cells.length, 4);
  assert.ok(cells.every((c) => c.vintage === "2026"));
  assert.equal(cells.find((c) => c.dcode === "d4")?.value, 2.169);
});

test("parseRinPrices is fail-soft when there is no RIN block", () => {
  assert.deepEqual(parseRinPrices("Upcoming Webinars — Register here for our next session"), []);
  assert.deepEqual(parseRinPrices(""), []);
});
