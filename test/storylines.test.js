// Regression tests for the storyline DELTA (1.30.0).
//
// WHY THIS FILE EXISTS. The storylines table's own comment claimed the summary and timeline "accumulate
// rather than resetting". They did not. `upsertStoryline` set `summary = excluded.summary` and
// `timeline = excluded.timeline`, so on every run — twice daily — the previous "what changed" and the
// ENTIRE previous timeline were discarded and rewritten from whatever the rolling 21-day window
// happened to hold. Only `key` and `first_seen` actually persisted.
//
// Two consequences: a thread could not show a delta, because nothing older existed to compare against;
// and a dated event that fell out of the 21-day window vanished permanently even though it was the
// thread's own history.
//
// The input side was the other half: `generateStorylines` fed the model a bare list of thread NAMES
// while instructing it to "continue existing threads", so a delta was not computable from the inputs at
// all — the model could only re-summarize the current window.
//
// Zero deps (node --test), no network — globalThis.fetch is stubbed — temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-story-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.BRIEF_MODEL = "claude-sonnet-5";

const store = await import("../src/store.js");
const { generateStorylines } = await import("../src/pipeline.js");
const Database = (await import("better-sqlite3")).default;
const raw = new Database(store.DB_PATH);
const rowOf = (key) => raw.prepare("SELECT * FROM storylines WHERE key = ?").get(key);

test("storylines: a prior summary MOVES to prev_summary rather than being overwritten", () => {
  store.upsertStoryline({ key: "t-45z", name: "45Z", summary: "Treasury guidance pending.", timeline: [] });
  store.upsertStoryline({ key: "t-45z", name: "45Z", summary: "Treasury issued proposed guidance.", timeline: [] });

  const r = rowOf("t-45z");
  assert.equal(r.summary, "Treasury issued proposed guidance.", "the new summary is current");
  assert.equal(r.prev_summary, "Treasury guidance pending.", "the previous one must be kept, not discarded");
  assert.equal(r.update_count, 2);
});

test("storylines: restating the same summary does not clobber the last MEANINGFULLY different one", () => {
  store.upsertStoryline({ key: "t-quiet", name: "Quiet", summary: "State A.", timeline: [] });
  store.upsertStoryline({ key: "t-quiet", name: "Quiet", summary: "State B.", timeline: [] });
  store.upsertStoryline({ key: "t-quiet", name: "Quiet", summary: "State B.", timeline: [] }); // unchanged run

  const r = rowOf("t-quiet");
  assert.equal(r.summary, "State B.");
  assert.equal(r.prev_summary, "State A.", "a no-op run must not overwrite prev_summary with a copy of current");
});

test("storylines: a dated event omitted by a later run SURVIVES in the merged timeline", () => {
  // The event that fell out of the 21-day window used to vanish permanently.
  store.upsertStoryline({
    key: "t-merge",
    name: "Merge",
    summary: "s",
    timeline: [{ date: "2026-06-01", event: "Comment period opened", url: "" }],
  });
  store.upsertStoryline({
    key: "t-merge",
    name: "Merge",
    summary: "s2",
    timeline: [{ date: "2026-07-20", event: "Guidance issued", url: "" }],
  });

  const tl = store.listStorylines(20).find((s) => s.key === "t-merge").timeline;
  const events = tl.map((e) => e.event);
  assert.ok(events.includes("Comment period opened"), "the older event must survive the later run");
  assert.ok(events.includes("Guidance issued"));
  assert.equal(tl[0].date, "2026-07-20", "most recent first");
});

test("storylines: the merge dedupes on date + event and keeps the 8 newest", () => {
  const mk = (d, e) => ({ date: d, event: e, url: "" });
  store.upsertStoryline({ key: "t-dedupe", name: "D", summary: "s", timeline: [mk("2026-07-01", "Same event")] });
  // Re-report the identical event with different whitespace/case — must not duplicate.
  store.upsertStoryline({ key: "t-dedupe", name: "D", summary: "s2", timeline: [mk("2026-07-01", "same   Event")] });
  let tl = store.listStorylines(20).find((s) => s.key === "t-dedupe").timeline;
  assert.equal(tl.length, 1, "the same event must not appear twice");

  // Push past the cap.
  for (let i = 2; i <= 12; i++) {
    store.upsertStoryline({ key: "t-dedupe", name: "D", summary: `s${i}`, timeline: [mk(`2026-07-${String(i).padStart(2, "0")}`, `Event ${i}`)] });
  }
  tl = store.listStorylines(20).find((s) => s.key === "t-dedupe").timeline;
  assert.equal(tl.length, 8, "the timeline is capped at 8");
  assert.equal(tl[0].event, "Event 12", "newest retained");
});

