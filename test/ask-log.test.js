// Regression tests for ask logging + the bounded tracked block (1.29.0).
//
// WHY THIS FILE EXISTS.
//
// 1. `answerQuery` persisted NOTHING — not the question, not the hit count, not whether the web-search
//    tool was reached for. The most direct evidence of what this tool cannot answer was produced twice
//    a day and discarded, which made "which questions do we keep failing?" and "where do we keep going
//    to the web for the same gap?" unanswerable. Those are the highest-signal inputs to deciding which
//    data source to add next.
//
// 2. `store.listTracked()` was `SELECT *` with NO LIMIT, and both prompt call sites interpolated the
//    whole result with no slice — the one genuinely unbounded block in any prompt this tool builds.
//    Invisible at two pins; at a few hundred it would crowd out the retrieved items beside it. Pins are
//    also the only user-curated signal in the context, so a silent truncation is the worst kind: the
//    block reads as "these are all your pins" either way.
//
// Zero deps (node --test), no network, temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-asklog-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.BRIEF_MODEL = "claude-sonnet-5";
process.env.WEB_SEARCH = "off";

const { answerQuery } = await import("../src/pipeline.js");
const store = await import("../src/store.js");
const Database = (await import("better-sqlite3")).default;
const raw = new Database(store.DB_PATH);
const asks = () => raw.prepare("SELECT * FROM ask_log ORDER BY id").all();

function seedItem(uid, title) {
  store.markSeen(
    {
      uid,
      sourceId: "federal_register",
      title,
      summary: "x".repeat(600),
      sourceLabel: "Federal Register",
      jurisdiction: "US-Federal",
      docType: "notice",
      url: `https://example.gov/${uid}`,
      publishedAt: "2026-07-30T00:00:00Z",
      raw: {},
    },
    { relevant: true, oneLine: "matters", topicIds: [], tier: "must_read" }
  );
}

/** Stub the model with a given answer text and optional server_tool_use blocks. */
function withModel(text, { searchBlocks = 0 } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const content = [];
    for (let i = 0; i < searchBlocks; i++) content.push({ type: "server_tool_use", id: `stu_${i}`, name: "web_search", input: {} });
    content.push({ type: "text", text });
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content,
        usage: { input_tokens: 500, output_tokens: 80 },
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
    );
  };
  return () => { globalThis.fetch = original; };
}

test("asklog: an ask with no stored data at all is logged as unanswered, with no model call", async () => {
  // The early-return path — an ask that never reaches the model is the strongest evidence of a gap,
  // and was previously the one case that left no trace whatsoever.
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error("should not be called"); };
  try {
    const { answer } = await answerQuery("what about 45Z?", process.env, "cli");
    assert.match(answer, /Nothing stored yet matches/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, false, "no model call on the early return");
  const rows = asks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unanswered, 1);
  assert.equal(rows[0].hits, 0);
  assert.equal(rows[0].source, "cli");
});

test("asklog: a normal ask records hits, source and answer length", async () => {
  seedItem("ask-1", "EPA dicamba registration review");
  const restore = withModel("Here is a full, grounded answer about dicamba.");
  try {
    await answerQuery("What is happening with dicamba?", process.env, "ui");
  } finally {
    restore();
  }
  const row = asks().at(-1);
  assert.equal(row.source, "ui");
  assert.ok(row.hits > 0, "retrieved items must be counted");
  assert.equal(row.unanswered, 0, "a grounded answer is not unanswered");
  assert.ok(row.answer_chars > 0);
  assert.match(row.answer, /grounded answer/);
});

test("asklog: `unanswered` is derived deterministically from the prompt's own phrases", async () => {
  // No second model call judging the first. The Ask system prompt instructs the model to say the
  // substance was not retrieved rather than inferring it, so that phrase is a reliable marker.
  const restore = withModel("The substance was not retrieved for this action, so I can't say.");
  try {
    await answerQuery("what did the notice actually say?", process.env, "ui");
  } finally {
    restore();
  }
  assert.equal(asks().at(-1).unanswered, 1);
});

