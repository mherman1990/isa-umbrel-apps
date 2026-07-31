// eval-corpus.js — a deterministic stand-in for the real stored feed, built to exercise the cases
// that actually go wrong.
//
// PROVENANCE. These are not invented shapes. Every identifier, title and abstract below was taken
// from the live corpus or verified against the live API on 2026-07-30:
//   - The nine EPA pesticide rows are the nine "Aug 6" comment deadlines that were on the homepage.
//     Their Federal Register document numbers were read back from api.regulations.gov, which is how
//     we know the nine rows are three notices: fr 2026-13552 (3 docket copies), 2026-13553 (2) and
//     2026-13557 (4).
//   - The 740-character abstract on 2026-13552 is the real one, fetched from
//     federalregister.gov/api/v1/documents/2026-13552.json — the field the pipeline was
//     hard-coding to "" for this source.
//   - `summary: ""` on the un-enriched docket copies reproduces exactly what
//     adapters/regulations_gov.js emitted.
//
// NO NETWORK, NO MODEL, NO SECRETS. Fully deterministic so the eval numbers are comparable between
// runs and between branches.

/** The real Federal Register abstract for 2026-13552 (740 chars). */
export const FR_13552_ABSTRACT =
  "This document announces the Agency's receipt of and solicits comments on applications to register new pesticide products containing currently registered active ingredients that would entail a change in use pattern. The Agency is providing this notice in accordance with the Federal Insecticide, Fungicide, and Rodenticide Act (FIFRA). EPA uses the month and year in the title to identify when the Agency compiled the applications identified in this notice of receipt. Unit II. of this document identifies certain applications received in 2025 and 2026 that are currently being evaluated by EPA, along with information about each application, including when it was received, who submitted the application, and the purpose of the application.";

const rg = (docId, title, { frDocNum = null, summary = "", deadline = "2026-08-06" } = {}) => ({
  uid: `regulations_gov:${docId}`,
  sourceId: "regulations_gov",
  sourceLabel: "Regulations.gov",
  title,
  summary,
  url: `https://www.regulations.gov/document/${docId}`,
  publishedAt: "2026-07-06T00:00:00.000Z",
  jurisdiction: "US-Federal",
  docType: "notice",
  raw: { frDocNum, docketId: docId.replace(/-\d+$/, ""), commentsCloseOn: deadline },
});

const fr = (docNum, title, summary, { deadline = null, docType = "rule" } = {}) => ({
  uid: `federal_register:${docNum}`,
  sourceId: "federal_register",
  sourceLabel: "Federal Register",
  title,
  summary,
  url: `https://www.federalregister.gov/documents/${docNum}`,
  publishedAt: "2026-07-06T00:00:00.000Z",
  jurisdiction: "US-Federal",
  docType,
  raw: { commentsCloseOn: deadline },
});

const bill = (billId, changeHash, lastAction) => ({
  uid: `legiscan:${billId}:${changeHash}`,
  sourceId: "legiscan",
  sourceLabel: "LegiScan",
  title: "IA HF2571: Relating to agricultural drainage districts and nutrient reduction",
  summary: `${lastAction} — An Act relating to agricultural drainage.`,
  url: "https://legiscan.com/IA/bill/HF2571/2026",
  publishedAt: "2026-07-05T00:00:00.000Z",
  jurisdiction: "IA",
  docType: "bill",
  raw: { billId, changeHash, lastAction },
});

const news = (id, title, summary) => ({
  uid: `rss:ent-${id}:${id}`,
  sourceId: "rss",
  sourceLabel: "Entity RSS/Atom feeds",
  title,
  summary,
  url: `https://example.test/news/${id}`,
  publishedAt: "2026-07-07T00:00:00.000Z",
  jurisdiction: null,
  docType: null,
  raw: { entityId: `ent-${id}` },
});

/**
 * CASE A + B — one action, many filings, across two sources.
 * Ground truth: 3 distinct Federal Register notices behind 10 rows (9 docket copies + 1 FR original).
 */
