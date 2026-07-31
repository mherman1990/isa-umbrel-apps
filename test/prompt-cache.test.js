// Regression tests for prompt caching (1.29.0) — the reorder that made it possible, and the
// invariants that keep it working.
//
// WHY THIS FILE EXISTS. Prompt caching is a PREFIX match rendered `tools` → `system` → `messages`,
// and a single byte moving inside the cached prefix yields zero reads and NO ERROR. A silently broken
// breakpoint is indistinguishable from a working one at runtime, so the only defence is asserting the
// prefix bytes directly.
//
// Before 1.29.0 the Ask box opened its user turn with `Question: ${question}` at byte ZERO, ahead of
// ~22,700 characters of question-blind market data — so nothing after the first line was cacheable,
// and a breakpoint on the system prompt alone would have been ~620 tokens, under Sonnet 5's
// 1,024-token minimum, and would have silently not cached at all.
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed — temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cache-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.BRIEF_MODEL = "claude-sonnet-5";
process.env.WEB_SEARCH = "off"; // keep `tools` out of the picture except where a test wants it

const { answerQuery } = await import("../src/pipeline.js");
const store = await import("../src/store.js");

// Seed enough that answerQuery doesn't take its "nothing stored yet" early return.
for (let i = 0; i < 3; i++) {
  store.markSeen(
    {
      uid: `cache-uid-${i}`,
      sourceId: "federal_register",
      title: `EPA dicamba registration review notice ${i}`,
      summary: "x".repeat(600),
      sourceLabel: "Federal Register",
      jurisdiction: "US-Federal",
      docType: "notice",
      url: `https://example.gov/${i}`,
      publishedAt: "2026-07-30T00:00:00Z",
      raw: {},
    },
    { relevant: true, oneLine: "matters to soy", topicIds: [], tier: "must_read" }
  );
}

/** Capture every request body the SDK sends. `pauseTurns` forces the resume loop. */
function captureRequests({ pauseTurns = 0 } = {}) {
  const bodies = [];
  const original = globalThis.fetch;
  let turn = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const paused = turn < pauseTurns;
    turn += 1;
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: paused ? "" : "the answer" }],
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_creation_input_tokens: paused ? 7000 : 0,
          cache_read_input_tokens: paused ? 0 : 7000,
        },
        stop_reason: paused ? "pause_turn" : "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
    );
  };
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

const firstUserBlocks = (body) => body.messages[0].content;
/** Everything the API hashes as the cached prefix: tools, then system, then the marked block(s). */
const cachedPrefix = (body) =>
  JSON.stringify([body.tools ?? null, body.system, firstUserBlocks(body).filter((b) => b.cache_control)]);

test("cache: the invariant context precedes the question in the user turn", async () => {
  const cap = captureRequests();
  try {
    await answerQuery("What is happening with 45Z?", process.env);
  } finally {
    cap.restore();
  }
  const blocks = firstUserBlocks(cap.bodies[0]);
  assert.ok(Array.isArray(blocks), "the user turn must be content BLOCKS, not one string");
  assert.equal(blocks.length, 2);

  // Block 1 is question-blind context and carries the breakpoint.
  assert.match(blocks[0].text, /^=== MARKET DATA/, "the cached block must start with the invariant market data");
  assert.ok(!blocks[0].text.includes("Question:"), "the question must NOT be inside the cached block");
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });

  // Block 2 is what varies with the question, and is NOT cached.
  assert.match(blocks[1].text, /Question: What is happening with 45Z\?$/, "the question must be last");
  assert.equal(blocks[1].cache_control, undefined);
});

