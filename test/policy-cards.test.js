// Acceptance tests for the card-based daily policy brief (1.32.0).
//
// WHAT THIS FILE IS FOR. The brief used to be one model call producing prose, and prose cannot be
// checked. Every test here exists because the corresponding failure would otherwise ship looking
// exactly like a correct brief: a card with no procedural posture, a mechanism ending in "market
// sentiment", a final-rule claim resting on a trade-press article, or a `so_what` that quietly tells
// the reader to price grain.
//
// The eight numbered tests map 1:1 onto the acceptance criteria agreed for this build. They are
// numbered in the test names so a failure says which criterion broke.
//
// Zero deps (node --test), no network, no model calls — the Anthropic client is stubbed. Temp
// DATA_DIR, so nothing here can touch the dev database.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cards-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.BRIEF_MODEL = "claude-sonnet-5";
process.env.POLICY_REVIEW_MODEL = "claude-opus-4-8";

const store = await import("../src/store.js");
const { buildPolicyCards, applyDowngrade, buildEvidenceUniverse, bindEvidence, PRIOR_CARD_HOURS } = await import("../src/policycards.js");
const { lintCard } = await import("../src/policylint.js");
const { gradeEvidence, gradeRank } = await import("../src/provenance.js");
const { renderPolicyBrief, renderCard } = await import("../src/policyrender.js");
const { POLICY_DOMAIN_CONTEXT, MECHANISM_TERMINALS } = await import("../src/prompts/policy-domain.js");

const today = new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────

/** A well-formed card. Every test that wants ONE thing wrong starts from this and breaks that thing. */
const goodCard = (over = {}) => ({
  event_key: "fr:2026-13552",
  headline: "EPA reopens D4 volume comment period",
  what_changed: "EPA reopened the comment period on the 2027 biomass-based diesel volume obligation, citing new feedstock supply data submitted after the original close.",
  posture: {
    status: "comment_open",
    clock_date: inDays(30),
    clock_label: "comments close",
    detail: "Reopened notice published in the Federal Register; the original proposal is unchanged and remains a proposal.",
  },
  mechanism: {
    chain: [
      "EPA reopens comment on the 2027 D4 obligation",
      "A higher final D4 obligation would require more biomass-based diesel volume",
      "Producers bid harder for soybean oil as the marginal feedstock",
    ],
    terminal: "rvo_volume",
    weak_link: "Whether the reopening changes the final number at all is unknown; reopenings often confirm the original proposal.",
  },
  evidence: ["item:federal_register:2026-13552", "series:cbot:zl:front"],
  so_what: "An Iowa operation delivering to a crush plant sees this through processor bid competition for soybean oil, which shows up in local basis rather than in the board.",
  watch_next: { event: "Comment period closes and EPA sends the final rule to OMB", date: inDays(30) },
  certainty: "proposed",
  ...over,
});

/** Seed one official item so `item:` ids resolve, and one market series so `series:` ids resolve. */
function seedStore() {
  store.markSeen(
    {
      uid: "federal_register:2026-13552",
      sourceId: "federal_register",
      sourceLabel: "Federal Register",
      title: "Biomass-Based Diesel Volume; Reopening of Comment Period",
      summary: "EPA is reopening the comment period.".repeat(20),
      url: "https://www.federalregister.gov/documents/2026-13552",
      publishedAt: new Date().toISOString(),
      jurisdiction: "US-Federal",
      docType: "proposed-rule",
      raw: {},
    },
    { relevant: true, tier: "must_read", topicIds: [], oneLine: "why it matters", type: "proposed-rule" }
  );
  store.markSeen(
    {
      uid: "rss:ent-x:trade-1",
      sourceId: "rss",
      sourceLabel: "Farm Progress",
      title: "EPA said to finalise biodiesel volumes within weeks",
      summary: "Trade report.".repeat(30),
      url: "https://www.farmprogress.com/policy/epa-volumes",
      publishedAt: new Date().toISOString(),
      jurisdiction: null,
      docType: null,
      raw: {},
    },
    { relevant: true, tier: "must_read", topicIds: [], oneLine: "trade press", type: null }
  );
  // A fresh series so it is not excluded as stale. Daily cadence, points up to today.
  const points = [];
  for (let i = 20; i >= 0; i--) points.push({ period: inDays(-i), value: 50 + i });
  store.saveSeriesPoints("cbot:zl:front", { label: "CBOT soybean oil (front month)", unit: "cents/lb", category: "soy_products" }, points);
}
seedStore();

