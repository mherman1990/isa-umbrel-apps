// Tests for challenger.js — Phase 3b.
//
// The Challenger's value depends entirely on rules that are enforced in CODE rather than by the
// model's goodwill, because every one of them fails SILENTLY and in the flattering direction:
//
//   - A Challenger that could RAISE confidence would be an amplifier, not a check — and nobody would
//     notice, because a more confident note reads better.
//   - A malformed response that defaulted to `approve` would silently bless an entire note.
//   - A thesis nobody reviewed, rendered identically to an approved one, is a false assurance.
//
// So each is asserted here against the pure functions, with the model stubbed out entirely.
//
// Zero deps (node --test), no network.

import test from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const { applyChallenges, renderWeakness, challengeTheses, VERDICTS, CHALLENGE_SCHEMA } = await import("../src/challenger.js");

/** A grounded thesis as it leaves thesis.js applyBounds(). */
function thesis(over = {}) {
  return {
    thesis: "Crush margins hold above trend into Q4.",
    narrative: "Utilization is at a record for the month.",
    horizonDays: 90,
    mechanismChain: ["Record utilization", "Margins stay wide"],
    supportingEvidence: ["signal:crush_demand"],
    counterevidence: [],
    alternativeExplanations: ["Soybean oil alone is carrying it."],
    confidence: "high",
    confidenceStated: "high",
    confirm: "September NOPA print.",
    invalidate: "Board crush below $1.20 for two weeks.",
    falsifiableClaim: { claim: "Board crush stays above $1.20.", comparator: "stays_above", threshold: 1.2, series: "", confirmingEvent: "NOPA" },
    droppedEvidence: [],
    droppedCount: 0,
    needsReview: false,
    reviewNotes: [],
    ...over,
  };
}

function challenge(over = {}) {
  return {
    thesis_index: 0,
    verdict: "approve",
    reason: "Holds as stated.",
    caveat: "",
    relationship: "independent",
    evidence_precedes_outcome: "yes",
    seasonal_risk: "none",
    duplicate_sources: "none",
    series_measures_claim: "not_applicable",
    history_sufficient: "yes",
    ...over,
  };
}

// ── THE RULE THAT MATTERS MOST ────────────────────────────────────────────────────────────────────

test("challenger: the Challenger can NEVER raise confidence", () => {
  // There is no verdict that raises confidence, and no code path that could. Asserted across every
  // verdict rather than just the obvious one, because the dangerous version of this bug is a new
  // verdict added later that quietly promotes.
  for (const verdict of VERDICTS) {
    const low = applyChallenges([thesis({ confidence: "low", confidenceStated: "low" })], [challenge({ verdict })]);
    assert.equal(low.all[0].confidence, "low", `${verdict} must not raise a low-confidence thesis`);
    const med = applyChallenges([thesis({ confidence: "medium", confidenceStated: "medium" })], [challenge({ verdict })]);
    assert.ok(["low", "medium"].includes(med.all[0].confidence), `${verdict} must not raise a medium thesis`);
  }
});

test("challenger: lower_confidence demotes exactly ONE step, and floors at low", () => {
  const high = applyChallenges([thesis({ confidence: "high" })], [challenge({ verdict: "lower_confidence" })]);
  assert.equal(high.all[0].confidence, "medium", "one step, not straight to low");
  const low = applyChallenges([thesis({ confidence: "low" })], [challenge({ verdict: "lower_confidence" })]);
  assert.equal(low.all[0].confidence, "low", "low is the floor");
});

test("challenger: an unrecognised verdict becomes human_review, NEVER approve", () => {
  // Failing open here would let one malformed response bless a whole note.
  const r = applyChallenges([thesis()], [challenge({ verdict: "looks_great_to_me" })]);
  assert.equal(r.all[0].verdict, "human_review");
  assert.equal(r.all[0].confidence, "medium", "and an unjudgeable high-confidence thesis is stepped down");
});

test("challenger: a thesis with NO challenge is recorded as unreviewed, not approved", () => {
  // The database has to be able to tell "approved" from "never looked at". If an unreviewed thesis
  // were stored as approve, the approve rate — the stated kill criterion — would be meaningless.
  const r = applyChallenges([thesis(), thesis()], [challenge({ thesis_index: 0 })]);
  assert.equal(r.all[0].verdict, "approve");
  assert.equal(r.all[1].verdict, null);
  assert.equal(r.all[1].caveat, null);
  assert.equal(r.all[1].confidence, "high", "an unreviewed thesis is not penalised either");
});

test("challenger: a challenge with a non-integer index is ignored rather than misapplied", () => {
  const r = applyChallenges([thesis()], [challenge({ thesis_index: "0" })]);
  assert.equal(r.all[0].verdict, null, "a verdict applied to the wrong thesis is worse than none");
});

// ── REJECTION IS RECORDED, NOT JUST DELETED ───────────────────────────────────────────────────────

