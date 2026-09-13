// Tests for the RIN-price adapter's pure parsing. The live IMAP path (EcoEngineers "Carbon Markets
// Snapshot" in the collector inbox) is confirmed on the Pi via scripts/probe-rin-email.mjs; these lock
// the matrix parse + the timezone-proof snapshot date against the real email content.

import test from "node:test";
import assert from "node:assert/strict";

const rin = await import("../src/adapters/banyan_rin.js");
const { parseRinMatrix, snapshotDate } = rin.__test;

// Shaped like emailBodyToText's single-lined output: the headline (year → D-code headers → values) then
// the "Daily Full RIN Update" vintage × D-code matrix (the values EcoEngineers actually sent 2026-09-11).
const SNAP =
  "Carbon Markets Snapshot September 11, 2026 " +
  "US$ per RIN (Renewable Fuel Standard) 2026 D3 D4 D5 D6 $2.370 $2.169 $2.160 $2.112 " +
  "California Low Carbon Fuel Standard (LCFS) Credit $84.50 " +
  "Daily Full RIN Update US$ per RIN (Renewable Fuel Standard) " +
  "2024 $2.300 $2.105 $2.095 $2.040 " +
  "2025 $2.350 $2.140 $2.130 $2.079 " +
  "2026 $2.370 $2.169 $2.160 $2.112 " +
  "D-Code D3 D4 D5 D6";

test("snapshotDate reads the headline date (timezone-proof); null when absent", () => {
  assert.equal(snapshotDate(SNAP), "2026-09-11");
  assert.equal(snapshotDate("no date here"), null);
});

test("parseRinMatrix captures every vintage × D-code cell — and only the matrix, not the headline", () => {
  const cells = parseRinMatrix(SNAP);
  assert.equal(cells.length, 12, "3 vintages × 4 D-codes"); // headline 2026 row must not double-count
  const get = (vintage, dcode) => cells.find((c) => c.vintage === vintage && c.dcode === dcode)?.value;
  assert.equal(get("2024", "d3"), 2.3);
  assert.equal(get("2024", "d6"), 2.04);
  assert.equal(get("2025", "d4"), 2.14);
  assert.equal(get("2026", "d3"), 2.37);
  assert.equal(get("2026", "d4"), 2.169);
  assert.equal(get("2026", "d6"), 2.112);
  assert.equal(cells.filter((c) => c.vintage === "2026" && c.dcode === "d4").length, 1);
});

test("parseRinMatrix survives ESP HTML that glues the values within a row", () => {
  // cheerio .text() on tightly-packed table HTML can drop the spaces between value cells (rows still
  // separated). The bounded value pattern must split "$2.300$2.105…" back into four distinct prices.
  const glued = "Daily Full RIN Update 2024 $2.300$2.105$2.095$2.040 2025 $2.350$2.140$2.130$2.079 D-Code D3 D4 D5 D6";
  const cells = parseRinMatrix(glued);
  assert.equal(cells.length, 8); // 2 vintages × 4
  const get = (v, d) => cells.find((c) => c.vintage === v && c.dcode === d)?.value;
  assert.equal(get("2024", "d3"), 2.3);
  assert.equal(get("2024", "d6"), 2.04);
  assert.equal(get("2025", "d3"), 2.35);
  assert.equal(get("2025", "d6"), 2.079);
});

test("parseRinMatrix honors a non-standard D-code header order", () => {
  const t = "Daily Full RIN Update 2026 $2.112 $2.160 $2.169 $2.370 D-Code D6 D5 D4 D3";
  const cells = parseRinMatrix(t);
  const get = (d) => cells.find((c) => c.dcode === d)?.value;
  assert.equal(get("d6"), 2.112);
  assert.equal(get("d3"), 2.37);
});

test("parseRinMatrix is fail-soft when there is no RIN table", () => {
  assert.deepEqual(parseRinMatrix("just newsletter prose, no table"), []);
  assert.deepEqual(parseRinMatrix(""), []);
});