const ITEMS = [
  { uid: "federal_register:2026-13552", sourceId: "federal_register", sourceLabel: "Federal Register", title: "BBD volume; reopening", url: "https://www.federalregister.gov/documents/2026-13552", raw: { eventKey: "fr:2026-13552" }, summary: "x".repeat(400), tier: "must_read" },
  { uid: "rss:ent-x:trade-1", sourceId: "rss", sourceLabel: "Farm Progress", title: "EPA said to finalise volumes", url: "https://www.farmprogress.com/policy/epa-volumes", raw: { eventKey: "news:epa-volumes" }, summary: "y".repeat(400), tier: "must_read" },
];

/** A stub Anthropic client. `queue` supplies one JSON payload per call, in order. */
function stubClient(queue) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        const body = queue.shift();
        return {
          content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  };
}

const silent = () => {};

// ── 1. cold run end to end ────────────────────────────────────────────────────────────────────────

test("acceptance 1: a cold run produces a rendered brief end to end with no manual intervention", async () => {
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([
    { cards: [goodCard()] },
    { verdicts: [{ card_index: 0, verdict: "keep", failed_slot: "none", reason: "", corrected_certainty: "none" }] },
  ]);
  const { cards, stats } = await buildPolicyCards({
    relevantItems: ITEMS,
    edition: "am",
    dateLabel: today,
    runId,
    client,
    log: silent,
  });
  assert.equal(stats.drafted, 1);
  assert.equal(stats.out, 1, "the card survived lint and review");
  const md = renderPolicyBrief({ cards, dateLabel: today, edition: "am" });
  assert.match(md, /## ISA Policy Brief/);
  assert.match(md, /EPA reopens D4 volume comment period/);
  assert.match(md, /\*\*Mechanism:\*\*/);
  assert.match(md, /RVO volume by D-code/, "the mechanism terminal is rendered by its label");
  store.finishBriefRun(runId);
});

// ── 2. the lint catches a deliberately malformed card ─────────────────────────────────────────────

test("acceptance 2: every slot is required — a card missing any one of them fails the lint", () => {
  const ctx = { evidence: [{ id: "item:a", kind: "item", grade: "primary_source" }, { id: "series:b", kind: "series", grade: "primary_source" }] };
  assert.equal(lintCard(goodCard(), ctx).ok, true, "the reference card passes");

  const cases = [
    ["what_changed", goodCard({ what_changed: "" })],
    ["posture", goodCard({ posture: { status: "comment_open", clock_date: "", clock_label: "comments close", detail: "Reopened notice published." } })],
    ["mechanism", goodCard({ mechanism: { chain: ["one step only"], terminal: "rvo_volume", weak_link: "" } })],
    ["so_what", goodCard({ so_what: "" })],
    ["watch_next", goodCard({ watch_next: { event: "Monitor developments closely", date: inDays(10) } })],
    ["certainty", goodCard({ certainty: "quite likely" })],
  ];
  for (const [slot, card] of cases) {
    const res = lintCard(card, ctx);
    assert.equal(res.ok, false, `${slot}: a malformed card must fail`);
    assert.ok(res.failures.some((f) => f.slot === slot), `${slot}: the failure names the right slot, got ${JSON.stringify(res.failures.map((f) => f.slot))}`);
  }
});

test("acceptance 2b: a mechanism that ends in something uncheckable is rejected", () => {
  const ctx = { evidence: [{ id: "item:a", kind: "item", grade: "primary_source" }, { id: "series:b", kind: "series", grade: "primary_source" }] };
  const vague = goodCard({
    mechanism: {
      chain: ["EPA reopens the comment period", "This raises market uncertainty"],
      terminal: "rvo_volume",
      weak_link: "",
    },
  });
  const res = lintCard(vague, ctx);
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.rule === "vague_terminal"), "the banned terminal is caught in the final step");

  // And a terminal outside the allowed list is caught even when the prose looks fine.
  const bad = goodCard({ mechanism: { ...goodCard().mechanism, terminal: "vibes" } });
  assert.ok(lintCard(bad, ctx).failures.some((f) => f.rule === "bad_terminal"));
});

