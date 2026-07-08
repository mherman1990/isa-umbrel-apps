// legiscan.js — LegiScan API adapter for state legislation (free key: https://legiscan.com/legiscan).
//
// Docs: https://legiscan.com/gaits/documentation/legiscan (+ LegiScan API User Manual)
// Strategy: getSearch per (state × topic query), iterating topics by weight so the
// item budget is spent on the highest-priority topics first. Page 1 only (50 results),
// deduped by bill_id across queries, filtered to bills acted on since the last run.
//
// Per the API manual, each bill carries a change_hash that changes whenever the
// bill's status changes. We fold it into the item uid, so a bill RE-SURFACES in
// briefs when something actually happens to it (committee vote, passage, signing)
// but is still never re-processed while unchanged.
//
// Quota note: the free tier allows 30,000 queries/month. Worst case per run is
// (#states × #non-empty legiscan queries) requests — with the starter watchlist
// that's ~70, or ~4,200/month at two runs a day. Comfortable, but keep it in mind
// when adding states or queries.

import { fetchJSON, isoDateOnly } from "../util.js";

export const id = "legiscan";
export const label = "LegiScan (state bills)";

const BASE = "https://api.legiscan.com/";

export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
  if (!env.LEGISCAN_API_KEY) {
    throw new Error("LEGISCAN_API_KEY is not set in .env (free key: https://legiscan.com/legiscan)");
  }
  const budget = sourceConfig.maxItemsPerRun ?? 40;
  const states = sourceConfig.states ?? ["IA"];
  const sinceDate = isoDateOnly(sinceISO);

  // (topic, query) pairs, highest-weight topics first — stop when the budget fills.
  const queries = [];
  for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
    for (const term of topic.queries?.[id] ?? []) {
      queries.push({ topic, term });
    }
  }

  const byBillId = new Map();
  outer: for (const { topic, term } of queries) {
    for (const state of states) {
      if (byBillId.size >= budget) break outer;

      const params = new URLSearchParams({
        key: env.LEGISCAN_API_KEY,
        op: "getSearch",
        state,
        query: term,
        year: "2", // 2 = current legislative sessions
      });
      const data = await fetchJSON(`${BASE}?${params}`);
      if (data.status !== "OK") {
        // LegiScan reports errors in-band with HTTP 200.
        throw new Error(`LegiScan error: ${data.alert?.message ?? JSON.stringify(data).slice(0, 200)}`);
      }

      // searchresult is an object: { summary: {...}, "0": {...}, "1": {...}, ... }
      const results = Object.entries(data.searchresult ?? {})
        .filter(([k]) => k !== "summary")
        .map(([, v]) => v);

      for (const bill of results) {
        if (byBillId.size >= budget) break outer;
        if (byBillId.has(bill.bill_id)) continue;
        if ((bill.last_action_date ?? "") < sinceDate) continue; // only recent activity

        byBillId.set(bill.bill_id, {
          // bill_id + change_hash: same bill in a new status = a new item.
          uid: `${id}:${bill.bill_id}:${(bill.change_hash ?? "0").slice(0, 8)}`,
          sourceId: id,
          sourceLabel: label,
          title: `${bill.state} ${bill.bill_number}: ${bill.title ?? ""}`,
          summary: bill.last_action ?? "",
          url: bill.url ?? bill.text_url ?? "",
          publishedAt: bill.last_action_date
            ? new Date(bill.last_action_date).toISOString()
            : sinceISO,
          jurisdiction: bill.state ?? state,
          docType: "bill",
          raw: {
            matchedQuery: term,
            matchedTopicId: topic.id,
            relevance: bill.relevance ?? null,
            lastAction: bill.last_action ?? null,
            lastActionDate: bill.last_action_date ?? null,
            billId: bill.bill_id,
            changeHash: bill.change_hash ?? null,
          },
        });
      }
    }
  }

  return [...byBillId.values()];
}