export const CASE_CROSS_FILED = [
  // fr:2026-13552 — 3 docket copies. One is enriched (carries frDocNum + the real abstract), the
  // other two are as the adapter emitted them, which is the mixed state a real run produces.
  rg("EPA-HQ-OPP-2025-1905-0003", "Pesticide Product Registration: Applications for New Uses (April 2026)", {
    frDocNum: "2026-13552",
    summary: FR_13552_ABSTRACT,
  }),
  rg("EPA-HQ-OPP-2026-1783-0001", "Pesticide Product Registration: Applications for New Uses (April 2026)", { frDocNum: "2026-13552" }),
  rg("EPA-HQ-OPP-2025-2500-0002", "Pesticide Product Registration: Applications for New Uses (April 2026)", { frDocNum: "2026-13552" }),
  // …and the Federal Register original of the SAME notice, from the other source.
  fr("2026-13552", "Pesticide Product Registration; Receipt of Applications for New Uses (April 2026)", FR_13552_ABSTRACT, {
    deadline: "2026-08-05",
    docType: "notice",
  }),
  // fr:2026-13553 — 2 docket copies.
  rg("EPA-HQ-OPP-2026-1784-0001", "Pesticide Product Registration: Applications for New Active Ingredients (April 2026)", { frDocNum: "2026-13553" }),
  rg("EPA-HQ-OPP-2026-1255-0001", "Pesticide Product Registration: Applications for New Active Ingredients (April 2026)", { frDocNum: "2026-13553" }),
  // fr:2026-13557 — 4 docket copies.
  rg("EPA-HQ-OPP-2025-1905-0001", "Pesticide Tolerance; Exemptions, Petitions, Revocations, etc.: Receipt of Pesticide Petitions", { frDocNum: "2026-13557" }),
  rg("EPA-HQ-OPP-2026-1784-0002", "Pesticide Tolerance; Exemptions, Petitions, Revocations, etc.: Receipt of Pesticide Petitions", { frDocNum: "2026-13557" }),
  rg("EPA-HQ-OPP-2026-1783-0004", "Pesticide Tolerance; Exemptions, Petitions, Revocations, etc.: Receipt of Pesticide Petitions", { frDocNum: "2026-13557" }),
  rg("EPA-HQ-OPP-2025-2500-0001", "Pesticide Tolerance; Exemptions, Petitions, Revocations, etc.: Receipt of Pesticide Petitions", { frDocNum: "2026-13557" }),
];
export const CASE_CROSS_FILED_TRUTH = 3;

/**
 * CASE C — a new development in an old storyline. LegiScan's uid embeds `change_hash`, so a bill
 * that moves is a NEW item every time. Correct for change detection; four separate feed rows is not.
 * Ground truth: 1 action with 4 recorded movements.
 */
export const CASE_BILL_MOVEMENT = [
  bill(1893441, "aa11bb22", "Introduced"),
  bill(1893441, "cc33dd44", "Subcommittee recommends passage"),
  bill(1893441, "ee55ff66", "Committee report approving bill"),
  bill(1893441, "aa77bb88", "Passed House"),
];
export const CASE_BILL_MOVEMENT_TRUTH = 1;

/**
 * CASE D — the HARD NEGATIVE. Two genuinely different Federal Register notices with titles that
 * differ only in a qualifier. Any dedup scheme that merges these is worse than no dedup at all,
 * because it silently deletes a real action from the feed.
 */
export const CASE_DISTINCT_LOOKALIKES = [
  fr("2026-14001", "Pesticide Tolerance; Epyrifenacil", "Establishes tolerances for residues of epyrifenacil.", { docType: "rule" }),
  fr("2026-14002", "Pesticide Tolerance; Fluazaindolizine", "Establishes tolerances for residues of fluazaindolizine.", { docType: "rule" }),
];
export const CASE_DISTINCT_LOOKALIKES_TRUTH = 2;

/**
 * CASE E/F — news. Three outlets carrying the same wire story (identical headline) must group;
 * two different stories about the same topic must not.
 */
export const CASE_NEWS = [
  news("a1", "FIFRA overrides state pesticide warning requirements, SCOTUS rules", "The Supreme Court held that federal law preempts state failure-to-warn claims."),
  news("a2", "FIFRA overrides state pesticide warning requirements, SCOTUS rules", "Syndicated copy of the same wire story."),
  news("a3", "FIFRA overrides state pesticide warning requirements, SCOTUS rules", "Third outlet, same wire story."),
  news("b1", "Reaction to the FIFRA preemption ruling splits farm groups", "ASA welcomed the decision while state attorneys general objected."),
];
export const CASE_NEWS_TRUTH = 2;

/**
 * CASE G — retrieval. The domain runs on 2–3 character identifiers, which the previous Ask-box
 * tokenizer discarded (it kept only words of 4+ characters), and the noise rows are full of the
 * stopwords that survived it. A correct retriever puts the signal rows first; the old one returned
 * the newest rows containing "what"/"about"/"latest".
 */
export const CASE_RETRIEVAL = [
  news("r1", "How the latest Section 45Z rulings change feedstock math", "Treasury guidance on the 45Z clean fuel production credit reshapes soybean oil demand."),
  news("r2", "EPA sets 2027 RFS volumes, lifting RIN prices", "The renewable fuel standard proposal raises implied RIN demand."),
  fr("2026-15001", "Clean Water Act; Waters of the United States definition", "Revises the WOTUS definition following the Sackett decision."),
  // Noise: no signal terms, but stuffed with the words the old fallback kept.
  news("n1", "What farmers should know about the latest county fair schedule", "Please update your calendar about these happening events."),
  news("n2", "Show me the latest update about tractor maintenance", "Latest news about happening maintenance."),
  news("n3", "Virtual fencing with eyes in the sky changes cattle game", "Unrelated livestock technology feature."),
];

/** Every fixture item, in the order a run would see them. */
export const ALL = [
  ...CASE_CROSS_FILED,
  ...CASE_BILL_MOVEMENT,
  ...CASE_DISTINCT_LOOKALIKES,
  ...CASE_NEWS,
  ...CASE_RETRIEVAL,
];
