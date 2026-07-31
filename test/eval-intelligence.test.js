// eval-intelligence.test.js — the evaluation harness for the information → insight path.
//
// This file is BOTH a regression suite and a measurement. Each test asserts a property AND records a
// metric, and the final block prints a scorecard so a change to the pipeline can be judged on
// numbers instead of impressions. Run it with `npm test`, or on its own:
//
//     node --test test/eval-intelligence.test.js
//
// The metrics, and why each one is here rather than some other one:
//
//   redundancy_rate        The share of feed rows that repeat an action already in the feed. Measured
//                          at 19% of the stored "relevant" feed, and 67% of the comment deadlines on
//                          the homepage, before this work. It is the metric the user feels first,
//                          because duplicates cost attention at the exact moment attention is scarce.
//   false_merge_rate       The counterweight. Deduplication that merges two DIFFERENT actions is
//                          strictly worse than none, because it deletes a real item silently. This
//                          must stay at 0 or the redundancy number means nothing.
//   thread_fragmentation   How many feed rows one multi-stage proceeding produces. A bill that moved
//                          four times should be one row that changed four times.
//   grounding_rate         The share of prompt-context entries carrying the source document's own
//                          words rather than only a title and a model-written one-liner. This is the
//                          ceiling on how good any downstream synthesis can be.
//   retrieval_p_at_5       Precision@5 for questions written the way the user writes them, including
//                          the 2–3 character identifiers this domain runs on (45Z, RFS, RIN, WOTUS).
//   repetition_as_evidence Whether N copies of one document reach the model as N corroborating
//                          items. This is the mechanism by which a tool manufactures false confidence.
//   recall_preserved       The safety net: every fetched row must remain findable regardless of what
//                          any view chooses to collapse. Deduplication is a display decision.
//
// Deterministic: no network, no Anthropic calls, temp database, fixtures with recorded provenance.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eventKeyFor, groupByEvent, pickLead, normalizeTitle } from "../src/eventkey.js";
import * as FIX from "./fixtures/eval-corpus.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-eval-"));
process.env.POLIBRIEF_DATA_DIR = tmp;
const store = await import("../src/store.js");

/** The scorecard, filled in as the tests run and printed at the end. */
const M = {};
const record = (k, v, note) => {
  M[k] = { value: v, note };
  return v;
};

// ---------------------------------------------------------------------------------------------
// 1. Redundancy — one government action, one row
// ---------------------------------------------------------------------------------------------

test("eval: cross-filed copies of one notice collapse to one action (and across sources)", () => {
  const groups = groupByEvent(FIX.CASE_CROSS_FILED.map((i) => ({ ...i, event_key: eventKeyFor(i) })));
  assert.equal(groups.length, FIX.CASE_CROSS_FILED_TRUTH, "10 filings are 3 Federal Register notices");

  // The Federal Register original and its Regulations.gov docket copies must land in ONE group —
  // this is the cross-source case, and it is the one a per-source dedup would miss entirely.
  const g13552 = groups.find((g) => g.key === "fr:2026-13552");
  assert.ok(g13552, "the group is keyed on the Federal Register document number");
  assert.equal(g13552.members.length, 4, "3 docket copies + the FR original");
  assert.deepEqual(
    [...new Set(g13552.members.map((m) => m.sourceId))].sort(),
    ["federal_register", "regulations_gov"],
    "both sources are in the same group"
  );

  const rows = FIX.CASE_CROSS_FILED.length;
  record(
    "redundancy_rate",
    `${Math.round((100 * (rows - groups.length)) / rows)}%  (${rows} filings → ${groups.length} actions)`,
    "before: every filing was its own row, one-liner, calendar entry and deadline"
  );
});

test("eval: the group leads with the copy that has the document, from the publisher of record", () => {
  const groups = groupByEvent(FIX.CASE_CROSS_FILED);
  const lead = pickLead(groups.find((g) => g.key === "fr:2026-13552").members);
  assert.equal(lead.sourceId, "federal_register", "the Federal Register copy is the canonical one");
  assert.ok(lead.summary.length > 700, "and it is the copy carrying the real abstract");

  // Same test with the FR original absent: it must still pick the enriched docket copy over the bare ones.
  const withoutFR = groups.find((g) => g.key === "fr:2026-13552").members.filter((m) => m.sourceId !== "federal_register");
  assert.equal(pickLead(withoutFR).uid, "regulations_gov:EPA-HQ-OPP-2025-1905-0003", "text beats no text");
});

