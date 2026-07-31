// Regression tests for triage.js — the gate the entire daily brief depends on, and until now the
// only major module in the pipeline with NO test coverage at all.
//
// WHY THIS FILE EXISTS. v1.27.0 shipped a release-breaking crash here and 37 green tests did not
// notice, because none of them executed the triage loop. The release added a `verdicts` Map so one
// representative's judgement could reach the other filings of a cross-filed document — and named the
// per-batch parse result `verdicts` too, which shadowed the Map for the rest of the loop body:
//
//   const verdicts = new Map();          // returned to pipeline.js
//   for (...batches...) {
//     let verdicts = null;               // ← shadows it
//     verdicts = parseVerdicts(text);    // now an Array
//     ...
//     verdicts.set(item.uid, verdict);   // TypeError: verdicts.set is not a function
//
// Reproduced before the fix: the well-formed path threw `TypeError: verdicts.set is not a function`
// on the FIRST item of the FIRST batch, and the malformed-JSON path threw `Cannot read properties of
// null (reading 'set')`. Both threw AFTER markSeen had already written the row, so every run marked
// one item permanently seen (never re-fetched, never judged) and then died before the brief was
// written. runFullPipeline awaits triageItems with no try/catch, so this was total.
//
// The tests therefore assert on BEHAVIOUR, not on the variable name: the function must return, the
// verdict map must be keyed by uid, and a batch the model never answered must leave its items unseen.
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed so the Anthropic SDK never leaves
// the process — and a temp DATA_DIR so the real DB is untouched.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-triage-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.TRIAGE_MODEL = "claude-haiku-4-5";

const { triageItems } = await import("../src/triage.js");
const { runFullPipeline: runFullPipelineRef } = await import("../src/pipeline.js");
const store = await import("../src/store.js");

const TOPICS = [
  { id: "biofuel", label: "Biofuels & renewable diesel" },
  { id: "crop", label: "Crop protection" },
];

const item = (uid, sourceId, title, summary = "") => ({
  uid,
  sourceId,
  title,
  summary,
  sourceLabel: sourceId,
  jurisdiction: "US-Federal",
  docType: "notice",
  matchedTopics: [],
  raw: {},
});

/** Build a Messages-API response carrying `text` as the assistant's only text block. */
function reply(text) {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 40 },
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
  );
}

/** Point the SDK at a canned reply for the duration of one call. */
function withModelReply(text, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => reply(text);
  return fn().finally(() => { globalThis.fetch = original; });
}

const verdictJson = (uids, over = {}) =>
  JSON.stringify(
    uids.map((uid) => ({
      uid,
      relevant: true,
      tier: "must_read",
      topicIds: ["biofuel"],
      oneLine: `Something specific about ${uid}.`,
      type: "rule",
      ...over,
    }))
  );

test("a well-formed model response is processed without throwing (the everyday path)", async () => {
  const items = [
    item("fr:a", "federal_register", "RFS volumes", "EPA proposes RFS volumes affecting soybean oil."),
    item("fr:b", "federal_register", "45Z guidance", "Treasury guidance on the 45Z clean fuel credit."),
  ];
  const res = await withModelReply(verdictJson(["fr:a", "fr:b"]), () => triageItems(items, TOPICS, process.env));

  // Before the fix this line was never reached — the call threw on the first item.
  assert.equal(res.relevant.length, 2, "both items come back relevant");
  assert.equal(res.triagedCount, 2);
  assert.ok(res.verdicts instanceof Map, "verdicts must be the Map pipeline.js calls .has()/.get() on");
  assert.equal(res.verdicts.size, 2);
  assert.equal(res.verdicts.get("fr:a").tier, "must_read", "and it must be keyed by uid");
  assert.equal(res.relevant[0].oneLine, "Something specific about fr:a.");
});

test("the verdict map is what lets cross-filed copies inherit a judgement", async () => {
  // pipeline.js sends one lead per event and applies verdicts.get(lead.uid) to the other filings.
  // If the map is empty or mis-keyed, the copies silently keep no verdict.
  const lead = item("rg:lead", "regulations_gov", "Pesticide registration", "EPA seeks comment on a soybean herbicide.");
  lead.eventFilings = 4;
  const res = await withModelReply(verdictJson(["rg:lead"]), () => triageItems([lead], TOPICS, process.env));

  assert.ok(res.verdicts.has("rg:lead"), "the lead's uid must be present for the inherit step to fire");
  const v = res.verdicts.get("rg:lead");
  assert.equal(v.relevant, true);
  assert.equal(v.tier, "must_read");
  assert.ok(v.oneLine.length > 0, "the inherited verdict carries the one-line the copies will show");
});