// ── 3. a dead adapter degrades the run rather than breaking it ─────────────────────────────────────

test("acceptance 3: a killed evidence layer is named in the brief and no card can rest on it", async () => {
  // The series exists and is fresh, but its layer is declared dead for this run.
  const { series, excludedSeries } = buildEvidenceUniverse({ items: ITEMS, excludeSeriesPrefixes: ["cbot:"] });
  assert.ok(excludedSeries >= 1, "the dead layer's series are withheld from the menu");
  assert.ok(!series.some((s) => s.series.startsWith("cbot:")), "no cbot series survives into the menu");

  // A card that cites the dead series therefore fails to bind, and the lint then rejects it for
  // having no market corroboration — it cannot silently ship citing a source that did not run.
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([{ cards: [goodCard()] }]);
  const { cards, stats } = await buildPolicyCards({
    relevantItems: ITEMS,
    edition: "am",
    dateLabel: today,
    runId,
    client,
    missingLayers: ["CBOT futures (market data)"],
    missingSeriesPrefixes: ["cbot:"],
    log: silent,
  });
  assert.equal(stats.out, 0, "the card depending on the dead layer did not ship");
  assert.ok(stats.evidenceDropped >= 1, "the citation to the dead series was dropped at bind time");
  assert.ok(stats.lintRules["evidence.no_market_series"] >= 1, "and the lint named why");

  // The run still completes and the brief names the layer.
  const md = renderPolicyBrief({ cards, dateLabel: today, edition: "am", missingLayers: ["CBOT futures (market data)"] });
  assert.match(md, /About this run/);
  assert.match(md, /CBOT futures \(market data\)/, "the missing layer is named, not silently omitted");
  store.finishBriefRun(runId);
});

// ── 4. trade press cannot establish that a rule is final ──────────────────────────────────────────

test("acceptance 4: a card whose only document evidence is trade press cannot be certainty:enacted", () => {
  const tradeOnly = {
    evidence: [
      { id: "item:rss:ent-x:trade-1", kind: "item", grade: "trade_press" },
      // A government STATISTIC is primary — and must not be allowed to launder the certainty claim.
      { id: "series:cbot:zl:front", kind: "series", grade: "primary_source" },
    ],
  };
  const res = lintCard(goodCard({ certainty: "enacted" }), tradeOnly);
  assert.equal(res.ok, false);
  assert.ok(
    res.failures.some((f) => f.rule === "enacted_without_primary"),
    "a series graded primary must not satisfy the primary-source requirement for the ACTION"
  );

  // With a primary-source document present, the same card is fine.
  const withPrimary = {
    evidence: [
      { id: "item:federal_register:2026-13552", kind: "item", grade: "primary_source" },
      { id: "series:cbot:zl:front", kind: "series", grade: "primary_source" },
    ],
  };
  assert.equal(lintCard(goodCard({ certainty: "enacted" }), withPrimary).ok, true);
});

