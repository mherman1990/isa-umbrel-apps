// Iowa snapshot — the gate every multi-state migration step must pass (docs/MULTI_STATE.md §13).
//
// The Iowa deployment's prompts, Member Brief, text blocks and page HTML must stay BYTE-IDENTICAL to the
// golden files in test/fixtures/snapshot-ia/ as Iowa literals move into packs/us-ia. A diff here means a
// step changed what Iowa sees — either a bug, or an intended change that must be reviewed and re-recorded:
//
//   UPDATE_SNAPSHOT=1 node --test test/iowa-snapshot.test.js     (then review `git diff test/fixtures/`)
//
// Clock frozen at Wed 2026-10-07 12:00Z; model stubbed (requests captured, not answered); synthetic store.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-07T12:00:00Z") });
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-snap-ia-"));
for (const k of Object.keys(process.env)) if (/^(SMTP_|MEMBER_|BRIEF_EMAIL|ALERT_|POLIBRIEF_PASSWORD|CME_|MONTHLY_BUDGET)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  POLIBRIEF_DATA_DIR: DIR,
  ANTHROPIC_API_KEY: "test",
  TRIAGE_MODEL: "claude-haiku-4-5",
  BRIEF_MODEL: "claude-sonnet-5",
  ANALYST_MODEL: "claude-opus-4-8",
  REVIEW_MODEL: "claude-opus-5-5",
  WEB_SEARCH: "off",
});
delete process.env.STATE_PACK; // the default pack must be Iowa
fs.copyFileSync(new URL("../watchlist.json", import.meta.url), path.join(DIR, "watchlist.json"));

const { captureState, compareGolden } = await import("./fixtures/snapshot-harness.js");
const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "snapshot-ia");

test("Iowa snapshot: prompts, Member Brief, text blocks and pages are byte-identical to the recorded baseline", { timeout: 120_000 }, async () => {
  const cap = await captureState({ stateKey: "ia" });
  assert.ok(cap.prompts.length >= 10, `expected the scheduled prompts to be captured, got ${cap.prompts.length}`);
  const diffs = compareGolden(cap, GOLDEN, { update: process.env.UPDATE_SNAPSHOT === "1" });
  assert.deepEqual(diffs, [], `Iowa output changed in: ${diffs.join(", ")} — run with UPDATE_SNAPSHOT=1 only if the change is intended`);
});
