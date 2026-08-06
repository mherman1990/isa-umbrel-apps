// Regression tests for brief.js — the twice-daily output Matt actually reads, and (like triage.js
// before v1.28.0) a module that shipped with no test coverage while three releases changed the data
// underneath it.
//
// WHY THIS FILE EXISTS. Between 2026-07-08 and v1.28.0 this file was never touched, while v1.26.0
// added graded triage tiers, v1.27.0 grounded official documents and collapsed cross-filed actions,
// and v1.28.0 grounded news. None of it reached the writer: the projection carried ten fields with no
// tier and zero characters of document text, and sorted by keyword score — the signal the news eval
// measured ranking a personnel notice (10) above a SCOTUS FIFRA ruling (8).
//
// So these tests assert on the PAYLOAD SENT TO THE MODEL, never on prose. The model is stubbed; what
// is verifiable — and what silently regressed for three releases — is which items are selected, in
// what order, and carrying what evidence.
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed so the Anthropic SDK never leaves
// the process — and a temp DATA_DIR so the real DB is untouched.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-brief-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.BRIEF_MODEL = "claude-sonnet-5";

const { generateBrief, __testing } = await import("../src/brief.js");
// Imported AFTER POLIBRIEF_DATA_DIR is set, so the packet rows land in the temp DB above.
const store = await import("../src/store.js");

const WATCHLIST = {
  sources: { legiscan: { states: ["IA", "IL"] } },
  briefEditions: { timezone: "America/Chicago" },
  output: {},
};
const STATS = { fetchedCount: 120, sourceCount: 18, skippedSources: [] };