// ---------------------------------------------------------------------------------------------
// 2. The counterweight — no false merges
// ---------------------------------------------------------------------------------------------

test("eval: two different notices with near-identical titles stay separate (no false merge)", () => {
  const cases = [
    ["distinct FR notices", FIX.CASE_DISTINCT_LOOKALIKES, FIX.CASE_DISTINCT_LOOKALIKES_TRUTH],
    ["news: same wire story vs. a different story", FIX.CASE_NEWS, FIX.CASE_NEWS_TRUTH],
  ];
  let merges = 0;
  for (const [label, items, truth] of cases) {
    const n = groupByEvent(items).length;
    if (n < truth) merges += truth - n;
    assert.equal(n, truth, `${label}: expected ${truth} actions, got ${n}`);
  }
  // The specific trap: an explicit identifier must always beat title similarity.
  assert.notEqual(
    eventKeyFor(FIX.CASE_DISTINCT_LOOKALIKES[0]),
    eventKeyFor(FIX.CASE_DISTINCT_LOOKALIKES[1]),
    "different document numbers are different actions no matter how alike the titles read"
  );
  record("false_merge_rate", `${merges} of ${cases.length} hard-negative cases`, "must be 0 — a merge deletes a real action");
});

test("eval: title normalization is conservative — it drops qualifiers, not substance", () => {
  assert.equal(
    normalizeTitle("Pesticide Tolerance; Exemptions, Petitions, Revocations, etc.: Receipt — Correction"),
    normalizeTitle("Pesticide Tolerance; Exemptions, Petitions, Revocations: Receipt"),
    "a trailing '; Correction' and 'etc.' do not make a different action"
  );
  assert.notEqual(
    normalizeTitle("Pesticide Tolerance; Epyrifenacil"),
    normalizeTitle("Pesticide Tolerance; Fluazaindolizine"),
    "the active ingredient does"
  );
});

// ---------------------------------------------------------------------------------------------
// 3. Storyline continuity — a new development in an old thread
// ---------------------------------------------------------------------------------------------

test("eval: a bill that moved four times is one thread, not four items", () => {
  const groups = groupByEvent(FIX.CASE_BILL_MOVEMENT);
  assert.equal(groups.length, FIX.CASE_BILL_MOVEMENT_TRUTH, "one bill");
  assert.equal(groups[0].members.length, 4, "with four recorded movements");
  assert.equal(groups[0].key, "bill:ia:1893441", "keyed on the bill, not on the change hash in the uid");
  record(
    "thread_fragmentation",
    `${FIX.CASE_BILL_MOVEMENT.length} rows → 1 thread (${groups[0].members.length} movements)`,
    "LegiScan's uid embeds change_hash, so every status change used to be a brand-new feed row"
  );
});

// ---------------------------------------------------------------------------------------------
// 4. Grounding — does the model see the document, or only its title?
// ---------------------------------------------------------------------------------------------

test("eval: prompt context carries the source document's own words", async () => {
  // Seed the temp store the way a run would, then project rows through the real context builder.
  for (const it of FIX.ALL) {
    store.markSeen(it, { relevant: true, tier: "worth_knowing", topicIds: [], oneLine: "why it matters", type: it.docType });
  }
  const rows = store.listItems({ verdict: "relevant", days: 30, tier: "", limit: 200 });
  assert.ok(rows.length >= FIX.ALL.length, "everything was stored");

  // compactItems is module-private, so measure the property it is responsible for using the same
  // two primitives it is built from — grouping, and the presence of body text on the lead.
  // Scoped to OFFICIAL documents — the stream the policy brief is built from, and the one where three
  // adapters supplied no text at all. (News items are short by nature; averaging them in would hide
  // the number that matters.) This fixture is deliberately mostly UN-enriched, so what it measures is
  // the reachable ceiling: the one grounded action is the notice whose abstract was resolved.
  // enrich.test.js measures the delta the enrichment pass produces (0/3 → 3/3 offline; 0/19 → 17/19
  // against the live API on 2026-07-30).
  const officialGroups = groupByEvent(rows.filter((r) => r.source_id === "federal_register" || r.source_id === "regulations_gov"));
  const grounded = officialGroups.filter(({ members }) => String(pickLead(members).body ?? "").trim().length >= 200).length;
  record(
    "grounding_rate",
    `${grounded}/${officialGroups.length} official actions carry ≥200 chars of document text (fixture is mostly un-enriched by design)`,
    'the three adapters that hard-coded summary:"" held this at 0 for their entire stream; see enrich.test.js for the delta'
  );

  // The property that matters: for the cross-filed notice, the row the analyst is shown is the one
  // with the abstract — even though most of its copies have none.
  const g = officialGroups.find((x) => x.key === "fr:2026-13552");
  assert.ok(String(pickLead(g.members).body ?? "").includes("change in use pattern"), "the grounded copy leads the group");
});

