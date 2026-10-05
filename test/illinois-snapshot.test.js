// Illinois snapshot — the pilot pack's own baseline (docs/MULTI_STATE.md §13 step 8).
//
// Same harness as the Iowa snapshot, run under STATE_PACK=us-il with Illinois series keys. The golden
// files in test/fixtures/snapshot-il/ are what ILSoy reviews: every prompt, the Member Brief preview,
// the text blocks, the adapter requests and the pages, as an Illinois deployment would produce them.
// The second test is the leak check: no Iowa organisation or Iowa-only wording may appear.
//
//   UPDATE_SNAPSHOT=1 node --test test/illinois-snapshot.test.js     (then review `git diff test/fixtures/`)

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-07T12:00:00Z") });
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-snap-il-"));
for (const k of Object.keys(process.env)) if (/^(SMTP_|MEMBER_|BRIEF_EMAIL|ALERT_|POLIBRIEF_PASSWORD|CME_|MONTHLY_BUDGET)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  POLIBRIEF_DATA_DIR: DIR,
  ANTHROPIC_API_KEY: "test",
  TRIAGE_MODEL: "claude-haiku-4-5",
  BRIEF_MODEL: "claude-sonnet-5",
  ANALYST_MODEL: "claude-opus-4-8",
  REVIEW_MODEL: "claude-opus-5-5",
  WEB_SEARCH: "off",
  STATE_PACK: "us-il",
});
fs.copyFileSync(new URL("../watchlist.json", import.meta.url), path.join(DIR, "watchlist.json"));

const { captureState, compareGolden } = await import("./fixtures/snapshot-harness.js");
const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "snapshot-il");
const cap = await captureState({ stateKey: "il" });

test("Illinois snapshot: prompts, Member Brief, text blocks, adapter requests and pages match the reviewed baseline", { timeout: 120_000 }, () => {
  assert.ok(cap.prompts.length >= 10, `expected the scheduled prompts to be captured, got ${cap.prompts.length}`);
  const diffs = compareGolden(cap, GOLDEN, { update: process.env.UPDATE_SNAPSHOT === "1" });
  assert.deepEqual(diffs, [], `Illinois output changed in: ${diffs.join(", ")} — run with UPDATE_SNAPSHOT=1 only if the change is intended`);
});

test("Illinois output carries no Iowa organisation or Iowa-only wording", () => {
  const texts = [];
  for (const f of fs.readdirSync(GOLDEN)) texts.push([f, fs.readFileSync(path.join(GOLDEN, f), "utf8")]);
  const LEAK = /Iowa Soybean Association|\bISA\b|iasoybeans|an Iowa |Iowa (House|Senate|cash|basis|Administrative|Political Map|drought)|IECDB|iowa_admin_rules|legis\.iowa\.gov/;
  const hits = [];
  for (const [f, t] of texts) {
    // The shared watchlist (topics, feeds) is still Iowa's own until packs carry focus areas — that text is
    // data, not product wording, and is excluded by name.
    for (const line of t.split("\n")) if (LEAK.test(line) && !ALLOWED.some((re) => re.test(line))) hits.push(`${f}: ${line.slice(0, 160)}`);
  }
  assert.deepEqual(hits, []);
});

const ALLOWED = [
  // A CSS comment naming where the palette came from — the colours stay until ILSoy supplies its own
  // (packs/us-il "verify": identity.branding). Not visible on the page.
  /\/\* ---- ISA brand palette/,
];
