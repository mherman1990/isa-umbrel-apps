// Tests for thesis.js — Phase 3a. Every case here locks a MEASURED constraint or a rule that, if
// quietly relaxed, turns a grounded thesis back into a confident-sounding guess.
//
// Zero deps (node --test), fully offline: globalThis.fetch is stubbed so the Anthropic SDK never
// leaves the process, and the pure functions need no DB at all — resolveEvidence takes the universe
// as an argument precisely so this file does not have to stand up a store.

import test from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const { resolveEvidence, parseEvidenceId, applyBounds, demote, renderTheses, buildTheses, BOUNDS, THESIS_SCHEMA, CONFIDENCE_ORDER } =
  await import("../src/thesis.js");

const UNIVERSE = {
  itemUids: new Set(["fr-2026-1234", "cl-9981"]),
  seriesIds: new Set(["cbot:zs:settle", "ams:iowa:basis"]),
  signalIds: new Set(["crush_demand", "export_pace"]),
  briefPaths: new Set(["briefings/2026-08-05-am.md"]),
  reportKeys: new Set(["WASDE"]),
};

/** A well-formed model response, before applyBounds. Override to build the failing cases. */
function rawThesis(over = {}) {
  return {
    thesis: "Crush margins hold above trend into Q4.",
    narrative: "Capacity utilization is running at a record for the month and margins have not compressed.",
    horizon_days: 90,
    mechanism_chain: ["Record crush utilization", "Board crush margin stays wide", "Processors bid basis up"],
    supporting_evidence: ["signal:crush_demand", "series:cbot:zs:settle@2026-08"],
    counterevidence: ["item:cl-9981"],
    alternative_explanations: ["Margins are wide only because soybean oil is carrying them, and that can reverse."],
    confidence: "high",
    confirm: "The September NOPA crush print comes in above 200 million bushels.",
    invalidate: "Board crush margin falls below $1.20 for two consecutive weeks.",
    falsifiable_claim: {
      claim: "Iowa cash crush margin stays above $2.00 through Q4.",
      comparator: "stays_above",
      threshold: 2.0,
      direction: "n/a",
      series: "ams:iowa:basis",
      confirmingEvent: "Monthly NOPA crush report",
    },
    ...over,
  };
}

// ── THE MEASURED API CONSTRAINT ───────────────────────────────────────────────────────────────────

test("thesis: the schema contains NO minItems — the API rejects any value above 1", () => {
  // Measured 2026-08-06: `output_config.format.schema` returns
  // "For 'array' type, 'minItems' values other than 0 or 1 are not supported".
  // The plan specified mechanism_chain[2-5] and supporting_evidence[1-6] as schema constraints; they
  // cannot be. If someone "restores" them to the schema, every thesis call 400s — silently, because
  // buildTheses is fail-soft and would just stop producing theses.
  const json = JSON.stringify(THESIS_SCHEMA);
  assert.ok(!json.includes("minItems"), "minItems in the schema makes every request a 400");
  assert.ok(!json.includes("maxItems"), "maxItems is refused the same way");
  assert.ok(!json.includes("minimum"), "numeric bounds are refused too");
  // The bounds still exist — they just live in code.
  assert.equal(BOUNDS.mechanism_chain.min, 2);
  assert.equal(BOUNDS.supporting_evidence.min, 1);
});

// ── EVIDENCE RESOLUTION IS ARITHMETIC, NOT TRUST ──────────────────────────────────────────────────

test("thesis: an invented evidence id is dropped and counted, never silently kept", () => {
  const { resolved, dropped } = resolveEvidence(
    ["item:fr-2026-1234", "item:does-not-exist", "signal:crush_demand", "signal:invented_signal"],
    UNIVERSE
  );
  assert.deepEqual(resolved.map((r) => r.id), ["item:fr-2026-1234", "signal:crush_demand"]);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((d) => d.reason.startsWith("no such")));
});

test("thesis: a series id parses apart from its period, and the period is not part of the lookup", () => {
  // `series:<id>@<period>` — the id contains colons of its own (cbot:zs:settle), so splitting on the
  // FIRST colon and the LAST @ is load-bearing. Getting this backwards drops every series citation.
  const p = parseEvidenceId("series:cbot:zs:settle@2026-08");
  assert.equal(p.kind, "series");
  assert.equal(p.key, "cbot:zs:settle");
  assert.equal(p.period, "2026-08");
  const { resolved } = resolveEvidence(["series:cbot:zs:settle@2026-08"], UNIVERSE);
  assert.equal(resolved.length, 1, "a real series must resolve even with a period suffix");
});

