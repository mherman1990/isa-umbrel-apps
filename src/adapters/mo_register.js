// mo_register.js — Missouri Register adapter (no key needed).
//
// Follows the pattern of mn_register.js / il_register.js for the MO
// administrative register. Published bi-weekly at sos.mo.gov/adrules/moreg.
//
// Key agencies for MO soybean policy: Agriculture, Natural Resources, Conservation, Economic Development
//
// Defensive: any parsing failure warns and returns [] — never crashes the run.
// Selectors are isolated so they can be tuned without touching the flow.

import * as cheerio from "cheerio";
import { fetchText } from "../util.js";

export const id = "mo_register";
export const label = "Missouri Register";
export const state = "MO";

const SITE = "https://www.sos.mo.gov";
const INDEX = "https://www.sos.mo.gov/adrules/moreg/moreg.htm";

const TRACKED_AGENCIES = ["Agriculture", "Natural Resources", "Conservation", "Economic Development"];

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
    const indexHtml = await fetchText(INDEX, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; polibrief/1.0)" },
    });

    const $ = cheerio.load(indexHtml);
    const issueLinks = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (href.includes("/adrules/moreg/") || /register/i.test($(el).text())) {
        const full = href.startsWith("http") ? href : new URL(href, SITE).href;
        if (!issueLinks.includes(full)) issueLinks.push(full);
      }
    });

    if (!issueLinks.length) throw new Error("no issue links found on the MO register index page");

    const issueUrl = issueLinks[0];
    const issueHtml = await fetchText(issueUrl, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; polibrief/1.0)" },
    });

    const $i = cheerio.load(issueHtml);
    const pageTitle = $i("title").text().trim() || $i("h1").first().text().trim() || "Missouri Register";
    const dateMatch = pageTitle.match(/(\w+ \d{1,2},?\s+\d{4})/);
    const issueDateISO = dateMatch ? new Date(dateMatch[1]).toISOString() : new Date().toISOString();

    const items = [];

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

      const pdfHref = $i(tr).find("a[href$=\".pdf\"], a[href$=\".PDF\"]").attr("href");
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
        jurisdiction: "MO",
        docType: "admin-rule",
        raw: {
          matchedQuery: topicHit?.term ?? null,
          matchedTopicId: topicHit?.topic.id ?? null,
          matchedAgency: agencyHit ? agency : null,
          filingType, agency, partRef, issueUrl,
        },
      });
    });

    return items;
  } catch (err) {
    console.log(`\u26A0\uFE0F  Missouri Register: could not parse the register (${err.message}) — returning no items`);
    return [];
  }
}
