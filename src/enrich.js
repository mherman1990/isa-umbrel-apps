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
import { fetchDocumentText } from "./summarize.js";

/** Sources whose adapter cannot supply document text on its own. */
const THIN_SOURCES = new Set(["regulations_gov"]);

const POOL = 4; // polite against api.data.gov; ≤35 official items/run means this is never the bottleneck
const DEFAULT_BUDGET = 40; // hard cap on enrichment fetches per run

/**
 * The length at which text stops being a headline restatement and starts being a document.
 *
 * Not arbitrary. Measured on the stored news corpus (68 items, 2026-07-30): 12 items had NO body at
 * all, 48 had 1–199 characters, 8 had 200–799, and NOTHING exceeded 800. The 48 are RSS
 * `<description>` teasers, which publishers truncate mid-word — "U.S. farmers planted 95.3 million
 * acres of corn and 85.4 mil…". So 200 separates "a teaser" from "something worth reasoning over"
 * for both streams, which is why the official path uses the same number.
 */
const GROUNDED_MIN_CHARS = 200;
const FR_DOC = "https://www.federalregister.gov/api/v1/documents";
const RG_DOC = "https://api.regulations.gov/v4/documents";

/** Collapse whitespace and trim; "" for anything empty. */
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Normalize fetched article text while KEEPING paragraph breaks.
 *
 * ⚠️ Deliberately not `clean()`. `clean` collapses every whitespace run including newlines, which would
 * immediately undo `fetchDocumentText`'s `preserveParagraphs` and put the 8,000-character wall back —
 * this text is read by a human in the News tab, not only fed to a model. So spaces and tabs collapse
 * within a line, and blank lines between paragraphs survive.
 */
const normalizeArticle = (s) =>
  String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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

// ---------------------------------------------------------------------------------------------
// NEWS GROUNDING
// ---------------------------------------------------------------------------------------------
//
// The same information loss, in the stream that carries more than half the corpus.
//
// MEASURED, on the stored feed (2026-07-30): of 68 news items, 12 had no body at all, 48 had
// 1–199 characters and 8 had 200–799 — nothing above 800. An RSS `<description>` is a teaser the
// publisher truncates mid-word, so every downstream consumer — `searchItemsRanked` (which weights a
// `body` hit), `compactItems` (whose `document` field IS `body`), the Ask box and the Analyst Note —
// was reasoning about news from a headline plus a fragment. A story whose substance is "China booked
// four cargoes" is unreachable if its title is "Daily market recap" and its body stops at 180 chars.
//
// The text was already being fetched. `generateNewsDigest` pulled up to 14 articles' readable text
// into a local Map, used it for one Haiku call and dropped it on the floor — so the tool paid the
// HTTP cost every run and kept nothing. This persists it into `summary`, which `markSeen` writes to
// `body`, so one fetch serves the digest, retrieval, and every prompt from then on.
//
// WHY THIS IS NOT A SECOND ENRICHMENT SYSTEM. Same budget/pool/fail-soft shape as the official path,
// same `GROUNDED_MIN_CHARS` bar, same "a failure leaves the item exactly as the adapter produced it"
// rule. It differs only in where the text comes from: official documents have an API that returns an
// abstract, news has an article behind a URL.

/** Per-run cap on article fetches. Above the digest's old 14 so the whole recent feed gets grounded,
 *  low enough that a slow publisher can't stretch a run. Each is one GET with a 15 s timeout. */
const NEWS_BUDGET = 25;

/**
 * Ground news items in the article they link to.
 *
 * Only touches items that are BOTH thin and linkable, so a collector email (whose stored body IS the
 * message, and which has no URL) is never fetched, and an item a publisher gave a real body to is
 * left alone.
 *
 * @param {object[]} items   normalized news-class Items
 * @param {{budget?: number, log?: Function, fetchText?: Function}} opts  fetchText is injectable for tests
 * @returns {Promise<{items: object[], stats: {attempted:number, grounded:number, failed:number, charsAdded:number}}>}
 */
