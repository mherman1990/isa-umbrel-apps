// leadlag.js must pair each period with the value KNOWN THEN (its first print), never the value USDA
// later revised into existence — otherwise the scan has lookahead bias (§1.4). This locks that: after a
// wholesale revision of a predictor's latest values, the scan's output is byte-for-byte unchanged,
// because it reads the first-print vintage, not market_series' latest.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-leadlag-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const { __test } = await import("../src/leadlag.js");
const { computeLeadLag } = __test;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Daily price ("cbot:zs:front" is leadlag's target) across the predictor's whole range so pairs form.
function seedPrice() {
  const pts = [];
  const start = Date.UTC(2021, 0, 1);
  for (let i = 0; i < 1500; i++) {
    const period = new Date(start + i * 864e5).toISOString().slice(0, 10);
    pts.push({ period, value: 1000 + 40 * Math.sin(i / 25) + i * 0.05 });
  }
  store.saveSeriesPoints("cbot:zs:front", { label: "ZS front", unit: "cents/bu", category: "px" }, pts);
}

const monthlyPeriods = () => {
  const out = [];
  for (let y = 2021; y <= 2024; y++) for (let m = 1; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
};

test("leadlag reads predictors at first print — a later revision does not move the scan", async () => {
  seedPrice();
  const periods = monthlyPeriods();

  // First prints (sequence A): a genuinely varying series, so the scan has a defined correlation.
  store.saveSeriesPoints("fund:test", { label: "Fund test", unit: "u", category: "z" },
    periods.map((p, i) => ({ period: p, value: 100 + 30 * Math.sin(i / 4) })));

  const before = computeLeadLag();
  assert.ok(before.nearMiss && before.nearMiss.series === "fund:test", "the predictor is the tested series");
  assert.ok(before.nearMiss.n >= 30, "enough pairs to be meaningful");

  // A later refresh REVISES every latest value to a clearly different shape (B: a steep downtrend).
  // market_series' latest changes; the first-print vintage (A) does not.
  await sleep(3);
  store.saveSeriesPoints("fund:test", { label: "Fund test", unit: "u", category: "z" },
    periods.map((p, i) => ({ period: p, value: 500 - 12 * i + 5 * Math.cos(i / 3) })));

  // Sanity: the latest genuinely changed, but the first vintage did not.
  assert.notEqual(
    store.getSeries("fund:test").at(-1).value,
    store.getSeriesFirstVintage("fund:test").at(-1).value,
    "the revision really did change the latest value"
  );

  const after = computeLeadLag();
  assert.equal(after.nearMiss.r, before.nearMiss.r, "nearMiss r identical → scan used the first print, not the revision");
  assert.equal(after.nearMiss.n, before.nearMiss.n, "pair count identical");
  assert.deepEqual(after.leads, before.leads, "reported leads unchanged by the revision");
});