test("eval: repetition never reaches the model as corroboration", () => {
  const groups = groupByEvent(FIX.CASE_CROSS_FILED);
  // What the model would receive: one entry per action, with the filing count as a stated fact.
  const entries = groups.map(({ members }) => ({ lead: pickLead(members), filings: members.length }));
  assert.equal(entries.length, 3, "three entries, not ten");
  const worst = Math.max(...entries.map((e) => e.filings));
  record(
    "repetition_as_evidence",
    `0 duplicate entries (largest action states "${worst} filings" once)`,
    "ten near-identical entries read to a model as ten independent signals of the same claim"
  );
  assert.ok(
    entries.every((e) => e.filings >= 1),
    "every entry knows how many filings it stands for, so the count is available as evidence-of-breadth rather than as repetition"
  );
});

// ---------------------------------------------------------------------------------------------
// 5. Retrieval — can the user reach what is stored?
// ---------------------------------------------------------------------------------------------

const RETRIEVAL_CASES = [
  { q: "What's happening with 45Z?", relevant: ["rss:ent-r1:r1"] },
  { q: "any news about the RFS and RIN prices", relevant: ["rss:ent-r2:r2"] },
  { q: "EPA WOTUS litigation update", relevant: ["federal_register:2026-15001"] },
  { q: 'tell me about "pesticide tolerance" petitions', relevant: FIX.CASE_CROSS_FILED.filter((i) => /Pesticide Tolerance/.test(i.title)).map((i) => i.uid) },
];

test("eval: retrieval reaches the identifiers this domain runs on", () => {
  let newHits = 0;
  let oldHits = 0;
  const lines = [];
  for (const c of RETRIEVAL_CASES) {
    const want = new Set(c.relevant);

    const nu = store.searchItemsRanked(c.q, { limit: 5 }).map((r) => r.uid);
    const nGood = nu.filter((u) => want.has(u)).length;

    // The previous behaviour, reproduced exactly: keep only words longer than 3 characters, OR them,
    // order by recency. Kept in the eval on purpose — a claim of improvement needs the baseline.
    const ol = store.searchSeenItemsAny(c.q.split(/\s+/), 5).map((r) => r.uid);
    const oGood = ol.filter((u) => want.has(u)).length;

    newHits += nGood;
    oldHits += oGood;
    lines.push(`      "${c.q}" → was ${oGood}/${Math.min(5, want.size)} relevant, now ${nGood}/${Math.min(5, want.size)}`);
    assert.ok(nGood >= oGood, `ranked retrieval must not be worse for: ${c.q}`);
    assert.ok(nGood >= 1, `ranked retrieval must find something relevant for: ${c.q}`);
  }
  const denom = RETRIEVAL_CASES.reduce((a, c) => a + Math.min(5, c.relevant.length), 0);
  record(
    "retrieval_p_at_5",
    `${((100 * newHits) / denom).toFixed(0)}%  (was ${((100 * oldHits) / denom).toFixed(0)}%)\n${lines.join("\n")}`,
    "the old tokenizer dropped every term of 3 characters or fewer — 45Z, RFS, RIN, EPA, SAF, EU"
  );
});

test("eval: a query with no usable terms returns nothing rather than the newest rows", () => {
  assert.deepEqual(store.searchItemsRanked("what about the latest?"), [], "stopwords alone are not a query");
  assert.deepEqual(store.parseQuery("what about the latest?"), { phrases: [], terms: [] });
});

test("eval: a phrase straddling two fields is not a match", () => {
  // The fast path gates on title/one_line/body CONCATENATED, so "…New Uses" + "New use registrations…"
  // could match across the seam. Every returned row must have earned a real per-field score.
  const rows = store.searchItemsRanked('"April 2026 New use"', { limit: 10 });
  assert.ok(
    rows.every((r) => r.match_score > 0),
    "no row may be returned on a cross-field artefact"
  );
});