test("cache: two DIFFERENT questions share a byte-identical cached prefix", async () => {
  // This is the payoff the reorder buys. The 15-minute askCache in server.js only dedupes IDENTICAL
  // questions, so distinct questions inside the TTL are exactly the case caching still pays for.
  const cap = captureRequests();
  try {
    await answerQuery("What is happening with 45Z?", process.env);
    await answerQuery("How is crush demand trending?", process.env);
  } finally {
    cap.restore();
  }
  assert.equal(cap.bodies.length, 2);
  assert.equal(
    cachedPrefix(cap.bodies[0]),
    cachedPrefix(cap.bodies[1]),
    "the cached prefix must not vary with the question"
  );
  // And the uncached tail genuinely differs, or we cached the wrong thing.
  assert.notEqual(firstUserBlocks(cap.bodies[0])[1].text, firstUserBlocks(cap.bodies[1])[1].text);
});

test("cache: a resume turn re-sends a byte-identical prefix", async () => {
  // The resume loop re-sends the ENTIRE request per turn. That is the one guaranteed repeat, so if
  // the prefix drifts here the loop pays full input price on every turn — the failure this release
  // exists to remove.
  const cap = captureRequests({ pauseTurns: 2 });
  try {
    await answerQuery("What is happening with 45Z?", process.env);
  } finally {
    cap.restore();
  }
  assert.equal(cap.bodies.length, 3, "two pauses then a completion");
  assert.equal(cachedPrefix(cap.bodies[0]), cachedPrefix(cap.bodies[1]));
  assert.equal(cachedPrefix(cap.bodies[1]), cachedPrefix(cap.bodies[2]));
  // The resume mechanism itself still works: each turn appends the assistant echo.
  assert.equal(cap.bodies[0].messages.length, 1);
  assert.equal(cap.bodies[1].messages.length, 2);
  assert.equal(cap.bodies[2].messages.length, 3);
  assert.equal(cap.bodies[1].messages[1].role, "assistant");
});

test("cache: at most one breakpoint on the Ask path, and never more than the API's four", async () => {
  const cap = captureRequests();
  try {
    await answerQuery("45Z", process.env);
  } finally {
    cap.restore();
  }
  const marked = firstUserBlocks(cap.bodies[0]).filter((b) => b.cache_control).length;
  assert.equal(marked, 1);
  assert.ok(marked <= 4, "the API allows a maximum of 4 cache_control breakpoints per request");
});

test("cache: tools stay byte-identical across resume turns", async () => {
  // `tools` renders FIRST in the prefix, so varying anything in it — including max_uses — would
  // invalidate the tools, system AND messages caches at once. This is why the retrieval planner in a
  // later phase must never be allowed to touch it.
  const prev = process.env.WEB_SEARCH;
  process.env.WEB_SEARCH = "on";
  const cap = captureRequests({ pauseTurns: 1 });
  try {
    await answerQuery("45Z", process.env);
  } finally {
    cap.restore();
    process.env.WEB_SEARCH = prev;
  }
  assert.ok(cap.bodies[0].tools, "web search should be attached when WEB_SEARCH is not 'off'");
  assert.equal(JSON.stringify(cap.bodies[0].tools), JSON.stringify(cap.bodies[1].tools));
});

test("cache: read and write tokens are persisted, per purpose", async () => {
  // Without this the reorder is unverifiable in production: a broken prefix yields zero reads and no
  // error, so "did it work?" can only be answered from stored counters.
  const cap = captureRequests({ pauseTurns: 1 });
  try {
    await answerQuery("does caching get recorded?", process.env);
  } finally {
    cap.restore();
  }
  const rows = store.getUsageByPurpose(1).filter((r) => r.purpose === "query");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].cache_write_tokens > 0, "the first turn's cache write must be recorded");
  assert.ok(rows[0].cache_read_tokens > 0, "the resume turn's cache read must be recorded");
});

test("cache: recordUsage stays backward compatible with 4-argument callers", async () => {
  store.recordUsage("claude-haiku-4-5", "cache-test-legacy", 10, 5);
  const row = store.getUsageByPurpose(1).find((r) => r.purpose === "cache-test-legacy");
  assert.ok(row, "a 4-arg call must still record");
  assert.equal(row.cache_read_tokens, 0);
  assert.equal(row.cache_write_tokens, 0);
});