test("challenger: reject removes the thesis from the note but keeps it for the record", () => {
  const r = applyChallenges(
    [thesis({ thesis: "Good one" }), thesis({ thesis: "Bad one" })],
    [challenge({ thesis_index: 0 }), challenge({ thesis_index: 1, verdict: "reject", reason: "Rests on one datapoint counted twice." })]
  );
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].thesis, "Good one");
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].thesis, "Bad one");
  assert.equal(r.all.length, 2, "all[] is what gets persisted — a deleted read comes back looking new");
});

test("challenger: approve clears any caveat the model attached anyway", () => {
  const r = applyChallenges([thesis()], [challenge({ verdict: "approve", caveat: "some hedge" })]);
  assert.equal(r.all[0].caveat, null, "an approved thesis must not render a warning");
});

test("challenger: the six structured checks survive onto the thesis for persistence", () => {
  const r = applyChallenges(
    [thesis()],
    [challenge({ verdict: "add_caveat", caveat: "Only two years of history behind that percentile.", duplicate_sources: "some", history_sufficient: "no" })]
  );
  assert.equal(r.all[0].checks.duplicateSources, "some");
  assert.equal(r.all[0].checks.historySufficient, "no");
  assert.equal(r.all[0].caveat, "Only two years of history behind that percentile.");
});

// ── SHOWN, NOT HIDDEN ─────────────────────────────────────────────────────────────────────────────

test("challenger: a clean note renders NO weakness section", () => {
  const r = applyChallenges([thesis()], [challenge()]);
  assert.equal(renderWeakness(r, ""), "", "inventing a warning for a clean note trains the reader to ignore it");
});

test("challenger: a caveated thesis and a rejected one both surface, with reasons", () => {
  const r = applyChallenges(
    [thesis({ thesis: "Caveated" }), thesis({ thesis: "Rejected" })],
    [
      challenge({ thesis_index: 0, verdict: "add_caveat", caveat: "Two years of history only." }),
      challenge({ thesis_index: 1, verdict: "reject", reason: "Two ids are the same filing." }),
    ]
  );
  const md = renderWeakness(r, "");
  assert.match(md, /Where this read is weak/);
  assert.match(md, /Two years of history only/);
  assert.match(md, /~~Rejected~~/, "a removed thesis is shown as removed, not silently absent");
  assert.match(md, /Two ids are the same filing/);
});

test("challenger: a lowered confidence says so in the weakness section", () => {
  const r = applyChallenges([thesis()], [challenge({ verdict: "lower_confidence", caveat: "Thin history." })]);
  assert.match(renderWeakness(r, ""), /confidence lowered to medium/);
});

test("challenger: a note-level concern renders even when every thesis is approved", () => {
  // The inter-thesis finding is the one a per-thesis pass cannot make; it must not be dropped just
  // because each thesis individually passed.
  const r = applyChallenges([thesis()], [challenge()]);
  const md = renderWeakness(r, "All three theses rest on the same crush datapoint.");
  assert.match(md, /Across the note/);
  assert.match(md, /same crush datapoint/);
});

// ── THE CALL ──────────────────────────────────────────────────────────────────────────────────────

test("challenger: the schema has no minItems — the API rejects any value above 1", () => {
  const json = JSON.stringify(CHALLENGE_SCHEMA);
  assert.ok(!json.includes("minItems") && !json.includes("maxItems"));
});

async function runChallenge(body) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let requestBody = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: body }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
    );
  };
  console.log = () => {};
  try {
    const result = await challengeTheses([thesis()], { context: "ctx", env: { ANTHROPIC_API_KEY: "k", ANALYST_MODEL: "claude-opus-4-8" } });
    return { requestBody, result };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test("challenger: the request carries no tools and runs at medium effort", async () => {
  const { requestBody } = await runChallenge(JSON.stringify({ challenges: [challenge()], note_level_concern: "" }));
  assert.equal(requestBody.tools, undefined, "schema + web search does not work — see thesis.js");
  assert.equal(requestBody.output_config.effort, "medium");
  assert.equal(requestBody.model, "claude-opus-4-8");
});

test("challenger: the prompt tells it that zero lead-lag results are CORRECT, not missing", async () => {
  // Without this the reviewer reads a Bonferroni-corrected null result as a gap in the evidence and
  // penalises every thesis that cites a series.
  const { requestBody } = await runChallenge(JSON.stringify({ challenges: [], note_level_concern: "" }));
  assert.match(requestBody.system, /no significant leads.*CORRECT|CORRECT result/i);
});

test("challenger: the prompt explicitly permits approval", async () => {
  // A reviewer that never approves is as useless as one that always does, and the failure looks like
  // rigour, so it survives review.
  const { requestBody } = await runChallenge(JSON.stringify({ challenges: [], note_level_concern: "" }));
  assert.match(requestBody.system, /BE WILLING TO APPROVE/i);
});

test("challenger: a malformed response yields null — the theses render unchallenged", async () => {
  const { result } = await runChallenge("not json");
  assert.equal(result, null);
});

test("challenger: no theses means no call at all", async () => {
  const r = await challengeTheses([], { env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r, null);
});