test("storylines: first_seen is never overwritten", () => {
  store.upsertStoryline({ key: "t-first", name: "F", summary: "a", timeline: [] });
  const first = rowOf("t-first").first_seen;
  store.upsertStoryline({ key: "t-first", name: "F", summary: "b", timeline: [] });
  assert.equal(rowOf("t-first").first_seen, first, "the thread's origin date must survive every update");
});

test("storylines: the delta fields round-trip, including openQuestions and nextExpected", () => {
  store.upsertStoryline({
    key: "t-fields",
    name: "Fields",
    summary: "s",
    timeline: [],
    state: "advanced",
    openQuestions: ["Whether EPA modelling will be accepted"],
    nextExpected: { what: "Close of comment period", when: "2026-08-12", why: "sets the filing deadline" },
    materiality: "decision_changing",
  });
  const s = store.listStorylines(20).find((x) => x.key === "t-fields");
  assert.equal(s.state, "advanced");
  assert.equal(s.materiality, "decision_changing");
  assert.deepEqual(s.openQuestions, ["Whether EPA modelling will be accepted"]);
  assert.equal(s.nextExpected.what, "Close of comment period");
  assert.equal(s.nextExpected.when, "2026-08-12");
});

test("storylines: a resolved decision_changing thread survives the 30-day prune", () => {
  // A thread that reaches a decision correctly stops being re-reported, which under a bare age rule
  // looks identical to a thread that went quiet — so the most consequential threads were the ones most
  // likely to be deleted right after they mattered.
  store.upsertStoryline({ key: "t-old-dc", name: "Old DC", summary: "s", timeline: [], materiality: "decision_changing", state: "resolved" });
  store.upsertStoryline({ key: "t-old-ctx", name: "Old ctx", summary: "s", timeline: [], materiality: "context" });
  const old = new Date(Date.now() - 45 * 86400e3).toISOString();
  raw.prepare("UPDATE storylines SET updated_at = ? WHERE key IN ('t-old-dc','t-old-ctx')").run(old);

  store.pruneStorylines(30);
  assert.ok(rowOf("t-old-dc"), "a decision_changing thread is exempt from the 30-day window");
  assert.ok(!rowOf("t-old-ctx"), "a context thread still ages off");
});

test("storylines: the hard ceiling eventually removes even a decision_changing thread", () => {
  store.upsertStoryline({ key: "t-ancient", name: "Ancient", summary: "s", timeline: [], materiality: "decision_changing" });
  const ancient = new Date(Date.now() - 200 * 86400e3).toISOString();
  raw.prepare("UPDATE storylines SET updated_at = ? WHERE key = 't-ancient'").run(ancient);
  store.pruneStorylines(30, 120);
  assert.ok(!rowOf("t-ancient"), "the exemption must not accumulate threads forever");
});

// ---------- the input side ----------

/** Capture the request and return a canned schema-shaped response. */
function withModel(storylines) {
  const original = globalThis.fetch;
  const captured = {};
  globalThis.fetch = async (_u, init) => {
    captured.body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "m", type: "message", role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: JSON.stringify({ storylines }) }],
        usage: { input_tokens: 900, output_tokens: 300 }, stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return { captured, restore: () => { globalThis.fetch = original; } };
}

function seedItems(n) {
  for (let i = 0; i < n; i++) {
    store.markSeen(
      {
        uid: `sl-item-${i}`,
        sourceId: "federal_register",
        title: `Federal action ${i} on renewable diesel`,
        summary: "x".repeat(400),
        sourceLabel: "FR",
        jurisdiction: "US-Federal",
        docType: "notice",
        url: `https://example.gov/sl${i}`,
        publishedAt: "2026-07-28T00:00:00Z",
        raw: {},
      },
      { relevant: true, oneLine: "matters", topicIds: [], tier: "must_read" }
    );
  }
}

