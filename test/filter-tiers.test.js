// Regression tests for the 1.26.0 filtering work: exclusion terms, graded triage tiers, the
// no-deadline age-out, and the newsletter chrome pass.
//
// The property that matters most here is a NEGATIVE one: shipping tiers must not hide anything that
// was triaged before tiers existed. Those rows have triage_tier IS NULL, and if the default filter
// had been written as `tier IN ('must_read','worth_knowing')` the whole existing feed would have
// vanished on update — silently, and only on Matt's Pi where the history lives. Hence the NULL cases.
//
// Zero deps (node --test), no network, no Anthropic calls. The store tests run against a temp DB via
// POLIBRIEF_DATA_DIR so they never touch the real one.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scoreItems } from "../src/score.js";
import { textToHtml, emailBodyToPreview, sanitizeEmailHtml } from "../src/emailhtml.js";

const AREAS = [
  { id: "biofuel", label: "Biofuels", weight: 10, keywords: ["renewable diesel", "45Z"] },
  { id: "crop", label: "Crop protection", weight: 8, keywords: ["pesticide"], excludeTerms: ["school lunch"] },
];
const OUTPUT = { minLocalScoreForTriage: 5, maxItemsToTriage: 80, entitySourceBoost: 6 };
const item = (uid, title, summary = "") => ({ uid, title, summary, raw: {} });

test("exclusion terms: a global exclude drops an item however well it scores", () => {
  const items = [
    item("a", "EPA sets renewable diesel volumes for Iowa soybean oil"),
    item("b", "Renewable diesel plant hosts a 5K fun run in Iowa"),
  ];
  const plain = scoreItems(items, AREAS, OUTPUT);
  assert.equal(plain.kept.length, 2, "both clear the filter with no exclusions");
  assert.equal(plain.excluded, 0);

  const withExclude = scoreItems(items, AREAS, { ...OUTPUT, excludeTerms: ["fun run"] });
  assert.equal(withExclude.kept.length, 1, "the 5K is gone");
  assert.equal(withExclude.kept[0].uid, "a", "the real item survives");
  assert.equal(withExclude.excluded, 1, "and the drop is counted, not silent");
});

test("exclusion terms: a per-area exclude only cancels THAT area's weight", () => {
  // Hits "pesticide" (crop, weight 8) but in a school-lunch context, and also "45Z" (biofuel, 10).
  const it = item("c", "Pesticide residue rules for the school lunch program", "Also amends 45Z guidance.");
  const scored = scoreItems([it], AREAS, OUTPUT);
  const topics = scored.kept[0].matchedTopics.map((t) => t.id);
  assert.deepEqual(topics, ["biofuel"], "crop protection opts out; biofuels still counts");
  assert.equal(scored.kept[0].localScore, 10, "score reflects biofuels only (no Iowa/soy boost here)");

  // Same text without the biofuel hook falls below the threshold entirely.
  const onlyCrop = scoreItems([item("d", "Pesticide residue rules for the school lunch program")], AREAS, OUTPUT);
  assert.equal(onlyCrop.kept.length, 0, "nothing left to qualify on");
});

test("exclusion terms are word-boundary matched, like include terms", () => {
  const res = scoreItems([item("e", "RIN prices and 45Z credits")], AREAS, { ...OUTPUT, excludeTerms: ["rine"] });
  assert.equal(res.kept.length, 1, '"rine" must not match inside "RIN prices"');
  assert.equal(res.excluded, 0);
});

// ---- store-level filters (temp DB) -------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tier-"));
process.env.POLIBRIEF_DATA_DIR = tmp;
const store = await import("../src/store.js");

function seed(uid, { tier = null, deadline = null, docType = "rule", firstSeen = new Date().toISOString() } = {}) {
  store.markSeen(
    {
      uid,
      sourceId: "federal_register",
      title: `Item ${uid}`,
      url: `https://example.test/${uid}`,
      jurisdiction: "US-Federal",
      docType,
      publishedAt: firstSeen,
      summary: "body text",
      raw: { commentsCloseOn: deadline },
    },
    { relevant: true, tier, topicIds: [], oneLine: "why it matters", type: docType }
  );
}

// first_seen_at is set by markSeen, so backdating for the age-out test is done straight against the
// temp DB rather than by adding a test-only hook to the store.
const { default: Database } = await import("better-sqlite3");
function backdate(uid, iso) {
  const db = new Database(path.join(tmp, "polibrief.db"));
  db.prepare("UPDATE seen_items SET first_seen_at = ? WHERE uid = ?").run(iso, uid);
  db.close();
}

test("triage tiers: the default view keeps NULL-tier history and hides only background", () => {
  seed("must", { tier: "must_read" });
  seed("worth", { tier: "worth_knowing" });
  seed("bg", { tier: "background" });
  seed("legacy", { tier: null }); // triaged before tiers existed

  const ids = (tier) => store.listItems({ verdict: "relevant", days: 30, tier, limit: 100 }).map((r) => r.uid).sort();

  assert.deepEqual(ids(""), ["bg", "legacy", "must", "worth"], "everything");
  assert.deepEqual(ids("top"), ["legacy", "must", "worth"], "default hides background, KEEPS legacy NULL rows");
  assert.deepEqual(ids("must_read"), ["must"]);
  assert.deepEqual(ids("background"), ["bg"]);
});

