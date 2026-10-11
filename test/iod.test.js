// test/iod.test.js — #52: parseDmi() and iodPhase() unit tests.
import test from "node:test";
import assert from "node:assert/strict";
import { parseDmi, iodPhase } from "../src/adapters/cpc_outlook.js";

const SAMPLE_DMI = `
YEAR  JAN  FEB  MAR  APR  MAY  JUN  JUL  AUG  SEP  OCT  NOV  DEC
2020  0.12  0.05 -0.08  0.20  0.15  0.35  0.61  0.88  0.95  0.72  0.45  0.21
2021 -0.32 -0.41 -0.18  0.04  0.08  0.12  0.28  0.10 -0.05 -0.22 -0.38 -0.41
2022  0.02  0.10  0.05  0.18  0.25  0.42  0.68  0.91  0.88  0.55  0.31  0.08
`;

test("iod: parseDmi returns sorted monthly points", () => {
  const pts = parseDmi(SAMPLE_DMI);
  assert.ok(pts.length > 0, "should parse some points");
  // All periods should be valid YYYY-MM
  for (const p of pts) assert.match(p.period, /^\d{4}-\d{2}$/, `bad period: ${p.period}`);
  // Should be sorted chronologically
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].period >= pts[i-1].period, "must be sorted ascending");
  }
});

test("iod: parseDmi extracts correct values", () => {
  const pts = parseDmi(SAMPLE_DMI);
  const jan2020 = pts.find(p => p.period === "2020-01");
  assert.ok(jan2020, "should have Jan 2020");
  assert.equal(jan2020.value, 0.12);
  const sep2020 = pts.find(p => p.period === "2020-09");
  assert.ok(sep2020, "should have Sep 2020");
  assert.equal(sep2020.value, 0.95);
});

test("iod: parseDmi skips missing values (-999.9)", () => {
  // Full 12-month row; FEB is -999.9 (missing marker)
  const text = "YEAR  JAN  FEB  MAR  APR  MAY  JUN  JUL  AUG  SEP  OCT  NOV  DEC\n" +
               "2020  0.12  -999.9  0.05  0.20  0.15  0.35  0.61  0.88  0.95  0.72  0.45  0.21\n";
  const pts = parseDmi(text);
  assert.equal(pts.filter(p => p.period === "2020-01").length, 1, "valid JAN should be kept");
  assert.equal(pts.filter(p => p.period === "2020-02").length, 0, "-999.9 missing marker must be skipped");
  assert.equal(pts.filter(p => p.period === "2020-03").length, 1, "valid MAR should be kept");
});

test("iod: parseDmi returns [] for empty or junk input", () => {
  assert.deepEqual(parseDmi(""), []);
  assert.deepEqual(parseDmi("not a dmi file"), []);
  assert.deepEqual(parseDmi(null), []);
});

test("iod: iodPhase identifies positive IOD (DMI ≥ +0.4)", () => {
  assert.equal(iodPhase(0.4), "positive");
  assert.equal(iodPhase(0.95), "positive");
  assert.equal(iodPhase(1.5), "positive");
});

test("iod: iodPhase identifies negative IOD (DMI ≤ -0.4)", () => {
  assert.equal(iodPhase(-0.4), "negative");
  assert.equal(iodPhase(-0.9), "negative");
});

test("iod: iodPhase identifies neutral IOD (|DMI| < 0.4)", () => {
  assert.equal(iodPhase(0.0), "neutral");
  assert.equal(iodPhase(0.39), "neutral");
  assert.equal(iodPhase(-0.39), "neutral");
});

test("iod: iodPhase handles null/non-finite gracefully", () => {
  assert.equal(iodPhase(null), "neutral");
  assert.equal(iodPhase(undefined), "neutral");
  assert.equal(iodPhase(NaN), "neutral");
});