test("provenance: the ladder grades by how we fetched it first, and by host second", () => {
  assert.equal(gradeEvidence({ sourceId: "federal_register", url: "https://example.test/x" }).grade, "primary_source");
  // ⚠️ The case that matters: a trade-press article LINKING to a primary source is still trade press.
  assert.equal(gradeEvidence({ sourceId: "rss", url: "https://www.farmprogress.com/x" }).grade, "trade_press");
  assert.equal(gradeEvidence({ sourceId: "rss", url: "https://www.epa.gov/newsreleases/x" }).grade, "agency_press");
  assert.equal(gradeEvidence({ sourceId: "rss", url: "https://www.federalregister.gov/documents/x" }).grade, "primary_source");
  assert.equal(gradeEvidence({ sourceId: "rss", url: "https://www.reuters.com/x" }).grade, "general_press");
  assert.equal(gradeEvidence({ sourceId: "email_intake", url: "https://www.federalregister.gov/x" }).grade, "aggregator", "a newsletter relay is not its links");
  const adv = gradeEvidence({ sourceId: "rss", url: "https://cleanfuels.org/press/x" });
  assert.equal(adv.grade, "trade_press");
  assert.equal(adv.advocacy, true, "an interested party is flagged as one");
  // An unenumerated .gov rounds DOWN to agency_press, never up to primary.
  assert.equal(gradeEvidence({ sourceId: "rss", url: "https://www.fmcsa.dot.gov/x" }).grade, "agency_press");
  assert.ok(gradeRank("primary_source") < gradeRank("trade_press"));
});

// ── 5. the advice boundary ────────────────────────────────────────────────────────────────────────

test("acceptance 5: an instruction-shaped so_what is caught mechanically", () => {
  const ctx = { evidence: [{ id: "item:a", kind: "item", grade: "primary_source" }, { id: "series:b", kind: "series", grade: "primary_source" }] };
  const planted = [
    "With the D4 obligation rising, you should sell into the rally before the final rule lands.",
    "Now is a good time to price the remainder of your old crop ahead of the announcement.",
    "We recommend holding unpriced bushels until the comment period closes.",
  ];
  for (const so_what of planted) {
    const res = lintCard(goodCard({ so_what }), ctx);
    assert.equal(res.ok, false, `must reject: ${so_what}`);
    assert.ok(res.failures.some((f) => f.slot === "so_what" && f.rule === "advice_boundary"));
  }
  // And the explanatory version of the same fact passes — the boundary is instruction, not topic.
  const ok = "A higher final D4 obligation would put more processor competition behind soybean oil, which reaches an Iowa operation as processor basis rather than as a board move.";
  assert.equal(lintCard(goodCard({ so_what: ok }), ctx).ok, true);
});

// ── 6. thread continuity ──────────────────────────────────────────────────────────────────────────

test("acceptance 6: a thread carded an hour ago is offered to the writer as a continuation, not as new", async () => {
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([
    { cards: [goodCard()] },
    { verdicts: [{ card_index: 0, verdict: "keep", failed_slot: "none", reason: "", corrected_certainty: "none" }] },
  ]);
  await buildPolicyCards({ relevantItems: ITEMS, edition: "am", dateLabel: today, runId, client, log: silent });
  store.finishBriefRun(runId);

  // Second run, an hour later in effect: the prior card must reach the prompt.
  const runId2 = store.startBriefRun({ edition: "pm", trigger: "manual" });
  const client2 = stubClient([{ cards: [] }]);
  await buildPolicyCards({ relevantItems: ITEMS, edition: "pm", dateLabel: today, runId: runId2, client: client2, log: silent });
  const userTurn = client2.calls[0].messages[0].content;
  assert.match(userTurn, /THREADS ALREADY CARDED RECENTLY/, "the second run is told the thread is a continuation");
  assert.match(userTurn, /fr:2026-13552/);
  store.finishBriefRun(runId2);

  // And a REJECTED card must never suppress a later corrected one.
  store.insertPolicyCard({ runId: runId2, eventKey: "fr:rejected-only", card: {}, certainty: "proposed", status: "rejected", rejectSlot: "mechanism" });
  assert.equal(store.priorCardsFor(["fr:rejected-only"], PRIOR_CARD_HOURS).size, 0, "rejections do not silence a thread");
});

// ── 7. cost ──────────────────────────────────────────────────────────────────────────────────────

