// federal_register.js — Federal Register API adapter (no API key required).
//
// Docs: https://www.federalregister.gov/developers/documentation/api/v1
// Strategy: one request per topic query term (topics ordered by weight, highest first),
// scoped to the watchlist's agencies and to documents published since the last run.
// Results are deduped by document_number and capped at sourceConfig.maxItemsPerRun.

import { fetchJSON, isoDateOnly } from "../util.js";

export const id = "federal_register";
export const label = "Federal Register";

const BASE = "https://www.federalregister.gov/api/v1/documents.json";

const DOC_TYPE_MAP = {
  RULE: "rule",
  PRORULE: "proposed-rule",
  NOTICE: "notice",
  PRESDOCU: "notice",
  Rule: "rule",
  "Proposed Rule": "proposed-rule",
  Notice: "notice",
  "Presidential Document": "notice",
};

export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
  const budget = sourceConfig.maxItemsPerRun ?? 40;
  const agencies = sourceConfig.agencies ?? [];
  const since = isoDateOnly(sinceISO);

  // Collect (topic, query term) pairs, highest-weight topics first, so the budget
  // is spent on what the watchlist says matters most.
  const queries = [];
  for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
    for (const term of topic.queries?.[id] ?? []) {
      queries.push({ topic, term });
    }
  }

  const byDocNumber = new Map();
  for (const { topic, term } of queries) {
    if (byDocNumber.size >= budget) break;

    const params = new URLSearchParams();
    params.set("conditions[publication_date][gte]", since);
    params.set("conditions[term]", term);
    for (const agency of agencies) params.append("conditions[agencies][]", agency);
    for (const field of ["document_number", "title", "abstract", "html_url", "publication_date", "type", "comments_close_on", "docket_ids"]) {
      params.append("fields[]", field);
    }
    params.set("per_page", "20");
    params.set("order", "newest");

    const data = await fetchJSON(`${BASE}?${params}`);
    for (const doc of data.results ?? []) {
      if (byDocNumber.size >= budget) break;
      if (byDocNumber.has(doc.document_number)) continue;
      byDocNumber.set(doc.document_number, {
        uid: `${id}:${doc.document_number}`,
        sourceId: id,
        sourceLabel: label,
        title: doc.title ?? "",
        summary: doc.abstract ?? "",
        url: doc.html_url ?? "",
        publishedAt: doc.publication_date ? new Date(doc.publication_date).toISOString() : sinceISO,
        jurisdiction: "US-Federal",
        docType: DOC_TYPE_MAP[doc.type] ?? "notice",
        raw: {
          matchedQuery: term,
          matchedTopicId: topic.id,
          commentsCloseOn: doc.comments_close_on ?? null,
          docketIds: doc.docket_ids ?? [],
        },
      });
    }
  }

  return [...byDocNumber.values()];
}
