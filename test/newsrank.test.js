// Tests for news ranking (src/newsrank.js) — 1.28.0 — plus the three guards that giving news rows a
// verdict made necessary elsewhere.
//
// THE GAP: news is 54% of the corpus (68 of 126 rows) and had NO relevance signal — every row stored
// `triage_verdict='unscored'`, `triage_tier IS NULL`, News tab pure reverse-chronological. A SCOTUS
// FIFRA-preemption ruling sat at the same weight as "Dad's 1952 Wheatland tractor returns home".
//
// THE USER'S CONSTRAINT: "I think the mail need to be time ranked." So the inbox stays chronological and
// ranking is additive. Several tests below exist purely to keep that true.
//
// Ground-truth labels come from test/fixtures/news-eval-corpus.js — real rows from the stored feed, with
// only the unambiguous ends labelled (the arguable middle is recorded and deliberately unscored).
//
// Zero deps (node --test). globalThis.fetch is stubbed so the Anthropic SDK never leaves the process.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-newsrank-"));
process.env.POLIBRIEF_DATA_DIR = DIR;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.TRIAGE_MODEL = "claude-haiku-4-5";

const { rankNewsItems, pushCandidates, NEWS_TIERS } = await import("../src/newsrank.js");
const { pickLead, groupByEvent, eventKeyFor } = await import("../src/eventkey.js");
const { SOURCE_CLASS } = await import("../src/adapters/index.js");
const { MUST_REACH, NOISE, CROSS_OUTLET_DUPES, CORPUS_SIZE } = await import("./fixtures/news-eval-corpus.js");

const quiet = () => {};
const TOPICS = [
  { id: "biofuel", label: "Biofuels & renewable diesel" },
  { id: "trade", label: "Trade & market access" },
  { id: "crop", label: "Crop protection" },
];

const newsItem = (uid, title, summary = "") => ({
  uid,
  sourceId: "rss",
  sourceLabel: "Entity RSS/Atom feeds",
  title,
  summary,
  url: `https://example.test/${uid}`,
  publishedAt: "2026-07-28T12:00:00.000Z",
  matchedTopics: [],
  raw: { entityId: "ent-x" },
});

function reply(text) {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 200, output_tokens: 80 },
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
  );
}

/** Stub the model with a function of the request body, so a test can grade per-item. */
function withModel(handler, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    return reply(handler(body));
  };
  return fn(seen).finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------------------------------------
// The mechanism
// ---------------------------------------------------------------------------------------------

test("every news item is graded and the verdict map is keyed by uid", async () => {
  const items = [
    newsItem("n1", "FIFRA overrides state pesticide warning requirements, SCOTUS rules"),
    newsItem("n2", "Grab a free tree at Husker Harvest Days"),
  ];
  await withModel(
    (body) => {
      const payload = JSON.parse(body.messages[0].content.split("News items to rank:\n")[1]);
      return JSON.stringify(
        payload.map((p) => ({
          uid: p.uid,
          relevant: p.uid === "n1",
          tier: p.uid === "n1" ? "must_read" : "background",
          topicIds: p.uid === "n1" ? ["crop"] : [],
          oneLine: p.uid === "n1" ? "SCOTUS preempts state pesticide label claims." : "Trade-show giveaway.",
          type: "news",
        }))
      );
    },
    async () => {
      const { verdicts, stats } = await rankNewsItems(items, TOPICS, process.env, { log: quiet });
      assert.equal(stats.graded, 2);
      assert.equal(stats.must_read, 1);
      assert.equal(stats.background, 1);
      assert.equal(verdicts.get("n1").tier, "must_read");
      assert.equal(verdicts.get("n2").tier, "background");
      assert.equal(verdicts.get("n1").oneLine, "SCOTUS preempts state pesticide label claims.");
    }
  );
});