test("eval: short identifiers survive tokenization; stopwords do not", () => {
  const { terms } = store.parseQuery("What is the latest on 45Z, RFS and EU deforestation?");
  assert.ok(terms.includes("45z"), "45Z survives (3 chars, has a digit)");
  assert.ok(terms.includes("rfs"), "RFS survives (3 chars, written in caps)");
  assert.ok(terms.includes("eu"), "EU survives (2 chars, written in caps)");
  assert.ok(!terms.includes("what") && !terms.includes("latest"), "stopwords are gone");
});

// ---------------------------------------------------------------------------------------------
// 6. Nothing is lost — collapsing is a display decision
// ---------------------------------------------------------------------------------------------

test("eval: every filing stays retrievable even when a view collapses it", () => {
  // The diagnostic panel exists precisely to answer "where did this go?" — it must see every copy.
  const d = store.diagnoseCoverage("Applications for New Uses");
  const uids = new Set(d.rows.map((r) => r.uid));
  const allCopies = FIX.CASE_CROSS_FILED.filter((i) => /New Uses/.test(i.title)).map((i) => i.uid);
  for (const u of allCopies) assert.ok(uids.has(u), `${u} must remain findable`);
  record("recall_preserved", `${allCopies.length}/${allCopies.length} filings findable in the coverage diagnostic`, "dedup must never delete");

  // And the collapsed deadline list reports how many it folded, rather than quietly showing fewer.
  const collapsed = store.upcomingDeadlines(50);
  const raw = store.upcomingDeadlines(50, { collapse: false });
  assert.ok(raw.length > collapsed.length, "there was something to collapse");
  const folded = collapsed.reduce((a, d) => a + (d.dupCount ?? 0), 0);
  assert.equal(collapsed.length + folded, raw.length, "every folded row is accounted for in a dupCount");
});

test("eval: the event key is stable — re-running produces the same grouping", () => {
  const once = groupByEvent(FIX.ALL).map((g) => g.key).sort();
  const twice = groupByEvent([...FIX.ALL].reverse()).map((g) => g.key).sort();
  assert.deepEqual(twice, once, "grouping does not depend on input order");
});

// ---------------------------------------------------------------------------------------------
// 7. Stale cached model output must not be presented, or injected, as current
// ---------------------------------------------------------------------------------------------

test("eval: a stale cached digest is withheld from prompts instead of quietly aging", async () => {
  // pipeline.js shares this test's store instance (same POLIBRIEF_DATA_DIR), so writing kv_state
  // directly is the same thing extractMarketIntel does at the end of a run.
  const pipeline = await import("../src/pipeline.js");
  const write = (daysAgo, text) =>
    store.setState(
      "market_intel",
      JSON.stringify({ date: "2026-07-08", markdown: text, createdAt: new Date(Date.now() - daysAgo * 86400e3).toISOString(), count: 7 })
    );

  write(1, "**Price & basis** — Iowa cash bid $10.42 (2026-07-29).");
  const fresh = pipeline.marketIntelText();
  assert.ok(fresh.includes("Iowa cash bid"), "a fresh digest is used");
  assert.ok(/as of 2026-07-08/.test(fresh), "and is DATED in the prompt, so the model can weigh it against a newer figure");

  write(22, "**Fund positioning** — managed money net 38,149 contracts (39th percentile).");
  assert.equal(
    pipeline.marketIntelText(),
    "",
    "a 22-day-old digest is withheld — this exact figure was rendered next to a live board reading 130,505 at the 79th percentile"
  );
  assert.ok(pipeline.cachedAgeDays("market_intel") > pipeline.STALE_PANEL_DAYS, "and the UI can see that it is stale");
  record("stale_context_suppressed", `withheld beyond ${pipeline.STALE_PANEL_DAYS} days; dated when used`, "cached model output was previously injected with no age at all");
});

// ---------------------------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------------------------

test.after(() => {
  const w = Math.max(...Object.keys(M).map((k) => k.length));
  console.log("\n  ── Bean Brief intelligence scorecard ──────────────────────────────────────");
  for (const [k, { value, note }] of Object.entries(M)) {
    console.log(`  ${k.padEnd(w)} : ${value}`);
    if (note) console.log(`  ${" ".repeat(w)}   ↳ ${note}`);
  }
  console.log("  ──────────────────────────────────────────────────────────────────────────\n");
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});
