// Regression tests for evidence packets (1.30.0).
//
// WHY THIS FILE EXISTS. A packet is a structured extraction of a source document. The extraction itself
// is the easy part; the hard part is HONESTY, because a confidently-structured packet built from a
// 180-character RSS teaser is worse than no packet at all — it launders a headline into something that
// reads like sourced evidence, and every downstream prompt would treat it as such.
//
// Three layers enforce that in CODE rather than trusting the model, and each is tested here:
//   1. Below 800 source chars, no model call happens at all. 800 is measured, not chosen: on the real
//      68-item news corpus before grounding, 12 rows had no body, 48 had 1–199 chars, 8 had 200–799, and
//      none exceeded 800.
//   2. `sufficiency` is floored by code from the measured source length — a model claiming "full" on 300
//      characters is stored as thin.
//   3. Every evidence quote is checked as a verbatim substring of the source; failures are dropped and
//      counted, and a majority failure downgrades the packet.
//
// Also locked: the must_read scoping (a cost control — $1.44/mo vs $5.28 unscoped), compute-once-per
// event_key, and the pipeline ORDERING (packets read seen_items.body and never fetch, so running them
// before grounding makes every news packet silently thin).
//
// Zero deps (node --test), no network, temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-packets-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.TRIAGE_MODEL = "claude-haiku-4-5";

const store = await import("../src/store.js");
const { buildPackets, applyFloor, verifyEvidence, buildThinPacket, THIN_SOURCE_CHARS, PACKET_SCHEMA } =
  await import("../src/packets.js");

// A realistic Federal Register document. STATE.md records the real one behind a stored row at ~9,200
// characters, so this is sized to exercise the "full" sufficiency path rather than sitting in the
// partial band. The operative sentences come first so the quotes used below are genuinely present.
const LONG_DOC =
  "The Environmental Protection Agency is proposing to amend the registration of dicamba products " +
  "for use on soybeans. The proposal would narrow the application window and impose additional " +
  "buffer requirements. Comments must be received on or before September 14, 2026. " +
  "The Agency estimates approximately 45 million acres of soybeans could be affected. " +
  "Supporting analyses, docket materials and the economic assessment are available in the docket. ".repeat(60);

/**
 * Seed one must_read row and return its event key.
 *
 * ⚠️ The title MUST be unique per uid. `eventKeyFor` falls back to a normalized title, so seeding two
 * rows with the same title makes them ONE action sharing ONE packet — which is the system working
 * correctly, but it silently destroys per-test isolation (a later test sees "already packeted, reused"
 * and makes zero calls). Learned the hard way.
 */
function seed(uid, { body = LONG_DOC, tier = "must_read", title = `EPA proposes dicamba amendments (${uid})` } = {}) {
  store.markSeen(
    {
      uid,
      sourceId: "federal_register",
      title,
      summary: body,
      sourceLabel: "Federal Register",
      jurisdiction: "US-Federal",
      docType: "notice",
      url: `https://example.gov/${uid}`,
      publishedAt: "2026-07-30T00:00:00Z",
      raw: {},
    },
    { relevant: true, oneLine: "matters to soy", topicIds: [], tier }
  );
  return store.packetCandidates(100).find((r) => r.uid === uid)?.event_key;
}

/** A stub Anthropic client that returns a canned packet and counts calls. */
function stubClient(packetOverrides = {}, { throwOnce = false } = {}) {
  const calls = [];
  let thrown = false;
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        if (throwOnce && !thrown) {
          thrown = true;
          throw new Error("simulated API failure");
        }
        const packet = {
          sufficiency: "full",
          what_happened: "EPA proposed amending dicamba registrations for soybeans.",
          claims: [
            { text: "The proposal narrows the application window.", kind: "fact", attributed_to: "", evidence_index: 0 },
          ],
          actions_required: [{ who: "affected parties", what: "file comments", by_when: "2026-09-14" }],
          dates: [{ date: "2026-09-14", what: "comments due", kind: "comment_close" }],
          entities: [{ name: "Environmental Protection Agency", role: "agency" }],
          quantities: [{ value: 45, unit: "million acres", what: "soybean acres potentially affected", as_of: "" }],
          soy_mechanisms: [
            { channel: "production_cost", direction: "uncertain", explanation: "Buffer requirements could change weed-control costs." },
          ],
          evidence: [{ quote: "would narrow the application window", locator: "" }],
          unknowns: [],
          not_in_document: [],
          ...packetOverrides,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(packet) }],
          usage: { input_tokens: 1500, output_tokens: 400 },
        };
      },
    },
  };
}

