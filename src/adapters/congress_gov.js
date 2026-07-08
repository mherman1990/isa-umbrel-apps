// congress_gov.js — Congress.gov API adapter (free key from https://api.congress.gov/sign-up/).
//
// Docs: https://api.congress.gov/
// Strategy: pull recently-updated bills for the current congress (the API's
// full-text search is limited, so we filter client-side — that's fine at this
// volume). Bill titles are short, so we match against the union of each topic's
// query terms AND keywords; the local scoring pass downstream still gates quality.
// Bills whose title or latest action match are kept, up to maxItemsPerRun.

import { fetchJSON } from "../util.js";

export const id = "congress_gov";
export const label = "Congress.gov";

const BASE = "https://api.congress.gov/v3";

// Congresses last two years, starting in odd years: 2025-2026 → 119th.
function currentCongress(date = new Date()) {
  return Math.floor((date.getUTCFullYear() - 1789) / 2) + 1;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Public congress.gov URL slugs by bill type.
const TYPE_SLUGS = {
  hr: "house-bill",
  s: "senate-bill",
  hres: "house-resolution",
  sres: "senate-resolution",
  hjres: "house-joint-resolution",
  sjres: "senate-joint-resolution",
  hconres: "house-concurrent-resolution",
  sconres: "senate-concurrent-resolution",
};

function publicUrl(congress, type, number) {
  const slug = TYPE_SLUGS[type.toLowerCase()] ?? "bill";
  return `https://www.congress.gov/bill/${ordinal(congress)}-congress/${slug}/${number}`;
}

function termRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
  if (!env.CONGRESS_GOV_API_KEY) {
    throw new Error("CONGRESS_GOV_API_KEY is not set in .env (free key: https://api.congress.gov/sign-up/)");
  }
  const budget = sourceConfig.maxItemsPerRun ?? 30;
  const congress = currentCongress();
  const fromDateTime = sinceISO.replace(/\.\d{3}Z$/, "Z"); // API wants YYYY-MM-DDTHH:MM:SSZ

  // Compile (regex, topic) pairs once, highest-weight topics first.
  // Union of query terms + keywords per topic (bill titles are too short for
  // long policy phrases alone).
  const matchers = [];
  for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
    const terms = new Set([...(topic.queries?.[id] ?? []), ...(topic.keywords ?? [])]);
    for (const term of terms) {
      matchers.push({ re: termRegex(term), topic, term });
    }
  }

  // Recently-updated bills, newest first, 250 per page (the API max). A 7-day
  // first-run window can span >1000 bills, so walk a few pages — but never more
  // than MAX_PAGES, and stop early once the item budget is met.
  const MAX_PAGES = 4;
  const items = [];
  for (let page = 0; page < MAX_PAGES && items.length < budget; page++) {
    const url =
      `${BASE}/bill/${congress}` +
      `?fromDateTime=${encodeURIComponent(fromDateTime)}` +
      `&sort=updateDate+desc&limit=250&offset=${page * 250}&format=json` +
      `&api_key=${encodeURIComponent(env.CONGRESS_GOV_API_KEY)}`;
    const data = await fetchJSON(url);
    const bills = data.bills ?? [];

    for (const bill of bills) {
      if (items.length >= budget) break;
      const haystack = `${bill.title ?? ""}\n${bill.latestAction?.text ?? ""}`;
      const hit = matchers.find(({ re }) => re.test(haystack));
      if (!hit) continue;

      const type = (bill.type ?? "").toLowerCase();
      items.push({
        uid: `${id}:${bill.congress}-${type}-${bill.number}`,
        sourceId: id,
        sourceLabel: label,
        title: `${(bill.type ?? "").toUpperCase()} ${bill.number}: ${bill.title ?? ""}`,
        summary: bill.latestAction?.text ?? "",
        url: publicUrl(bill.congress ?? congress, type, bill.number),
        publishedAt: bill.latestAction?.actionDate
          ? new Date(bill.latestAction.actionDate).toISOString()
          : new Date(bill.updateDate ?? Date.now()).toISOString(),
        jurisdiction: "US-Federal",
        docType: "bill",
        raw: {
          matchedQuery: hit.term,
          matchedTopicId: hit.topic.id,
          latestAction: bill.latestAction ?? null,
          congress: bill.congress,
          originChamber: bill.originChamber ?? null,
        },
      });
    }

    if (bills.length < 250) break; // last page of the window
  }

  return items;
}
