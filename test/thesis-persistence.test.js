// Persistence for theses and challenges (Phase 3b).
//
// WHY THIS MATTERS MORE THAN IT LOOKS. `forecasts.challenge_verdict` is the column that eventually
// answers "do challenged-down claims hit less often than approved ones?" — i.e. whether the
// Challenger is worth its money at all. Without it that question can never be asked, only argued
// about, and an expensive review step would run forever on the strength of it feeling rigorous.
//
// The plan states the kill criterion explicitly: an approve rate near 100% after ~20 notes means cut
// the Challenger. `store.challengeScorecard()` is what makes that checkable, so these tests assert
// the numbers it needs actually reach the database.
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed — temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-thesis-persist-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.ANALYST_MODEL = "claude-opus-4-8";
process.env.WEB_SEARCH = "off";

const { generateMemo } = await import("../src/pipeline.js");
const store = await import("../src/store.js");
const { modelResponse } = await import("./fixtures/sse.js");

const NOTE = "## Analyst Note\n\nCrush margins are running at a record and have not compressed.\n".repeat(6);

// A real series has to exist or NOTHING resolves: with an empty universe every thesis is demoted to
// low by the grounding rule before the Challenger ever speaks, and a test for the Challenger's own
// demotion would be measuring the wrong mechanism.
const SERIES = "test:crush:margin";
store.saveSeriesPoints(
  SERIES,
  { label: "Test crush margin", unit: "$/bu", category: "crush" },
  Array.from({ length: 40 }, (_, i) => ({ period: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`, value: 1 + i / 40 }))
);

// Every test in this file runs on the same date, so saveBrief hands them all the SAME brief path,
// and thesis_challenges is append-only. Tagging each test's content keeps its rows findable, and
// counts are asserted as deltas rather than absolutes.
function thesisJson(n = 2, tag = "x") {
  return {
    theses: Array.from({ length: n }, (_, i) => ({
      thesis: `Thesis ${tag} ${i}`,
      narrative: `Narrative for thesis ${tag} ${i}.`,
      horizon_days: 60 + i,
      mechanism_chain: ["Step one", "Step two"],
      supporting_evidence: [`series:${SERIES}@2026-01-01`],
      counterevidence: [],
      alternative_explanations: ["Another reading exists."],
      confidence: "high",
      confirm: "A print.",
      invalidate: "Another print.",
      falsifiable_claim: {
        claim: `Claim ${tag} ${i} stays above 1.2.`,
        comparator: "stays_above",
        threshold: 1.2,
        direction: "n/a",
        series: SERIES,
        confirmingEvent: "NOPA",
      },
    })),
  };
}

/** Challenge rows for one thesis key, newest first — the row the current test just wrote. */
const challengeCount = (key) => store.listChallenges({ thesisKey: key }).length;

function challengeJson(challenges, noteLevelConcern = "") {
  return { challenges, note_level_concern: noteLevelConcern };
}

async function runAnalyst(bodies) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let i = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    // The note call is STREAMED and the two that follow it are not — the stub picks its wire format
    // from the request rather than assuming one.
    return modelResponse(body, text);
  };
  console.log = () => {};
  try {
    return await generateMemo("analyst", process.env);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

const CHECKS = {
  relationship: "duplicate_of_other_thesis",
  evidence_precedes_outcome: "no",
  seasonal_risk: "likely",
  duplicate_sources: "all",
  series_measures_claim: "no",
  history_sufficient: "no",
};

test("persistence: theses are stored with BOTH the stated and the final confidence", async () => {
  const result = await runAnalyst([
    NOTE,
    JSON.stringify(thesisJson(1, "conf")),
    JSON.stringify(challengeJson([{ thesis_index: 0, verdict: "lower_confidence", reason: "Thin history.", caveat: "Two years only.", ...CHECKS }])),
  ]);
  const briefPath = path.relative(store.DATA_DIR, result.filePath);
  const row = store.listTheses({ briefPath }).find((r) => r.thesis === "Thesis conf 0");
  assert.ok(row, "the thesis must be persisted");
  // Keeping only the final value would erase the signal that says the model is overconfident.
  assert.equal(row.confidence_stated, "high", "what the model claimed");
  assert.equal(row.confidence_final, "medium", "what survived grounding and the Challenger");
  assert.equal(row.thesis_key, `${briefPath}#0`);
});

test("persistence: the thesis key is POSITIONAL, not a hash of the model's wording", async () => {
  // forecasts.dedupe_key hashes the claim TEXT, so a re-run that paraphrases produces a duplicate
  // row. Position within a note is stable under paraphrase, which is why theses key on it.
  const result = await runAnalyst([NOTE, JSON.stringify(thesisJson(2, "pos")), JSON.stringify(challengeJson([]))]);
  const briefPath = path.relative(store.DATA_DIR, result.filePath);
  const keys = store.listTheses({ briefPath }).map((r) => r.thesis_key).sort();
  assert.deepEqual(keys, [`${briefPath}#0`, `${briefPath}#1`]);
});

test("persistence: a challenge row carries all six structured checks", async () => {
  const result = await runAnalyst([
    NOTE,
    JSON.stringify(thesisJson(1, "checks")),
    JSON.stringify(challengeJson([{ thesis_index: 0, verdict: "add_caveat", reason: "Same filing twice.", caveat: "One datapoint.", ...CHECKS }])),
  ]);
  const briefPath = path.relative(store.DATA_DIR, result.filePath);
  const c = store.listChallenges({ thesisKey: `${briefPath}#0` })[0]; // newest first
  assert.ok(c, "a verdict must produce a challenge row");
  assert.equal(c.verdict, "add_caveat");
  assert.equal(c.duplicate_sources, "all");
  assert.equal(c.series_measures_claim, "no");
  assert.equal(c.history_sufficient, "no");
  assert.equal(c.seasonal_risk, "likely");
  assert.equal(c.evidence_precedes_outcome, "no");
  assert.equal(c.relationship, "duplicate_of_other_thesis");
  assert.equal(c.model, "claude-opus-4-8", "which reviewer said it is part of the record");
});

test("persistence: an UNREVIEWED thesis writes no challenge row — approved and unlooked-at differ", async () => {
  // If an unreviewed thesis were stored as approve, the approve rate (the kill criterion) would be
  // measuring the wrong population. Asserted as a DELTA: thesis_challenges is append-only and every
  // test here shares one brief path, so absolute counts carry earlier tests' rows.
  const probe = `${path.join("briefings", `${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date())}-analyst.md`)}`;
  const before0 = challengeCount(`${probe}#0`);
  const before1 = challengeCount(`${probe}#1`);
  await runAnalyst([NOTE, JSON.stringify(thesisJson(2, "unrev")), JSON.stringify(challengeJson([{ thesis_index: 0, verdict: "approve", reason: "Fine.", caveat: "", ...CHECKS }]))]);
  assert.equal(challengeCount(`${probe}#0`) - before0, 1, "the reviewed thesis gets a row");
  assert.equal(challengeCount(`${probe}#1`) - before1, 0, "the unreviewed one gets none");
});

test("persistence: a rejected thesis is KEPT in the table, removed from the note, and not forecast", async () => {
  const result = await runAnalyst([
    NOTE,
    JSON.stringify(thesisJson(2, "rej")),
    JSON.stringify(
      challengeJson([
        { thesis_index: 0, verdict: "approve", reason: "Fine.", caveat: "", ...CHECKS },
        { thesis_index: 1, verdict: "reject", reason: "Rests on one datapoint counted twice.", caveat: "", ...CHECKS },
      ])
    ),
  ]);
  const briefPath = path.relative(store.DATA_DIR, result.filePath);

  const rejected = store.listTheses({ briefPath }).find((r) => r.thesis === "Thesis rej 1");
  assert.equal(rejected.rejected, 1, "kept in the record so the same read cannot reappear as new");
  assert.ok(!result.markdown.includes("### Thesis rej 1"), "but removed from what the reader sees");
  assert.match(result.markdown, /~~Thesis rej 1~~/, "and shown as removed, with the reason");

  // A rejected read is not a prediction the system made, so it must not enter the track record.
  const filed = store.listForecasts({ limit: 200 }).filter((f) => /^Claim rej /.test(f.claim));
  assert.equal(filed.length, 1, "only the kept thesis is filed");
  assert.equal(filed[0].claim, "Claim rej 0 stays above 1.2.");
});

test("persistence: forecasts carry the thesis key and the challenge verdict", async () => {
  const result = await runAnalyst([
    NOTE,
    JSON.stringify(thesisJson(1, "fkey")),
    JSON.stringify(challengeJson([{ thesis_index: 0, verdict: "lower_confidence", reason: "Thin.", caveat: "Thin.", ...CHECKS }])),
  ]);
  const briefPath = path.relative(store.DATA_DIR, result.filePath);
  const f = store.listForecasts({ limit: 200 }).find((r) => r.claim === "Claim fkey 0 stays above 1.2.");
  assert.ok(f, "the claim must be filed");
  assert.equal(f.thesis_key, `${briefPath}#0`);
  assert.equal(f.challenge_verdict, "lower_confidence");
  // And it files at the POST-challenge confidence, not what the model first claimed.
  assert.equal(f.confidence, "medium");
});

test("persistence: challengeScorecard reports the approve rate — the stated kill criterion", async () => {
  const before = store.challengeScorecard();
  await runAnalyst([
    NOTE,
    JSON.stringify(thesisJson(2, "score")),
    JSON.stringify(
      challengeJson([
        { thesis_index: 0, verdict: "approve", reason: "Fine.", caveat: "", ...CHECKS },
        { thesis_index: 1, verdict: "approve", reason: "Fine.", caveat: "", ...CHECKS },
      ])
    ),
  ]);
  const after = store.challengeScorecard();
  assert.ok(after.totalChallenged > before.totalChallenged);
  assert.ok(after.approveRate > 0 && after.approveRate <= 1);
  assert.ok(Number.isFinite(after.verdictCounts.approve));
  // byVerdict is keyed off resolved forecasts; with everything still pending the hit rate is null
  // rather than a misleading zero.
  for (const v of Object.values(after.byVerdict)) {
    assert.ok(v.hitRate === null || (v.hitRate >= 0 && v.hitRate <= 1));
  }
});

test("persistence: a legacy extractor-filed forecast has a NULL thesis key, so the two are separable", async () => {
  // Structuring fails → the Haiku extractor fills the ledger as it always did. Those rows must be
  // distinguishable from thesis-filed ones, or the scorecard would mix two populations.
  const result = await runAnalyst([
    NOTE,
    "not json",
    JSON.stringify({ forecasts: [{ claim: "Legacy claim.", comparator: "not_measurable", threshold: 0, direction: "n/a", series: "", horizonDays: 30, confirmingEvent: "x", confidence: "low" }] }),
  ]);
  const briefPath = path.relative(store.DATA_DIR, result.filePath);
  const f = store.listForecasts({ limit: 80 }).find((r) => r.brief_path === briefPath);
  assert.ok(f, "the ledger keeps filling when structuring fails");
  assert.equal(f.thesis_key, null);
  assert.equal(f.challenge_verdict, null);
});