// ---------- layer 1: no model call on thin text ----------

test("packets: a feed teaser produces a thin packet with ZERO model calls", async () => {
  seed("p-thin", { body: "EPA proposes dicamba changes. Read more at example.gov." }); // ~55 chars
  const client = stubClient();
  const stats = await buildPackets({ env: process.env, client, log: () => {} });

  assert.equal(client.calls.length, 0, "text below the measured teaser line must never be sent to a model");
  assert.equal(stats.thin, 1);
  assert.equal(stats.extracted, 0);

  const p = store.getPacket(store.packetCandidates(100).find((r) => r.uid === "p-thin").event_key);
  assert.equal(p.sufficiency, "thin");
  assert.equal(p.model, null, "a free packet records no model");
  assert.match(p.packet.unknowns[0], /feed teaser|never retrieved/i, "it must say WHY it is thin");
  assert.ok(p.packet.not_in_document.length, "and what is therefore absent");
});

test("packets: the thin threshold is the measured 800 characters", () => {
  assert.equal(THIN_SOURCE_CHARS, 800);
  const thin = buildThinPacket({ title: "T", comment_deadline: null }, 0);
  assert.equal(thin.sufficiency, "thin");
  assert.deepEqual(thin.claims, []);
  assert.deepEqual(thin.evidence, []);
});

test("packets: a thin packet still carries a recorded comment deadline", () => {
  // The one piece of hard information a teaser row does have — losing it would be a regression.
  const thin = buildThinPacket({ title: "T", comment_deadline: "2026-08-12T00:00:00Z" }, 100);
  assert.equal(thin.dates.length, 1);
  assert.equal(thin.dates[0].date, "2026-08-12");
  assert.equal(thin.dates[0].kind, "comment_close");
});

// ---------- layer 2: sufficiency floored by code ----------

test("packets: sufficiency is FLOORED by source length, never trusted from the model", () => {
  assert.equal(applyFloor("full", 300), "thin", "a model claiming 'full' on 300 chars is stored as thin");
  assert.equal(applyFloor("full", 1200), "partial", "between the thresholds it caps at partial");
  assert.equal(applyFloor("full", 5000), "full");
  assert.equal(applyFloor("thin", 5000), "thin", "the floor caps DOWNWARD only — it never promotes");
  assert.equal(applyFloor("nonsense", 5000), "thin", "an unrecognized value is treated as thin");
});

test("packets: a model claiming 'full' on short text is stored as capped, end to end", async () => {
  // 900 chars: past the teaser line, short of the partial->full line.
  seed("p-short", { body: "x".repeat(900) });
  const client = stubClient({ sufficiency: "full", evidence: [] });
  await buildPackets({ env: process.env, client, log: () => {} });
  const key = store.packetCandidates(100).find((r) => r.uid === "p-short").event_key;
  assert.equal(store.getPacket(key).sufficiency, "partial", "the code's ceiling wins over the model's claim");
});

// ---------- layer 3: verbatim evidence ----------

test("packets: an evidence quote absent from the source is dropped and counted", () => {
  const src = "The Agency proposes to narrow the application window for dicamba products.";
  const v = verifyEvidence(
    {
      sufficiency: "full",
      evidence: [
        { quote: "narrow the application window", locator: "" }, // real
        { quote: "the Agency will ban all use immediately", locator: "" }, // fabricated
      ],
      claims: [{ text: "c", kind: "fact", attributed_to: "", evidence_index: 1 }],
    },
    src
  );
  assert.equal(v.evidence.length, 1, "only the verbatim quote survives");
  assert.equal(v.evidence_rejected, 1);
  assert.equal(v.claims[0].evidence_index, -1, "a claim pointing at a dropped quote must be orphaned, not left dangling");
});

