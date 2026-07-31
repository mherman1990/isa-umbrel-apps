// eventkey.js — one government ACTION, one identity.
//
// WHY THIS EXISTS. The monitoring streams overlap on purpose (Regulations.gov carries the docket
// side of the same rulemaking the Federal Register publishes; a state bill resurfaces on every
// status change), and until now every copy was a separate row with its own Haiku one-liner, its own
// calendar entry, and its own comment deadline. Measured on the stored feed: the nine "Aug 6"
// comment deadlines on the homepage were **three** Federal Register notices — 2026-13552, -13553
// and -13557 — each cross-filed into two to four EPA dockets. The analyst saw nine
// indistinguishable rows titled "Pesticide Product Registration: Applications for New Uses
// (April 2026)" and had no way to tell that six of them were the same document.
//
// WHY NOT EMBEDDINGS. The obvious reach here is semantic clustering, and it would be the wrong
// tool. These documents carry an EXACT shared identifier — Regulations.gov's `frDocNum` is the
// Federal Register document number — so the correct grouping is derivable deterministically, for
// free, with no model, no vector store, and no false merges. Embeddings would be slower, cost
// money, need a similarity threshold nobody can defend, and would still be less accurate than a
// primary key the publisher already assigns. Reserve semantic similarity for the cases below that
// genuinely have no shared identifier (news re-syndication), and even there the fallback stays a
// normalized-title EXACT match so it can never merge two different stories.
//
// WHAT THIS IS NOT. Collapsing is a DISPLAY and TRIAGE decision, never a deletion. Every row stays
// in `seen_items` exactly as fetched, so "Did we see this?" (store.diagnoseCoverage) still finds
// every copy — that panel's whole job is showing what the filters did, and it would be useless if
// dedup ran upstream of it.

import { createHash } from "node:crypto";

/** Short stable hash for the title fallback. */
function hash(s) {
  return createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
}

/** A whole-string Federal Register document number ("2026-13552"). See rule 1 in eventKeyFor. */
const FR_DOCNUM_EXACT = /^(?:19|20)\d{2}-\d{3,6}$/;

/**
 * Strip the parts of a title that vary between copies of the same action without changing what it
 * is: case, punctuation, whitespace, the "etc." padding agencies add, and a trailing
 * "; Correction"/"; Notice of ..." qualifier. Deliberately conservative — this only ever runs as
 * the LAST resort, so a false merge is worse than a missed one.
 */
