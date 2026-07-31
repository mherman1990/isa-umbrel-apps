// Tests for news grounding (enrich.js groundNewsItems + store.groundItemBody) — 1.28.0.
//
// THE GAP THIS CLOSES, measured on the stored feed before any code was written (2026-07-30, 68 news
// items): 12 had no body at all, 48 had 1–199 characters, 8 had 200–799, and nothing exceeded 800.
// The 48 are RSS `<description>` teasers, truncated mid-word by the publisher. Meanwhile news is 54%
// of the whole corpus (68 of 126 rows), and every consumer downstream reads `body`:
// searchItemsRanked weights a body hit, compactItems' `document` field IS body, and the Ask box and
// Analyst Note read compactItems. So more than half the corpus reached the deepest model in the
// system as a headline plus a fragment.
//
// The text was already being fetched. generateNewsDigest pulled up to 14 articles' readable text into
// a local Map, used it for one Haiku call, and discarded it — paying the HTTP cost every run and
// keeping nothing. This suite locks in that the text is now kept, that keeping it can only ever ADD
// information, and — the part that matters — that retrieval can now reach a fact that lives in an
// article's body rather than its headline.
//
// Zero deps (node --test), no network: fetchDocumentText is injected. Temp DATA_DIR throughout.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bb-news-"));
process.env.POLIBRIEF_DATA_DIR = DIR;

const { groundNewsItems } = await import("../src/enrich.js");
const store = await import("../src/store.js");

const quiet = () => {};

// Shapes taken from the real stored corpus, including the mid-word truncation. The teaser for the
// acreage story is the actual stored body, cut exactly where Progressive Farmer's feed cuts it.
const TEASER_ACREAGE =
  'Progressive Farmer reported, "U.S. farmers planted 95.3 million acres of corn and 85.4 mil';
const ARTICLE_ACREAGE =
  'Progressive Farmer reported, "U.S. farmers planted 95.3 million acres of corn and 85.4 million ' +
  "acres of soybeans in 2026, USDA said in its June Acreage report. Soybean plantings came in 1.2 " +
  "million acres above the March intentions figure, and Iowa growers seeded 9.8 million acres. " +
  "Grain Stocks put June 1 soybean stocks at 1.01 billion bushels, up 4% year over year, which " +
  "analysts read as a modest bearish surprise against a pre-report trade estimate near 980 million.";

const newsItem = (uid, title, summary, url = `https://example.test/${uid}`) => ({
  uid,
  sourceId: "rss",
  sourceLabel: "Entity RSS/Atom feeds",
  title,
  summary,
  url,
  publishedAt: "2026-07-28T12:00:00.000Z",
  jurisdiction: "US-Federal",
  docType: "statement",
  raw: { entityId: "ent-progressive-farmer" },
});

/** A stub fetchDocumentText driven by a uid → text map. */
const stubFetch = (byUrl, calls = []) => async (url) => {
  calls.push(url);
  const text = byUrl[url];
  if (text === undefined) return { text: "", note: "couldn't fetch the document (HTTP 404)" };
  if (text instanceof Error) throw text;
  return { text, note: null };
};

test("a thin teaser is replaced by the article's text, and provenance is recorded", async () => {
  const items = [newsItem("a1", "USDA releases June 2026 Acreage Report and Grain Stocks", TEASER_ACREAGE)];
  const calls = [];
  const { items: out, stats } = await groundNewsItems(items, {
    log: quiet,
    fetchText: stubFetch({ "https://example.test/a1": ARTICLE_ACREAGE }, calls),
  });

  assert.equal(stats.attempted, 1);
  assert.equal(stats.grounded, 1);
  assert.ok(out[0].summary.length > 400, `grounded body should be substantive, got ${out[0].summary.length}`);
  assert.match(out[0].summary, /85\.4 million\s+acres of soybeans/, "the truncated figure is now complete");
  assert.equal(out[0].raw.groundedFrom, "article", "provenance says where the text came from");
  assert.equal(out[0].raw.groundedChars, out[0].summary.length);
  assert.ok(stats.charsAdded > 300, "and the gain is reported");
  assert.deepEqual(calls, ["https://example.test/a1"]);
});

