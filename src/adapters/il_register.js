// il_register.js — Illinois Register adapter (no key needed).
//
// Mirrors the pattern of iowa_admin_rules.js for the Illinois Secretary of State's weekly
// administrative register. The Illinois Register is published every Friday at ilsos.gov.
//
// Flow: fetch the index page, find the most recent issue link, fetch that issue's HTML,
// parse the rule-filing table, filter by topic keywords. Items are deduplicated downstream.
//
// Key agencies for Illinois soybean policy:
//   IDOA  — Illinois Department of Agriculture (pesticides, grain dealers, weights & measures)
//   IEPA  — Illinois Environmental Protection Agency (WOTUS, nutrient loss, biofuel permits)
//   IDNR  — Illinois Dept of Natural Resources (conservation programs, carbon sequestration)
//   IRRC  — Illinois Commerce Commission (CO2 pipeline, carbon capture routing)
//   IDOT  — Illinois Dept of Transportation (infrastructure, barge/rail access)
//
// Defensive: any parsing failure warns and returns [] — never crashes the run.
// Selectors are isolated in one block so they can be maintained independently of the flow.

import * as cheerio from "cheerio";
import { fetchText } from "../util.js";

export const id = "il_register";
export const label = "Illinois Register";
// State-specific: registered only under a pack whose stateAlpha matches (adapters/index.js).
export const state = "IL";

const SITE = "https://www.ilsos.gov";
const INDEX = `${SITE}/departments/index/register/home.html`;

// Agencies whose filings are tracked even when no topic keyword hits the title.
// These make up the majority of soy-relevant IL rulemaking.
const TRACKED_AGENCIES = [
  "Department of Agriculture",
  "Environmental Protection Agency",
  "Dept of Agriculture",
  "Dept. of Agriculture",
  "Natural Resources",
  "Commerce Commission",
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
    // ── selector logic (isolated — may need maintenance if ilsos.gov redesigns) ──

    // 1. Index page → find the most recent weekly issue link.
    //    The index lists links of the form /publications/register/YYYY/regXXXX.htm
    const indexHtml = await fetchText(INDEX, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; polibrief/1.0)" },
    });

    const issueLinks = [
      ...indexHtml.matchAll(/href="(\/publications\/register\/\d{4}\/reg\w+\.htm)"/gi),
    ].map((m) => m[1]);

    if (!issueLinks.length) {
      // Fallback: try plain links to the register directory
      const fallback = [...indexHtml.matchAll(/href="(\/[^"]*register[^"]*\.htm)"/gi)].map((m) => m[1]);
      if (!fallback.length) throw new Error("no issue links found on the Illinois Register index page");
      issueLinks.push(...fallback);
    }

    // The index lists newest first; take the first one.
    const latestPath = issueLinks[0];
    const issueUrl = new URL(latestPath, SITE).href;

    // 2. Issue HTML → parse the table of rule filings.
    //    The Illinois Register HTML uses tables where each row is one filing.
    //    Columns typically: Part, Section, Agency, Subject, Type
    //    (exact column order may vary — we look for keywords across the full row text)
    const issueHtml = await fetchText(issueUrl, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; polibrief/1.0)" },
    });

    // Extract the issue date from the page title or heading (e.g. "October 4, 2026")
    const $ = cheerio.load(issueHtml);
    const pageTitle = $("title").text().trim() ||
      $("h1, h2").first().text().trim() ||
      "Illinois Register";
    const dateMatch = pageTitle.match(/(\w+ \d{1,2},?\s+\d{4})/);
    const issueDateISO = dateMatch
      ? new Date(dateMatch[1]).toISOString()
      : new Date().toISOString();

    const items = [];

    // Walk every table row looking for filings
    $("table tr").each((_, tr) => {
      if (items.length >= budget) return false;
      const cells = $(tr).find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
      if (cells.length < 2) return; // header or empty row
      const rowText = cells.join(" ");

      // Match against topic keywords or tracked agencies
      const topicHit = matchers.find(({ re }) => re.test(rowText));
      const agencyHit = !topicHit && agencyMatchers.some((re) => re.test(rowText));
      if (!topicHit && !agencyHit) return;

      // Extract a Part/Section reference and filing type from the cells
      // Typical format: [Part] [Section] [Agency] [Subject] [Type (Proposed/Adopted/Emergency)]
      const subject = cells[cells.length > 3 ? cells.length - 2 : cells.length - 1] || rowText.slice(0, 120);
      const agency = cells.length > 2 ? cells[cells.length > 3 ? cells.length - 3 : 1] : "";
      const filingType = cells[cells.length - 1] || "Filing";
      const partRef = cells[0] || "";

      // Find a PDF link in this row
      const pdfHref = $(tr).find('a[href$=".pdf"], a[href$=".PDF"]').attr("href");
      const url = pdfHref ? new URL(pdfHref, SITE).href : issueUrl;

      // Build a stable UID from the issue URL + part reference
      const uidBase = `${latestPath}:${partRef.replace(/\s+/g, "-")}:${subject.slice(0, 40).replace(/\s+/g, "-")}`;
      items.push({
        uid: `${id}:${uidBase}`,
        sourceId: id,
        sourceLabel: label,
        title: `${filingType} — ${subject.slice(0, 120)}${agency ? ` (${agency.slice(0, 60)})` : ""}`,
        summary: "",
        url,
        publishedAt: issueDateISO,
        jurisdiction: "IL",
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

    // ── end selector logic ──────────────────────────────────────────────────────

    return items;
  } catch (err) {
    // Never crash the run over an ilsos.gov markup change — warn and contribute nothing.
    console.log(`⚠️  ${label}: could not parse the register (${err.message}) — returning no items`);
    return [];
  }
}
