// eurlex_oj.js — EUR-Lex Official Journal (L series = legislation) adapter. No key needed.
//
// NOTE ON APPROACH: the spec originally called for EUR-Lex's OJ RSS feeds, but those
// now require account-tied saved-search IDs (the anonymous feed endpoints return empty
// shells). v1 therefore parses the public OJ "daily view" pages, which have a stable
// URL pattern:
//
//   https://eur-lex.europa.eu/oj/daily-view/L-series/default.html?ojDate=DDMMYYYY
//
// One page per day in the incremental window (max 7). Each published act appears as a
// link "legal-content/EN/TXT/?uri=OJ:L_<number>". Items are filtered against the union
// of all topics' eurlex_oj query terms + keywords (case-insensitive).
//
// Upgrade path: EUR-Lex SOAP webservice or CELLAR SPARQL for structured search.
// If the page markup changes, this adapter warns and returns [] — it never crashes a run.

import * as cheerio from "cheerio";
import { fetchText } from "../util.js";

export const id = "eurlex_oj";
export const label = "EUR-Lex OJ (EU law)";

const DAILY_VIEW = "https://eur-lex.europa.eu/oj/daily-view/L-series/default.html";

function termRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

function ddmmyyyy(date) {
  const d = String(date.getUTCDate()).padStart(2, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${d}${m}${date.getUTCFullYear()}`;
}

export async function fetchItems({ sinceISO, topics, sourceConfig }) {
  const budget = sourceConfig.maxItemsPerRun ?? 25;

  // Union of every topic's eurlex_oj query terms + keywords, tagged with the topic.
  const matchers = [];
  for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
    const terms = new Set([...(topic.queries?.[id] ?? []), ...(topic.keywords ?? [])]);
    for (const term of terms) matchers.push({ re: termRegex(term), topic, term });
  }

  // Walk each day from the window start through today (bounded at 7 pages).
  const days = [];
  const start = new Date(sinceISO);
  const today = new Date();
  for (let d = new Date(start); d <= today && days.length < 7; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(new Date(d));
  }

  const byOjNumber = new Map();
  for (const day of days) {
    if (byOjNumber.size >= budget) break;
    let html;
    try {
      html = await fetchText(`${DAILY_VIEW}?ojDate=${ddmmyyyy(day)}`, {
        headers: { "user-agent": "Mozilla/5.0 polibrief/1.0" },
      });
    } catch (err) {
      // A single missing day (weekend, holiday, hiccup) shouldn't kill the source.
      continue;
    }

    const $ = cheerio.load(html);
    // ---- selector logic (isolated on purpose — this is the part that may need
    // maintenance if EUR-Lex changes its markup) -------------------------------
    $('a[href*="uri=OJ:L_"]').each((_, el) => {
      if (byOjNumber.size >= budget) return false;
      const href = $(el).attr("href") ?? "";
      const ojNumber = (href.match(/uri=(OJ:L_[0-9A-Za-z]+)/) ?? [])[1];
      if (!ojNumber || byOjNumber.has(ojNumber)) return;

      // The act title is usually the anchor's own text; some anchors are just
      // format buttons ("HTML", "PDF"), in which case use the enclosing row text.
      let title = $(el).text().replace(/\s+/g, " ").trim();
      if (title.length < 20) {
        title = $(el).closest("div, li, tr").text().replace(/\s+/g, " ").trim().slice(0, 300);
      }
      if (title.length < 20) return; // still nothing useful — skip

      const hit = matchers.find(({ re }) => re.test(title));
      if (!hit) return;

      // CELEX numbers aren't on this page; the OJ number is the stable native id.
      byOjNumber.set(ojNumber, {
        uid: `${id}:${ojNumber}`,
        sourceId: id,
        sourceLabel: label,
        title,
        summary: "",
        url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=${encodeURIComponent(ojNumber)}`,
        publishedAt: day.toISOString(),
        jurisdiction: "EU",
        docType: "regulation",
        raw: { matchedQuery: hit.term, matchedTopicId: hit.topic.id, ojNumber },
      });
    });
    // --------------------------------------------------------------------------
  }

  return [...byOjNumber.values()];
}
