// Tests for the assembled U.S. soybean balance sheet + the house nowcast (§1.6 / §1.2).
//
// The pure assembler and the two projection functions are tested against hand-built inputs (projectCrush
// / projectExports take an injectable getSeries). The house nowcast is tested end-to-end against the real
// store + pipeline.computeSurprises, proving surprise = actual − house settles once the next WASDE lands.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-balance-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const bs = await import("../src/balancesheet.js");
const { computeSurprises } = await import("../src/pipeline.js");

// A WASDE line whose supply − use equals ending stocks (a clean identity), mln bu.
const WASDE = { beginStocks: 350, production: 4600, imports: 25, crush: 2410, exports: 1685, seed: 100, residual: 15, endStocks: 765, stocksToUse: 17.0 };

test("assembleBalance builds the identity and the overlay's implied carryout + delta", () => {
  const a = bs.assembleBalance(WASDE, { projectedCrush: 2460, projectedExports: 1715 });
  assert.equal(a.supply, 4975); // 350 + 4600 + 25
  assert.equal(a.use, 4210); // 2410 + 1685 + 100 + 15
  assert.equal(a.identityGap, 0); // supply − use == ending stocks
  assert.equal(a.crushDelta, 50);
  assert.equal(a.exportsDelta, 30);
  assert.equal(a.impliedCarryout, 685); // 765 − 50 − 30 (more crush/exports → tighter)
  assert.equal(a.carryoutDelta, -80);
  assert.ok(a.impliedStocksToUse < a.wasdeStocksToUse, "tighter carryout → lower stocks-to-use");
});

test("assembleBalance with no overlay leaves the house equal to WASDE", () => {
  const a = bs.assembleBalance(WASDE, {});
  assert.equal(a.hasOverlay, false);
  assert.equal(a.impliedCarryout, a.wasdeCarryout);
  assert.equal(a.carryoutDelta, 0);
});

test("assembleBalance degrades: missing supply components → null supply, carryout still anchored", () => {
  const a = bs.assembleBalance({ crush: 2410, exports: 1685, seed: 100, residual: 15, endStocks: 765 }, {});
  assert.equal(a.supply, null);
  assert.equal(a.use, 4210);
  assert.equal(a.wasdeCarryout, 765);
  assert.equal(a.identityGap, null); // can't check identity without supply
});

// --- projection functions (pure via injected getSeries) --------------------------------------------
const monthly = (startYM, n, val) => {
  let [y, m] = startYM.split("-").map(Number);
  return Array.from({ length: n }, () => { const p = `${y}-${String(m).padStart(2, "0")}`; m++; if (m > 12) { m = 1; y++; } return { period: p, value: val }; });
};

test("projectCrush scales WASDE crush by the observed YoY marketing-year pace", () => {
  // Two full MY-to-date windows: last MY at 1000/mo, this MY at 1100/mo → pace +10%.
  const lastMY = monthly("2024-09", 11, 1000); // Sep2024..Jul2025
  const thisMY = monthly("2025-09", 11, 1100); // Sep2025..Jul2026 (latest = 2026-07)
  const getSeries = () => [...lastMY, ...thisMY];
  const r = bs.projectCrush(2410, getSeries);
  assert.ok(r, "projection returned");
  assert.ok(Math.abs(r.paceRatio - 1.1) < 1e-9, `paceRatio ~1.1, got ${r.paceRatio}`);
  assert.ok(Math.abs(r.value - 2651) < 1e-6, `2410 × 1.1 = 2651, got ${r.value}`);
});

test("projectCrush returns null when a marketing-year window is incomplete", () => {
  assert.equal(bs.projectCrush(2410, () => monthly("2025-09", 6, 1100)), null); // only one partial MY
});

