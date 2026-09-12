// Tests for the market-series vintage trail (§1.4).
//
// What these lock:
//   - saveSeriesPoints keeps the LATEST value in market_series (display, unchanged) AND appends to an
//     append-only vintage trail: one row on first sight, another on each genuine revision, and NOTHING
//     on an unchanged re-fetch (so the trail is [first print, …revisions], not one row per pipeline run).
//   - getSeriesFirstVintage returns the FIRST print per period (what a backtest/lead-lag scan must use),
//     while getSeries / marketSnapshot keep returning the latest revision.
//   - The one-time boot backfill seeds the trail from a pre-existing market_series so leadlag has a
//     baseline immediately, stamped with each series' last-refresh time.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-vintage-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
const DB_PATH = path.join(DIR, "polibrief.db");

// Pre-seed a "pre-existing" DB BEFORE importing store, so importing it exercises the one-time backfill
// against rows that predate the vintage trail (the real upgrade path on the Pi).
{
  const raw = new Database(DB_PATH);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS market_series (series TEXT NOT NULL, period TEXT NOT NULL, value REAL, PRIMARY KEY (series, period));
    CREATE TABLE IF NOT EXISTS market_series_meta (series TEXT PRIMARY KEY, label TEXT, unit TEXT, category TEXT, updated_at TEXT);
  `);
  raw.prepare("INSERT INTO market_series (series, period, value) VALUES (?,?,?)").run("legacy:series", "2025-12", 99);
  raw.prepare("INSERT INTO market_series_meta (series,label,unit,category,updated_at) VALUES (?,?,?,?,?)")
    .run("legacy:series", "Legacy", "u", "c", "2026-01-15T00:00:00.000Z");
  raw.close();
}

// Importing store now runs the boot-time backfill against the row seeded above.
const store = await import("../src/store.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const META = { label: "Demo", unit: "u", category: "c" };

test("boot backfill seeds the vintage trail from a pre-existing market_series", () => {
  assert.deepEqual(store.getSeriesFirstVintage("legacy:series"), [{ period: "2025-12", value: 99 }]);
  const trail = store.getSeriesVintages("legacy:series", "2025-12");
  assert.equal(trail.length, 1, "one baseline row");
  assert.equal(trail[0].as_of, "2026-01-15T00:00:00.000Z", "backfill stamps as_of from meta.updated_at");
});

test("first print preserved; unchanged re-fetch adds no row; a revision appends one", async () => {
  store.saveSeriesPoints("nass:us:demo", META, [{ period: "2026-06", value: 210 }]);
  assert.equal(store.getSeriesVintages("nass:us:demo", "2026-06").length, 1, "first print recorded");

  await sleep(3);
  store.saveSeriesPoints("nass:us:demo", META, [{ period: "2026-06", value: 210 }]); // unchanged re-fetch
  assert.equal(store.getSeriesVintages("nass:us:demo", "2026-06").length, 1, "unchanged re-fetch adds nothing");

  await sleep(3);
  store.saveSeriesPoints("nass:us:demo", META, [{ period: "2026-06", value: 205 }]); // genuine revision
  assert.equal(store.getSeriesVintages("nass:us:demo", "2026-06").length, 2, "revision appends a row");
});

test("getSeries returns the latest revision; getSeriesFirstVintage returns the first print", () => {
  // (continues from the previous test's series) latest = the revised value, first vintage = the original.
  assert.deepEqual(store.getSeries("nass:us:demo"), [{ period: "2026-06", value: 205 }]);
  assert.deepEqual(store.getSeriesFirstVintage("nass:us:demo"), [{ period: "2026-06", value: 210 }]);
});

test("first vintage tracks each period independently across a multi-period backfill then revision", async () => {
  store.saveSeriesPoints("fas:demo", META, [
    { period: "2026-01", value: 1 },
    { period: "2026-02", value: 2 },
    { period: "2026-03", value: 3 },
  ]);
  await sleep(3);
  // A later refresh revises Feb up and leaves Jan/Mar unchanged.
  store.saveSeriesPoints("fas:demo", META, [
    { period: "2026-01", value: 1 },
    { period: "2026-02", value: 20 },
    { period: "2026-03", value: 3 },
  ]);
  assert.deepEqual(store.getSeriesFirstVintage("fas:demo"), [
    { period: "2026-01", value: 1 },
    { period: "2026-02", value: 2 }, // first print, not the revised 20
    { period: "2026-03", value: 3 },
  ]);
  assert.deepEqual(store.getSeries("fas:demo"), [
    { period: "2026-01", value: 1 },
    { period: "2026-02", value: 20 }, // latest = revised
    { period: "2026-03", value: 3 },
  ]);
  assert.equal(store.getSeriesVintages("fas:demo", "2026-02").length, 2, "Feb has first + revision");
  assert.equal(store.getSeriesVintages("fas:demo", "2026-01").length, 1, "Jan never revised");
});

test("marketSnapshot still reflects the latest revision (display is unchanged by the vintage trail)", () => {
  const s = store.marketSnapshot().find((x) => x.series === "nass:us:demo");
  assert.ok(s, "series present");
  assert.equal(s.latest.value, 205, "snapshot shows the revised value, not the first print");
});