test("grounding NEVER shortens — a paywall stub leaves the teaser intact", async () => {
  // The real failure mode: a JS-rendered or metered page returns nav chrome shorter than the feed
  // teaser we already had. Overwriting would make the row worse than before grounding existed, so the
  // longer text wins and the item is counted as unavailable rather than grounded.
  const items = [newsItem("a2", "USDA releases June 2026 Acreage Report", TEASER_ACREAGE)];
  const { items: out, stats } = await groundNewsItems(items, {
    log: quiet,
    fetchText: stubFetch({ "https://example.test/a2": "Subscribe to continue reading." }),
  });

  assert.equal(stats.grounded, 0);
  assert.equal(stats.failed, 1, "counted as unavailable, not as a success");
  assert.equal(out[0].summary, TEASER_ACREAGE, "the row is untouched");
  assert.equal(out[0].raw.groundedFrom, undefined, "and is not falsely marked as grounded");
});

test("an item with no URL is never fetched — a collector email's body IS the message", async () => {
  const email = { ...newsItem("e1", "Daily market letter", "Short note."), sourceId: "email_intake", url: null };
  const calls = [];
  const { stats } = await groundNewsItems([email], { log: quiet, fetchText: stubFetch({}, calls) });

  assert.equal(stats.attempted, 0, "not even considered");
  assert.deepEqual(calls, [], "no HTTP call made");
});

test("an item that already carries real text is skipped, so no fetch is wasted", async () => {
  const already = newsItem("a3", "Growth Energy backs penalties against Brazil", "x".repeat(450));
  const calls = [];
  const { items: out, stats } = await groundNewsItems([already], { log: quiet, fetchText: stubFetch({}, calls) });

  assert.equal(stats.attempted, 0);
  assert.deepEqual(calls, []);
  assert.equal(out[0].summary.length, 450, "left exactly as the adapter produced it");
});

test("the budget caps fetches per run", async () => {
  // DISTINCT hosts, so this measures the budget alone. (With one shared host the per-host strike rule
  // below kicks in first and fewer fetches are made — correct, but a different property.)
  const items = Array.from({ length: 40 }, (_, i) =>
    newsItem(`b${i}`, `Story ${i}`, "tiny", `https://pub${i}.test/a`)
  );
  const calls = [];
  const { stats } = await groundNewsItems(items, { budget: 5, log: quiet, fetchText: stubFetch({}, calls) });

  assert.equal(stats.attempted, 5);
  assert.equal(calls.length, 5, "a busy news day cannot stretch the run");
});

test("a host that keeps refusing stops consuming the budget", async () => {
  // MEASURED MOTIVATION: farmprogress.com is 50 of 68 stored news rows, returns 403 to every request,
  // and arrives FIRST in the array. So allocating the 25-fetch budget in plain array order spent all of
  // it on a host that can never succeed, starving farmdocdaily / Farm Policy News / Feedstuffs, which do.
  const items = [
    ...Array.from({ length: 12 }, (_, i) => newsItem(`fp${i}`, `Blocked ${i}`, "tiny", `https://www.farmprogress.com/a${i}`)),
    newsItem("ok1", "Readable story", "tiny", "https://farmdocdaily.illinois.edu/x"),
  ];
  const calls = [];
  const { items: out, stats } = await groundNewsItems(items, {
    budget: 25,
    log: quiet,
    fetchText: async (url) => {
      calls.push(url);
      if (url.includes("farmprogress")) return { text: "", note: "couldn't fetch the document (HTTP 403)" };
      return { text: ARTICLE_ACREAGE, note: null };
    },
  });

  const fpCalls = calls.filter((u) => u.includes("farmprogress")).length;
  assert.ok(fpCalls <= 4, `should stop hammering a refusing host; made ${fpCalls} calls to farmprogress`);
  assert.ok(stats.skippedHost > 0, "and the un-attempted items are counted, not hidden");
  // The readable publisher still gets served — the whole point.
  assert.ok(calls.some((u) => u.includes("farmdocdaily")), "the publisher that works must still be fetched");
  assert.equal(out.find((i) => i.uid === "ok1").raw.groundedFrom, "article");
  assert.equal(stats.grounded, 1);
});