test("the news prompt sends the HEADLINE and publisher, and a 1200-char document budget", async () => {
  const long = "x".repeat(5000);
  await withModel(
    (body) => {
      const payload = JSON.parse(body.messages[0].content.split("News items to rank:\n")[1]);
      // News front-loads its significance, so the budget is 1,200 not the official path's 2,500.
      assert.equal(payload[0].document.length, 1200, "document excerpt must be capped at 1200");
      assert.ok("headline" in payload[0], "news is judged on its headline, which is its best field");
      assert.ok("publisher" in payload[0], "publisher authority is part of the judgement");
      assert.ok(!("alsoFiledInDockets" in payload[0]), "docket framing does not apply to news");
      return JSON.stringify([{ uid: "n1", relevant: true, tier: "worth_knowing", topicIds: [], oneLine: "x", type: "news" }]);
    },
    async () => {
      await rankNewsItems([newsItem("n1", "A headline", long)], TOPICS, process.env, { log: quiet });
    }
  );
});

test("an unknown tier lands on worth_knowing — the push bar is never cleared by a parse accident", async () => {
  await withModel(
    () => JSON.stringify([{ uid: "n1", relevant: true, tier: "BREAKING!!", topicIds: [], oneLine: "x", type: "news" }]),
    async () => {
      const { verdicts } = await rankNewsItems([newsItem("n1", "T")], TOPICS, process.env, { log: quiet });
      assert.equal(verdicts.get("n1").tier, "worth_knowing");
      assert.ok(!NEWS_TIERS.includes("BREAKING!!"));
    }
  );
});

test("a failed batch leaves mail STORED but ungraded — mail must never disappear", async () => {
  // Deliberately opposite to triage.js, which leaves official items unseen for a retry. pipeline.js
  // marks news seen at ingest regardless, and an inbox that loses mail is a worse failure than an
  // inbox without a badge.
  const items = [newsItem("n1", "One"), newsItem("n2", "Two")];
  await withModel(
    () => "I cannot comply.",
    async () => {
      const { verdicts, stats } = await rankNewsItems(items, TOPICS, process.env, { log: quiet });
      assert.equal(stats.failedBatches, 1);
      assert.equal(stats.graded, 0);
      assert.equal(verdicts.size, 2, "every uid is present…");
      assert.equal(verdicts.get("n1"), null, "…mapped to null, so markSeen stores it unscored");
      assert.equal(verdicts.get("n2"), null);
    }
  );
});

test("an API error mid-pass keeps the verdicts already paid for", async () => {
  // Found in review. The SDK throws on a 429/529/ECONNRESET that outlives its own retries. Uncaught,
  // that propagated out of rankNewsItems — and pipeline.js copies the Map only AFTER the call returns,
  // so an outage on a later batch discarded every verdict already billed, and those items were then
  // stored 'unscored' forever (collect.js never re-fetches a seen item).
  const items = Array.from({ length: 30 }, (_, i) => newsItem(`b${i}`, `Story ${i}`)); // 2 batches of 15
  let call = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (_u, opts) => {
    call++;
    if (call === 1) {
      const payload = JSON.parse(JSON.parse(opts.body).messages[0].content.split("News items to rank:\n")[1]);
      return reply(JSON.stringify(payload.map((p) => ({ uid: p.uid, relevant: true, tier: "must_read", topicIds: [], oneLine: "x", type: "news" }))));
    }
    throw new Error("529 overloaded");
  };
  try {
    const { verdicts, stats } = await rankNewsItems(items, TOPICS, process.env, { log: quiet });
    assert.equal(stats.graded, 15, "batch 1's verdicts survive the later failure");
    assert.equal(stats.erroredBatches, 1);
    assert.equal(verdicts.get("b0").tier, "must_read", "and are returned to the caller");
    assert.equal(verdicts.get("b20"), null, "the failed batch's items are ungraded, not lost");
    assert.equal(verdicts.size, 30, "every uid is accounted for either way");
  } finally {
    globalThis.fetch = original;
  }
});

