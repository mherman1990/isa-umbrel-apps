// Tests for market_runs — the per-adapter series-refresh success record that lets the /sources dot show a
// series-only markets adapter (comexstat, banyan_rin, carbon_prices, eu_ets, …) as healthy from its last
// fetchSeries, instead of a permanent 🟠 "waiting for first successful run" (it never fetches items).
//
// The CRITICAL property is that this is SEPARATE from the runs table: runs.last_success_at doubles as the
// item-fetch watermark (getSince reads it), so a series refresh must never write there or it would advance
// a dual adapter's item cursor and silently skip items.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-mktruns-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
const store = await import("../src/store.js");

test("getMarketRuns is empty on a fresh store", () => {
  assert.deepEqual(store.getMarketRuns(), {});
});

test("setMarketRunSuccess records last success + series count, and upserts in place", () => {
  store.setMarketRunSuccess("eu_ets", 1, "2026-09-14T00:00:00.000Z");
  assert.deepEqual(store.getMarketRuns()["eu_ets"], { lastSuccess: "2026-09-14T00:00:00.000Z", seriesCount: 1 });
  // a later refresh with more series overwrites the same row
  store.setMarketRunSuccess("eu_ets", 3, "2026-09-14T06:00:00.000Z");
  assert.deepEqual(store.getMarketRuns()["eu_ets"], { lastSuccess: "2026-09-14T06:00:00.000Z", seriesCount: 3 });
});

test("a market run does NOT touch the item-fetch watermark (the safety property)", () => {
  store.setMarketRunSuccess("banyan_rin", 8, "2026-09-14T00:00:00.000Z");
  // getSourceStats reads the runs table (item watermark); a market-only source must not appear there.
  assert.equal(store.getSourceStats(7)["banyan_rin"], undefined, "no runs row created by a market run");
  // getSince must fall back (~now − fallbackDays), NOT return the market-run time — proving runs is untouched.
  const since = new Date(store.getSince("banyan_rin", 7)).getTime();
  const sevenDaysAgo = Date.now() - 7 * 864e5;
  assert.ok(Math.abs(since - sevenDaysAgo) < 60_000, "getSince fell back; the market run did not set the watermark");
});

test("timestamp defaults to now when omitted", () => {
  const before = Date.now();
  store.setMarketRunSuccess("carbon_prices", 2);
  const t = new Date(store.getMarketRuns()["carbon_prices"].lastSuccess).getTime();
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000, "defaulted timestamp is ~now");
  assert.equal(store.getMarketRuns()["carbon_prices"].seriesCount, 2);
});

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
});