test("projectExports scales WASDE exports by the YoY commitments pace at the same week", () => {
  // 60 weekly cumulative points; the point exactly 52 weeks before the latest is the YoY comparator.
  const start = Date.UTC(2025, 5, 6);
  const pts = Array.from({ length: 60 }, (_, i) => ({ period: new Date(start + i * 7 * 864e5).toISOString().slice(0, 10), value: 1000 + i }));
  pts[7].value = 20000; // ~52 weeks before index 59
  pts[59].value = 21000;
  const r = bs.projectExports(1685, () => pts);
  assert.ok(r, "projection returned");
  assert.ok(Math.abs(r.paceRatio - 1.05) < 1e-9, `paceRatio 1.05, got ${r.paceRatio}`);
  assert.ok(Math.abs(r.value - 1769.25) < 1e-6, `1685 × 1.05, got ${r.value}`);
});

// --- live assembly + house nowcast against the real store ------------------------------------------
function seedWasdeLine(period = "2026-09") {
  const S = (comp, value) => store.saveSeriesPoints(`wasde:us:soy-${comp}`, { label: comp, unit: "mln bu", category: "soy_balance" }, [{ period, value }]);
  S("begin-stocks", WASDE.beginStocks); S("production", WASDE.production); S("imports", WASDE.imports);
  S("crush", WASDE.crush); S("exports", WASDE.exports); S("seed", WASDE.seed); S("residual", WASDE.residual);
  S("endstocks", WASDE.endStocks); S("stocks-to-use", WASDE.stocksToUse);
}
function seedRunRates() {
  store.saveSeriesPoints("nass:us:crush", { label: "crush", unit: "tons", category: "soy_crush" },
    [...monthly("2024-09", 11, 1000), ...monthly("2025-09", 11, 1100)]);
  const start = Date.UTC(2025, 5, 6);
  const pts = Array.from({ length: 60 }, (_, i) => ({ period: new Date(start + i * 7 * 864e5).toISOString().slice(0, 10), value: 1000 + i }));
  pts[7].value = 20000; pts[59].value = 21000;
  store.saveSeriesPoints("fas:soybeans:commitments", { label: "China", unit: "MT", category: "export_commitments" }, pts);
}

test("usSoyBalanceSheet assembles the live line and balanceSheetText renders it", () => {
  seedWasdeLine();
  seedRunRates();
  const b = bs.usSoyBalanceSheet();
  assert.equal(b.asOf, "2026-09");
  assert.equal(b.wasdeCarryout, 765);
  assert.ok(b.hasOverlay, "crush + commitments pace present → overlay active");
  assert.ok(b.impliedCarryout < 765, "observed pace running hot → tighter than WASDE");
  const text = bs.balanceSheetText();
  assert.match(text, /U\.S\. SOYBEAN BALANCE SHEET/);
  assert.match(text, /ending stocks 765 mln bu/);
  assert.match(text, /HOUSE NOWCAST/);
  assert.match(text, /implied carryout/);
});

test("houseNowcasts files a scoreable prior that computeSurprises settles against the next WASDE", () => {
  seedWasdeLine("2026-09");
  seedRunRates();
  const h = bs.houseNowcasts();
  assert.equal(h.upserted, 1);
  assert.equal(h.reportDate, "2026-10-01", "scored against the NEXT monthly release, not the current one");

  const open = store.openExpectations().find((e) => e.source === "house" && e.dedupe_key === `house:soy-carryout:2026-10-01`);
  assert.ok(open, "house expectation is on the open book");
  assert.equal(open.series, "wasde:us:soy-endstocks");
  assert.equal(open.est_avg, h.estAvg);

  // The next WASDE lands with ending stocks of 700 → surprise = 700 − house.
  store.saveSeriesPoints("wasde:us:soy-endstocks", { label: "endstocks", unit: "mln bu", category: "soy_balance" }, [{ period: "2026-10", value: 700 }]);
  computeSurprises();

  const settled = store.listExpectations({ settledOnly: true }).find((e) => e.dedupe_key === `house:soy-carryout:2026-10-01`);
  assert.ok(settled, "the house prior settled once the actual landed");
  assert.equal(settled.actual_value, 700);
  assert.equal(settled.surprise, 700 - h.estAvg);
});