test("acceptance 7: run cost is attributed and the ceiling aborts before spending past it", async () => {
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([
    { cards: [goodCard()] },
    { verdicts: [{ card_index: 0, verdict: "keep", failed_slot: "none", reason: "", corrected_certainty: "none" }] },
  ]);
  await buildPolicyCards({ relevantItems: ITEMS, edition: "am", dateLabel: today, runId, client, log: silent });
  const spent = store.runCostUsd(runId);
  assert.ok(spent > 0, "the run's model calls are attributed to it");
  assert.equal(store.runCostByModel(runId).length, 2, "cost is broken down per tier");
  store.finishBriefRun(runId);
  assert.ok(store.getBriefRun(runId).cost_usd > 0, "and stamped on the run row");

  // A ceiling already exceeded stops the run before the draft call is made at all.
  const runId2 = store.startBriefRun({ edition: "am", trigger: "manual" });
  store.recordUsage("claude-opus-4-8", "policy_cards", 4_000_000, 100_000, null); // ~$22.50
  const client2 = stubClient([{ cards: [goodCard()] }]);
  const { stats } = await buildPolicyCards({
    relevantItems: ITEMS,
    edition: "am",
    dateLabel: today,
    runId: runId2,
    client: client2,
    costCeilingUsd: 5,
    log: silent,
  });
  assert.equal(client2.calls.length, 0, "no model call is made once the ceiling is reached");
  assert.match(stats.aborted, /ceiling/);
  store.finishBriefRun(runId2, { status: "aborted_cost" });
});

// ── 8. the existing run types are untouched ───────────────────────────────────────────────────────

test("acceptance 8: the four memo presets are unchanged by this work", async () => {
  const { MEMO_PRESETS } = await import("../src/pipeline.js");
  assert.deepEqual(Object.keys(MEMO_PRESETS).sort(), ["analyst", "education", "monthly", "weekly"]);
  // Each preset still owns its own system prompt and none of them imports the policy-card contract —
  // that separation is the whole "additive, do not refactor existing run types" constraint.
  for (const [id, p] of Object.entries(MEMO_PRESETS)) {
    assert.equal(typeof p.system, "function", `${id} still builds its own system prompt`);
    const text = p.system("2026-08-10");
    assert.ok(!text.includes("six slots"), `${id} did not acquire the card contract`);
    assert.ok(!text.includes("what_changed"), `${id} did not acquire the card schema`);
  }
  // The Analyst Note keeps its explicit licence to give a directional read; the advice-boundary lint
  // in policylint.js applies to the daily brief's so_what ONLY and must never reach it.
  assert.match(MEMO_PRESETS.analyst.system("2026-08-10"), /This is analysis, not advice/);
  assert.equal(MEMO_PRESETS.analyst.model, "claude-opus-4-8");
  assert.equal(MEMO_PRESETS.analyst.maxTokens, 64000);
});

// ── supporting invariants ─────────────────────────────────────────────────────────────────────────

test("the reviewer may lower certainty and may never raise it", () => {
  assert.equal(applyDowngrade("enacted", "proposed"), "proposed");
  assert.equal(applyDowngrade("proposed", "speculative"), "speculative");
  // ⚠️ The direction that matters: a reviewer able to promote a proposal to a final rule would defeat
  // the entire point of the certainty field.
  assert.equal(applyDowngrade("proposed", "enacted"), "proposed");
  assert.equal(applyDowngrade("speculative", "enacted"), "speculative");
  assert.equal(applyDowngrade("proposed", "nonsense"), "proposed");
});

test("a reviewer rejection that names no slot is not honoured", async () => {
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([
    { cards: [goodCard()] },
    { verdicts: [{ card_index: 0, verdict: "reject", failed_slot: "none", reason: "I don't like it", corrected_certainty: "none" }] },
  ]);
  const { stats } = await buildPolicyCards({ relevantItems: ITEMS, edition: "am", dateLabel: today, runId, client, log: silent });
  assert.equal(stats.reviewRejected, 0, "a slotless rejection is ignored");
  assert.equal(stats.out, 1, "and the card survives");
  store.finishBriefRun(runId);
});

