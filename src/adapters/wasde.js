// wasde.js — USDA WASDE (World Agricultural Supply & Demand Estimates) balance sheet.
//
// WASDE is THE monthly supply/demand number the whole market hangs on. We pull the U.S.
// soybean balance sheet — Ending Stocks and Total Use → STOCKS-TO-USE, the tightness ratio —
// plus world ending stocks. Because each monthly WASDE re-estimates the SAME marketing year,
// storing one point per release builds a "revision trail": "USDA keeps cutting carryout" is
// itself a signal.
//
// Source: USDA ESMIS machine-readable release (the old Cornell/Mann-Library feed moved to the
// National Ag Library — the cornell URL 301-redirects here). No key. "markets"-class.
//   API:   https://esmis.nal.usda.gov/api/v1/release/findByIdentifier/wasde?latest=true
//   file:  .../sites/default/release-files/<id>/wasde<MMYY>v<N>.xml
//
// The XML nests commodity → geography (matrix2 = "United States") → market year → attribute
// (Ending Stocks / Total Use) → <Cell cell_value2>. We walk it defensively rather than hard-
// coding the path, so a layout tweak doesn't silently break extraction.

import { XMLParser } from "fast-xml-parser";
import { fetchJSON, fetchText } from "../util.js";

export const id = "wasde";
export const label = "USDA WASDE (balance sheet)";

const API = "https://esmis.nal.usda.gov/api/v1/release/findByIdentifier/wasde?latest=true";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", textNodeName: "_t" });