export function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    // A trailing qualifier the agency appends to the SAME action. Separators seen in the wild:
    // "Epyrifenacil; Pesticide Tolerances; Correction" (semicolon) and em/en-dash variants. A plain
    // hyphen is deliberately excluded so a hyphenated word is never truncated.
    .replace(/\s*[;,—–]\s*(corrections?|notice of availability|request for comments?)\s*$/i, "")
    .replace(/\betc\.?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The document-number half of a `source:id` uid, e.g. "federal_register:2026-13552" → "2026-13552". */
function uidTail(uid, sourceId) {
  const prefix = `${sourceId}:`;
  return String(uid ?? "").startsWith(prefix) ? String(uid).slice(prefix.length) : String(uid ?? "");
}

/**
 * The cross-source identity of the government action an item reports on.
 *
 * Ordered strongest-evidence-first. Each rule keys on an identifier the PUBLISHER assigns, so two
 * items share a key only when they really are the same action:
 *
 *   fr:<docnum>          a Federal Register document. Regulations.gov copies carry the same number
 *                        in `frDocNum` (supplied by enrich.js), which is what collapses the docket
 *                        copies onto the notice itself.
 *   bill:<juris>:<id>    a bill across its whole life. LegiScan's uid embeds `change_hash`, so a
 *                        bill that moves becomes a NEW item every time — correct for change
 *                        detection, useless as identity. This key is what lets the feed say "HF 123,
 *                        4 actions since you last looked" instead of listing HF 123 four times.
 *   case:<court>:<no>    a litigation docket across filings (same reason: the uid embeds the
 *                        latest filing date).
 *   docket:<id>          a Regulations.gov docket when no FR number is available (un-enriched).
 *   hearing:/oj:/iar:    one-per-publisher-id streams; these already dedupe, so the key just makes
 *                        the identity explicit and uniform for the grouping code.
 *   t:<hash>            LAST RESORT for news/RSS: a normalized-title EXACT match, so the same wire
 *                        story republished by three outlets groups, but two different stories never do.
 *
 * @param {object} item a normalized adapter Item (or a stored row with {uid, source_id, ...})
 * @returns {string} always a key — falls back to the uid so every row belongs to exactly one group
 */
export function eventKeyFor(item) {
  const sourceId = item.sourceId ?? item.source_id ?? "";
  const uid = item.uid ?? "";
  const raw = item.raw ?? {};

  // 1. An explicit Federal Register document number — the strongest evidence there is, and the one
  //    that spans sources. enrich.js resolves it for Regulations.gov items.
  //
  //    VALIDATED, NOT TRUSTED. Some Regulations.gov records carry a page range in `frDocNum`
  //    ("46594 - 46594"); enrich.js recovers the real number from the neighbouring fields, but this
  //    function is also called on rows enriched by an older build, so the shape is re-checked here.
  //    A key built from a page range would be non-unique across volumes — a latent false merge.
  const frNum = String(raw.frDocNum ?? (sourceId === "federal_register" ? uidTail(uid, sourceId) : "")).trim();
  if (FR_DOCNUM_EXACT.test(frNum)) return `fr:${frNum}`;

  // 2. Bills — identity is the bill, not the status change that resurfaced it.
  if (sourceId === "legiscan" && raw.billId) {
    const juris = (item.jurisdiction ?? "us").toLowerCase();
    return `bill:${juris}:${raw.billId}`;
  }
  if (sourceId === "congress_gov") return `bill:us:${uidTail(uid, sourceId)}`;

  // 3. Litigation — identity is the docket, not the newest filing.
  if (sourceId === "courtlistener" && raw.docketNumber) {
    return `case:${(raw.court ?? "fed").toLowerCase()}:${String(raw.docketNumber).replace(/\s+/g, "")}`;
  }

  // 4. Deliberately NO docket-based rule. A Regulations.gov docket is wrong in both directions: one
  //    Federal Register notice is cross-filed into MANY dockets (so keying on the docket prevents the
  //    grouping this whole module exists for), while one docket accumulates a proposed rule, the
  //    final rule and their supporting analyses (so keying on the docket would MERGE genuinely
  //    different actions — a false merge, which is the failure mode that matters). Un-enriched
  //    Regulations.gov items therefore fall through to the normalized-title rule below, which is
  //    exact and was verified against the frDocNum ground truth on the stored feed.

  // 5. Streams whose publisher id is already one-per-action.
  if (sourceId === "congress_hearings" && raw.eventId) return `hearing:${raw.chamber ?? "?"}:${raw.eventId}`;
  if (sourceId === "eurlex_oj" && raw.ojNumber) return `oj:${raw.ojNumber}`;
  if (sourceId === "iowa_admin_rules") return `iar:${uidTail(uid, sourceId)}`;

  // 6. News and anything else: normalized-title exact match, scoped to the source class so a press
  //    release and a rule are never merged on a coincidentally similar headline.
  const norm = normalizeTitle(item.title);
  if (norm.length >= 25) return `t:${hash(norm)}`;

  // 7. No usable signal (a very short or missing title) — the item is its own event.
  return `u:${uid}`;
}

/**
 * Group rows by event key, newest-first within a group, preserving the input order of the
 * representatives. The FIRST row of each group is the representative: callers pass rows already
 * sorted the way they want them ranked, so this never re-ranks.
 *
 * @param {object[]} rows      rows carrying `event_key` (or from which one can be derived)
 * @returns {{key: string, lead: object, members: object[]}[]}
 */
export function groupByEvent(rows) {
  const groups = new Map();
  for (const r of rows ?? []) {
    const key = r.event_key || eventKeyFor(r);
    if (!groups.has(key)) groups.set(key, { key, lead: r, members: [] });
    groups.get(key).members.push(r);
  }
  return [...groups.values()];
}

/**
 * Pick the best representative of an event group for the analyst.
 *
 * Preference order matters: the Federal Register copy carries the real abstract and the canonical
 * citation, while a Regulations.gov docket copy carries the comment mechanics. Where both exist we
 * lead with whichever has actual document text, then prefer the source that is the publisher of
 * record, then the longest title (docket copies truncate).
 */
const SOURCE_RANK = { federal_register: 0, regulations_gov: 1, congress_gov: 2, legiscan: 2, courtlistener: 3 };

/**
 * The non-official source ids, as a LOCAL COPY of adapters/index.js's SOURCE_CLASS.
 *
 * ⚠️ WHY DUPLICATED INSTEAD OF IMPORTED. This module is deliberately PURE — `node:crypto` and nothing
 * else — which is what makes it unit-testable without a database. Importing `classOf` from
 * adapters/index.js would create a real cycle: eventkey → adapters/index → rss → store → eventkey
 * (store.js:16 imports eventKeyFor). ESM would tolerate it here because the lookup happens at call
 * time, but a load-order cycle through the database layer is not worth a tidier import.
 *
 * Mirrors classOf's semantics exactly, INCLUDING its default: anything unlisted counts as official. So
 * a newly added official adapter automatically gets lead priority, and only a new news/markets source
 * needs adding here. `test/newsrank.test.js` asserts this set matches SOURCE_CLASS exactly, so the two
 * cannot drift silently.
 */
const NON_OFFICIAL = new Set([
  "rss",
  "email_intake",
  "fas_export_sales",
  "usda_nass",
  "eia",
  "cftc",
  "usda_ams",
  "open_meteo",
  "agtransport",
  "drought_monitor",
  "ibge_brazil",
  "fred",
  "wasde",
  "barchart",
  "vegscape",
  "cropcasma",
  "cbot_futures",
]);
const isOfficial = (sourceId) => !NON_OFFICIAL.has(sourceId);
export function pickLead(members) {
  return [...members].sort((a, b) => {
    const aBody = (a.body ?? a.summary ?? "").length;
    const bBody = (b.body ?? b.summary ?? "").length;
    // ⚠️ CLASS OUTRANKS EVERYTHING — checked FIRST, before body length.
    //
    // A group can span classes: a news article about a rule and the rule's own Federal Register notice
    // normalize to the same title and land in one event. The publisher of record must lead it, because
    // compactItems presents the lead as THE action — its title, its url, its document text and (since
    // 1.28.0) its priority tier go to the model as the sourced fact about a government action. A news
    // row leading such a group means the deepest model in the system cites a trade-press write-up as
    // the rule.
    //
    // This became a live risk in 1.28.0 rather than a theoretical one: news grounding gives news rows
    // ~5,000-character bodies, while `iowa_admin_rules` and `eurlex_oj` still emit `summary: ""`. So on
    // the old ordering the FIRST comparison — `(aBody >= 200) !== (bBody >= 200)` — handed the lead to
    // the news article over the actual Iowa Administrative Bulletin filing. SOURCE_RANK could not save
    // it either: news sources aren't in the table, so they scored the same `?? 9` as those two official
    // sources and the tie fell through to body length. Locked by test.
    const aOfficial = isOfficial(a.source_id ?? a.sourceId);
    const bOfficial = isOfficial(b.source_id ?? b.sourceId);
    if (aOfficial !== bOfficial) return aOfficial ? -1 : 1;
    // A copy with real document text beats one without — that's the whole point of enrichment.
    if ((aBody >= 200) !== (bBody >= 200)) return bBody - aBody;
    const ar = SOURCE_RANK[a.source_id ?? a.sourceId] ?? 9;
    const br = SOURCE_RANK[b.source_id ?? b.sourceId] ?? 9;
    if (ar !== br) return ar - br;
    if (bBody !== aBody) return bBody - aBody;
    return String(b.title ?? "").length - String(a.title ?? "").length;
  })[0];
}
