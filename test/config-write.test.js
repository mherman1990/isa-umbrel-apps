// Regression test for the non-atomic config write (fix/config-write-safety, Fix 1).
//
// saveWatchlist used fs.writeFileSync directly onto the live watchlist.json — a truncate-then-write.
// A crash/power-loss mid-write leaves the whole config (sources, focus areas, schedule) corrupt or
// truncated. The fix writes a sibling temp file and renames it onto the target (atomic within one
// filesystem), cleaning up the temp and rethrowing if the write fails — so a reader/next boot sees
// either the intact old file or the fully-written new one, never a torn one.
//
// Zero deps: Node's built-in test runner + a temp watchlist.json. No network, no API key.
// Run with: node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// watchlistFilePath() resolves against store.DATA_DIR (from POLIBRIEF_DATA_DIR) — point it at a
// throwaway dir BEFORE importing any src module so the real watchlist.json is never touched.
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "beanbrief-cfg-"));
process.env.POLIBRIEF_DATA_DIR = dataDir;
const target = path.join(dataDir, "watchlist.json");

const { saveWatchlist } = await import(pathToFileURL(path.join(here, "../src/pipeline.js")).href);

const ORIGINAL = { focusAreas: [{ id: "a", label: "A", terms: ["x"] }], briefEditions: { am: "07:00" } };
// Only count temp artifacts — store.js also keeps polibrief.db (+ WAL/SHM) in this dir.
const tmpResidue = () => fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));
const seedOriginal = () => fs.writeFileSync(target, JSON.stringify(ORIGINAL, null, 2) + "\n", "utf8");

test("saveWatchlist persists new content and leaves no temp residue", () => {
  seedOriginal();
  saveWatchlist({ ...ORIGINAL, briefEditions: { am: "09:30" } });
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).briefEditions.am, "09:30", "new content persisted");
  assert.deepEqual(tmpResidue(), [], "no temp files left behind");
});

test("saveWatchlist strips the derived engine `topics` view (on-disk format unchanged)", () => {
  seedOriginal();
  saveWatchlist({ ...ORIGINAL, topics: [{ id: "derived" }] });
  const raw = fs.readFileSync(target, "utf8");
  assert.ok(!("topics" in JSON.parse(raw)), "derived topics view is not written");
  assert.match(raw, /\n$/, "trailing newline preserved");
});

test("a failed write leaves the original file intact and cleans up the temp (atomicity)", () => {
  seedOriginal();
  const before = fs.readFileSync(target, "utf8");
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated crash during rename");
  };
  try {
    assert.throws(
      () => saveWatchlist({ ...ORIGINAL, briefEditions: { am: "23:59" } }),
      /simulated crash during rename/,
      "the write error is rethrown so the caller/UI learns the save failed"
    );
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(target, "utf8"), before, "original watchlist.json is untouched by a failed write");
  assert.deepEqual(tmpResidue(), [], "the temp file was cleaned up");
});
