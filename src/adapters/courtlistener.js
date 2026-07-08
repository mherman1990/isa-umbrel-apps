// courtlistener.js — federal litigation watch via CourtListener/RECAP (free, no key).
//
// Docs: https://www.courtlistener.com/help/api/rest/
// Watches federal court docket activity for topics with explicit `courtlistener`
// query terms in watchlist.json (e.g. glyphosate/FIFRA preemption cases, WOTUS).
// Only topics that opt in with queries are searched — litigation is noisy, so
// there is deliberately NO keyword fallback here.
//
// Optional: set COURTLISTENER_API_TOKEN in .env for higher rate limits
// (anonymous works fine at polibrief's volume).

import { fetchJSON, isoDateOnly } from "../util.js";

export const id = "courtlistener";
export const label = "CourtListener (litigation)";

const BASE = "https://www.courtlistener.com/api/rest/v4/search/";

export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
  const budget = sourceConfig.maxItemsPerRun ?? 10;
  const sinceDate = isoDateOnly(sinceISO);

  const queries = [];
  for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
    for (const term of topic.queries?.[id] ?? []) queries.push({ topic, term });
  }
  if (queries.length === 0) return []; // no topic opted in

  const headers = { "user-agent": "polibrief/1.1 (policy monitoring)" };
  if (env.COURTLISTENER_API_TOKEN) headers.authorization = `Token ${env.COURTLISTENER_API_TOKEN}`;

  const byKey = new Map();
  for (const { topic, term } of queries) {
    if (byKey.size >= budget) break;

    // type=r searches RECAP (federal docket filings); newest filings first.
    // Multi-word terms MUST be quoted or the engine matches individual words
    // ("waters of the United States" would match anything saying "United States").
    const q = term.includes(" ") && !term.startsWith('"') ? `"${term}"` : term;
    const params = new URLSearchParams({
      q,
      type: "r",
      order_by: "entry_date_filed desc",
    });
    const data = await fetchJSON(`${BASE}?${params}`, { headers });

    for (const hit of data.results ?? []) {
      if (byKey.size >= budget) break;
      // Latest filing date on this docket in the result window.
      const entryDates = (hit.recap_documents ?? [])
        .map((d) => d.entry_date_filed)
        .filter(Boolean)
        .sort()
        .reverse();
      const latest = entryDates[0] ?? hit.dateFiled ?? null;
      if (!latest || latest < sinceDate) continue; // only new activity

      const docketKey = hit.docket_id ?? `${hit.court_id}-${hit.docketNumber}`;
      if (byKey.has(docketKey)) continue; // one row per docket per run
      const key = docketKey;

      const latestDoc = (hit.recap_documents ?? []).find((d) => d.entry_date_filed === latest);
      byKey.set(key, {
        // latest filing date in the uid ⇒ the docket resurfaces on new activity
        uid: `${id}:${docketKey}:${latest}`,
        sourceId: id,
        sourceLabel: label,
        title: `${hit.caseName ?? "Unnamed case"} (${hit.court ?? "federal court"})`,
        summary: latestDoc?.description ?? latestDoc?.short_description ?? "",
        url: hit.absolute_url ? `https://www.courtlistener.com${hit.absolute_url}` : "https://www.courtlistener.com",
        publishedAt: new Date(latest).toISOString(),
        jurisdiction: "US-Courts",
        docType: "litigation",
        raw: {
          matchedQuery: term,
          matchedTopicId: topic.id,
          docketNumber: hit.docketNumber ?? null,
          court: hit.court ?? null,
          latestFiling: latest,
        },
      });
    }
  }

  return [...byKey.values()];
}