test("thesis: a series cited without a period still resolves", () => {
  const { resolved } = resolveEvidence(["series:ams:iowa:basis"], UNIVERSE);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].period, null);
});

test("thesis: a web id is accepted on SHAPE only — the named hole in the grounding guarantee", () => {
  // A web citation is by definition not in the store, so it cannot be checked against it. A
  // well-formed but fabricated URL survives. This is accepted deliberately (the analyst has web
  // search on and its best source is often one we never stored) and is asserted here so the
  // limitation stays visible rather than being discovered later as a surprise.
  const { resolved, dropped } = resolveEvidence(["web:https://www.fas.usda.gov/x", "web:not-a-url"], UNIVERSE);
  assert.equal(resolved.length, 1);
  assert.equal(dropped.length, 1);
});

test("thesis: citing the same id twice is not two pieces of evidence", () => {
  const { resolved } = resolveEvidence(["signal:crush_demand", "signal:crush_demand"], UNIVERSE);
  assert.equal(resolved.length, 1, "repetition is not corroboration");
});

test("thesis: garbage and untagged ids are dropped, not guessed at", () => {
  const { resolved, dropped } = resolveEvidence(["fr-2026-1234", "", null, "nosuchkind:x"], UNIVERSE);
  assert.equal(resolved.length, 0);
  assert.equal(dropped.length, 4);
});

// ── THE GROUNDING RULE ────────────────────────────────────────────────────────────────────────────

test("thesis: a thesis with NO resolvable evidence is demoted to low and flagged, not rendered as confident", () => {
  const t = applyBounds(rawThesis({ supporting_evidence: ["item:made-up", "signal:also-made-up"], confidence: "high" }), UNIVERSE);
  assert.equal(t.confidence, "low", "this is the rule the whole phase exists for");
  assert.equal(t.confidenceStated, "high", "but what the model claimed is preserved for audit");
  assert.ok(t.needsReview);
  assert.ok(t.reviewNotes.some((n) => /no supporting evidence resolved/.test(n)));
  assert.equal(t.droppedCount, 2);
});

test("thesis: a demoted thesis is NOT deleted — a real read with sloppy citations still shows", () => {
  const t = applyBounds(rawThesis({ supporting_evidence: ["item:made-up"] }), UNIVERSE);
  assert.ok(t.thesis, "the thesis survives");
  const md = renderTheses([t]);
  assert.match(md, /Flagged for review/, "and says why, inline, where it cannot be compressed away");
});

test("thesis: partial grounding keeps the stated confidence — only ZERO resolvable evidence demotes", () => {
  const t = applyBounds(rawThesis({ supporting_evidence: ["signal:crush_demand", "item:invented"] }), UNIVERSE);
  assert.equal(t.confidence, "high");
  assert.deepEqual(t.supportingEvidence, ["signal:crush_demand"]);
  assert.equal(t.droppedCount, 1, "the invented one is still counted");
});

// ── BOUNDS ENFORCED IN CODE ───────────────────────────────────────────────────────────────────────

test("thesis: array bounds are enforced in code, since the schema cannot express them", () => {
  const t = applyBounds(
    rawThesis({
      mechanism_chain: ["a", "b", "c", "d", "e", "f", "g"],
      supporting_evidence: ["signal:crush_demand", "signal:export_pace", "item:fr-2026-1234", "item:cl-9981", "series:cbot:zs:settle", "series:ams:iowa:basis", "web:https://x.gov/a"],
    }),
    UNIVERSE
  );
  assert.equal(t.mechanismChain.length, BOUNDS.mechanism_chain.max);
  assert.equal(t.supportingEvidence.length, BOUNDS.supporting_evidence.max);
});

test("thesis: a one-step mechanism chain is flagged — that is an observation, not a thesis", () => {
  const t = applyBounds(rawThesis({ mechanism_chain: ["Crush is high"] }), UNIVERSE);
  assert.ok(t.needsReview);
  assert.ok(t.reviewNotes.some((n) => /fewer than 2/.test(n)));
});

test("thesis: no alternative explanation is flagged — an unexamined thesis says so out loud", () => {
  const t = applyBounds(rawThesis({ alternative_explanations: [] }), UNIVERSE);
  assert.ok(t.needsReview);
  assert.ok(t.reviewNotes.some((n) => /alternative/.test(n)));
});

test("thesis: empty strings do not count toward a bound", () => {
  const t = applyBounds(rawThesis({ mechanism_chain: ["a", "", "   "] }), UNIVERSE);
  assert.equal(t.mechanismChain.length, 1);
  assert.ok(t.needsReview, "one real step is still short of two");
});

// ── CONFIDENCE CAN ONLY GO DOWN ───────────────────────────────────────────────────────────────────

