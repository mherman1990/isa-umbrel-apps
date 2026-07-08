// iowa_admin_rules.js — Iowa Administrative Bulletin adapter (no key needed).
//
// Proof-of-concept for the aspirational state-admin-rules goal. No unified API
// exists for state administrative rules; other states would each need their own
// adapter like this one.
//
// Flow: read the bulletin index at legis.iowa.gov, find the most recent bulletin's
// HTML rule-making listing (ruleMaking?pubDate=MM-DD-YYYY), and parse its table of
// rule filings (Notices of Intended Action, Adopted rules, Regulatory Analyses...).
// Items are filtered against topic keywords. Already-seen filings are deduped
// downstream, which is what makes re-reading the same bulletin incremental.
//
// If parsing fails for any reason, this adapter warns and returns [] — it never
// crashes the run. The selector logic is isolated below since legis.iowa.gov may
// change its markup someday.

import * as cheerio from "cheerio";
import { fetchText } from "../util.js";

export const id = "iowa_admin_rules";
export const label = "Iowa Admin Rules";

const SITE = "https://www.legis.iowa.gov";
const INDEX = `${SITE}/law/administrativeRules/bulletinSupplementListings`;

function termRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

export async function fetchItems({ sinceISO, topics, sourceConfig }) {
  const budget = sourceConfig.maxItemsPerRun ?? 15;

  const matchers = [];
  for (const topic of [...topics].sort((a, b) => b.weight - a.weight)) {
    for (const term of topic.keywords ?? []) {
      matchers.push({ re: termRegex(term), topic, term });
    }
  }

  try {
    // ---- selector logic (isolated on purpose; may need maintenance) ----------
    // 1. Bulletin index → most recent ruleMaking?pubDate=MM-DD-YYYY link.
    const indexHtml = await fetchText(INDEX, { headers: { "user-agent": "Mozilla/5.0 polibrief/1.0" } });
    const pubDates = [...indexHtml.matchAll(/ruleMaking\?pubDate=(\d{2}-\d{2}-\d{4})/g)].map((m) => m[1]);
    if (pubDates.length === 0) throw new Error("no bulletin links found on the index page");
    // Index lists newest first; sort defensively anyway (MM-DD-YYYY → YYYYMMDD).
    const latest = pubDates.sort((a, b) => {
      const key = (s) => s.slice(6) + s.slice(0, 2) + s.slice(3, 5);
      return key(b).localeCompare(key(a));
    })[0];
    const [mm, dd, yyyy] = latest.split("-");
    const bulletinDateISO = new Date(Date.UTC(+yyyy, +mm - 1, +dd)).toISOString();

    // 2. Rule-making listing → table #iacList with columns:
    //    [RA or ARC number, Agency, Type, Title, PDF, RTF, Minutes, Fiscal]
    const listingUrl = `${SITE}/law/administrativeRules/ruleMaking?pubDate=${latest}`;
    const $ = cheerio.load(await fetchText(listingUrl, { headers: { "user-agent": "Mozilla/5.0 polibrief/1.0" } }));

    const items = [];
    $("#iacList tbody tr").each((_, tr) => {
      if (items.length >= budget) return false;
      const cells = $(tr).find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
      const [filingId, agency, filingType, title] = cells;
      if (!filingId || !title) return;

      const haystack = `${agency ?? ""}\n${title}`;
      const hit = matchers.find(({ re }) => re.test(haystack));
      if (!hit) return;

      const pdfHref = $(tr).find('a[href$=".pdf"]').attr("href");
      items.push({
        uid: `${id}:${filingId.replace(/\s+/g, "-")}`,
        sourceId: id,
        sourceLabel: label,
        title: `${filingType ?? "Filing"} ${filingId}: ${title} (${(agency ?? "").replace(/\[\d+\]$/, "").trim()})`,
        summary: "",
        url: pdfHref ? new URL(pdfHref, SITE).href : listingUrl,
        publishedAt: bulletinDateISO,
        jurisdiction: "IA",
        docType: "admin-rule",
        raw: { matchedQuery: hit.term, matchedTopicId: hit.topic.id, filingType, agency, bulletinDate: latest },
      });
    });
    // ---------------------------------------------------------------------------

    return items;
  } catch (err) {
    // Never crash the run over a state-website change — warn and contribute nothing.
    console.log(`⚠️  ${label}: could not parse the bulletin (${err.message}) — returning no items`);
    return [];
  }
}