test("a card the reviewer forgot to return a verdict for is kept, not silently dropped", async () => {
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([
    { cards: [goodCard(), goodCard({ event_key: "news:epa-volumes", headline: "Second card" })] },
    { verdicts: [{ card_index: 0, verdict: "keep", failed_slot: "none", reason: "", corrected_certainty: "none" }] },
  ]);
  const { stats } = await buildPolicyCards({ relevantItems: ITEMS, edition: "am", dateLabel: today, runId, client, log: silent });
  assert.equal(stats.out, 2, "a short verdict list must not delete the brief");
  store.finishBriefRun(runId);
});

test("a card citing an event_key that was never supplied is dropped", async () => {
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([{ cards: [goodCard({ event_key: "fr:invented-by-the-model" })] }]);
  const { stats } = await buildPolicyCards({ relevantItems: ITEMS, edition: "am", dateLabel: today, runId, client, log: silent });
  assert.equal(stats.drafted, 0, "an unsupplied event key means the card describes something we never sent");
  store.finishBriefRun(runId);
});

test("unresolvable evidence ids are dropped rather than trusted", () => {
  const { universe } = buildEvidenceUniverse({ items: ITEMS });
  const itemsByUid = new Map(ITEMS.map((i) => [i.uid, i]));
  const { evidence, dropped } = bindEvidence(
    { evidence: ["item:federal_register:2026-13552", "item:does-not-exist", "series:cbot:zl:front", "series:invented:series"] },
    universe,
    itemsByUid
  );
  assert.equal(evidence.length, 2, "only the two real ids survive");
  assert.equal(dropped.length, 2);
  assert.ok(evidence.some((e) => e.kind === "item" && e.grade === "primary_source"));
  assert.ok(evidence.some((e) => e.kind === "series"));
});

test("the renderer separates certainty structurally, not just with a badge", () => {
  const cards = [
    goodCard({ certainty: "enacted", headline: "A final rule", evidence: [] }),
    goodCard({ certainty: "proposed", headline: "A mere proposal", evidence: [] }),
  ];
  const md = renderPolicyBrief({ cards, dateLabel: today, edition: "am" });
  const finalAt = md.indexOf("✅ In force");
  const proposedAt = md.indexOf("📝 Proposed — NOT final");
  assert.ok(finalAt >= 0 && proposedAt >= 0, "both sections render");
  assert.ok(finalAt < proposedAt, "in-force items come first");
  // The section carries the plain-language warning, not just the word "proposed".
  assert.match(md, /may change substantially or never take effect at all/);
  // And the per-card band is present too — belt and braces, both survive plain text.
  assert.match(md, /\*\*\[PROPOSED — NOT FINAL\]\*\*/);
  assert.match(md, /\*\*\[ENACTED — IN FORCE\]\*\*/);
});

test("a certainty downgrade is disclosed to the reader, not hidden", () => {
  const md = renderCard({ ...goodCard(), certainty: "proposed", downgradedFrom: "enacted", downgradeReason: "no primary source establishes finality" }, today);
  assert.match(md, /Certainty lowered from "enacted" in review/);
});

test("day counts in the rendered brief are computed, never copied from the model", () => {
  const md = renderCard(goodCard({ posture: { status: "comment_open", clock_date: inDays(3), clock_label: "comments close", detail: "Reopened notice published." } }), today);
  assert.match(md, /in 3 days/, "the count is derived from the date");
});

test("the shared domain block is large enough to actually cache, and both stages use the same one", async () => {
  // ⚠️ Sonnet 5 and Opus will not cache a prefix under 1,024 tokens. A "tidy up" that trims this
  // block would silently stop it caching while appearing to work.
  const approxTokens = Math.round(POLICY_DOMAIN_CONTEXT.length / 3.7);
  assert.ok(approxTokens >= 1024, `domain block is ~${approxTokens} tokens, under the 1,024 cache minimum`);
  const { POLICY_SYNTHESIS_SYSTEM } = await import("../src/prompts/policy-synthesis.js");
  const { POLICY_REVIEW_SYSTEM } = await import("../src/prompts/policy-review.js");
  assert.ok(POLICY_SYNTHESIS_SYSTEM.startsWith(POLICY_DOMAIN_CONTEXT), "synthesis shares the block verbatim");
  assert.ok(POLICY_REVIEW_SYSTEM.startsWith(POLICY_DOMAIN_CONTEXT), "review shares the SAME block — a reviewer working from a paraphrase is not a check");
});