test("thesis: demote() moves exactly one step and never upward", () => {
  assert.equal(demote("high"), "medium");
  assert.equal(demote("medium"), "low");
  assert.equal(demote("low"), "low", "low is the floor");
  assert.equal(demote("nonsense"), "low", "an unknown value cannot become high");
  // The ladder itself is asserted, since the Challenger (3b) demotes against this order.
  assert.deepEqual(CONFIDENCE_ORDER, ["low", "medium", "high"]);
});

test("thesis: an unrecognized confidence value degrades to low, never to high", () => {
  const t = applyBounds(rawThesis({ confidence: "certain" }), UNIVERSE);
  assert.equal(t.confidence, "low");
});

// ── RENDER IS A TEMPLATE, NOT A MODEL CALL ────────────────────────────────────────────────────────

test("thesis: render is deterministic — same input, byte-identical output", () => {
  const t = applyBounds(rawThesis(), UNIVERSE);
  assert.equal(renderTheses([t]), renderTheses([t]));
});

test("thesis: the render surfaces the mechanism, the falsifier and the alternative reading", () => {
  const t = applyBounds(rawThesis(), UNIVERSE);
  const md = renderTheses([t]);
  assert.match(md, /Crush margins hold above trend/);
  assert.match(md, /Record crush utilization → Board crush margin/, "the chain renders in order");
  assert.match(md, /Dies if:/, "a thesis that cannot be killed is not falsifiable");
  assert.match(md, /Read it another way:/);
  assert.match(md, /signal:crush_demand/, "evidence ids are shown, so a reader can check them");
});

test("thesis: a lowered confidence says so, rather than quietly presenting the lower number", () => {
  const t = applyBounds(rawThesis({ supporting_evidence: ["item:nope"], confidence: "high" }), UNIVERSE);
  assert.match(renderTheses([t]), /stated high, lowered/);
});

test("thesis: rendering no theses produces nothing, not an empty heading", () => {
  assert.equal(renderTheses([]), "");
  assert.equal(renderTheses(null), "");
});

// ── THE MODEL CALL ────────────────────────────────────────────────────────────────────────────────

/** Stub the SDK transport and return {requestBody, result}. */
async function runBuild(responseTheses, { text = null } = {}) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  let requestBody = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: text ?? JSON.stringify({ theses: responseTheses }) }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
    );
  };
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const result = await buildTheses("x".repeat(400), {
      evidenceIds: ["item:fr-2026-1234", "signal:crush_demand"],
      universe: UNIVERSE,
      env: { ANTHROPIC_API_KEY: "k" },
    });
    return { requestBody, result, logs };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test("thesis: the structuring call carries NO tools — schema and web search do not combine", async () => {
  // Measured 2026-08-06: schema + an actually-running web search failed 5/5 (overloaded_error),
  // while schema-only and search-only both passed at the same moment. Adding a tools array here
  // would reintroduce that failure, and buildTheses is fail-soft so it would look like the model
  // simply stopped finding theses.
  const { requestBody } = await runBuild([rawThesis()]);
  assert.equal(requestBody.tools, undefined, "no tools on the schema-constrained call, ever");
  assert.ok(requestBody.output_config?.format?.type === "json_schema");
});

test("thesis: a malformed response yields null, so the note is still saved and delivered", async () => {
  const { result } = await runBuild(null, { text: "not json at all" });
  assert.equal(result, null, "structuring is an enhancement to the note, never a gate on it");
});

test("thesis: a short note is not sent to the model at all", async () => {
  const r = await buildTheses("too short", { evidenceIds: [], universe: UNIVERSE, env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r, null);
});

test("thesis: dropped evidence ids are logged — inventing citations is otherwise invisible", async () => {
  const { result, logs } = await runBuild([rawThesis({ supporting_evidence: ["signal:crush_demand", "item:invented", "item:also-invented"] })]);
  assert.equal(result.droppedTotal, 2);
  const line = logs.find((l) => l.includes("🧠 Theses:"));
  assert.match(line, /2 unresolvable evidence ids dropped/);
});

test("thesis: the prompt tells the model its invented ids will be dropped", async () => {
  const { requestBody } = await runBuild([rawThesis()]);
  assert.match(requestBody.system, /copied EXACTLY/i);
  assert.match(requestBody.system, /dropped/i);
  // And the ids it may cite are actually in the user turn.
  assert.match(requestBody.messages[0].content, /item:fr-2026-1234/);
});

test("thesis: a thesis missing its prose is discarded rather than rendered empty", async () => {
  const { result } = await runBuild([rawThesis(), rawThesis({ thesis: "", narrative: "" })]);
  assert.equal(result.theses.length, 1);
});