/** Today in the watchlist timezone, the same way brief.js computes its dateLabel. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const daysFromToday = (n) => {
  const base = Date.parse(`${today()}T00:00:00Z`);
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
};

let seq = 0;
function action(over = {}) {
  seq += 1;
  return {
    uid: over.uid ?? `uid-${seq}`,
    title: over.title ?? `Action ${seq}`,
    oneLine: "a sentence about the title",
    sourceLabel: "Federal Register",
    publishedAt: "2026-07-30T00:00:00Z",
    url: `https://example.gov/${seq}`,
    docType: "notice",
    jurisdiction: "US-Federal",
    tier: "worth_knowing",
    localScore: 5,
    eventFilings: 1,
    summary: "x".repeat(1000), // a real abstract unless a test overrides it
    raw: {},
    ...over,
  };
}

/** Run generateBrief against a stubbed model and return { items, body, requestBody, logs }. */
async function runBrief(relevantItems, { watchlist = WATCHLIST, text = "## Brief\n\nbody text" } = {}) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  let requestBody = null;
  let calls = 0;

  globalThis.fetch = async (_url, init) => {
    calls += 1;
    requestBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text }],
        usage: { input_tokens: 500, output_tokens: 200 },
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
    );
  };
  console.log = (...a) => logs.push(a.join(" "));

  try {
    const body = await generateBrief({ relevantItems, watchlist, edition: "am", env: process.env, stats: STATS });
    const userText = requestBody?.messages?.[0]?.content ?? "";
    const items = requestBody ? JSON.parse(userText.slice(userText.indexOf("["))) : [];
    return { items, body, requestBody, logs, calls };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test("brief: tier outranks localScore — the keyword count is only a tie-break", async () => {
  const { items } = await runBrief([
    action({ uid: "noise", title: "Personnel notice", tier: "background", localScore: 40 }),
    action({ uid: "ruling", title: "SCOTUS FIFRA preemption ruling", tier: "must_read", localScore: 3 }),
  ]);
  assert.equal(items[0].uid, "ruling", "must_read at score 3 must precede background at score 40");
  assert.equal(items[1].uid, "noise");
});

test("brief: localScore still breaks a tie once tier, deadline and evidence are equal", async () => {
  const { items } = await runBrief([
    action({ uid: "low", localScore: 1 }),
    action({ uid: "high", localScore: 30 }),
  ]);
  assert.equal(items[0].uid, "high");
});

test("brief: a deadline inside the action window outranks a later one at the same tier", async () => {
  const { items } = await runBrief([
    action({ uid: "far", raw: { commentsCloseOn: daysFromToday(60) } }),
    action({ uid: "soon", raw: { commentsCloseOn: daysFromToday(5) } }),
  ]);
  assert.equal(items[0].uid, "soon");
});

test("brief: evidence strength breaks a tier tie — grounded precedes ungrounded", async () => {
  const { items } = await runBrief([
    action({ uid: "bare", summary: "" }),
    action({ uid: "grounded", summary: "y".repeat(1200) }),
  ]);
  assert.equal(items[0].uid, "grounded");
  assert.equal(items[0].evidenceBasis, "document");
  assert.equal(items[1].evidenceBasis, "title_only");
});

test("brief: a cross-filed action outranks a one-off at equal tier and evidence", async () => {
  const { items } = await runBrief([
    action({ uid: "single", eventFilings: 1 }),
    action({ uid: "crossfiled", eventFilings: 4 }),
  ]);
  assert.equal(items[0].uid, "crossfiled");
  assert.equal(items[0].eventFilings, 4);
});

test("brief: an item with NO tier sorts as worth_knowing, never as background", async () => {
  // The NULL-tier trap, same one test/filter-tiers.test.js locks for the LRD filter. Defaulting a
  // missing tier to "background" would silently disqualify the item from being a development.
  const { items } = await runBrief([
    action({ uid: "background", tier: "background" }),
    action({ uid: "untiered", tier: undefined }),
  ]);
  assert.equal(items[0].uid, "untiered");
  assert.equal(__testing.tierRank({ tier: undefined }), __testing.tierRank({ tier: "worth_knowing" }));
});

test("brief: the payload carries document text; the roster is metadataOnly", async () => {
  const many = Array.from({ length: 20 }, (_, i) => action({ uid: `u${i}`, localScore: 100 - i }));
  const { items } = await runBrief(many);

  const withDoc = items.filter((i) => i.document !== undefined);
  const metaOnly = items.filter((i) => i.metadataOnly === true);

  assert.equal(withDoc.length, 10, "default payload budget is 10");
  assert.equal(metaOnly.length, 10, "the next 10 travel as metadata");
  assert.ok(metaOnly.every((i) => i.document === undefined), "roster items must not carry a document");
  // Every item still carries the three fields the old projection dropped.
  assert.ok(items.every((i) => i.priority !== undefined && i.eventFilings !== undefined && i.evidenceBasis !== undefined));
});

test("brief: nothing beyond the roster budget is sent, and the true total is logged", async () => {
  const many = Array.from({ length: 31 }, (_, i) => action({ uid: `u${i}`, localScore: 100 - i }));
  const { items, logs } = await runBrief(many);

  assert.equal(items.length, 25, "roster budget caps what is sent");
  const line = logs.find((l) => l.includes("Brief:"));
  assert.ok(line, "a summary line must be logged");
  assert.ok(line.includes("31 relevant"), `the true pre-cap total must be logged, got: ${line}`);
  assert.ok(line.includes("6 not sent"), `the withheld count must be logged, got: ${line}`);
});

test("brief: tracked items are in the payload and survive both budgets", async () => {
  // 30 pinned items exceed both budgets. The analyst asked to follow them, so none may be dropped
  // and all must carry evidence.
  const pinned = Array.from({ length: 30 }, (_, i) => action({ uid: `t${i}`, tracked: true, tier: "background", localScore: 0 }));
  const loud = action({ uid: "loud", tier: "must_read", localScore: 99 });
  const { items } = await runBrief([...pinned, loud]);

  const sentTracked = items.filter((i) => i.tracked);
  assert.equal(sentTracked.length, 30, "no tracked item may be dropped by a cap");
  assert.ok(sentTracked.every((i) => i.document !== undefined), "tracked items must carry evidence");
});

test("brief: daysToDeadline is computed for the model, not left to it", async () => {
  const { items } = await runBrief([action({ uid: "d", raw: { commentsCloseOn: daysFromToday(9) } })]);
  assert.equal(items[0].daysToDeadline, 9);
  assert.equal(items[0].commentDeadline, daysFromToday(9));
});

test("brief: date arithmetic is DST-safe across a spring-forward boundary", async () => {
  // Compared as UTC midnights, so the March transition cannot shift a day count.
  assert.equal(__testing.daysBetweenDates("2026-03-07", "2026-03-09"), 2);
  assert.equal(__testing.daysBetweenDates("2026-11-01", "2026-11-02"), 1);
  assert.equal(__testing.daysBetweenDates("2026-07-01", "not-a-date"), null);
});

test("brief: evidenceBasis flips at the measured 200-character line", async () => {
  assert.equal(__testing.evidenceBasisOf({ summary: "" }), "title_only", "eurlex_oj / iowa_admin_rules emit empty summaries");
  assert.equal(__testing.evidenceBasisOf({ summary: "x".repeat(199) }), "title_only", "an RSS teaser is not evidence");
  assert.equal(__testing.evidenceBasisOf({ summary: "x".repeat(200) }), "document");
});

test("brief: the document excerpt is capped and marked as truncated", async () => {
  const { items } = await runBrief([action({ uid: "long", summary: "z".repeat(5000) })]);
  assert.ok(items[0].document.length <= __testing.BRIEF_DOC_CHARS + 8);
  assert.ok(items[0].document.endsWith("[…]"), "truncation must be visible to the model");
});

test("brief: the stats footer is appended verbatim and the model's text is not post-processed", async () => {
  const { body } = await runBrief([action()], { text: "## Heading\n\nExact model prose." });
  assert.ok(body.startsWith("## Heading\n\nExact model prose."), "model text must pass through unchanged");
  assert.ok(body.includes("120 items across 18 sources"));
  assert.ok(body.includes("1 relevant after triage"));
  assert.ok(body.includes("Skipped sources: none"));
});

test("brief: an empty item list makes no model call", async () => {
  const { calls, body } = await runBrief([]);
  assert.equal(calls, 0, "an empty day must not be billed");
  assert.ok(body.includes("Quiet day"));
});

test("brief: thinking is disabled — the 8k ceiling is for prose, not reasoning", async () => {
  const { requestBody } = await runBrief([action()]);
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal(requestBody.max_tokens, 8000);
});

test("brief: the prompt states the four rules that keep the writer honest", async () => {
  const { requestBody } = await runBrief([action()]);
  // Asterisks stripped so these assert the WORDING of each rule, not its markdown emphasis.
  const sys = requestBody.system.replace(/\*/g, "");
  assert.match(sys, /title_only[\s\S]*never be a "What changed" development/i, "ungrounded items may not be developments");
  assert.match(sys, /Repetition is not evidence/i, "cross-filed copies may not read as corroboration");
  assert.match(sys, /priority "background" may never be a "What changed" development/i);
  assert.match(sys, /document as sourced fact and oneLine as someone else's summary/i);
});

test("brief: the writer is told not to hard-wrap — the email renderer splits on newlines", async () => {
  // Verified against markdownToEmailHtml: it turns every LINE into its own <p>. The old contract
  // said "keep every item to one line" so this never arose; the new one asks for 2–3 sentences per
  // development, which would arrive as broken fragments if the model wrapped them.
  const { requestBody } = await runBrief([action()]);
  assert.match(requestBody.system.replace(/\*/g, ""), /ONE line — do not hard-wrap/i);
});

test("brief: the section contract is the decision structure, not source buckets", async () => {
  const { requestBody } = await runBrief([action()]);
  const sys = requestBody.system;
  for (const heading of ["What changed", "Needs attention", "Could matter later", "Deadlines & required actions", "Evidence", "What to watch"]) {
    assert.ok(sys.includes(heading), `missing section: ${heading}`);
  }
  // The seven source-by-source buckets are gone.
  for (const gone of ["Federal rules & notices", "Rulemaking dockets", "Federal legislation", "Iowa administrative rules"]) {
    assert.ok(!sys.includes(gone), `source bucket should be removed: ${gone}`);
  }
});

test("brief: no farmer path remains", async () => {
  const src = fs.readFileSync(new URL("../src/brief.js", import.meta.url), "utf8");
  assert.ok(!/farmerBriefSystemPrompt|isFarmer|brief-farmer/.test(src), "the retired farmer twin must be gone");
  // And passing the old parameter cannot resurrect it.
  const { requestBody } = await runBrief([action()]);
  assert.ok(!/NONPARTISAN policy update/i.test(requestBody.system));
});

// ── EVIDENCE PACKETS REACH THE BRIEF ──────────────────────────────────────────────────────────────
//
// v1.30.0 built packets and wired them into `compactItems`, so the Ask box and the Analyst Note read
// verified extractions while the twice-daily brief still read raw text — the SAME shape of gap this
// file was created to catch, one release later. These tests assert on the payload, not on prose.

/** Insert a packet keyed on `eventKey`. Defaults describe a real, quotable extraction. */
function seedPacket(eventKey, over = {}) {
  store.upsertPacket({
    eventKey,
    leadUid: over.leadUid ?? "lead-uid",
    sourceUid: over.sourceUid ?? "src-uid",
    sufficiency: over.sufficiency ?? "full",
    sourceChars: over.sourceChars ?? 2400,
    model: "claude-haiku-4-5",
    packet: {
      sufficiency: over.sufficiency ?? "full",
      what_happened: "EPA set the 2027 RFS volumes.",
      claims: [{ text: "Biomass-based diesel rises", kind: "fact", attributed_to: "", evidence_index: 0 }],
      actions_required: [{ who: "Refiners", what: "Comment on the docket", by_when: "2026-09-01" }],
      dates: [{ date: "2026-09-01", what: "Comments close", kind: "comment_close" }],
      quantities: [],
      soy_mechanisms: ["Soybean oil demand for biodiesel"],
      evidence: [{ quote: "the Agency is finalizing the 2027 volumes", locator: "p. 3" }],
      unknowns: ["Whether the SRE backlog is addressed"],
      not_in_document: ["Any change to the 45Z credit"],
      ...(over.packet ?? {}),
    },
  });
}

test("brief: a packet REPLACES the document excerpt — the same text is never paid for twice", async () => {
  seedPacket("evt-replace");
  const { items } = await runBrief([
    action({ uid: "packed", summary: "z".repeat(1200), raw: { eventKey: "evt-replace" } }),
  ]);
  assert.equal(items[0].evidenceBasis, "packet");
  assert.ok(items[0].packet, "the packet must be sent");
  assert.equal(items[0].document, undefined, "sending both would bill twice for the same source text");
  // The verified quote is the point of the whole exercise — it must survive into the payload.
  assert.equal(items[0].packet.evidence[0].quote, "the Agency is finalizing the 2027 volumes");
});

test("brief: a packet-backed item outranks a fully-grounded raw-document one at equal tier", async () => {
  seedPacket("evt-rank");
  const { items } = await runBrief([
    action({ uid: "rawdoc", summary: "y".repeat(4000), raw: {} }),
    action({ uid: "packed", summary: "y".repeat(900), raw: { eventKey: "evt-rank" } }),
  ]);
  // Same tier, same deadline, same eventFilings — evidence strength is the only discriminator, and a
  // verified extraction beats a longer pile of raw text.
  assert.equal(items[0].uid, "packed");
  assert.equal(items[1].uid, "rawdoc");
});

test("brief: a THIN packet is ignored — a packet restating the title is worse than the document", async () => {
  // The honesty floor in packets.js stores "thin" when the source was too short to support more.
  // Spending prompt space on it would dress a teaser up as verified evidence.
  seedPacket("evt-thin", { sufficiency: "thin", sourceChars: 180 });
  const { items } = await runBrief([
    action({ uid: "thinly", summary: "q".repeat(1200), raw: { eventKey: "evt-thin" } }),
  ]);
  assert.equal(items[0].packet, undefined, "a thin packet must not be sent");
  assert.equal(items[0].evidenceBasis, "document");
  assert.ok(items[0].document, "it falls back to the document excerpt");
});

test("brief: a roster item keeps its real evidenceBasis but carries no packet payload", async () => {
  // evidenceBasis says what the item RESTS ON; metadataOnly says what was SENT. Collapsing the two
  // would make every roster item look ungrounded and disqualify it under the title_only rule.
  seedPacket("evt-roster");
  const many = Array.from({ length: 12 }, (_, i) => action({ uid: `f${i}`, localScore: 100 - i }));
  const { items } = await runBrief([
    ...many,
    action({ uid: "rostered", localScore: 0, tier: "background", raw: { eventKey: "evt-roster" } }),
  ]);
  const rostered = items.find((i) => i.uid === "rostered");
  assert.equal(rostered.metadataOnly, true);
  assert.equal(rostered.packet, undefined, "the roster must not carry packet payloads — that is the cost control");
  assert.equal(rostered.evidenceBasis, "packet", "but its basis is still honestly reported");
});

test("brief: an item with no eventKey simply has no packet — the lookup never throws", async () => {
  const { items } = await runBrief([action({ uid: "keyless", raw: {} }), action({ uid: "noraw", raw: undefined })]);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.packet === undefined));
});

test("brief: the prompt gives the packet a contract — the field is never sent unexplained", async () => {
  seedPacket("evt-prompt");
  const { requestBody } = await runBrief([action({ raw: { eventKey: "evt-prompt" } })]);
  const sys = requestBody.system.replace(/\*/g, "");
  assert.match(sys, /packet/i, "the writer must be told what a packet is");
  assert.match(sys, /verbatim substring/i, "and why its quotes can be trusted");
  assert.match(sys, /evidenceBasis.*packet/is, "the three-valued basis must be described");
  assert.match(sys, /unknowns/i, "and told not to fill the gaps the source left open");
});

test("brief: the packet count is logged — the packet path fails silently otherwise", async () => {
  seedPacket("evt-log");
  const { logs } = await runBrief([
    action({ uid: "packed", raw: { eventKey: "evt-log" } }),
    action({ uid: "plain", raw: {} }),
  ]);
  const line = logs.find((l) => l.includes("📝 Brief:"));
  assert.ok(line, "the brief must report what it sent");
  assert.match(line, /1 packet-backed/, "an empty packet map must be visible from the Pi's Logs pane");
});