test("packets: whitespace differences do not fail an otherwise verbatim quote", () => {
  const src = "The Agency\n  proposes   to narrow\tthe window.";
  const v = verifyEvidence({ sufficiency: "full", evidence: [{ quote: "proposes to narrow the window", locator: "" }] }, src);
  assert.equal(v.evidence.length, 1, "normalized whitespace still counts as verbatim");
  assert.equal(v.evidence_rejected, 0);
});

test("packets: a trivially short 'quote' proves nothing and is rejected", () => {
  const v = verifyEvidence({ sufficiency: "full", evidence: [{ quote: "the", locator: "" }] }, "the agency proposes");
  assert.equal(v.evidence.length, 0);
});

test("packets: a majority of fabricated quotes downgrades the packet, and never upgrades it", () => {
  const src = "Only this exact sentence appears in the source document text.";
  const many = verifyEvidence(
    {
      sufficiency: "full",
      evidence: [
        { quote: "Only this exact sentence appears", locator: "" },
        { quote: "a completely invented passage one", locator: "" },
        { quote: "a completely invented passage two", locator: "" },
      ],
      claims: [],
    },
    src
  );
  assert.equal(many.sufficiency, "partial", "2 of 3 fabricated caps it at partial");
  assert.equal(many.evidence_downgraded, true);

  // And it must not promote a thin packet.
  const thin = verifyEvidence({ sufficiency: "thin", evidence: [{ quote: "invented entirely here", locator: "" }], claims: [] }, src);
  assert.equal(thin.sufficiency, "thin");
});

// ---------- scoping, reuse, ordering, fail-soft ----------

test("packets: only must_read actions qualify — a grounded worth_knowing action gets no call", async () => {
  seed("p-wk", { tier: "worth_knowing", title: "Worth knowing but not must-read" });
  const client = stubClient();
  await buildPackets({ env: process.env, client, log: () => {} });
  assert.ok(
    !client.calls.some((c) => JSON.stringify(c).includes("Worth knowing but not must-read")),
    "widening this widens the bill: must_read only is ~$1.44/mo, all relevant events ~$5.28/mo"
  );
});

test("packets: computed once per event_key — a second pass makes no new calls", async () => {
  seed("p-once");
  const first = stubClient();
  await buildPackets({ env: process.env, client: first, log: () => {} });
  assert.ok(first.calls.length >= 1);

  const second = stubClient();
  const stats = await buildPackets({ env: process.env, client: second, log: () => {} });
  assert.equal(second.calls.length, 0, "the PM run must reuse what the AM run paid for");
  assert.ok(stats.reused >= 1);
});

test("packets: re-extracted when the body materially grows (the grounding heal path)", async () => {
  const uid = "p-grow";
  seed(uid, { body: "y".repeat(850) }); // extracted, but only just past the teaser line
  const first = stubClient();
  await buildPackets({ env: process.env, client: first, log: () => {} });
  assert.equal(first.calls.length, 1);

  // groundItemBody heals the row into a full article — the real path is a teaser becoming an article,
  // which is a large multiple, not a nudge. The 2x regrow rule exists so a marginal change does NOT
  // buy a second extraction.
  assert.ok(LONG_DOC.length > 850 * 2, "the fixture must actually clear the regrow bar it is testing");
  store.groundItemBody(uid, LONG_DOC);
  const second = stubClient();
  await buildPackets({ env: process.env, client: second, log: () => {} });
  assert.equal(second.calls.length, 1, "a materially longer body earns a re-extraction");
});

test("packets: a MARGINAL body increase does not buy a second extraction", async () => {
  const uid = "p-nudge";
  seed(uid, { body: "z".repeat(900) });
  const first = stubClient();
  await buildPackets({ env: process.env, client: first, log: () => {} });
  assert.equal(first.calls.length, 1);

  store.groundItemBody(uid, "z".repeat(1200)); // grew, but nowhere near 2x
  const second = stubClient();
  await buildPackets({ env: process.env, client: second, log: () => {} });
  assert.equal(second.calls.length, 0, "re-extracting for 300 extra characters is money for nothing");
});

