// Regression test for the silent watermark data-loss bug (fix/collect-watermark-dataloss).
//
// The bug: collectAll advanced a source's last-success watermark (store.setLastSuccess)
// the moment its FETCH succeeded — but fetched items only become durable later, at
// store.markSeen during triage. If the run died between collect and triage (missing
// ANTHROPIC_API_KEY, an Anthropic 429/5xx, a crash), the watermark had already moved past
// items that were never recorded. store.getSince() uses last_success_at as the fetch
// cursor, so the next run never re-fetched them: silent, permanent loss.
//
// The fix: collect is read-only. It RETURNS per-source pending watermark advances
// (ts = each source's fetch-start) instead of writing them; the caller applies them at the
// single post-triage commit point, once every fetched item is durably in seen_items.
//
// Zero deps: Node's built-in test runner + a fake in-memory adapter + a throwaway SQLite DB.
// No network and no Anthropic key required.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// store.js opens its SQLite DB at import time from POLIBRIEF_DATA_DIR — point it at a
// throwaway dir BEFORE importing any src module so the real polibrief.db is never touched.
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "beanbrief-wm-"));
process.env.POLIBRIEF_DATA_DIR = dataDir;

const store = await import(pathToFileURL(path.join(here, "../src/store.js")).href);
const { collectAll } = await import(pathToFileURL(path.join(here, "../src/collect.js")).href);
const adaptersMod = await import(pathToFileURL(path.join(here, "../src/adapters/index.js")).href);

const OLD_TS = "2020-01-01T00:00:00.000Z"; // seeded prior watermark
const PUB_TS = "2020-06-01T00:00:00.000Z"; // item published after OLD_TS, long before "now"

/** Register a fake source that returns one item, and only when the incremental window includes it. */
function registerFakeSource(srcId, uid) {
  const item = {
    uid,
    sourceId: srcId,
    title: "Test item",
    summary: "body",
    url: "https://example.test/" + uid,
    publishedAt: PUB_TS,
  };
  adaptersMod.adapters[srcId] = {
    id: srcId,
    label: "WM Test " + srcId,
    async fetchItems({ sinceISO }) {
      // Honour the incremental window the way real adapters do: items older than the
      // cursor are not returned. This is what makes the silent loss observable — once the
      // watermark advances past the item, a later fetch no longer includes it.
      return item.publishedAt >= sinceISO ? [structuredClone(item)] : [];
    },
  };
  return item;
}

const watchlistFor = (srcId) => ({ sources: { [srcId]: { enabled: true } }, topics: [] });
const collect = (srcId) => collectAll({ watchlist: watchlistFor(srcId), env: {}, onlySource: srcId, commit: true });

test("collect is read-only: a successful fetch does not advance the watermark, but returns it as pending", async () => {
  const SRC = "__wm_readonly__";
  const item = registerFakeSource(SRC, "wm-readonly-1");
  store.setLastSuccess(SRC, OLD_TS); // seed a known prior watermark

  const r = await collect(SRC);

  assert.ok(r.items.some((i) => i.uid === item.uid), "fetch still returns the fresh item");
  assert.equal(store.getSince(SRC), OLD_TS, "collect must NOT advance the watermark (it is read-only)");
  assert.ok(Array.isArray(r.pendingWatermarks), "collect returns a pendingWatermarks array");
  const p = r.pendingWatermarks.find((x) => x.sourceId === SRC);
  assert.ok(p, "a successfully-fetched source has a pending watermark advance");
  assert.ok(p.ts > OLD_TS, "the pending ts is the fetch-start (newer than the old watermark)");
});

test("a crash between collect and the post-triage commit point loses nothing; next run re-fetches", async () => {
  const SRC = "__wm_dataloss__";
  const item = registerFakeSource(SRC, "wm-dataloss-1");
  store.setLastSuccess(SRC, OLD_TS);

  // Run 1: collect succeeds …
  const r1 = await collect(SRC);
  assert.equal(r1.items.length, 1, "run 1 fetched the item");

  // … then the run dies before the commit point: no markSeen, no pending applied.
  assert.equal(store.getSince(SRC), OLD_TS, "aborted run leaves the watermark untouched");
  assert.equal(store.isSeen(item.uid), false, "the item was never durably recorded");

  // Run 2: the next run must still see the item (its window was never advanced past it).
  const r2 = await collect(SRC);
  assert.ok(r2.items.some((i) => i.uid === item.uid), "item is still fetchable next run — no silent loss");
});

test("happy path: applying pendings only AFTER markSeen advances the watermark and dedupes next run", async () => {
  const SRC = "__wm_commit__";
  const item = registerFakeSource(SRC, "wm-commit-1");
  store.setLastSuccess(SRC, OLD_TS);

  const r = await collect(SRC);
  assert.ok(Array.isArray(r.pendingWatermarks), "collect returns pendingWatermarks");

  // Mirror the pipeline commit point: every fetched item becomes durable, THEN watermarks advance.
  for (const it of r.items) store.markSeen(it, null);
  for (const { sourceId, ts } of r.pendingWatermarks) store.setLastSuccess(sourceId, ts);

  assert.ok(store.getSince(SRC) > OLD_TS, "watermark advances once items are durable");
  assert.equal(store.isSeen(item.uid), true, "item is durably recorded");

  const r2 = await collect(SRC);
  assert.ok(!r2.items.some((i) => i.uid === item.uid), "next run does not re-process the committed item");
});