test("a throwing fetch is a no-op, not a run-killer", async () => {
  const items = [
    newsItem("c1", "Story one", TEASER_ACREAGE),
    newsItem("c2", "Story two", "tiny teaser"),
  ];
  const { items: out, stats } = await groundNewsItems(items, {
    log: quiet,
    fetchText: stubFetch(
      { "https://example.test/c1": new Error("socket hang up"), "https://example.test/c2": ARTICLE_ACREAGE },
      []
    ),
  });

  assert.equal(stats.failed, 1);
  assert.equal(stats.grounded, 1, "the healthy item still gets grounded");
  assert.equal(out[0].summary, TEASER_ACREAGE, "the failed one continues exactly as fetched");
});

test("a publisher that cannot be read is NAMED, not silently skipped", async () => {
  // MEASURED AND LOAD-BEARING. farmprogress.com is 50 of the 68 stored news rows and returns HTTP 403
  // from Cloudflare to every user-agent tried, including an ordinary browser one — so the single
  // biggest news publisher in this corpus contributes no article text at all. If that were invisible,
  // "news grounding shipped" would read as "news is grounded", and the absence of evidence would be
  // mistaken for an absence of news. The per-host tally is how the run log can answer it.
  const items = [
    newsItem("blk:1", "FIFRA overrides state pesticide warning requirements", "tiny", "https://www.farmprogress.com/a"),
    newsItem("blk:2", "Nebraska passes farmer data law", "tiny", "https://www.farmprogress.com/b"),
    newsItem("ok:1", "Pesticide costs and returns", "tiny", "https://farmdocdaily.illinois.edu/c"),
  ];
  const lines = [];
  const { stats } = await groundNewsItems(items, {
    log: (l) => lines.push(l),
    fetchText: async (url) =>
      url.includes("farmprogress")
        ? { text: "", note: "couldn't fetch the document (HTTP 403)" }
        : { text: ARTICLE_ACREAGE, note: null },
  });

  assert.equal(stats.grounded, 1);
  assert.equal(stats.failed, 2);
  assert.equal(stats.blockedHosts["farmprogress.com"].n, 2, "counted per host, with www stripped");
  assert.match(stats.blockedHosts["farmprogress.com"].reason, /403/, "and the reason is kept");
  assert.ok(
    lines.some((l) => l.includes("farmprogress.com") && l.includes("2 items unreadable")),
    `the run log must name the blocked publisher; got:\n${lines.join("\n")}`
  );
});

test("paragraph breaks survive into storage, so the reader doesn't get a wall of text", async () => {
  // Found in review: grounding made the News tab render up to 8,000 characters as ONE unbroken run,
  // because fetchDocumentText collapsed all whitespace (fine for a model, unreadable for a human — and
  // this text is now read by a human). Fixing it in the RENDERER was cosmetic and didn't work: with no
  // newlines in the stored text there is nothing for textToHtml to split on. So it is fixed at
  // extraction (fetchDocumentText's preserveParagraphs) and preserved through normalizeArticle.
  const { textToHtml } = await import("../src/emailhtml.js");
  const article = [
    "U.S. farmers planted 85.4 million acres of soybeans in 2026.",
    "June 1 soybean stocks came in at 1.01 billion bushels, up 4% year over year.",
    "Analysts had expected closer to 980 million bushels.",
  ].join("\n\n");

  let askedForParagraphs = null;
  const { items: out } = await groundNewsItems([newsItem("p1", "Acreage report", "tiny")], {
    log: quiet,
    fetchText: async (_url, opts) => {
      askedForParagraphs = opts?.preserveParagraphs;
      return { text: article, note: null };
    },
  });

  assert.equal(askedForParagraphs, true, "grounding must request paragraph-preserving extraction");
  assert.equal((out[0].summary.match(/\n\n/g) || []).length, 2, "blank lines survive normalization");
  assert.equal((textToHtml(out[0].summary).match(/<p/g) || []).length, 3, "and render as 3 paragraphs, not one wall");
  // Spaces/tabs inside a line still collapse — only the paragraph boundaries are special.
  const { items: out2 } = await groundNewsItems([newsItem("p2", "T", "tiny")], {
    log: quiet,
    fetchText: async () => ({ text: "one    two\t\tthree\n\n\n\n\nfour", note: null }),
  });
  assert.equal(out2[0].summary, "one two three\n\nfour", "runs collapse; a single blank line remains");
});

