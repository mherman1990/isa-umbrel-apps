// legiscan.js — LegiScan API adapter for state legislation (free key: https://legiscan.com/legiscan).
//
// Docs: https://legiscan.com/gaits/documentation/legiscan (+ LegiScan API User Manual)
//       https://legiscan.com/legiscan/crashcourse  — the quota/best-practice guide
//
// ── Why this is a two-pass design (rewritten v1.20.0) ─────────────────────────────
// The original ran one getSearch per (term × state) on EVERY run: 103 watchlist terms
// × 7 states = 721 queries/run ≈ 45,000/month against the free tier's 30,000 cap. We
// blew the cap on 2026-07-16; LegiScan's coverage log showed 97.5% duplicate queries
// (39.7:1 repeat ratio) for that spend.
//
// It also failed backwards: `maxItemsPerRun` capped items KEPT, not queries SPENT, and
// the loop only exited once that many bills cleared the `last_action_date` filter. Out
// of session nothing clears it, so the quietest month fired all 721 queries and
// returned ~nothing. Spend was inversely proportional to activity.
//
//   Pass 1 — getMasterList per state. ONE query returns every bill in that state's
//            current session with title, description, change_hash and last_action. We
//            match keywords LOCALLY (free), so cost is fixed at #states per run no
//            matter how long the term list grows, and coverage is now the whole
//            session rather than page 1 of each search.
//
//   Pass 2 — getSearch over a CURATED term list (watchlist `sourceTerms.legiscan`),
//            for `fullTextStates` only (default: IA). This is the ONLY way to reach a
//            bill whose TEXT mentions a term but whose title/description don't —
//            score.js leans on that explicitly (see its `foundByQuery` note: state
//            bill titles are often generic). We keep it where it pays rather than
//            paying for it seven times over.
//
// Cost is now ~#states + (curated terms × fullTextStates) per run — ~38 with the
// shipped config — and is DECOUPLED from how many items return. `maxQueriesPerRun` is
// a hard backstop so this class of blowout cannot recur.
//
// The curated list is a BUDGET, not a relevance judgement: local matching in pass 1
// still uses each topic's full keyword vocabulary, because matching costs nothing.
// Only the paid searches are trimmed.
//
// change_hash: per the API manual it changes whenever a bill's status does. We fold it
// into the item uid, so a bill RE-SURFACES when something actually happens to it while
// never being re-processed while unchanged — collect.js's seen-item filter does the
// change detection for free, with no extra state to keep.

import { fetchJSON, isoDateOnly, keywordRegex, sleep } from "../util.js";

export const id = "legiscan";
export const label = "LegiScan (state bills)";

const BASE = "https://api.legiscan.com/";

// Hard ceiling on API calls per run. Expected spend is ~38; this only ever trips if
// the config grows (more states/terms) or something loops. LegiScan revokes keys for
// abuse, so failing short is always better than failing long.
const DEFAULT_MAX_QUERIES_PER_RUN = 120;

// Gap between calls. The old adapter ran a tight await loop and LegiScan logged us at
// avg 27 req/s, peak 50 — the crash course warns that earns a suspension.
const THROTTLE_MS = 250;

/** Meters API calls so the loops can stop before the backstop is breached. */
class QueryBudget {
  constructor(max) {
    this.max = max;
    this.spent = 0;
  }
  get exhausted() {
    return this.spent >= this.max;
  }
}

/** One throttled, metered LegiScan call. Errors arrive in-band with HTTP 200. */
async function callApi(env, budget, params) {
  if (budget.spent > 0) await sleep(THROTTLE_MS);
  budget.spent += 1;
  const qs = new URLSearchParams({ key: env.LEGISCAN_API_KEY, ...params });
  const data = await fetchJSON(`${BASE}?${qs}`);
  if (data.status !== "OK") {
    const msg = data.alert?.message ?? JSON.stringify(data).slice(0, 200);
    if (/limit|quota|exceed/i.test(msg)) {
      throw new Error(
        `LegiScan monthly query limit reached — resets at midnight on the 1st. ` +
          `Do NOT register a second key; LegiScan revokes all keys for that. (${msg})`
      );
    }
    throw new Error(`LegiScan error: ${msg}`);
  }
  return data;
}

