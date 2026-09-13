// Tests for the crush_capacity.json staleness guard (plan housekeeping item). A hand-maintained
// capacity table silently going stale understates nameplate and OVERSTATES utilization — the same
// inversion that retired the old volume scorer — so capacityStaleness() must catch it via BOTH the
// table's age and a physical "observed crush above realistic-max" tell, and never false-fire on a fresh
// table or the trailing-max fallback.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-crush-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const { __test } = await import("../src/crush.js");
const { capacityStaleness } = __test;

const NOW = new Date("2026-09-13T00:00:00Z");
const FRESH = { asOf: "2026-07-15", currentTotalBuPerDay: 8557000, benchmarks: { realisticMax: 0.91 }, capacityAdditions: [] };
const nameplate = (...us) => us.map((u) => ({ basis: "nameplate", utilization: u }));

test("not stale: a recent table with normal utilization", () => {
  const r = capacityStaleness({ now: NOW, cap: FRESH, series: nameplate(0.83, 0.84, 0.85) });
  assert.equal(r.present, true);
  assert.equal(r.stale, false);
  assert.ok(r.ageMonths >= 1 && r.ageMonths <= 3, `asOf ~2mo → ageMonths ${r.ageMonths}`);
  assert.deepEqual(r.reasons, []);
});

test("stale by AGE: asOf older than the threshold", () => {
  const r = capacityStaleness({ now: NOW, cap: { ...FRESH, asOf: "2025-06-01" }, series: nameplate(0.84) });
  assert.equal(r.stale, true);
  assert.ok(r.reasons.some((x) => /months ago/.test(x)), r.reasons.join(" | "));
});

test("stale when asOf is unreadable (age can't be checked)", () => {
  const r = capacityStaleness({ now: NOW, cap: { ...FRESH, asOf: "n/a" }, series: nameplate(0.84) });
  assert.equal(r.stale, true);
  assert.ok(r.reasons.some((x) => /readable asOf/.test(x)));
});

test("stale EMPIRICALLY: observed crush at/above realistic-max, even with a fresh date", () => {
  const r = capacityStaleness({ now: NOW, cap: FRESH, series: nameplate(0.86, 0.93) }); // 0.93 ≥ 0.91
  assert.equal(r.stale, true);
  assert.ok(r.reasons.some((x) => /realistic-max/.test(x)), r.reasons.join(" | "));
});

test("the empirical tell uses only the last 6 nameplate points", () => {
  // An old 0.95 spike outside the trailing-6 window must not keep flagging once it ages out.
  const r = capacityStaleness({ now: NOW, cap: FRESH, series: nameplate(0.95, 0.80, 0.81, 0.82, 0.83, 0.84, 0.85) });
  assert.equal(r.stale, false);
});

test("trailing-max fallback points never trigger the empirical tell", () => {
  const series = [{ basis: "trailing-max", utilization: 1.0 }, { basis: "trailing-max", utilization: 0.99 }];
  assert.equal(capacityStaleness({ now: NOW, cap: FRESH, series }).stale, false);
});

test("an absent table is not 'stale' — the trailing-max fallback owns that path", () => {
  assert.deepEqual(capacityStaleness({ now: NOW, cap: null, series: [] }), {
    present: false, stale: false, ageMonths: null, asOf: null, reasons: [],
  });
});
