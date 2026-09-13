// Tests for the Step 7 leading-indicator adapters (§2 rows 6–7): NOAA CPC ENSO (ONI) and the
// Mississippi river-stage feed. Both are keyless and reachable, but the unit tests lock the PURE parsers
// against fixtures (no network) — the live shapes were confirmed against the real endpoints separately.

import test from "node:test";
import assert from "node:assert/strict";

const cpc = await import("../src/adapters/cpc_outlook.js");
const river = await import("../src/adapters/river_stage.js");

// ---------------------------------------------------------------------------
// CPC ONI (row 6)
// ---------------------------------------------------------------------------
const ONI_FIXTURE = ` SEAS  YR   TOTAL   ANOM
  DJF 1950  25.01  -1.32
  MAM 2020  27.00  -0.50
  JJA 2026  29.09   1.80
  ASO 2026  29.20   1.55
`;

test("parseOni maps 3-month seasons to centre months, skips the header, keeps sign", () => {
  const pts = cpc.__test.parseOni(ONI_FIXTURE);
  assert.deepEqual(pts, [
    { period: "1950-01", value: -1.32 }, // DJF → Jan
    { period: "2020-04", value: -0.5 },  // MAM → Apr
    { period: "2026-07", value: 1.8 },   // JJA → Jul
    { period: "2026-09", value: 1.55 },  // ASO → Sep
  ]);
});

test("parseOni returns [] for empty / headers-only input", () => {
  assert.deepEqual(cpc.__test.parseOni(""), []);
  assert.deepEqual(cpc.__test.parseOni(" SEAS  YR   TOTAL   ANOM\n"), []);
  assert.deepEqual(cpc.__test.parseOni(null), []);
});

test("ensoPhase applies the ±0.5 °C convention", () => {
  assert.equal(cpc.__test.ensoPhase(1.8), "El Niño");
  assert.equal(cpc.__test.ensoPhase(0.5), "El Niño");
  assert.equal(cpc.__test.ensoPhase(0.2), "neutral");
  assert.equal(cpc.__test.ensoPhase(-0.5), "La Niña");
  assert.equal(cpc.__test.ensoPhase(-1.32), "La Niña");
  assert.equal(cpc.__test.ensoPhase(null), "neutral");
});

// ---------------------------------------------------------------------------
// Mississippi river stage (row 7)
// ---------------------------------------------------------------------------
test("dailyStage reduces hourly observed to a daily mean, drops sentinels, sorts", () => {
  const observed = {
    data: [
      { validTime: "2026-09-12T00:00:00Z", primary: 5.0 },
      { validTime: "2026-09-12T12:00:00Z", primary: 7.0 }, // 09-12 mean = 6.0
      { validTime: "2026-09-13T06:00:00Z", primary: -4.63 },
      { validTime: "2026-09-11T06:00:00Z", primary: -999 }, // sentinel → whole day dropped
      { validTime: "2026-09-10T06:00:00Z", primary: 2.0 },
    ],
  };
  assert.deepEqual(river.__test.dailyStage(observed), [
    { period: "2026-09-10", value: 2.0 },
    { period: "2026-09-12", value: 6.0 },
    { period: "2026-09-13", value: -4.63 },
  ]);
});

test("dailyStage is empty for missing/blank observed", () => {
  assert.deepEqual(river.__test.dailyStage(null), []);
  assert.deepEqual(river.__test.dailyStage({ data: [] }), []);
  assert.deepEqual(river.__test.dailyStage({ data: [{ validTime: "2026-09-01T00:00:00Z", primary: -999 }] }), []);
});

test("river gauges are the lower-Mississippi barge-corridor chokepoints", () => {
  const lids = river.__test.GAUGES.map((g) => g.lid);
  assert.deepEqual(lids, ["MEMT1", "VCKM6", "BTRL1", "NORL1"]);
});
