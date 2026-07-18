// verify-legiscan.mjs — offline verification for the v1.20.0 LegiScan adapter rewrite.
//
//   node scripts/verify-legiscan.mjs
//
// The quota blowout of 2026-07-16 left the key dead until the 1st, so this stubs
// globalThis.fetch (which util.js's fetchJSON goes through) and drives the adapter
// against fixtures. The assertion that matters is #2: query spend must NOT depend on
// how many bills come back. That coupling is what blew the cap — out of session no
// bill cleared the date filter, the item budget never bound, and all 721 queries fired
// to return nothing. Re-run against the live API once the quota resets.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as legiscan from "../src/adapters/legiscan.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────────
const SESSION = { session_id: 2000, state_id: 17, year_start: 2025, year_end: 2026, sine_die: 0 };

/** getMasterList shape: `number`, no per-bill `state`, keyed by index. */
const masterlistBill = (n, over = {}) => ({
  bill_id: n,
  number: `HF${n}`,
  change_hash: `hash${n}aaaaaaaa`,
  url: `https://legiscan.com/IA/bill/HF${n}/2025`,
  status_date: "2026-07-14",
  status: 1,
  last_action_date: "2026-07-14",
  last_action: "Introduced",
  title: `An Act relating to matter ${n}`,
  description: `A bill for an act relating to matter ${n}.`,
  ...over,
});

/** getSearch shape: `bill_number` + `state` + `relevance`, keyed by index. */
const searchBill = (n, over = {}) => ({
  bill_id: n,
  bill_number: `HF${n}`,
  change_hash: `hash${n}aaaaaaaa`,
  url: `https://legiscan.com/IA/bill/HF${n}/2025`,
  state: "IA",
  relevance: 95,
  last_action_date: "2026-07-14",
  last_action: "Introduced",
  title: `An Act relating to matter ${n}`,
  ...over,
});

const keyed = (arr, extraKey, extraVal) =>
  Object.assign({ [extraKey]: extraVal }, ...arr.map((b, i) => ({ [String(i)]: b })));

