// Unit tests for the Brazil ComexStat adapter's pure transforms (§2 row 5). These lock the row→points
// shaping, the kg→tonnes and FOB unit-value math, and the China-share join. The live query schema
// (filters/details/metrics) was confirmed against the real api-comexstat.mdic.gov.br endpoint separately.

import test from "node:test";
import assert from "node:assert/strict";

const cx = await import("../src/adapters/comexstat.js");

// Shaped like real ComexStat rows (all-string metrics).
const TOTAL = [
  { year: "2025", monthNumber: "08", metricFOB: "3870000000", metricKG: "9330000000" },
  { year: "2025", monthNumber: "06", metricFOB: "5340000000", metricKG: "13420000000" },
  { year: "2025", monthNumber: "13", metricFOB: "1", metricKG: "1" },   // bad month → skipped
  { year: "abcd", monthNumber: "07", metricFOB: "1", metricKG: "1" },   // bad year → skipped
];
const CHINA = [
  { year: "2025", monthNumber: "08", metricKG: "7930000000" },
  { year: "2025", monthNumber: "06", metricKG: "11000000000" },
];

test("rowsToPoints builds sorted YYYY-MM points and skips malformed rows", () => {
  const pts = cx.__test.rowsToPoints(TOTAL, cx.__test.kgToTonnes);
  assert.deepEqual(pts, [
    { period: "2025-06", value: 13420000 },
    { period: "2025-08", value: 9330000 },
  ]);
});

test("kgToTonnes divides kg by 1000; unitValue is FOB/kg×1000 ($/t)", () => {
  assert.equal(cx.__test.kgToTonnes({ metricKG: "9330000000" }), 9330000);
  assert.equal(cx.__test.kgToTonnes({ metricKG: "" }), null);
  assert.equal(cx.__test.unitValue({ metricFOB: "3870000000", metricKG: "9330000000" }), 414.79);
  assert.equal(cx.__test.unitValue({ metricFOB: "100", metricKG: "0" }), null); // no divide-by-zero
});

test("chinaSharePoints joins by period → percent, skipping periods absent from the total", () => {
  const totalVol = cx.__test.rowsToPoints(TOTAL, cx.__test.kgToTonnes);
  const chinaVol = cx.__test.rowsToPoints(CHINA, cx.__test.kgToTonnes);
  const share = cx.__test.chinaSharePoints(totalVol, chinaVol);
  assert.deepEqual(share, [
    { period: "2025-06", value: 82.0 }, // 11.0 / 13.42
    { period: "2025-08", value: 85.0 }, // 7.93 / 9.33
  ]);
});

test("empty / missing inputs are handled", () => {
  assert.deepEqual(cx.__test.rowsToPoints(null, cx.__test.kgToTonnes), []);
  assert.deepEqual(cx.__test.chinaSharePoints([], []), []);
});

// Outage propagation (Codex #17, P2): a genuine exhausted-retry failure must escape fetchSeries/fetchItems
// so refreshMarketSeries flags the layer unavailable / collect marks the source skipped — rather than a
// silent [] that reads as a successful empty refresh and leaves stale Brazil values looking current.
test("fetchSeries propagates an exhausted-retry failure (does not swallow to [])", async () => {
  await assert.rejects(
    () => cx.fetchSeries({ pull: async () => { throw new Error("SECEX unreachable"); } }),
    /SECEX unreachable/
  );
});

test("fetchItems propagates an exhausted-retry failure too", async () => {
  await assert.rejects(
    () => cx.fetchItems({ pull: async () => { throw new Error("SECEX unreachable"); } }),
    /SECEX unreachable/
  );
});

test("fetchSeries returns [] on a legitimate empty response, not on an error", async () => {
  const out = await cx.fetchSeries({ pull: async () => ({ total: [], china: [] }) });
  assert.deepEqual(out, []);
});

test("fetchSeries shapes the four Brazil series from pulled rows", async () => {
  const out = await cx.fetchSeries({ pull: async () => ({ total: TOTAL, china: CHINA }) });
  assert.deepEqual(
    out.map((s) => s.series).sort(),
    ["comex:br:soy-export-price", "comex:br:soy-exports", "comex:br:soy-exports-china", "comex:br:soy-exports-china-share"]
  );
});