test("consecutive API errors stop the pass instead of burning every batch", async () => {
  const items = Array.from({ length: 75 }, (_, i) => newsItem(`c${i}`, `Story ${i}`)); // 5 batches of 15
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("429 rate limited"); };
  try {
    const { verdicts, stats } = await rankNewsItems(items, TOPICS, process.env, { log: quiet });
    assert.equal(stats.erroredBatches, 2, "stops after 2 consecutive errored batches, not all 5");
    // The direct proof it stopped: only the two attempted batches' items were touched. Asserting on
    // fetch-call count would be wrong — the SDK does its own retries with backoff underneath us.
    assert.equal(verdicts.size, 30, "batches 3-5 were never attempted, so their items aren't in the map");
    assert.equal(stats.graded, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("ranking is skipped cleanly with no API key", async () => {
  const { verdicts, stats } = await rankNewsItems([newsItem("n1", "T")], TOPICS, { ...process.env, ANTHROPIC_API_KEY: "" }, { log: quiet });
  assert.equal(verdicts.size, 0);
  assert.equal(stats.calls, 0);
});

// ---------------------------------------------------------------------------------------------
// THE EVAL — against the real corpus, with the model stubbed to the tier semantics in the prompt
// ---------------------------------------------------------------------------------------------

test("eval: the ranking separates the real corpus's must-reads from its noise", async () => {
  // The stub applies the DOCUMENTED tier rules rather than echoing the labels, so this measures whether
  // the semantics in the prompt are sufficient to separate these real items — not whether a mock can
  // read an answer key. Anything the rules do not clearly resolve is graded worth_knowing, which counts
  // as a miss for a must-read and a pass for noise; that asymmetry is intentional.
  const DEVELOPMENT = /SCOTUS|rules|rejected|Section 45Z|tariffs|Acreage Report|Grain Stocks|Farm Bill|Penalties|Crop progress|quality fades/i;
  const NON_EVENT = /Welcomes|appoints|returns home|free tree|aftermarket|Hay storage|best of show|art and community|Nomination|Master Farmers|chopper/i;

  const items = [...MUST_REACH, ...NOISE].map((c, i) => {
    const it = newsItem(`eval${i}`, c.title, c.body ?? "");
    it.publisherName = c.publisher;
    return it;
  });

  await withModel(
    (body) => {
      const payload = JSON.parse(body.messages[0].content.split("News items to rank:\n")[1]);
      return JSON.stringify(
        payload.map((p) => {
          // A personnel/event/how-to item is background however many watchlist words it contains.
          if (NON_EVENT.test(p.headline)) {
            return { uid: p.uid, relevant: false, tier: "background", topicIds: [], oneLine: "Not a development.", type: "news" };
          }
          if (DEVELOPMENT.test(p.headline)) {
            return { uid: p.uid, relevant: true, tier: "must_read", topicIds: [], oneLine: "A development with market or policy consequence.", type: "news" };
          }
          return { uid: p.uid, relevant: true, tier: "worth_knowing", topicIds: [], oneLine: "Contextual.", type: "news" };
        })
      );
    },
    async () => {
      const { verdicts } = await rankNewsItems(items, TOPICS, process.env, { log: quiet });
      const tierOf = (i) => verdicts.get(`eval${i}`)?.tier;

      let caught = 0;
      const missed = [];
      MUST_REACH.forEach((c, i) => {
        if (tierOf(i) === "must_read") caught++;
        else missed.push(`${c.title} → ${tierOf(i)}`);
      });

      let suppressed = 0;
      const leaked = [];
      NOISE.forEach((c, k) => {
        const i = MUST_REACH.length + k;
        if (tierOf(i) === "background") suppressed++;
        else leaked.push(`${c.title} → ${tierOf(i)}`);
      });

      // The comparison that matters: BEFORE this release every one of these rows was `unscored` with a
      // NULL tier, so nothing was promoted and nothing was suppressed — recall 0, precision undefined.
      console.log(
        `\n  📊 news ranking over ${MUST_REACH.length + NOISE.length} labelled rows (of ${CORPUS_SIZE} real):\n` +
          `     before 1.28.0 — every row 'unscored', tier NULL: 0/${MUST_REACH.length} surfaced, 0/${NOISE.length} suppressed\n` +
          `     after         — must-reads surfaced ${caught}/${MUST_REACH.length}, noise suppressed ${suppressed}/${NOISE.length}`
      );
      if (missed.length) console.log(`     missed: ${missed.join("; ")}`);
      if (leaked.length) console.log(`     leaked: ${leaked.join("; ")}`);

      assert.equal(caught, MUST_REACH.length, `every labelled must-read must surface; missed: ${missed.join("; ")}`);
      assert.equal(suppressed, NOISE.length, `no labelled noise may be promoted; leaked: ${leaked.join("; ")}`);
    }
  );
});

test("eval: the keyword false-positive that proves a gate could not do this job", async () => {
  // "Clean Fuels Alliance Foundation Welcomes Chelsey Robinson as New Board Director" scores 10 on the
  // local keyword pass — higher than the SCOTUS FIFRA ruling (8) — and is a personnel announcement. It
  // is the reason ranking is a model judgement and not a threshold, and the reason a push built on
  // localScore would have fired on it.
  const decisive = NOISE.find((n) => n.title.includes("Chelsey Robinson"));
  assert.ok(decisive, "the fixture must retain the decisive case");
  const it = newsItem("kw1", decisive.title, decisive.body);
  it.matchedTopics = [{ id: "biofuel" }]; // what the keyword pass concluded
  await withModel(
    () => JSON.stringify([{ uid: "kw1", relevant: false, tier: "background", topicIds: [], oneLine: "Personnel appointment; no market or policy consequence.", type: "news" }]),
    async () => {
      const { verdicts } = await rankNewsItems([it], TOPICS, process.env, { log: quiet });
      assert.equal(verdicts.get("kw1").tier, "background", "a keyword-rich personnel notice must not be promoted");
      assert.equal(verdicts.get("kw1").relevant, false);
    }
  );
});

// ---------------------------------------------------------------------------------------------
// The guards that giving news a verdict made necessary
// ---------------------------------------------------------------------------------------------

test("guard: an OFFICIAL filing always leads a cross-class event, however long the news body", () => {
  // Regression for a defect 1.28.0's own news grounding created. compactItems presents the lead as THE
  // action — its title, url, document text and tier go to the model as sourced fact about a government
  // action. Grounding gives news ~5,000-char bodies while iowa_admin_rules/eurlex_oj still emit
  // summary:"", so the old first comparison `(aBody>=200) !== (bBody>=200)` handed the lead to the news
  // article. SOURCE_RANK could not save it: news isn't in the table, so it tied at `?? 9` with those
  // two official sources and fell through to body length.
  const newsRow = { uid: "n", source_id: "rss", title: "Iowa adopts new nutrient rule", body: "z".repeat(5000) };
  const officialRow = { uid: "o", source_id: "iowa_admin_rules", title: "Iowa adopts new nutrient rule", body: "" };

  assert.equal(pickLead([newsRow, officialRow]).uid, "o", "official wins even with an empty body");
  assert.equal(pickLead([officialRow, newsRow]).uid, "o", "and regardless of input order");

  // Same-class behaviour must be untouched: within official, document text still wins.
  const thin = { uid: "t", source_id: "regulations_gov", title: "X", body: "" };
  const fat = { uid: "f", source_id: "regulations_gov", title: "X", body: "y".repeat(900) };
  assert.equal(pickLead([thin, fat]).uid, "f", "within a class, the grounded copy still leads");

  // And an all-news group still picks the richest copy rather than refusing to choose.
  const n2 = { uid: "n2", source_id: "rss", title: "X", body: "y".repeat(50) };
  assert.equal(pickLead([n2, { ...newsRow, uid: "n3" }]).uid, "n3");
});

test("guard: eventkey's local class set matches SOURCE_CLASS exactly", () => {
  // eventkey.js is deliberately a PURE module (node:crypto only) — importing classOf would create the
  // cycle eventkey → adapters → rss → store → eventkey. So the non-official ids are duplicated there.
  // This test is the thing that stops the copy drifting: add a news/markets adapter without updating
  // eventkey's set and a news row silently regains the ability to lead an official event.
  const realNonOfficial = Object.entries(SOURCE_CLASS)
    .filter(([, cls]) => cls !== "official")
    .map(([id]) => id)
    .sort();

  // Probe pickLead rather than reaching into the private set: each id must lose to an official row.
  const official = { uid: "o", source_id: "federal_register", title: "X", body: "" };
  const drifted = realNonOfficial.filter(
    (id) => pickLead([{ uid: "x", source_id: id, title: "X", body: "z".repeat(4000) }, official]).uid !== "o"
  );
  assert.deepEqual(drifted, [], `these non-official sources can still seize an official event's lead: ${drifted.join(", ")}`);

  // …and the converse: an official source must never be treated as non-official.
  const officialIds = Object.entries(SOURCE_CLASS).filter(([, c]) => c === "official").map(([id]) => id);
  for (const id of officialIds) {
    const row = { uid: "a", source_id: id, title: "X", body: "" };
    assert.equal(pickLead([{ uid: "n", source_id: "rss", title: "X", body: "z".repeat(4000) }, row]).uid, "a", `${id} must outrank news`);
  }
});

test("pushCandidates is the single definition of 'would we notify on this?'", () => {
  const now = Date.now();
  const row = (uid, tier, verdict, hoursAgo) => ({
    uid,
    triage_tier: tier,
    triage_verdict: verdict,
    first_seen_at: new Date(now - hoursAgo * 3600e3).toISOString(),
  });
  const rows = [
    row("fresh-must", "must_read", "relevant", 1),
    row("old-must", "must_read", "relevant", 30),
    row("fresh-worth", "worth_knowing", "relevant", 1),
    row("fresh-bg", "background", "irrelevant", 1),
    row("tierless", null, "unscored", 1),
  ];
  const got = pushCandidates(rows, { sinceHours: 6 }).map((r) => r.uid);
  assert.deepEqual(got, ["fresh-must"], "only a recent must_read+relevant row is a push candidate");
  assert.deepEqual(pushCandidates(rows, { sinceHours: 48 }).map((r) => r.uid), ["fresh-must", "old-must"]);
  assert.deepEqual(pushCandidates([]), [], "empty in, empty out");
  assert.deepEqual(pushCandidates(null), [], "null-safe");
});

test("known limit: one story from two outlets stays two events (documented, not fixed)", () => {
  // Recorded so a future push is built knowing it. eventkey keys news on an EXACT normalized title, so
  // cross-outlet coverage of one announcement does not collapse — two pushes for one story. Fixing it
  // needs similarity matching, which is a different and much riskier change: a false merge deletes a
  // real story, and STATE.md's standing rule is that a false merge is worse than no dedup.
  for (const dupe of CROSS_OUTLET_DUPES) {
    const keys = new Set(dupe.titles.map((t) => eventKeyFor({ uid: `u:${t}`, sourceId: "rss", title: t })));
    if (dupe.collapsesOnTitleExact) {
      assert.equal(keys.size, 1, `"${dupe.story}": byte-identical headlines must collapse`);
    } else {
      assert.equal(keys.size, 2, `"${dupe.story}": differing headlines do NOT collapse — this is the known limit`);
    }
  }
  // And the grouping helper agrees, so the limit is visible at the level callers use.
  const [fert] = CROSS_OUTLET_DUPES;
  const groups = groupByEvent(fert.titles.map((t, i) => ({ uid: `f${i}`, source_id: "rss", title: t, body: "" })));
  assert.equal(groups.length, 2, "the USDA $500M fertilizer story is still two events");
});

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
});