test("groundItemBody is additive-only and idempotent", () => {
  const row = {
    uid: "heal:1",
    sourceId: "rss",
    title: "USDA releases June 2026 Acreage Report",
    summary: TEASER_ACREAGE,
    url: "https://example.test/heal1",
    publishedAt: "2026-07-28T12:00:00.000Z",
    raw: {},
  };
  store.markSeen(row, null);

  assert.equal(store.groundItemBody("heal:1", ARTICLE_ACREAGE), true, "a longer body is written");
  assert.equal(store.groundItemBody("heal:1", ARTICLE_ACREAGE), false, "re-running changes nothing");
  assert.equal(store.groundItemBody("heal:1", "Subscribe to continue."), false, "a shorter body is refused");
  assert.equal(store.groundItemBody("heal:1", ""), false, "empty is refused");
  assert.equal(store.groundItemBody(null, ARTICLE_ACREAGE), false, "no uid is refused");

  const stored = store.searchItemsRanked("acreage", { limit: 5 }).find((r) => r.uid === "heal:1");
  assert.match(stored.body, /1\.01 billion bushels/, "the row now holds the article");
});

// ---------------------------------------------------------------------------------------------
// THE PAYOFF: can retrieval reach a fact that lives in the article rather than the headline?
// ---------------------------------------------------------------------------------------------
test("eval: retrieval reaches article-body facts only once news is grounded", () => {
  // Two rows, same story, stored the two ways: as the feed delivered it, and grounded.
  const asFeedDelivered = {
    uid: "eval:teaser",
    sourceId: "rss",
    title: "USDA releases June 2026 Acreage Report and Grain Stocks",
    summary: TEASER_ACREAGE,
    url: "https://example.test/eval-teaser",
    publishedAt: "2026-07-28T12:00:00.000Z",
    raw: {},
  };
  const grounded = { ...asFeedDelivered, uid: "eval:grounded", summary: ARTICLE_ACREAGE };
  store.markSeen(asFeedDelivered, null);
  store.markSeen(grounded, null);

  // Questions a Demand & Policy analyst would actually type. Each answer is IN the article and
  // absent from both the headline and the teaser — which is the whole point: the teaser stops at
  // "85.4 mil".
  const cases = [
    { q: "how many acres of soybeans were planted", needle: /85\.4 million/ },
    { q: "June 1 soybean stocks", needle: /1\.01 billion/ },
    { q: "Iowa soybean acres seeded", needle: /9\.8 million/ },
    { q: "bearish surprise versus the pre-report trade estimate", needle: /980 million/ },
  ];

  // MEASURE ANSWERABILITY, NOT REACHABILITY. Both rows share a title, so both usually get RETRIEVED
  // on a keyword — the teaser row matched 3 of these 4 queries before grounding existed. That is the
  // trap: a row that matches but whose text stops at "85.4 mil" is arguably worse than a miss,
  // because the model is then handed a citation that cannot support the claim, and the honest
  // outcomes are a hedge ("substance not retrieved") or a confabulated figure. So the metric is: of
  // the questions asked, for how many does the RETRIEVED row actually contain the answer?
  const score = (uid) => {
    let retrieved = 0;
    let answerable = 0;
    for (const { q, needle } of cases) {
      const row = store.searchItemsRanked(q, { limit: 20 }).find((r) => r.uid === uid);
      if (!row) continue;
      retrieved++;
      if (needle.test(String(row.body ?? ""))) answerable++;
    }
    return { retrieved, answerable };
  };
  const before = score("eval:teaser");
  const after = score("eval:grounded");

  console.log(
    `\n  📊 news evidence quality over ${cases.length} article-body questions:\n` +
      `     as delivered by the feed — retrieved ${before.retrieved}/${cases.length}, ANSWERABLE ${before.answerable}/${cases.length}\n` +
      `     grounded                — retrieved ${after.retrieved}/${cases.length}, ANSWERABLE ${after.answerable}/${cases.length}`
  );

  assert.equal(after.answerable, cases.length, "every article-body question is answerable once grounded");
  assert.equal(
    before.answerable,
    0,
    "and none were before — the teaser is retrieved on a keyword but truncates before every answer, " +
      "which is what made news citations unsupportable"
  );
});

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
});
