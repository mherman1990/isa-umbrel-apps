// mn_register.js — Minnesota State Register adapter (no key needed).
//
// Mirrors the pattern of il_register.js for the Minnesota Secretary of State's
// weekly administrative register. The MN State Register is published every Tuesday
// at revisor.mn.gov/rules/register/.
//
// Key agencies for Minnesota soybean policy:
//   MDA   — Minnesota Dept of Agriculture (pesticides, grain dealers, weights & measures)
//   MPCA  — Minnesota Pollution Control Agency (WOTUS, nutrient loss, biofuel permits)
//   DNR   — Dept of Natural Resources (conservation programs, carbon sequestration)
//   MnDOT — Dept of Transportation (rural infrastructure, barge/rail access)
//   DEED  — Dept of Employment and Economic Development (rural enterprise zones)
//
// Defensive: any parsing failure warns and returns [] — never crashes the run.

import * as cheerio from "cheerio";
import { fetchText } from "../util.js";

export const id = "mn_register";
export const label = "Minnesota State Register";
export const state = "MN";

const SITE = "https://www.revisor.mn.gov";
const INDEX = `${SITE}/rules/register/`;

const TRACKED_AGENCIES = [
  "Agriculture",
  "Pollution Control",
  "Natural Resources",
  "Transportation",
  "Board of Water",
  "Dept. of Commerce",
  "Economic Development",
];

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
  const agencyMatchers = TRACKED_AGENCIES.map((a) => new RegExp(a, "i"));

  try {
    // 1. Fetch the register index to find the most recent issue link.
    //    revisor.mn.gov lists issues as links with text like "September 24, 2026 (Vol. 51, No. 13)"
    const indexHtml = await fetchText(INDEX, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; polibrief/1.0)" },
    });

    const $ = cheerio.load(indexHtml);

    // Find links to individual issue pages — they typically go to /rules/register/YYYY/YYYYMMDD/
    const issueLinks = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text();
      // Match links that look like a register issue (date-based path or "State Register" label)
      if (href && (/\/rules\/register\/\d{4}\//.test(href) || /state register/i.test(text))) {
        const full = href.startsWith("http") ? href : new URL(href, SITE).href;
        if (!issueLinks.includes(full)) issueLinks.push(full);
      }
    });

    if (!issueLinks.length) {
      // Fallback: look for any link containing register dates
      $("a").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        if (/\/\d{8}\//.test(href) || /register.*\d{4}/i.test($(el).text())) {
          const full = href.startsWith("http") ? href : new URL(href, SITE).href;
          if (!issueLinks.includes(full)) issueLinks.push(full);
        }
      });
    }

    if (!issueLinks.length) {
      throw new Error("no issue links found on the MN State Register index page");
    }

    const issueUrl = issueLinks[0];

    // 2. Fetch the most recent issue and parse rule filings.
    const issueHtml = await fetchText(issueUrl, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; polibrief/1.0)" },
    });

    const $i = cheerio.load(issueHtml);
    const pageTitle = $i("title").text().trim() || $i("h1").first().text().trim() || "MN State Register";
    const dateMatch = pageTitle.match(/(\w+ \d{1,2},?\s+\d{4})/);
    const issueDateISO = dateMatch ? new Date(dateMatch[1]).toISOString() : new Date().toISOString();

    const items = [];

    // Walk table rows (MN Register HTML uses tables similar to IL Register)
    $i("table tr").each((_, tr) => {
      if (items.length >= budget) return false;
      const cells = $i(tr).find("td").map((_, td) => $i(td).text().replace(/\s+/g, " ").trim()).get();
      if (cells.length < 2) return;
      const rowText = cells.join(" ");

      const topicHit = matchers.find(({ re }) => re.test(rowText));
      const agencyHit = !topicHit && agencyMatchers.some((re) => re.test(rowText));
      if (!topicHit && !agencyHit) return;

      const subject = cells[cells.length > 3 ? cells.length - 2 : cells.length - 1] || rowText.slice(0, 120);
      const agency = cells.length > 2 ? cells[cells.length > 3 ? cells.length - 3 : 1] : "";
      const filingType = cells[cells.length - 1] || "Filing";
      const partRef = cells[0] || "";

      const pdfHref = $i(tr).find('a[href$=".pdf"], a[href$=".PDF"]').attr("href");
      const url = pdfHref ? new URL(pdfHref, SITE).href : issueUrl;

      const uidBase = `${issueUrl}:${partRef.replace(/\s+/g, "-")}:${subject.slice(0, 40).replace(/\s+/g, "-")}`;
      items.push({
        uid: `${id}:${uidBase}`,
        sourceId: id,
        sourceLabel: label,
        title: `${filingType} — ${subject.slice(0, 120)}${agency ? ` (${agency.slice(0, 60)})` : ""}`,
        summary: "",
        url,
        publishedAt: issueDateISO,
        jurisdiction: "MN",
        docType: "admin-rule",
        raw: {
          matchedQuery: topicHit?.term ?? null,
          matchedTopicId: topicHit?.topic.id ?? null,
          matchedAgency: agencyHit ? agency : null,
          filingType,
          agency,
          partRef,
          issueUrl,
        },
      });
    });

    return items;
  } catch (err) {
    console.log(`⚠️  ${label}: could not parse the register (${err.message}) — returning no items`);
    return [];
  }
}
