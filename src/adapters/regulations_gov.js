// regulations_gov.js — Regulations.gov v4 API adapter (uses the same free
// api.data.gov key as Congress.gov; set REGULATIONS_GOV_API_KEY to override).
//
// Docs: https://open.gsa.gov/api/regulationsgov/
// Why this source when we already watch the Federal Register: Regulations.gov
// carries the DOCKET side of rulemaking — comment opportunities, docket
// supporting material, and comment deadlines — and often surfaces documents
// sooner. Some overlap with federal_register items is expected; Haiku triage
// and the brief synthesis handle duplicates gracefully.
//
// Topic queries: uses topic.queries.regulations_gov when present, otherwise
// falls back to topic.queries.federal_register — so existing watchlists get
// coverage with zero edits.

import { fetchJSON, isoDateOnly } from "../util.js";

export const id = "regulations_gov";
export const label = "Regulations.gov";

const BASE = "https://api.regulations.gov/v4/documents";

// Keep substantive document types; skip supporting attachments and misc noise.
const DOC_TYPE_MAP = {
  Rule: "rule",
  "Proposed Rule": "proposed-rule",
  Notice: "notice",
};

export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
  const apiKey = env.REGULATIONS_GOV_API_KEY || env.CONGRESS_GOV_API_KEY;
  if (!apiKey) {
    throw new Error("REGULATIONS_GOV_API_KEY / CONGRESS_GOV_API_KEY is not set in .env (free key: https://api.data.gov/signup/)");
  }
  const budget = sourceConfig.maxItemsPerRun ?? 20;
  const since = isoDateOnly(sinceISO);

  const queries = [];
  for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
    const terms = topic.queries?.[id] ?? topic.queries?.federal_register ?? [];
    for (const term of terms) queries.push({ topic, term });
  }

  const byId = new Map();
  for (const { topic, term } of queries) {
    if (byId.size >= budget) break;

    const params = new URLSearchParams();
    params.set("filter[searchTerm]", term);
    params.set("filter[postedDate][ge]", since);
    params.set("sort", "-postedDate");
    params.set("page[size]", "20");
    params.set("api_key", apiKey);

    const data = await fetchJSON(`${BASE}?${params}`);
    for (const doc of data.data ?? []) {
      if (byId.size >= budget) break;
      if (byId.has(doc.id)) continue;
      const a = doc.attributes ?? {};
      const docType = DOC_TYPE_MAP[a.documentType];
      if (!docType) continue; // skip supporting material / misc

      byId.set(doc.id, {
        uid: `${id}:${doc.id}`,
        sourceId: id,
        sourceLabel: label,
        title: a.title ?? doc.id,
        summary: "",
        url: `https://www.regulations.gov/document/${encodeURIComponent(doc.id)}`,
        publishedAt: a.postedDate ? new Date(a.postedDate).toISOString() : sinceISO,
        jurisdiction: "US-Federal",
        docType,
        raw: {
          matchedQuery: term,
          matchedTopicId: topic.id,
          commentsCloseOn: a.commentEndDate ? a.commentEndDate.slice(0, 10) : null,
          docketId: a.docketId ?? null,
          agencyId: a.agencyId ?? null,
          openForComment: a.openForComment ?? null,
        },
      });
    }
  }

  return [...byId.values()];
}
