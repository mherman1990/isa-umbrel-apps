// enrich.js — give the pipeline the DOCUMENT, not just its title.
//
// THE PROBLEM THIS FIXES. Three official adapters shipped with a hard-coded `summary: ""` —
// `regulations_gov` (line 67), `iowa_admin_rules` (77) and `eurlex_oj` (93). `summary` is the field
// that becomes `seen_items.body`, and it is the ONLY document text anything downstream ever sees:
// score.js scores `title + summary`, triage.js sends `summary.slice(0, 600)`, and compactItems
// (pipeline.js) projects rows to title + one_line for every prompt. So for the comment-docket
// stream — the single most actionable source an advocacy organisation has, because it is where ISA
// would actually file — every judgement in the system was made from a headline.
//
// What that cost, measured on the stored feed: nine "relevant" rows all titled "Pesticide Product
// Registration: Applications for New Uses (April 2026)", each with a differently-worded Haiku
// one-liner restating the title, and no way for a reader to learn which pesticide any of them was
// about. The substance existed the whole time — the Federal Register notice behind them carries a
// 740-character abstract and 9,200 characters of full text.
//
// HOW. One extra HTTP call per Regulations.gov item resolves its detail record, which yields both
// the document text AND `frDocNum`, the Federal Register document number. That number is the exact
// dedup key eventkey.js needs, so grounding and deduplication fall out of the same request — and
// because copies share it, the FR lookups collapse (the nine documents above need three).
//
// Runs AFTER collect and BEFORE score, deliberately: the abstract then counts toward the local
// keyword score, so a docket whose title is generic but whose abstract says "soybean" can finally
// clear the filter it used to fail. No model is involved and nothing here costs Anthropic tokens.
//
// Fail-soft to the letter: every call is individually caught, a failure leaves the item exactly as
// the adapter produced it, and the whole pass is budget-capped so a bad day can't stall a run.

import { fetchJSON, mapPool } from "./util.js";

/** Sources whose adapter cannot supply document text on its own. */
const THIN_SOURCES = new Set(["regulations_gov"]);

const POOL = 4; // polite against api.data.gov; ≤35 official items/run means this is never the bottleneck
const DEFAULT_BUDGET = 40; // hard cap on enrichment fetches per run
const FR_DOC = "https://www.federalregister.gov/api/v1/documents";
const RG_DOC = "https://api.regulations.gov/v4/documents";

/** Collapse whitespace and trim; "" for anything empty. */
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// A Federal Register document number: a year, a hyphen, and a sequence number ("2026-13552").
// Validated rather than trusted, because Regulations.gov records are not uniformly populated — see
// frDocNumOf below.
const FR_DOCNUM = /\b((?:19|20)\d{2}-\d{3,6})\b/;

/**
 * Recover the Federal Register document number from a Regulations.gov detail record.
 *
 * MEASURED SOURCE DEFECT, not defensive padding. Sampling 11 live EPA records on 2026-07-30: 4
 * carried a canonical number in `frDocNum`, 5 carried nothing at all, and 2 had the citation fields
 * shifted by one position —
 *   frDocNum:     "46594 - 46594"                                    ← a page RANGE
 *   frVolNum:     "46594 Federal Register / Vol. 90, No. 186 / …"     ← a page plus a citation string
 *   startEndPage: "2025-18840"                                       ← the actual document number
 * Taking `frDocNum` on faith produced the event key "fr:46594 - 46594". It happened to group the two
 * affected filings correctly, because both were misfiled identically — but a page range is not
 * unique across volumes, so it is exactly the kind of key that eventually merges two unrelated
 * notices. Scanning the three fields for the canonical SHAPE recovers the right identifier and
 * refuses anything that isn't one.
 */
export function frDocNumOf(attrs = {}) {
  for (const candidate of [attrs.frDocNum, attrs.startEndPage, attrs.frVolNum]) {
    const m = FR_DOCNUM.exec(clean(candidate));
    if (m) return m[1];
  }
  return null;
}

/**
 * Fetch one Federal Register document by its document number. Cached per run by the caller, since
 * several Regulations.gov docket copies resolve to the same notice.
 */
async function frDocument(docNum) {
  const fields = ["title", "abstract", "action", "type", "html_url", "comments_close_on", "agencies", "docket_ids"];
  const qs = fields.map((f) => `fields[]=${f}`).join("&");
  const d = await fetchJSON(`${FR_DOC}/${encodeURIComponent(docNum)}.json?${qs}`, { timeoutMs: 15_000 });
  return {
    title: clean(d.title),
    abstract: clean(d.abstract),
    action: clean(d.action),
    type: clean(d.type),
    url: d.html_url || null,
    commentsCloseOn: d.comments_close_on || null,
    agencies: (d.agencies ?? []).map((a) => a.name).filter(Boolean),
  };
}