/** Install a fake LegiScan. `handler({op, state, query})` returns a payload or throws. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const p = new URL(url).searchParams;
    const call = { op: p.get("op"), state: p.get("state"), query: p.get("query"), at: Date.now() };
    calls.push(call);
    const data = handler(call) ?? { status: "OK" };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  return calls;
}

// Real watchlist config + the engine topic shape pipeline.js derives from it.
const wl = JSON.parse(readFileSync(new URL("../watchlist.json", import.meta.url), "utf8").replace(/^﻿/, ""));
const topicsFrom = (focusAreas) =>
  focusAreas
    .filter((fa) => fa.enabled !== false)
    .map((fa) => {
      const applies = fa.appliesTo?.length ? fa.appliesTo : ["legiscan"];
      const queries = {};
      for (const sid of applies) queries[sid] = fa.sourceTerms?.[sid] ?? fa.terms ?? [];
      return { id: fa.id, label: fa.label, weight: fa.weight ?? 5, keywords: fa.terms ?? [], queries };
    });

const TOPICS = topicsFrom(wl.focusAreas);
const CONFIG = wl.sources.legiscan;
const ENV = { LEGISCAN_API_KEY: "test-key" };
const SINCE = "2026-07-13T00:00:00.000Z";
const run = (cfg, env = ENV) =>
  legiscan.fetchItems({ sinceISO: SINCE, topics: TOPICS, sourceConfig: { ...CONFIG, ...cfg }, env });

const EXPECTED_QUERIES = CONFIG.states.length + 31 * CONFIG.fullTextStates.length; // 7 + 31

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`  ✅ ${name}`);
  } catch (err) {
    results.push(`  ❌ ${name}\n${err.message.split("\n").map((l) => `       ${l}`).join("\n")}`);
    process.exitCode = 1;
  }
};

// ── 1. Shipped config spends the budget we think it does ──────────────────────────
await check(`shipped config spends exactly ${EXPECTED_QUERIES} queries/run`, async () => {
  const calls = stubFetch(({ op, state }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([masterlistBill(1)], "session", SESSION) }
      : { status: "OK", searchresult: keyed([searchBill(2)], "summary", { count: 1 }) }
  );
  await run({});
  assert.equal(calls.length, EXPECTED_QUERIES, `spent ${calls.length}`);
  assert.equal(calls.filter((c) => c.op === "getMasterList").length, 7, "one masterlist per state");
  // Full-text search must not fan out across all 7 states — that was the old bug.
  assert.deepEqual([...new Set(calls.filter((c) => c.op === "getSearch").map((c) => c.state))], ["IA"]);
});

// ── 2. THE REGRESSION TEST: spend is decoupled from item count ────────────────────
await check("out-of-session (0 bills) spends the SAME as a busy session — the old bug", async () => {
  const quiet = stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([masterlistBill(1, { last_action_date: "2026-03-01" })], "session", SESSION) }
      : { status: "OK", searchresult: keyed([], "summary", { count: 0 }) }
  );
  const quietItems = await run({});
  assert.equal(quietItems.length, 0, "adjourned session should yield no items");

  // A flood of relevant bills — far past maxItemsPerRun (40).
  const flood = Array.from({ length: 300 }, (_, i) =>
    masterlistBill(1000 + i, { title: `An Act relating to biodiesel blending ${i}` })
  );
  const busy = stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed(flood, "session", SESSION) }
      : { status: "OK", searchresult: keyed([], "summary", { count: 0 }) }
  );
  const busyItems = await run({});
  assert.equal(busyItems.length, 40, "item cap still applies");
  assert.equal(quiet.length, busy.length, `quiet=${quiet.length} busy=${busy.length} — spend must not vary`);
});

// ── 3. change_hash drives the uid (so a bill resurfaces only when it moves) ────────
await check("change_hash folds into the uid; unchanged bill keeps its uid", async () => {
  const one = (hash) => async () => {
    stubFetch(({ op }) =>
      op === "getMasterList"
        ? { status: "OK", masterlist: keyed([masterlistBill(7, { change_hash: hash, title: "An Act relating to biodiesel" })], "session", SESSION) }
        : { status: "OK", searchresult: keyed([], "summary", { count: 0 }) }
    );
    return (await run({ states: ["IA"], fullTextStates: [] }))[0].uid;
  };
  assert.equal(await one("aaaaaaaabbbb")(), await one("aaaaaaaabbbb")(), "same hash = same uid");
  assert.notEqual(await one("aaaaaaaabbbb")(), await one("ccccccccdddd")(), "new hash = new uid");
});

// ── 4. Field-name drift between the two ops ───────────────────────────────────────
await check("masterlist `number` and search `bill_number` both map; billId preserved", async () => {
  stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([masterlistBill(11, { title: "An Act relating to biodiesel" })], "session", SESSION) }
      : { status: "OK", searchresult: keyed([searchBill(22, { title: "An Act relating to civil actions", last_action: "Referred" })], "summary", { count: 1 }) }
  );
  const items = await run({ states: ["IA"] });
  const ml = items.find((i) => i.raw.billId === 11);
  const se = items.find((i) => i.raw.billId === 22);
  assert.ok(ml.title.startsWith("IA HF11:"), `masterlist title: ${ml.title}`);
  assert.ok(se.title.startsWith("IA HF22:"), `search title: ${se.title}`);
  // pipeline.js:298 keys tracked items off raw.billId — must survive.
  assert.equal(typeof ml.raw.billId, "number");
  // The synopsis has to reach `summary`, or score.js can't re-match a masterlist bill.
  assert.ok(ml.summary.includes("A bill for an act relating to matter 11."), `summary: ${ml.summary}`);
  assert.ok(ml.summary.startsWith("Introduced"), "last_action leads the summary");
});

// ── 5. matchedTopicId semantics (score.js `foundByQuery` depends on this) ──────────
await check("matchedTopicId: null from masterlist, set from full-text search", async () => {
  stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([masterlistBill(31, { title: "An Act relating to biodiesel" })], "session", SESSION) }
      : { status: "OK", searchresult: keyed([searchBill(32, { title: "An Act relating to civil actions" })], "summary", { count: 1 }) }
  );
  const items = await run({ states: ["IA"] });
  const ml = items.find((i) => i.raw.billId === 31);
  const se = items.find((i) => i.raw.billId === 32);
  assert.equal(ml.raw.matchedTopicId, null, "masterlist may not claim a full-text match");
  assert.equal(ml.raw.matchedVia, "masterlist");
  assert.ok(se.raw.matchedTopicId, "search-found bill carries its topic");
  // Every one of the 31 curated terms returns this bill, so it takes the merge path 30
  // times. It was never in the masterlist and must not end up claiming it was.
  assert.equal(se.raw.matchedVia, "search", "search-only bill must not claim masterlist provenance");
  // A generic title only full-text search can reach — the whole reason pass 2 survives.
  assert.equal(typeof se.raw.matchedQuery, "string", "search-found bill records its query");
});

// ── 6. A bill found by both passes gets upgraded, not duplicated ───────────────────
await check("bill in both passes merges once and gains the full-text topic signal", async () => {
  stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([masterlistBill(41, { title: "An Act relating to biodiesel" })], "session", SESSION) }
      : { status: "OK", searchresult: keyed([searchBill(41, { title: "An Act relating to biodiesel" })], "summary", { count: 1 }) }
  );
  const items = await run({ states: ["IA"] });
  const hits = items.filter((i) => i.raw.billId === 41);
  assert.equal(hits.length, 1, "must not duplicate");
  assert.equal(hits[0].raw.matchedVia, "masterlist+search");
  assert.ok(hits[0].raw.matchedTopicId, "upgraded with the search topic");
});

// ── 7. Hard backstop ──────────────────────────────────────────────────────────────
await check("maxQueriesPerRun caps the run and warns", async () => {
  const calls = stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([masterlistBill(1)], "session", SESSION) }
      : { status: "OK", searchresult: keyed([], "summary", { count: 0 }) }
  );
  await run({ maxQueriesPerRun: 5 });
  assert.ok(calls.length <= 5, `spent ${calls.length}, cap 5`);
});

// ── 8. Quota error is human-readable and warns off the fatal workaround ────────────
await check("quota error explains the reset and warns against a second key", async () => {
  stubFetch(() => ({ status: "ERROR", alert: { message: "Monthly query limit exceeded" } }));
  await assert.rejects(run({}), (err) => {
    assert.match(err.message, /resets at midnight on the 1st/i);
    assert.match(err.message, /do NOT register a second key/i);
    return true;
  });
});

await check("missing key fails with the signup link", async () => {
  await assert.rejects(run({}, {}), /LEGISCAN_API_KEY is not set/);
});

// ── 9. Throttle — LegiScan logged us at 27 req/s avg, 50 peak ─────────────────────
await check("throttled well under the old 27 req/s average", async () => {
  const calls = stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([], "session", SESSION) }
      : { status: "OK", searchresult: keyed([], "summary", { count: 0 }) }
  );
  const t0 = Date.now();
  await run({});
  const qps = calls.length / ((Date.now() - t0) / 1000);
  assert.ok(qps < 10, `${qps.toFixed(1)} req/s — too fast`);
});

// ── 10. Code-only Update: the Pi's watchlist is persisted, so it may not be merged ─
await check("un-merged watchlist (no sourceTerms/knobs) still lands under the cap", async () => {
  // Exactly what the Pi looks like after an Update with no /data/watchlist.json merge:
  // no sourceTerms on the focus areas, no fullTextStates, no maxQueriesPerRun.
  const legacyTopics = topicsFrom(wl.focusAreas.map(({ sourceTerms, ...fa }) => fa));
  const { maxQueriesPerRun, fullTextStates, ...legacyConfig } = CONFIG;
  const calls = stubFetch(({ op }) =>
    op === "getMasterList"
      ? { status: "OK", masterlist: keyed([], "session", SESSION) }
      : { status: "OK", searchresult: keyed([], "summary", { count: 0 }) }
  );
  await legiscan.fetchItems({ sinceISO: SINCE, topics: legacyTopics, sourceConfig: legacyConfig, env: ENV });
  // Defaults must carry it: 7 masterlist + 103 terms × the default single fullTextState.
  assert.equal(calls.length, 110, `spent ${calls.length}`);
  assert.ok(calls.length * 2 * 31 < 30_000, "must stay under the monthly cap unmerged");
  assert.ok(calls.length < 120, "must not trip the default backstop (would truncate coverage)");
});

console.log("\nLegiScan adapter v1.20.0 — offline verification\n");
console.log(results.join("\n"));
const spendMo = EXPECTED_QUERIES * 2 * 31;
console.log(
  `\n  Budget: ${EXPECTED_QUERIES} queries/run → ${spendMo.toLocaleString()}/mo ` +
    `(2 scheduled runs/day) vs the 30,000 cap. Was 721/run → 44,702/mo.\n`
);
console.log(process.exitCode ? "  FAILED\n" : "  All checks passed.\n");