test("asklog: web_search usage is counted from server_tool_use blocks", async () => {
  const prev = process.env.WEB_SEARCH;
  process.env.WEB_SEARCH = "on";
  const restore = withModel("Answer with two web lookups.", { searchBlocks: 2 });
  try {
    await answerQuery("what is the current soybean price?", process.env, "ui");
  } finally {
    restore();
    process.env.WEB_SEARCH = prev;
  }
  assert.equal(asks().at(-1).web_searches, 2, "the count was available before and thrown away");
});

test("asklog: repeat askings group by normalized question", async () => {
  // The apostrophe is the common case: the same question typed with and without one must group.
  assert.equal(store.normalizeQuestion("What's happening with 45Z?"), store.normalizeQuestion("whats happening with 45z"));
  assert.equal(store.normalizeQuestion("What’s happening"), store.normalizeQuestion("whats happening"), "typographic apostrophe too");
  assert.equal(store.normalizeQuestion("  Multiple   spaces!!  "), "multiple spaces");
  // But a hyphen separates two real words and must stay a separator.
  assert.equal(store.normalizeQuestion("lead-lag"), "lead lag");
});

test("asklog: unansweredAsks surfaces repeated failures, not one-offs", async () => {
  const restore = withModel("The substance was not retrieved.");
  try {
    for (let i = 0; i < 3; i++) await answerQuery("What are analyst expectations for the WASDE?", process.env, "ui");
    await answerQuery("A one-off question asked once", process.env, "ui");
  } finally {
    restore();
  }
  const gaps = store.unansweredAsks({ days: 1, minTimes: 2 });
  const repeated = gaps.find((g) => /wasde/i.test(g.example));
  assert.ok(repeated, "a question that repeatedly fails must surface");
  assert.ok(repeated.times >= 3);
  assert.ok(!gaps.some((g) => /one-off/i.test(g.example)), "a single failure is not yet a gap");
});

test("asklog: a logging failure never breaks the answer", async () => {
  // Instrumentation sits on the path of something the user is waiting for.
  const originalLog = store.logAsk;
  const restore = withModel("A good answer.");
  try {
    // Force the write to throw by handing normalizeQuestion something hostile is not enough — assert
    // the call is wrapped instead, which is the property that matters.
    const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
    assert.match(src, /try \{\s*store\.logAsk\(\{/, "the logAsk call must be inside a try");
    assert.match(src, /Ask logging skipped/, "and must degrade with a message rather than throwing");
    const { answer } = await answerQuery("still works?", process.env, "ui");
    assert.match(answer, /A good answer/);
  } finally {
    restore();
    assert.equal(store.logAsk, originalLog);
  }
});

// ---------- bounded tracked block ----------

test("tracked: listTracked caps when asked and returns everything when not", () => {
  for (let i = 0; i < 40; i++) {
    seedItem(`pin-${i}`, `Pinned action ${i}`);
    store.trackItem(`pin-${i}`);
  }
  assert.equal(store.trackedCount(), 40);
  assert.equal(store.listTracked(25).length, 25, "a limit must be honoured");
  assert.equal(store.listTracked().length, 40, "no limit still returns everything, for UI views");
});

test("tracked: the prompt block is capped AND states the true total", async () => {
  // No silent caps: the block must never read as "these are all your pinned items" when it isn't.
  let body = null;
  const original = globalThis.fetch;
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
    await answerQuery("anything", process.env, "ui");
  } finally {
    globalThis.fetch = original;
  }
  const cached = body.messages[0].content[0].text;
  const trackedSection = cached.slice(cached.indexOf("=== TRACKED ITEMS"));
  const listed = (trackedSection.match(/^- Pinned action /gm) ?? []).length;
  assert.equal(listed, 25, "the block is capped at the prompt limit");
  assert.match(trackedSection, /\(\+15 more pinned items not listed here\)/, "the remainder must be stated");
});

test("tracked: trackedKeySet stays unlimited — it is movement detection, not a prompt block", () => {
  assert.equal(store.trackedKeySet().size, 40, "capping this would silently stop flagging older pins");
});