test("the mechanism terminals the prompt describes are exactly the ones the lint enforces", () => {
  // Two hand-maintained copies — one telling the model the rule, one enforcing it — is how a lint
  // starts rejecting precisely what the prompt asked for.
  for (const t of MECHANISM_TERMINALS) {
    assert.ok(POLICY_DOMAIN_CONTEXT.includes(t.id), `${t.id} is described to the model`);
    const ctx = { evidence: [{ id: "item:a", kind: "item", grade: "primary_source" }, { id: "series:b", kind: "series", grade: "primary_source" }] };
    const res = lintCard(goodCard({ mechanism: { ...goodCard().mechanism, terminal: t.id } }), ctx);
    assert.ok(!res.failures.some((f) => f.rule === "bad_terminal"), `${t.id} is accepted by the lint`);
  }
});

// ── the fallback, which is the thing that stops a bug here costing a day's briefs ──────────────────

test("a broken card stage falls back to the prose brief AND says so in the brief", async () => {
  const { generateBrief } = await import("../src/brief.js");
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  // First call (draft) returns unparseable JSON; the prose writer then answers normally.
  const client = stubClient(["}{ not json at all", "## ISA Policy Brief — prose fallback\n\n### 🔴 What changed\nSomething happened."]);
  const md = await generateBrief({
    relevantItems: ITEMS,
    watchlist: { briefEditions: { timezone: "America/Chicago" }, sources: {} },
    edition: "am",
    env: process.env,
    stats: { fetchedCount: 10, sourceCount: 7, skippedSources: [] },
    runId,
    client,
  });
  assert.match(md, /prose fallback/, "the prose writer produced the body");
  // ⚠️ The part that matters: the fallback is ANNOUNCED. A silent fallback would hide that the card
  // path had stopped working, which is precisely the failure mode brief.js's header is about.
  assert.match(md, /fallback prose writer, not the card pipeline/);
  assert.match(md, /Slot checks and the adversarial review did NOT run/);
  store.finishBriefRun(runId);
});

test("the footer reports the card funnel so a short brief is explicable", async () => {
  const { generateBrief } = await import("../src/brief.js");
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([
    { cards: [goodCard(), goodCard({ event_key: "news:epa-volumes", headline: "Weak card", mechanism: { chain: ["one"], terminal: "rvo_volume", weak_link: "" } })] },
    { verdicts: [{ card_index: 0, verdict: "keep", failed_slot: "none", reason: "", corrected_certainty: "none" }] },
  ]);
  const md = await generateBrief({
    relevantItems: ITEMS,
    watchlist: { briefEditions: { timezone: "America/Chicago" }, sources: {} },
    edition: "am",
    env: process.env,
    stats: { fetchedCount: 10, sourceCount: 7, skippedSources: [] },
    runId,
    client,
  });
  assert.match(md, /cards 2 drafted → 1 failed the contract → 0 rejected in review → 1 published/);
  store.finishBriefRun(runId);
});

test("the draft call caches the system prompt and sends per-run data in the user turn", async () => {
  const runId = store.startBriefRun({ edition: "am", trigger: "manual" });
  const client = stubClient([{ cards: [] }]);
  await buildPolicyCards({ relevantItems: ITEMS, edition: "am", dateLabel: today, runId, client, log: silent });
  const req = client.calls[0];
  assert.equal(req.system[0].cache_control.type, "ephemeral", "the stable prefix carries the breakpoint");
  assert.ok(!req.system[0].text.includes(today), "no per-run date leaks into the cached prefix");
  assert.match(req.messages[0].content, new RegExp(today), "the date travels in the user turn instead");
  store.finishBriefRun(runId);
});
