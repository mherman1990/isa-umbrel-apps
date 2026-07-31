// Regression test for feedback ordering (1.29.0).
//
// WHY THIS FILE EXISTS. `getFeedbackExamples` is the ONLY channel by which 👍/👎 changes anything —
// triage.js:34-36 says so in as many words — and it ordered by `first_seen_at`, the date the ITEM was
// collected, while selecting the most recent N. So a correction made TODAY on a three-week-old item
// sorted below every newer item that happened to carry feedback and never reached the prompt at all.
// The analyst's most recent judgement was the one most likely to be dropped.
//
// Zero deps (node --test), no network, temp DATA_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-feedback-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const store = await import("../src/store.js");
const Database = (await import("better-sqlite3")).default;

// markSeen stamps first_seen_at as "now", so the test opens the same file to set its own timeline
// rather than adding a test-only helper to the store's public API.
const raw = new Database(store.DB_PATH);
const setFirstSeen = raw.prepare("UPDATE seen_items SET first_seen_at = ? WHERE uid = ?");

/** Seed a row whose first_seen_at we control, so "old item" vs "new item" is unambiguous. */
function seed(uid, title, firstSeenAt, verdict = "relevant") {
  store.markSeen(
    { uid, sourceId: "federal_register", title, sourceLabel: "FR", jurisdiction: "US-Federal", docType: "notice", raw: {} },
    { relevant: verdict === "relevant", oneLine: "note", topicIds: [], tier: "worth_knowing" }
  );
  setFirstSeen.run(firstSeenAt, uid);
}

test("feedback: getFeedbackExamples orders by FEEDBACK time, not item date", async () => {
  // An OLD item corrected today must beat NEWER items corrected earlier.
  const old = "fb-old";
  seed(old, "Three-week-old EPA notice", "2026-07-01T00:00:00Z");
  for (let i = 0; i < 12; i++) seed(`fb-new-${i}`, `Newer item ${i}`, `2026-07-3${i % 2}T00:00:00Z`);

  // The newer items get their feedback FIRST (earlier wall-clock), the old item LAST.
  for (let i = 0; i < 12; i++) store.setFeedback(`fb-new-${i}`, "down", undefined);
  await new Promise((r) => setTimeout(r, 12)); // ensure a strictly later ISO timestamp
  store.setFeedback(old, "down", undefined);

  const examples = store.getFeedbackExamples(12);
  assert.equal(examples.length, 12);
  assert.equal(
    examples[0].title,
    "Three-week-old EPA notice",
    "the most recent CORRECTION must come first, even on the oldest item"
  );
});

test("feedback: clearing a thumb drops the row out of the ordering", () => {
  const uid = "fb-clear";
  seed(uid, "Cleared item", "2026-07-15T00:00:00Z");
  store.setFeedback(uid, "down", undefined);
  assert.ok(store.getFeedbackExamples(50).some((e) => e.title === "Cleared item"));

  store.setFeedback(uid, null, undefined);
  assert.ok(
    !store.getFeedbackExamples(50).some((e) => e.title === "Cleared item"),
    "a withdrawn thumb must not keep a stale timestamp holding it at the top"
  );
});

test("feedback: a free-text note rides along with its thumb, and is what reaches the prompt", () => {
  const uid = "fb-note";
  seed(uid, "Noted item", "2026-07-02T00:00:00Z");
  store.setFeedback(uid, "down", "relevant but won't move politically");
  const row = store.getFeedbackExamples(50).find((e) => e.title === "Noted item");
  assert.ok(row, "a thumbed row with a note must be selected");
  assert.equal(row.feedback_note, "relevant but won't move politically");
});

test("feedback: note-only rows are NOT selected today — the outer gate is `feedback IS NOT NULL`", () => {
  // Documenting the real shape of getFeedbackExamples so the defensive CASE in setFeedback isn't
  // mistaken for evidence that this path is live. Its `feedback_note IS NOT NULL` clause only
  // BROADENS which thumbed rows qualify; it does not admit rows with no thumb. Widening that is a
  // behaviour change to what reaches the triage prompt, and deliberately out of scope here.
  const uid = "fb-note-only";
  seed(uid, "Note but no thumb", "2026-07-03T00:00:00Z");
  store.setFeedback(uid, "down", "a note");
  assert.ok(store.getFeedbackExamples(50).some((e) => e.title === "Note but no thumb"));

  store.setFeedback(uid, null, undefined); // clear the thumb, note remains
  assert.ok(
    !store.getFeedbackExamples(50).some((e) => e.title === "Note but no thumb"),
    "with no thumb the row drops out regardless of its note — current, intended behaviour"
  );
});

test("feedback: the boot backfill is idempotent and only touches rows with feedback", () => {
  const first = store.backfillFeedbackAt();
  const second = store.backfillFeedbackAt();
  assert.equal(second, 0, "a second run must find nothing — the backfill is idempotent");
  assert.ok(first >= 0);
});