/**
 * Enrich the items of one run in place-ish (returns new item objects; inputs untouched).
 *
 * @param {object[]} items    normalized adapter Items, any class
 * @param {{env: object, budget?: number, log?: Function}} opts
 * @returns {Promise<{items: object[], stats: {attempted:number, grounded:number, linked:number, failed:number}}>}
 */
export async function enrichItems(items, { env = process.env, budget = DEFAULT_BUDGET, log = console.log } = {}) {
  const apiKey = env.REGULATIONS_GOV_API_KEY || env.CONGRESS_GOV_API_KEY;
  const targets = [];
  for (const [i, it] of (items ?? []).entries()) {
    if (!THIN_SOURCES.has(it.sourceId)) continue;
    // Never re-fetch something the adapter already grounded.
    if (clean(it.summary).length >= 200) continue;
    targets.push(i);
    if (targets.length >= budget) break;
  }
  const stats = { attempted: targets.length, grounded: 0, linked: 0, failed: 0 };
  if (!targets.length) return { items: items ?? [], stats };
  if (!apiKey) {
    log("   ⚠️ document enrichment skipped — no REGULATIONS_GOV_API_KEY / CONGRESS_GOV_API_KEY");
    return { items, stats: { ...stats, attempted: 0 } };
  }

  const out = [...items];
  // One FR lookup per DISTINCT document number, shared across the docket copies that cite it.
  const frCache = new Map();
  const frOnce = (num) => {
    if (!frCache.has(num)) frCache.set(num, frDocument(num).catch(() => null));
    return frCache.get(num);
  };

  await mapPool(targets, POOL, async (idx) => {
    const item = out[idx];
    const docId = String(item.uid ?? "").replace(/^regulations_gov:/, "");
    try {
      const detail = await fetchJSON(`${RG_DOC}/${encodeURIComponent(docId)}?api_key=${apiKey}`, { timeoutMs: 15_000 });
      const a = detail?.data?.attributes ?? {};
      const frDocNum = frDocNumOf(a);
      // Regulations.gov's own docAbstract is usually just the FR citation line ("Federal Register
      // for Monday, July 6, 2026 (91 FR 41018) …") — real provenance, but not substance. Keep it as
      // the citation and go to the Federal Register for the actual abstract.
      const citation = clean(a.docAbstract);
      const fr = frDocNum ? await frOnce(frDocNum) : null;

      const parts = [];
      if (fr?.abstract) parts.push(fr.abstract);
      if (fr?.action) parts.push(`Action: ${fr.action}`);
      if (fr?.agencies?.length) parts.push(`Agency: ${fr.agencies.join(", ")}`);
      if (citation) parts.push(citation);
      if (a.subject) parts.push(`Subject: ${clean(a.subject)}`);
      if (a.cfrPart) parts.push(`CFR part: ${clean(a.cfrPart)}`);
      const summary = parts.join(" — ").slice(0, 8000);

      out[idx] = {
        ...item,
        summary: summary || item.summary,
        raw: {
          ...item.raw,
          frDocNum,
          // The FR title is the canonical one; docket copies truncate and re-punctuate it. Kept
          // alongside rather than replacing the title, so the row still reads as the analyst saw it
          // in the docket while the group can display the canonical form.
          frTitle: fr?.title || null,
          frUrl: fr?.url || null,
          frCommentsCloseOn: fr?.commentsCloseOn || null,
          // ⚠️ Recorded, never applied. Observed live: Regulations.gov said 2026-08-06 for FR
          // 2026-13552 while the Federal Register said 2026-08-05. Regulations.gov is the system
          // that actually accepts the comment, so its date stays authoritative — but a
          // one-day disagreement on a filing deadline is worth being able to see.
          deadlineDisagreement:
            fr?.commentsCloseOn && item.raw?.commentsCloseOn && fr.commentsCloseOn !== item.raw.commentsCloseOn
              ? { regulationsGov: item.raw.commentsCloseOn, federalRegister: fr.commentsCloseOn }
              : null,
        },
      };
      if (summary.length >= 200) stats.grounded++;
      if (frDocNum) stats.linked++;
    } catch {
      // A failed enrichment is a no-op, not an error: the item continues exactly as fetched.
      stats.failed++;
    }
  });

  if (stats.attempted) {
    log(
      `   📄 Document enrichment: ${stats.grounded}/${stats.attempted} grounded with real document text, ` +
        `${stats.linked} linked to a Federal Register document number${stats.failed ? `, ${stats.failed} failed (kept as fetched)` : ""}`
    );
  }
  return { items: out, stats };
}
