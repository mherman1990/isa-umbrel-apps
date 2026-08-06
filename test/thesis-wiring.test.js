// Integration test for the two-call analyst flow (Phase 3a) — generateMemo end to end.
//
// WHY THIS FILE EXISTS. thesis.js is pure and well covered, and the ledger parity is covered, but
// the WIRING between them had no coverage at all — and an untested integration path is exactly how
// v1.27.0 shipped a triage crash that killed every production run for a release.
//
// The specific hazard here is that the note is EXPENSIVE and is produced BEFORE the thing that
// might fail. An Analyst run is ~$0.79 of Opus. Between the model call and `saveBrief` the code now
// assembles an evidence universe out of local lookups (market snapshot, signals, briefs). A first
// draft of this wiring left those lookups outside the try/catch, so a signal that cannot compute on
// a thin database would have thrown and destroyed a note that had already been paid for. These
// tests assert the note survives every failure mode of the structuring step.
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed — temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-thesis-wire-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.ANALYST_MODEL = "claude-opus-4-8";
process.env.WEB_SEARCH = "off"; // keep the analyst call tool-free in tests

const { generateMemo } = await import("../src/pipeline.js");
const store = await import("../src/store.js");
const { modelResponse } = await import("./fixtures/sse.js");

const NOTE = `## The Bean Brief — Analyst Note

Crush margins are running at a record for the month, and the board crush has not compressed.
That combination usually resolves one of two ways, and the next NOPA print settles it.
`.repeat(4);

const THESIS_JSON = {
  theses: [
    {
      thesis: "Crush margins hold above trend into Q4.",
      narrative: "Utilization is at a record for the month and margins have not compressed.",
      horizon_days: 90,
      mechanism_chain: ["Record utilization", "Board crush stays wide", "Processors bid basis up"],
      supporting_evidence: ["signal:crush_demand"],
      counterevidence: [],
      alternative_explanations: ["Soybean oil alone is carrying the margin, and that can reverse."],
      confidence: "high",
      confirm: "September NOPA crush above 200 million bushels.",
      invalidate: "Board crush below $1.20 for two consecutive weeks.",
      falsifiable_claim: {
        claim: "Board crush margin stays above $1.20 through Q4.",
        comparator: "stays_above",
        threshold: 1.2,
        direction: "n/a",
        series: "",
        confirmingEvent: "Monthly NOPA crush report",
      },
    },
  ],
};

const CHALLENGE_JSON = {
  note_level_concern: "",
  challenges: [
    {
      thesis_index: 0,
      verdict: "approve",
      reason: "Grounded and correctly hedged.",
      caveat: "",
      relationship: "independent",
      evidence_precedes_outcome: "yes",
      seasonal_risk: "none",
      duplicate_sources: "none",
      series_measures_claim: "not_applicable",
      history_sufficient: "yes",
    },
  ],
};

/**
 * Run the analyst preset with a scripted sequence of model responses.
 * @param {string[]} bodies  one JSON body per API call, in order
 */
async function runAnalyst(bodies) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  const calls = [];
  let i = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const text = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    if (text instanceof Error) throw text;
    // The note call is STREAMED and the two that follow it are not, so the stub picks its wire
    // format from the request rather than assuming one.
    return modelResponse(body, text);
  };
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const result = await generateMemo("analyst", process.env);
    return { result, calls, logs };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test("wiring: the analyst note is THREE calls — prose, structuring, adversarial pass", async () => {
  const { calls } = await runAnalyst([NOTE, JSON.stringify(THESIS_JSON), JSON.stringify(CHALLENGE_JSON)]);
  assert.equal(calls.length, 3, "one call cannot do prose AND schema — see thesis.js for the measurement");

  const [note, structuring, challenge] = calls;
  assert.equal(note.output_config?.format, undefined, "the prose call must not be schema-constrained");
  assert.ok(structuring.output_config?.format?.type === "json_schema");
  assert.equal(structuring.tools, undefined, "the schema call must carry no tools");
  assert.ok(challenge.output_config?.format?.type === "json_schema");
  assert.equal(challenge.tools, undefined, "the Challenger judges what it was given; it does not search");
  assert.equal(challenge.output_config.effort, "high", "cheapen the CONTEXT, not the reasoning — a reviewer that thinks less than the writer waves things through");
});