test("a batch the model never answered leaves its items UNSEEN so the next run retries", async () => {
  const items = [
    item("unanswered:1", "federal_register", "Some rule", "Body text."),
    item("unanswered:2", "federal_register", "Another rule", "Body text."),
  ];
  // Unparseable both attempts — the documented fail-soft path, which used to throw on `null.set`.
  const res = await withModelReply("I'm sorry, I can't do that.", () => triageItems(items, TOPICS, process.env));

  assert.equal(res.relevant.length, 0);
  assert.equal(res.triagedCount, 0);
  assert.equal(res.verdicts.size, 0, "no verdict is recorded for a batch that produced none");

  // The property that matters: these must be re-fetchable. Recording them as seen would retire items
  // nobody ever judged — and would let cross-filed copies inherit a null verdict as if it decided
  // something. pipeline.js's `verdicts.has(lead.uid)` guard depends on the absence above.
  for (const it of items) {
    assert.equal(store.isSeen(it.uid), false, `${it.uid} must not be marked seen`);
  }
});

test("an unrecognized tier degrades to worth_knowing rather than breaking the run", async () => {
  const items = [item("tier:odd", "federal_register", "A rule", "Body text.")];
  const res = await withModelReply(verdictJson(["tier:odd"], { tier: "URGENT!!" }), () =>
    triageItems(items, TOPICS, process.env)
  );
  assert.equal(res.verdicts.get("tier:odd").tier, "worth_knowing");
});

test("an irrelevant verdict is stored and kept out of the relevant list", async () => {
  const items = [item("no:1", "legiscan", "IL SB0315: BUSINESS-TECH", "Unrelated state bill.")];
  const res = await withModelReply(
    JSON.stringify([{ uid: "no:1", relevant: false, tier: "background", topicIds: [], oneLine: "Not soy-related.", type: "bill_action" }]),
    () => triageItems(items, TOPICS, process.env)
  );
  assert.equal(res.relevant.length, 0);
  assert.equal(res.triagedCount, 1, "it was still judged, so it is still recorded");
  assert.equal(res.verdicts.get("no:1").relevant, false);
  assert.equal(store.isSeen("no:1"), true, "a judged item is marked seen so it is never paid for twice");
});

test("a batch left unseen must HOLD BACK that source's watermark, or the retry never happens", async () => {
  // THE BUG THIS LOCKS (found in adversarial review of 1.28.0, reproduced end to end before fixing).
  // Making a failed batch leave items unseen is only safe if the cursor stays put. It did not:
  // runFullPipeline advanced every pendingWatermark unconditionally, so a congress_gov bill whose
  // triage batch failed twice ended up in NO table while getSince("congress_gov") moved from 6 hours
  // ago to this run's start — and congress_gov filters server-side on `fromDateTime`/updateDate, so the
  // next fetch could never return it. Silent permanent loss, and strictly worse than the v1.27.0 crash
  // it replaced (which at least left the watermark alone).
  const sixHoursAgo = new Date(Date.now() - 6 * 3600e3).toISOString();
  store.setLastSuccess("congress_gov", sixHoursAgo);

  const it = item("congress_gov:hr9999", "congress_gov", "H.R.9999 soybean crush credit", "A bill affecting crush.");
  const runStart = new Date().toISOString();

  await withModelReply("I'm sorry, I can't do that.", () =>
    runFullPipelineRef({
      watchlist: { topics: TOPICS, output: {} },
      env: process.env,
      edition: "am",
      kept: [it],
      items: [it],
      skippedSources: [],
      fetchedCount: 1,
      pendingWatermarks: [{ sourceId: "congress_gov", ts: runStart }],
    })
  );

  assert.equal(store.isSeen("congress_gov:hr9999"), false, "the failed batch's item is (correctly) not stored");
  assert.equal(
    store.getSince("congress_gov"),
    sixHoursAgo,
    "…so the watermark MUST NOT advance — otherwise the item is in no table and can never be re-fetched"
  );
});

test("a fully successful run still advances its watermarks", async () => {
  // The converse, so the fix above can't degrade into "never advance anything", which would re-fetch
  // the whole window every run forever.
  const sixHoursAgo = new Date(Date.now() - 6 * 3600e3).toISOString();
  store.setLastSuccess("federal_register", sixHoursAgo);

  const it = item("federal_register:ok-1", "federal_register", "A rule", "Body text about soybeans.");
  const runStart = new Date().toISOString();

  await withModelReply(verdictJson(["federal_register:ok-1"]), () =>
    runFullPipelineRef({
      watchlist: { topics: TOPICS, output: {} },
      env: process.env,
      edition: "am",
      kept: [it],
      items: [it],
      skippedSources: [],
      fetchedCount: 1,
      pendingWatermarks: [{ sourceId: "federal_register", ts: runStart }],
    })
  );

  assert.equal(store.isSeen("federal_register:ok-1"), true, "the item is durably stored");
  assert.equal(store.getSince("federal_register"), runStart, "so the cursor advances as designed");
});

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
});