// Newest-first list of recent releases as { xml, date }. The ESMIS API returns
// `results[]`, each with a plain-string `files[]` and `release_datetime` — so the
// revision trail (how each month's estimate changed) is backfillable for free.
async function listReleases(limit = 6) {
  const rel = await fetchJSON(API);
  const results = rel.results || (Array.isArray(rel) ? rel : []);
  const out = [];
  for (const r of results) {
    const files = r.files || [];
    const xml = files.find((u) => /\.xml($|\?)/i.test(String(u)));
    if (xml) out.push({ xml, date: r.release_datetime || r.date || null });
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error("WASDE: no .xml file URL in the ESMIS release list");
  return out;
}

// The soybean balance-sheet attributes we key on. Note the ACTUAL WASDE labels: total use is
// written "Use, Total" (not "Total Use"), and ending stocks appears as "Ending Stocks"/"Ending stocks".
const END_STOCKS_RE = /ending\s*stocks/i;
const USE_TOTAL_RE = /use,?\s*total|total\s*(use|disappearance)/i;

// WASDE ships as SSRS "matrix" XML: <Report Name="wasde"> → sub-reports <srNN> (one per table,
// keyed by `sub_report_title`) → one or more <matrixK> pivot tables. The U.S. soybean balance sheet
// lives in the "U.S. Soybeans and Products" sub-report as THREE sibling matrices — Soybeans /
// Soybean Oil / Soybean Meal — distinguished ONLY POSITIONALLY: there is no commodity field; each
// matrix's cells simply carry a numbered suffix (e.g. attribute4 / market_year4 / cell_value4 for
// the first matrix, …5 for the second, …6 for the third). Values nest attribute → year → forecast-
// month → <Cell cell_valueN>.
//
// So we collect every numeric cell into a group keyed by (sub-report title + matrix suffix), building
// each group's { marketingYear -> { attribute -> value } } table. Matrix-agnostic — the suffix
// numbers can shift release-to-release without breaking us, since we group by whatever suffix is
// present rather than hard-coding 1/2/3.
function collectGroups(root, sectionRe) {
  // World-table labels embed the PDF's line breaks as literal entities ("Ending&#xD;&#xA;Stocks"),
  // which fast-xml-parser leaves un-decoded in attribute values — decode CR/LF/tab refs to a space
  // so attribute names normalize to "Ending Stocks" and our attribute regexes match.
  const norm = (s) => String(s ?? "").replace(/&#x0*(?:d|a|9);/gi, " ").replace(/&#0*(?:13|10|9);/g, " ").replace(/\s+/g, " ").trim();
  const groups = new Map(); // "section||suffix" -> { section, attrs:Set<string>, table:{year:{attr:num}} }
  function walk(node, ctx) {
    if (node == null || typeof node !== "object") return;
    const c = { ...ctx };
    for (const [k, v] of Object.entries(node)) {
      if (v != null && typeof v === "object") continue; // scalars (attributes) only
      let m;
      if (/^sub_report_title\d*$/i.test(k)) c.section = norm(v);
      else if ((m = k.match(/^region_header(\d*)$/i))) { c.year = norm(v); if (m[1]) c.suffix = m[1]; } // world tables: the year is the matrix header
      else if ((m = k.match(/^region(\d*)$/i))) { c.region = norm(v); if (m[1]) c.suffix = m[1]; } // world tables: rows are regions
      else if ((m = k.match(/^attribute(\d*)$/i))) { c.attribute = norm(v); c.suffix = m[1] || c.suffix || ""; }
      else if ((m = k.match(/^market_year(\d*)$/i))) { c.year = norm(v); if (m[1]) c.suffix = m[1]; } // U.S. tables: the year is on the row
      else if ((m = k.match(/^cell_value(\d*)$/i))) { c.value = v; if (m[1]) c.suffix = m[1]; }
    }
    if (c.value != null && c.attribute && c.year && c.section && sectionRe.test(c.section)) {
      const num = Number(String(c.value).replace(/,/g, ""));
      if (Number.isFinite(num)) {
        const key = `${c.section}||${c.suffix || ""}||${c.region || ""}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { section: c.section, region: c.region || "", attrs: new Set(), table: {} }));
        g.attrs.add(c.attribute);
        (g.table[c.year] = g.table[c.year] || {})[c.attribute] = num; // later forecast-month wins
      }
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((x) => walk(x, c));
      else if (v && typeof v === "object") walk(v, c);
    }
  }
  walk(root, {});
  return [...groups.values()];
}

// Pick the soybean balance table out of a section and return { marketingYear -> {attr->num} }.
// Two very different WASDE layouts:
//   • World Soybean table — rows are REGIONS; we take the "World" aggregate row, merging its
//     per-year matrices into one table.
//   • U.S. "Soybeans and Products" table — three commodity matrices (Soybeans / Oil / Meal); the
//     soybean matrix is the ONLY one with acreage rows (Area Planted/Harvested/Yield) and a farm
//     price in $/bu (meal is $/short ton, oil is ¢/lb, neither has acreage). That isolates beans.
function extractBalance(root, sectionRe) {
  const groups = collectGroups(root, sectionRe);
  if (!groups.length) return {};
  const regionName = (r) => String(r ?? "").replace(/\s+/g, " ").replace(/\s*\d+\/?\s*$/, "").trim(); // "World  2/" -> "World"
  const worldGroups = groups.filter((g) => regionName(g.region) === "World");
  if (worldGroups.length) {
    const out = {};
    for (const g of worldGroups) for (const [yr, row] of Object.entries(g.table)) out[yr] = { ...(out[yr] || {}), ...row };
    return out;
  }
  const isBean = (g) => [...g.attrs].some((a) => /area\s*(planted|harvested)|yield\s*per|\$\s*\/\s*bu/i.test(a));
  const beans = groups.filter(isBean);
  const chosen = beans[0] || [...groups].sort((a, b) => b.attrs.size - a.attrs.size)[0];
  return chosen.table;
}

// Pick the marketing year to report: prefer the projection ("(Proj.)"), else the latest.
function pickYear(balance) {
  const years = Object.keys(balance);
  if (!years.length) return null;
  const proj = years.find((y) => /proj/i.test(y));
  if (proj) return proj;
  return years.sort().at(-1);
}
function attr(balance, year, re) {
  const row = balance[year] || {};
  const k = Object.keys(row).find((a) => re.test(a));
  return k ? row[k] : null;
}

async function loadRelease({ xml, date }) {
  const raw = await fetchText(xml);
  const doc = parser.parse(raw);
  const us = extractBalance(doc, /U\.?\s*S\.?\s*Soybeans/i);
  const world = extractBalance(doc, /World\s*Soybean\s*Supply/i);
  const period = date ? String(date).slice(0, 7) : new Date().toISOString().slice(0, 7);
  return { us, world, period, xml };
}

/** WASDE items → a summary of the current U.S. soybean balance sheet (markets-class). */
export async function fetchItems() {
  const [rel] = await listReleases(1);
  const { us, world, period, xml } = await loadRelease(rel);
  const y = pickYear(us);
  if (!y) return [];
  const end = attr(us, y, END_STOCKS_RE);
  const use = attr(us, y, USE_TOTAL_RE);
  const stu = end != null && use ? (end / use) * 100 : null;
  const wend = attr(world, pickYear(world) || y, END_STOCKS_RE);
  const bits = [
    end != null ? `ending stocks ${end} mln bu` : null,
    stu != null ? `stocks-to-use ${stu.toFixed(1)}%` : null,
    wend != null ? `world stocks ${wend} MMT` : null,
  ].filter(Boolean).join(" · ");
  return [{
    uid: `wasde:us:soy:${period}`,
    sourceId: id,
    sourceLabel: label,
    title: `WASDE ${y} U.S. soybeans — ${bits || "balance sheet updated"}`,
    summary: `USDA WASDE ${period}: U.S. soybean supply/demand balance for ${y}. Stocks-to-use is the tightness ratio behind price.`,
    url: xml,
    publishedAt: new Date(`${period}-15`).toISOString(),
    jurisdiction: "US",
    docType: "data",
    raw: { marketingYear: y, endingStocks: end, totalUse: use, stocksToUse: stu, worldEndingStocks: wend },
  }];
}

/**
 * Series for the Markets charts: the revision trail — one point per monthly release, showing
 * USDA's latest projection at each point (backfilled over recent releases). Idempotent upsert,
 * so re-parsing is harmless. NOTE phase-1: plots the current projection per release; the target
 * marketing year rolls at the May new-crop WASDE (a fixed-year trail is a phase-2 refinement).
 */
export async function fetchSeries() {
  const releases = await listReleases(8);
  const loaded = (await Promise.allSettled(releases.map(loadRelease)))
    .filter((r) => r.status === "fulfilled").map((r) => r.value);
  const endPts = [], stuPts = [];
  for (const { us, period } of loaded) {
    const y = pickYear(us);
    if (!y) continue;
    const end = attr(us, y, END_STOCKS_RE);
    const use = attr(us, y, USE_TOTAL_RE);
    if (end != null) endPts.push({ period, value: end });
    if (end != null && use) stuPts.push({ period, value: (end / use) * 100 });
  }
  const out = [];
  // U.S. ending stocks (mln bu) + stocks-to-use (%). World stocks are in MMT, so we keep them out of
  // these charts (no mixed-unit axis) — they ride along in the WASDE item summary instead.
  if (endPts.length) out.push({ series: "wasde:us:soy-endstocks", meta: { label: "U.S. soybean ending stocks", unit: "mln bu", category: "soy_balance" }, points: endPts });
  if (stuPts.length) out.push({ series: "wasde:us:soy-stocks-to-use", meta: { label: "U.S. soybean stocks-to-use", unit: "%", category: "soy_balance_stu" }, points: stuPts });
  return out;
}