export async function groundNewsItems(items, { budget = NEWS_BUDGET, log = console.log, fetchText = fetchDocumentText } = {}) {
  const targets = [];
  for (const [i, it] of (items ?? []).entries()) {
    if (!it?.url) continue; // an email has no article to fetch — its body is already the message
    if (clean(it.summary).length >= GROUNDED_MIN_CHARS) continue;
    targets.push(i);
    if (targets.length >= budget) break;
  }
  const stats = { attempted: targets.length, grounded: 0, failed: 0, charsAdded: 0, blockedHosts: {} };
  if (!targets.length) return { items: items ?? [], stats };

  // Which publishers could not be read, and why. MEASURED and worth surfacing rather than swallowing:
  // farmprogress.com — 50 of the 68 stored news rows — returns HTTP 403 from Cloudflare to EVERY
  // user-agent tried, including an ordinary browser one, so its article text is not reachable from a
  // plain Node fetch at all (the same class of wall as Stooq; see STATE.md). farmdocdaily.illinois.edu
  // returns 5,032 characters cleanly. A per-host tally means "news grounding isn't doing much" is a
  // question the log can answer, instead of the feature quietly appearing to work.
  const noteHost = (url, reason) => {
    let host = "unknown";
    try { host = new URL(url).host.replace(/^www\./, ""); } catch { /* keep "unknown" */ }
    stats.blockedHosts[host] = { reason, n: (stats.blockedHosts[host]?.n ?? 0) + 1 };
  };

  // ⚠️ DON'T SPEND THE BUDGET ON A HOST THAT IS ALREADY REFUSING US (found in review).
  //
  // The 25-fetch budget was allocated in plain array order, and farmprogress.com is 50 of the 68 stored
  // news rows and arrives first. So on a normal day the entire budget went to a host that returns 403 to
  // every request, and the publishers that DO work — farmdocdaily, Farm Policy News, Feedstuffs — were
  // starved by items that could never succeed. After two refusals from one host, the rest of that host's
  // items are skipped for the remainder of the run.
  //
  // Deliberately per-RUN and not persisted: a publisher's block can be lifted, a CDN rule can change,
  // and the Pi may not be blocked where this dev PC is. Every run gives each host two fresh chances.
  const HOST_STRIKES = 2;
  const strikes = new Map();
  const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return "unknown"; } };

  const out = [...items];
  await mapPool(targets, POOL, async (idx) => {
    const item = out[idx];
    const host = hostOf(item.url);
    if ((strikes.get(host) ?? 0) >= HOST_STRIKES) {
      // Not counted as a failure — it was never attempted. Recorded so the log still accounts for it.
      stats.skippedHost = (stats.skippedHost ?? 0) + 1;
      noteHost(item.url, `skipped — ${host} already refused ${HOST_STRIKES} requests this run`);
      return;
    }
    try {
      const { text, note } = await fetchText(item.url, { preserveParagraphs: true });
      // ⚠️ NOT clean() — that collapses every whitespace run and would immediately undo
      // preserveParagraphs. Collapse spaces/tabs within a line, keep blank lines between paragraphs.
      const article = normalizeArticle(text);
      const teaser = clean(item.summary);
      // NEVER SHORTEN. A publisher's teaser is usually the lede and the article text normally
      // contains it, but a paywall or a JS-rendered page can return a nav stub that is shorter than
      // the teaser we already had. Keeping the longer of the two means grounding can only ever add
      // information — the failure mode is "no change", never "worse than before".
      if (article.length <= teaser.length) {
        stats.failed++;
        strikes.set(host, (strikes.get(host) ?? 0) + 1);
        noteHost(item.url, note || "returned no more text than the feed teaser");
        return;
      }
      out[idx] = {
        ...item,
        summary: article.slice(0, 8000),
        raw: {
          ...item.raw,
          // Provenance: which text the row is carrying, so a reader (and a later debugging session)
          // can tell a real article from a feed teaser without re-measuring lengths.
          groundedFrom: "article",
          groundedChars: Math.min(article.length, 8000),
          groundedNote: note || null,
        },
      };
      stats.grounded++;
      stats.charsAdded += Math.min(article.length, 8000) - teaser.length;
    } catch (err) {
      // fetchDocumentText already returns {text:"", note} rather than throwing, so reaching here
      // means something unexpected. Either way the item continues exactly as fetched.
      stats.failed++;
      strikes.set(host, (strikes.get(host) ?? 0) + 1);
      noteHost(item.url, err?.message || "fetch threw");
    }
  });

  if (stats.attempted) {
    log(
      `   📰 News grounding: ${stats.grounded}/${stats.attempted} items now carry their article text ` +
        `(+${(stats.charsAdded / 1000).toFixed(1)}k chars stored${stats.failed ? `, ${stats.failed} unavailable (kept as fetched)` : ""}` +
        `${stats.skippedHost ? `, ${stats.skippedHost} not attempted — host already refusing` : ""})`
    );
    // Name the publishers that could not be read. Without this the feature looks like it is working
    // while a publisher supplying most of the feed is silently contributing nothing.
    const blocked = Object.entries(stats.blockedHosts).sort((a, b) => b[1].n - a[1].n);
    for (const [host, { reason, n }] of blocked.slice(0, 5)) {
      log(`      ↳ ${host}: ${n} item${n === 1 ? "" : "s"} unreadable — ${reason}`);
    }
  }
  return { items: out, stats };
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
    if (clean(it.summary).length >= GROUNDED_MIN_CHARS) continue;
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
      if (summary.length >= GROUNDED_MIN_CHARS) stats.grounded++;
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