test("packets: a failure writes NO row so the next run retries", async () => {
  seed("p-fail");
  const failing = stubClient({}, { throwOnce: true });
  const stats = await buildPackets({ env: process.env, client: failing, log: () => {} });
  assert.equal(stats.failed, 1);
  const key = store.packetCandidates(100).find((r) => r.uid === "p-fail").event_key;
  assert.equal(store.getPacket(key), null, "no row means the next run tries again and the consumer falls back");

  const ok = stubClient();
  await buildPackets({ env: process.env, client: ok, log: () => {} });
  assert.ok(store.getPacket(key), "the retry succeeds");
});

test("packets: the budget caps calls AND the log states the true qualifying total", async () => {
  for (let i = 0; i < 5; i++) seed(`p-budget-${i}`, { title: `Budgeted action ${i}` });
  const client = stubClient();
  const logs = [];
  const stats = await buildPackets({ env: process.env, client, log: (m) => logs.push(m), budget: 2 });
  assert.equal(client.calls.length, 2, "the budget is honoured");
  const line = logs.join(" ");
  assert.match(line, /qualified/, "no silent caps — the true total must be reported");
  assert.match(line, /next run/);
  assert.ok(stats.qualified >= 5);
});

test("packets: uses the cheap extraction model and stays schema-constrained", async () => {
  seed("p-model");
  const client = stubClient();
  await buildPackets({ env: process.env, client, log: () => {} });
  const req = client.calls[0];
  assert.equal(req.model, "claude-haiku-4-5", "this is parsing, not analysis");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.ok(req.output_config.format.schema.required.includes("not_in_document"));
});

test("packets: the schema demands the honesty fields, and empty arrays are valid", () => {
  for (const f of ["sufficiency", "unknowns", "not_in_document", "evidence", "claims"]) {
    assert.ok(PACKET_SCHEMA.required.includes(f), `${f} must be required`);
  }
  assert.equal(PACKET_SCHEMA.additionalProperties, false);
  const claim = PACKET_SCHEMA.properties.claims.items.properties.kind;
  assert.deepEqual(claim.enum, ["fact", "projection", "assertion_by_party"],
    "a party's position must be separable from an established fact");
});

test("packets: buildPackets runs AFTER grounding in the pipeline — reordering makes news packets thin", () => {
  const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  const enrichAt = src.indexOf("await enrichItems(");
  const groundAt = src.indexOf("await groundNewsItems(");
  const packetAt = src.indexOf("await buildPackets(");
  assert.ok(enrichAt > 0 && groundAt > 0 && packetAt > 0, "all three call sites must exist");
  assert.ok(packetAt > enrichAt, "packets must follow official enrichment");
  assert.ok(packetAt > groundAt, "packets must follow news grounding — they read seen_items.body and never fetch");
  // And after triage, since eligibility is triage_tier = must_read.
  assert.ok(packetAt > src.indexOf("const { relevant, verdicts } = await triageItems("), "packets must follow triage");
});

// ---------- the consumer ----------

test("packets: compactItems sends the packet INSTEAD of the document, and labels the basis", async () => {
  seed("p-consume");
  const client = stubClient();
  await buildPackets({ env: process.env, client, log: () => {} });

  // compactItems is module-private, so drive it through the real Ask path and inspect the payload.
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "m", type: "message", role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const { answerQuery } = await import("../src/pipeline.js");
    await answerQuery("dicamba", process.env, "ui");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const text = body.messages[0].content.map((b) => b.text).join("\n");
  const items = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  const withPacket = items.find((i) => i.evidenceBasis === "packet");
  assert.ok(withPacket, "a packeted action must be labelled evidenceBasis 'packet'");
  assert.ok(withPacket.packet, "and carry the packet");
  assert.equal(withPacket.document, undefined, "sending both would pay twice for the same text");
  assert.ok(withPacket.packet.evidence.length >= 1, "verified quotes travel with it");
  // The prompt must EXPLAIN the field, or the model gets a structure it was never told about.
  assert.match(body.system, /evidenceBasis/);
  assert.match(body.system, /verbatim quote from the source/i);
});