test("storylines: the PREVIOUS STATE reaches the prompt, not just thread names", async () => {
  seedItems(5);
  store.upsertStoryline({
    key: "t-prior",
    name: "45Z guidance",
    summary: "Treasury guidance was still pending as of last run.",
    timeline: [{ date: "2026-07-10", event: "Comment docket opened", url: "" }],
    openQuestions: ["Whether domestic feedstocks qualify"],
    nextExpected: { what: "Treasury proposed rule", when: "Q3 2026", why: "sets eligibility" },
    materiality: "decision_changing",
    state: "stalled",
  });

  const m = withModel([
    {
      key: "t-prior", name: "45Z guidance", focus: "f", whatChanged: "wc",
      stateChange: "advanced", whatIsNew: "Treasury issued the proposed rule.", whatIsUnchanged: "Timing still unresolved.",
      openQuestions: ["Whether EPA modelling is accepted"],
      nextExpectedEvent: { what: "Comment close", when: "2026-09-14", why: "filing deadline" },
      materiality: "decision_changing",
      timeline: [{ date: "2026-07-30", event: "Proposed rule published", url: "" }],
    },
  ]);
  try {
    await generateStorylines(process.env);
  } finally {
    m.restore();
  }

  const user = m.captured.body.messages[0].content;
  assert.match(user, /Treasury guidance was still pending/, "the previous SUMMARY must be in the prompt");
  assert.match(user, /Whether domestic feedstocks qualify/, "the previous open questions must be in the prompt");
  assert.match(user, /Treasury proposed rule/, "the previously expected next event must be in the prompt");
  assert.match(user, /Comment docket opened/, "the known timeline must be in the prompt so it isn't re-reported");
  // And the system prompt must frame the job as a transition, not a re-summary.
  assert.match(m.captured.body.system, /TRANSITION, NOT A RE-SUMMARY/i);
});

test("storylines: whatIsNew leads the stored summary; an unchanged thread is not dressed up", async () => {
  seedItems(5);
  const m = withModel([
    {
      key: "t-moved", name: "Moved", focus: "f", whatChanged: "background context",
      stateChange: "advanced", whatIsNew: "EPA set a new deadline.", whatIsUnchanged: "",
      openQuestions: [], nextExpectedEvent: { what: "", when: "", why: "" }, materiality: "monitor",
      timeline: [],
    },
    {
      key: "t-still", name: "Still", focus: "f", whatChanged: "background context",
      stateChange: "unchanged", whatIsNew: "", whatIsUnchanged: "Everything still holds.",
      openQuestions: [], nextExpectedEvent: { what: "", when: "", why: "" }, materiality: "context",
      timeline: [],
    },
  ]);
  let result;
  try {
    result = await generateStorylines(process.env);
  } finally {
    m.restore();
  }

  assert.equal(result.count, 2);
  assert.equal(result.moved, 1, "only the thread that actually moved counts as moved");
  // ⚠️ The delta lives in its OWN column. It must NOT be folded into `summary` as markdown — the
  // homepage panel renders summary through esc(), so "**What's new:**" would display as literal
  // asterisks. Storage must not encode one consumer's formatting.
  assert.equal(rowOf("t-moved").what_is_new, "EPA set a new deadline.");
  assert.equal(rowOf("t-moved").summary, "background context", "summary stays clean prose");
  assert.ok(!/\*\*/.test(rowOf("t-moved").summary ?? ""), "no markdown may leak into a field the UI escapes");
  assert.equal(rowOf("t-still").what_is_new, null, "an unchanged thread must not claim a delta");
});

test("storylines: thinking stays disabled — the stated reason still holds", async () => {
  seedItems(5);
  const m = withModel([
    { key: "t-x", name: "X", focus: "f", whatChanged: "w", stateChange: "new", whatIsNew: "n", whatIsUnchanged: "",
      openQuestions: [], nextExpectedEvent: { what: "", when: "", why: "" }, materiality: "context", timeline: [] },
  ]);
  try {
    await generateStorylines(process.env);
  } finally {
    m.restore();
  }
  assert.deepEqual(m.captured.body.thinking, { type: "disabled" });
  assert.ok(m.captured.body.output_config?.format?.schema, "must stay schema-constrained");
});

test("storylines: the twice-daily run calls this on AM only", () => {
  // The cost offset that funds evidence packets: ~$0.076/call x 60 calls/mo was $4.56/mo, the largest
  // single line item in the tool, for a 21-day window that does not change between 06:30 and 16:30.
  const src = fs.readFileSync(new URL("../src/pipeline.js", import.meta.url), "utf8");
  assert.match(src, /if \(edition !== "pm"\) \{\s*try \{\s*await generateStorylines\(env\)/,
    "the scheduled call must be gated to the AM edition");
});