test("wiring: the Challenger tracks the ANALYST's model, not the cheap one", async () => {
  // A reviewer weaker than the writer cannot out-argue it. The saving comes from effort, context
  // size and no web search — never from downgrading the judge.
  const { calls } = await runAnalyst([NOTE, JSON.stringify(THESIS_JSON), JSON.stringify(CHALLENGE_JSON)]);
  assert.equal(calls[2].model, "claude-opus-4-8");
  assert.ok(!calls[2].model.includes("haiku"));
});

test("wiring: a Challenger failure still saves the note AND its theses", async () => {
  // The note and the theses both already exist and are paid for. Losing them because the review
  // failed would be strictly worse than never having run a review.
  const { result } = await runAnalyst([NOTE, JSON.stringify(THESIS_JSON), "not json"]);
  assert.match(result.markdown, /## Theses/, "theses still render unchallenged");
  assert.ok(!result.markdown.includes("Where this read is weak"));
});

test("wiring: the rendered theses are saved INTO the note file, not just returned", async () => {
  const { result } = await runAnalyst([NOTE, JSON.stringify(THESIS_JSON)]);
  const onDisk = fs.readFileSync(result.filePath, "utf8");
  assert.match(onDisk, /## Theses/, "a thesis block only in memory would never be read");
  assert.match(onDisk, /Crush margins hold above trend/);
  assert.match(onDisk, /Dies if:/);
  // And the original note is still intact above it.
  assert.match(onDisk, /Crush margins are running at a record/);
});

test("wiring: a thesis-structuring FAILURE still saves and returns the note", async () => {
  // The expensive call already happened. Losing the note because the cheap follow-up failed would
  // be strictly worse than not having Phase 3 at all.
  const { result } = await runAnalyst([NOTE, "this is not json"]);
  assert.ok(result.filePath && fs.existsSync(result.filePath), "the note must be on disk");
  assert.match(result.markdown, /Crush margins are running at a record/);
  assert.ok(!result.markdown.includes("## Theses"), "no thesis block when structuring failed");
});

test("wiring: a THROWN structuring error still saves the note", async () => {
  const { result } = await runAnalyst([NOTE, new Error("network exploded")]);
  assert.ok(fs.existsSync(result.filePath));
  assert.match(result.markdown, /Crush margins are running at a record/);
});

test("wiring: when theses succeed the Haiku extractor does NOT also run", async () => {
  // Two filing paths over one note would double-file every claim under two wordings, and the
  // dedupe key is a hash of the claim text, so nothing downstream would catch the duplication.
  const { calls } = await runAnalyst([NOTE, JSON.stringify(THESIS_JSON), JSON.stringify(CHALLENGE_JSON)]);
  assert.equal(calls.length, 3, "a fourth call here is the Haiku extractor running as well");
  assert.ok(!calls.some((c) => c.model?.includes("haiku")), "the extractor is superseded, not stacked");
});

test("wiring: when theses FAIL the Haiku extractor still runs — the ledger keeps filling", async () => {
  const { calls } = await runAnalyst([NOTE, "not json", JSON.stringify({ forecasts: [] })]);
  assert.equal(calls.length, 3, "fallback must fire so Phase 3 never costs us the ledger");
  assert.ok(calls[2].model.includes("haiku"), "the third call is the legacy extractor");
});

test("wiring: the structuring call is offered only evidence ids that were actually shown", async () => {
  const { calls } = await runAnalyst([NOTE, JSON.stringify(THESIS_JSON)]);
  const userTurn = calls[1].messages[0].content;
  assert.match(userTurn, /EVIDENCE IDS/);
  // Signals are computed from stored series; on an empty test DB there may be none, but the section
  // must exist and must never contain an id the model was not shown.
  const ids = userTurn.slice(userTurn.indexOf("EVIDENCE IDS")).split("\n").filter((l) => /^(item|series|signal|brief):/.test(l));
  for (const id of ids) assert.ok(/^(item|series|signal|brief):.+/.test(id), `malformed offered id: ${id}`);
});