test("triage tiers: a re-triage without a tier never wipes an existing one", () => {
  // markSeen upserts on every run; COALESCE keeps the stored tier when the new verdict has none.
  store.markSeen(
    { uid: "must", sourceId: "federal_register", title: "Item must", url: "x", jurisdiction: "US", docType: "rule", publishedAt: null, summary: "b", raw: {} },
    { relevant: true, tier: null, topicIds: [], oneLine: "again", type: "rule" }
  );
  const row = store.listItems({ verdict: "relevant", days: 30, tier: "must_read", limit: 10 }).find((r) => r.uid === "must");
  assert.ok(row, "the must_read tier survived a tier-less re-triage");
});

test("lifecycle: a rule with no deadline retires only after the stale window", () => {
  const active = () => store.listItems({ verdict: "relevant", days: 400, tier: "", lifecycle: "active", limit: 100 }).map((r) => r.uid);
  const closed = () => store.listItems({ verdict: "relevant", days: 400, tier: "", lifecycle: "closed", limit: 100 }).map((r) => r.uid);

  assert.ok(active().includes("legacy"), "a fresh no-deadline rule stays active");
  assert.ok(!closed().includes("legacy"));

  // Backdate it past the 120-day window.
  backdate("legacy", new Date(Date.now() - 200 * 86400e3).toISOString());
  assert.ok(!active().includes("legacy"), "now it's out of the active feed");
  assert.ok(closed().includes("legacy"), "and findable in the Closed view — not deleted");
});

test("coverage diagnostic reports WHERE an item was lost, across every verdict", () => {
  store.markSeen(
    { uid: "dropped-1", sourceId: "federal_register", title: "Drainage tile permit standards", url: "u", jurisdiction: "US", docType: "notice", publishedAt: null, summary: "corps of engineers", raw: {} },
    null // never triaged — the locally-dropped case
  );
  const d = store.diagnoseCoverage("drainage tile");
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].triage_verdict, "unscored", "a locally-dropped item is still searchable");
  assert.equal(d.counts.unscored, 1);

  const body = store.diagnoseCoverage("corps of engineers");
  assert.equal(body.rows.length, 1, "the body is searched too, not just the title");

  assert.equal(store.diagnoseCoverage("no such phrase anywhere").rows.length, 0, "and a true miss reads as a miss");
});

// ---- newsletter chrome pass --------------------------------------------------------------------

test("newsletter chrome: ESP plumbing goes, the story stays", () => {
  const mac = [
    "Award[https://track.test/q/abc~~/XYZ] Images not showing up? Click [https://track.test/f/a/def] to view this in your browser. Morning Ag Clips [https://cdn.test/logo.png] Facebook [https://cdn.test/icon-fb.png]https://track.test/f/a/fb Twitter [https://cdn.test/icon-tw.png]https://track.test/f/a/tw Subscribe [https://track.test/f/a/sub]",
    "",
    "The McGuire family of Cedar County will receive the Wergin Good Farm Neighbor Award, Iowa Secretary of Agriculture Mike Naig announced Wednesday.",
    "",
    "Unsubscribe [https://track.test/unsub] | Manage your preferences [https://track.test/prefs]",
    "Copyright © 2026 Morning Ag Clips, LLC. All rights reserved.",
  ].join("\n");

  const html = textToHtml(mac);
  assert.ok(html.includes("McGuire family of Cedar County"), "the story survives");
  assert.ok(!/track\.test\/f\/a\/fb/.test(html.replace(/href="[^"]*"/g, "")), "no tracking URL is rendered as text");
  assert.ok(!/Images not showing up/i.test(html), "view-in-browser boilerplate is gone");
  assert.ok(!/Unsubscribe|All rights reserved/i.test(html), "footer boilerplate is gone");
  assert.ok(!/logo\.png|icon-fb\.png/.test(html), "image URLs are gone");

  const preview = emailBodyToPreview(html, 180);
  assert.ok(preview.startsWith("The McGuire family"), `preview starts at the lede, got: ${preview}`);
  assert.ok(!/https?:\/\//.test(preview), "and carries no URL at all");
});

test("newsletter chrome: prose with real links is NOT stripped", () => {
  const prose =
    "EPA sent the 2026 RVO proposal [https://www.epa.gov/rvo] to OMB on Tuesday, and ASA filed comments [https://soygrowers.com/c] opposing the carve-out.";
  const html = textToHtml(prose);
  assert.ok(html.includes("EPA sent the 2026 RVO proposal"), "prose kept");
  assert.ok(html.includes("ASA filed comments"), "all of it kept");
  assert.equal((html.match(/<a /g) || []).length, 2, "both links are still reachable");
});

test("sanitizeEmailHtml is idempotent and drops chrome even when it is a link", () => {
  const src = `<p><a href="https://x.test/s">Senate Ag advances markup</a> — cleared 18-5.</p>
    <p><a href="https://t.test/view">View this email in your browser</a></p>
    <p><a href="https://t.test/a">https://t.test/a</a> <a href="https://t.test/b">https://t.test/b</a> <a href="https://t.test/c">https://t.test/c</a></p>`;
  const once = sanitizeEmailHtml(src);
  assert.ok(once.includes("Senate Ag advances markup"), "story kept");
  assert.ok(!/View this email/i.test(once), "chrome dropped even though it was an anchor");
  assert.ok(!/t\.test\/b/.test(once), "the naked-link row (a social strip) is dropped by density");
  assert.equal(sanitizeEmailHtml(once), once, "running it twice changes nothing");
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
});