/**
 * Bills out of a getMasterList response. Shape is { masterlist: { session: {...},
 * "0": {bill}, "1": {bill}, ... } } — key scheme varies, so select on the value
 * carrying a bill_id rather than trusting the keys.
 */
function masterlistBills(data) {
  return Object.entries(data.masterlist ?? {})
    .filter(([k, v]) => k !== "session" && v && typeof v === "object" && v.bill_id)
    .map(([, v]) => v);
}

/** Bills out of a getSearch response: { searchresult: { summary: {...}, "0": {bill}, ... } }. */
function searchBills(data) {
  return Object.entries(data.searchresult ?? {})
    .filter(([k, v]) => k !== "summary" && v && typeof v === "object" && v.bill_id)
    .map(([, v]) => v);
}

// getMasterList calls it `number`; getSearch calls it `bill_number`.
const billNumber = (bill) => bill.number ?? bill.bill_number ?? "";

export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
  if (!env.LEGISCAN_API_KEY) {
    throw new Error("LEGISCAN_API_KEY is not set in .env (free key: https://legiscan.com/legiscan)");
  }

  const itemBudget = sourceConfig.maxItemsPerRun ?? 40;
  const states = sourceConfig.states ?? ["IA"];
  const maxQueries = sourceConfig.maxQueriesPerRun ?? DEFAULT_MAX_QUERIES_PER_RUN;
  // Full-text search is the expensive pass — only worth it where state bills are the
  // whole point. Widen once a real month's usage says there's room.
  const fullTextStates = (sourceConfig.fullTextStates ?? ["IA"]).filter((s) => states.includes(s));
  const sinceDate = isoDateOnly(sinceISO);
  const budget = new QueryBudget(maxQueries);

  // A topic reaches us with `queries[legiscan]` set only when its focus area applies to
  // this source; `keywords` is always the full vocabulary. Respect appliesTo for both
  // passes, but let pass 1 match on everything — matching is free, searching is not.
  const applicable = topics.filter((t) => t.queries?.[id] !== undefined);
  const compiled = applicable.map((topic) => ({
    topic,
    regexes: (topic.keywords ?? []).map(keywordRegex),
  }));

  /** Highest-weight topic whose vocabulary appears in `text`, plus that weight. */
  function matchLocally(text) {
    let best = null;
    let weight = 0;
    for (const { topic, regexes } of compiled) {
      if (regexes.some((re) => re.test(text)) && (topic.weight ?? 0) >= weight) {
        weight = topic.weight ?? 0;
        best = topic;
      }
    }
    return { topic: best, weight };
  }

  const byBillId = new Map();

  function addBill(bill, state, { matchedTopicId = null, matchedQuery = null, topicWeight = 0, via }) {
    const lastAction = (bill.last_action ?? "").trim();
    const description = (bill.description ?? "").trim();
    byBillId.set(bill.bill_id, {
      // bill_id + change_hash: the same bill in a new status is a new item.
      uid: `${id}:${bill.bill_id}:${String(bill.change_hash ?? "0").slice(0, 8)}`,
      sourceId: id,
      sourceLabel: label,
      title: `${bill.state ?? state} ${billNumber(bill)}: ${bill.title ?? ""}`.trim(),
      // last_action first (it's WHY the bill resurfaced), then the official synopsis.
      // score.js scores title + summary, so carrying the synopsis here is also what
      // lets it re-derive a masterlist bill's topics on its own.
      summary: [lastAction, description].filter(Boolean).join(" — ").slice(0, 500),
      url: bill.url ?? bill.text_url ?? "",
      publishedAt: bill.last_action_date ? new Date(bill.last_action_date).toISOString() : sinceISO,
      jurisdiction: bill.state ?? state,
      docType: "bill",
      raw: {
        matchedQuery,
        matchedTopicId,
        topicWeight,
        matchedVia: via,
        relevance: bill.relevance ?? null,
        lastAction: lastAction || null,
        lastActionDate: bill.last_action_date ?? null,
        billId: bill.bill_id,
        changeHash: bill.change_hash ?? null,
      },
    });
  }

  // ── Pass 1: masterlist per state — complete coverage, 1 query each ────────────────
  for (const state of states) {
    if (budget.exhausted) break;
    const data = await callApi(env, budget, { op: "getMasterList", state });
    for (const bill of masterlistBills(data)) {
      if ((bill.last_action_date ?? "") < sinceDate) continue; // only recent activity
      const { topic, weight } = matchLocally(
        `${bill.title ?? ""}\n${bill.description ?? ""}\n${bill.last_action ?? ""}`
      );
      if (!topic) continue;
      // matchedTopicId stays null: score.js reads it as "the source's full-text search
      // found this", which only pass 2 can honestly claim. Pass 1 matched the same text
      // score.js is about to match itself, so let it do its own work.
      addBill(bill, state, { topicWeight: weight, via: "masterlist" });
    }
  }

  // ── Pass 2: curated full-text search, highest-weight topics first ─────────────────
  const searches = [];
  for (const topic of [...applicable].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
    for (const term of topic.queries?.[id] ?? []) searches.push({ topic, term });
  }

  outer: for (const { topic, term } of searches) {
    for (const state of fullTextStates) {
      if (budget.exhausted) break outer;
      const data = await callApi(env, budget, { op: "getSearch", state, query: term, year: "2" });
      for (const bill of searchBills(data)) {
        if ((bill.last_action_date ?? "") < sinceDate) continue;
        const existing = byBillId.get(bill.bill_id);
        if (existing) {
          // Already collected — upgrade it with the full-text topic signal, which is
          // exactly what the title/description couldn't reveal. Searches run
          // highest-weight first, so the first topic to claim a bill is the best one.
          existing.raw.matchedTopicId ??= topic.id;
          existing.raw.matchedQuery ??= term;
          existing.raw.topicWeight = Math.max(existing.raw.topicWeight ?? 0, topic.weight ?? 0);
          // Only masterlist bills get promoted; a bill that several search terms return
          // was never in the masterlist and must not claim to have been.
          if (existing.raw.matchedVia === "masterlist") existing.raw.matchedVia = "masterlist+search";
          continue;
        }
        addBill(bill, state, {
          matchedTopicId: topic.id,
          matchedQuery: term,
          topicWeight: topic.weight ?? 0,
          via: "search",
        });
      }
    }
  }

  if (budget.exhausted) {
    console.log(
      `⚠️  ${label}: hit the ${maxQueries}-query per-run backstop — coverage is partial. ` +
        `Trim watchlist sourceTerms.legiscan / fullTextStates, or raise maxQueriesPerRun.`
    );
  }

  // Rank before truncating: query spend is fixed now, so the item cap is purely about
  // how much we hand the scorer. Highest-weight topic first, then most recent action.
  const items = [...byBillId.values()];
  items.sort(
    (a, b) =>
      (b.raw.topicWeight ?? 0) - (a.raw.topicWeight ?? 0) ||
      String(b.raw.lastActionDate ?? "").localeCompare(String(a.raw.lastActionDate ?? ""))
  );
  console.log(
    `   ${label}: ${budget.spent} queries (${states.length} masterlist + ${budget.spent - states.length} search), ` +
      `${items.length} matched, ${Math.min(items.length, itemBudget)} kept`
  );
  return items.slice(0, itemBudget);
}
