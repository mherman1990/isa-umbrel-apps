// Tests for the oil/meal share of crush product value (Markets "Crush value share" chart). The share is
// derived at read time from the stored product legs, so these lock the arithmetic (workbook yields, oil
// vs. meal only, the pair sums to 100), the date alignment (a point needs BOTH legs), and the
// board + Iowa-cash pairing the chart and CSV read.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-crush-share-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const { productShareSeries, __test } = await import("../src/crush.js");
const { oilSharePoints } = __test;

test("oil share ties out to the workbook's 2026-07-15 board figures", () => {
  // meal 319.10 $/ton × 0.0221 = 7.052; oil 72.9¢/lb × 11.71 = 8.537 → 8.537 / 15.589 = 54.76%
  const [p] = oilSharePoints([{ period: "2026-07-15", value: 319.1 }], [{ period: "2026-07-15", value: 72.9 }]);
  assert.equal(p.period, "2026-07-15");
  assert.equal(p.value, 54.76);
});

test("only dates carrying both legs produce a point, sorted oldest first", () => {
  const meal = [
    { period: "2026-07-03", value: 300 },
    { period: "2026-07-01", value: 300 },
    { period: "2026-07-02", value: 300 },
  ];
  const oil = [
    { period: "2026-07-01", value: 70 },
    { period: "2026-07-03", value: 70 },
    { period: "2026-07-04", value: 70 },
  ];
  assert.deepEqual(oilSharePoints(meal, oil).map((p) => p.period), ["2026-07-01", "2026-07-03"]);
});

test("non-positive legs are skipped rather than producing a 0% or 100% share", () => {
  const pts = oilSharePoints(
    [{ period: "2026-07-01", value: 0 }, { period: "2026-07-02", value: 300 }],
    [{ period: "2026-07-01", value: 70 }, { period: "2026-07-02", value: 0 }]
  );
  assert.deepEqual(pts, []);
});

test("productShareSeries: nothing stored → no series (chart hides itself)", () => {
  assert.deepEqual(productShareSeries(), []);
});

test("productShareSeries: board + Iowa cash oil/meal pairs that sum to 100", () => {
  store.saveSeriesPoints("cbot:zm:front", { label: "m", unit: "$/ton", category: "soy_products" }, [
    { period: "2026-07-14", value: 320 },
    { period: "2026-07-15", value: 319.1 },
  ]);
  store.saveSeriesPoints("cbot:zl:front", { label: "o", unit: "¢/lb", category: "soy_products" }, [
    { period: "2026-07-14", value: 73.4 },
    { period: "2026-07-15", value: 72.9 },
  ]);
  store.saveSeriesPoints("ams:ia:meal", { label: "m", unit: "$/ton", category: "soy_products_cash" }, [{ period: "2026-07-20", value: 334.5 }]);
  store.saveSeriesPoints("ams:ia:oil", { label: "o", unit: "¢/lb", category: "soy_products_cash" }, [{ period: "2026-07-20", value: 77.61 }]);

  const s = productShareSeries();
  assert.deepEqual(s.map((x) => x.label), ["Board oil share", "Board meal share", "Iowa cash oil share", "Iowa cash meal share"]);
  assert.ok(s.every((x) => x.unit === "%"));
  for (let i = 0; i < s.length; i += 2) {
    s[i].points.forEach((p, j) => assert.equal(Math.round((p.value + s[i + 1].points[j].value) * 100) / 100, 100));
  }
  assert.equal(s[0].points.at(-1).value, 54.76);
});
