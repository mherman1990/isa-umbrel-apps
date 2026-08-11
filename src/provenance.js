// provenance.js — how much weight a piece of evidence is entitled to.
//
// WHY THIS DID NOT EXIST BEFORE. The codebase already had three things that LOOK like this and are
// not: `evidenceBasis` (packet / document / title_only) says how much TEXT we retrieved,
// `sufficiency` (full / partial / thin) says how much of the action that text supports, and
// `SOURCE_RANK` in eventkey.js is a five-entry tie-breaker for choosing which duplicate filing to
// send to the model. None of them answers "who is making this claim, and are they in a position to
// know?" — which is the question that decides whether a card may say a rule is FINAL.
//
// ⚠️ THE GRADE COMES FROM `source_id` FIRST, HOST SECOND. We know how we fetched a thing with
// certainty; we only infer from its URL. A Federal Register item is primary because the Federal
// Register adapter fetched it, not because its host happens to be federalregister.gov — that
// ordering matters because news items routinely LINK to a primary source, and grading a trade-press
// article as primary because it links to an EPA docket is exactly the laundering this prevents.
//
// ⚠️ A TRADE GROUP'S PRESS RELEASE IS NOT AN AGENCY PRESS RELEASE. Clean Fuels Alliance and Growth
// Energy publish on their own domains about rules they are lobbying on; that is an interested
// party's characterisation of a government action, not the action. They grade `trade_press`, and the
// `advocacy` flag is set so a renderer can say so. This is the same distinction `packets.js` draws
// between `fact` and `assertion_by_party`.

/** The ladder, strongest first. Index IS the rank — lower outranks higher. */
export const GRADES = ["primary_source", "agency_press", "trade_press", "general_press", "aggregator"];

export const GRADE_LABEL = {
  primary_source: "primary source",
  agency_press: "agency release",
  trade_press: "trade press",
  general_press: "general press",
  aggregator: "aggregator",
};

/** Numeric rank; unknown grades sort last rather than throwing. */
export function gradeRank(grade) {
  const i = GRADES.indexOf(grade);
  return i < 0 ? GRADES.length : i;
}

/** True when `a` is at least as authoritative as `b`. */
export const atLeast = (a, b) => gradeRank(a) <= gradeRank(b);

// Sources whose items ARE the government record. These are the adapters that fetch from the
// publisher of record, so anything they return is the document itself.
const PRIMARY_SOURCES = new Set([
  "federal_register",
  "regulations_gov",
  "congress_gov",
  "congress_hearings",
  "courtlistener",
  "legiscan",
  "eurlex_oj",
  "iowa_admin_rules",
  "govinfo",
]);

// Hosts that publish the government's own record or its own announcements. Split into two tiers
// because a rule text and a press release about that rule are not the same evidence.
const PRIMARY_HOSTS = [
  "federalregister.gov",
  "regulations.gov",
  "congress.gov",
  "govinfo.gov",
  "courtlistener.com",
  "supremecourt.gov",
  "uscourts.gov",
  "eur-lex.europa.eu",
  "legis.iowa.gov",
  "legiscan.com",
  "ecfr.gov",
];

const AGENCY_HOSTS = [
  "epa.gov",
  "usda.gov",
  "fas.usda.gov",
  "ams.usda.gov",
  "nass.usda.gov",
  "fsa.usda.gov",
  "nrcs.usda.gov",
  "treasury.gov",
  "irs.gov",
  "ustr.gov",
  "commerce.gov",
  "trade.gov",
  "cftc.gov",
  "eia.gov",
  "energy.gov",
  "state.gov",
  "whitehouse.gov",
  "iowaagriculture.gov",
  "iowadnr.gov",
];

// Trade and farm press, plus the advocacy organisations whose releases arrive through the same feeds.
const TRADE_HOSTS = [
  "farmprogress.com",
  "feedstuffs.com",
  "agweb.com",
  "dtnpf.com",
  "progressivefarmer.com",
  "brownfieldagnews.com",
  "agriculture.com",
  "no-tillfarmer.com",
  "farmdocdaily.illinois.edu",
  "farmpolicynews.illinois.edu",
  "biodieselmagazine.com",
  "ethanolproducer.com",
  "ogj.com",
];

// Interested parties. Graded trade_press, flagged advocacy — see the header note.
const ADVOCACY_HOSTS = [
  "cleanfuels.org",
  "growthenergy.org",
  "soygrowers.com",
  "iasoybeans.com",
  "ncga.com",
  "nbb.org",
  "api.org",
  "fuelsamerica.org",
  "rfa.org",
];

const GENERAL_HOSTS = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "wsj.com",
  "nytimes.com",
  "washingtonpost.com",
  "cnbc.com",
  "politico.com",
  "thehill.com",
  "desmoinesregister.com",
];

/** Lowercased registrable-ish host, or "" when the URL is unusable. Never throws. */
export function hostOf(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return "";
  }
}

/** Does `host` equal one of `list`, or sit beneath it as a subdomain? */
function hostMatches(host, list) {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Grade one piece of evidence.
 *
 * @param {{sourceId?:string, url?:string, sourceLabel?:string}} ev
 * @returns {{grade:string, label:string, rank:number, advocacy:boolean, basis:string}}
 *   `basis` records WHY the grade was assigned, so a surprising grade is debuggable from the row
 *   rather than by re-deriving this function's logic in your head.
 */
export function gradeEvidence(ev = {}) {
  const sourceId = String(ev.sourceId ?? "");
  const host = hostOf(ev.url);

  const done = (grade, basis, advocacy = false) => ({
    grade,
    label: GRADE_LABEL[grade],
    rank: gradeRank(grade),
    advocacy,
    basis,
  });

  // 1. How we fetched it. Authoritative — see the header note on why this outranks the host.
  if (PRIMARY_SOURCES.has(sourceId)) return done("primary_source", `source_id=${sourceId}`);

  // 2. The collector inbox is a newsletter relay: the sender is not the publisher, and the link is
  //    usually a tracker. Nothing arriving this way can be graded above aggregator on host alone.
  if (sourceId === "email_intake") return done("aggregator", "collector inbox — sender is not the publisher");

  // 3. Host, for everything that arrived via RSS or a web citation.
  if (!host) return done("aggregator", "no usable URL");
  if (hostMatches(host, PRIMARY_HOSTS)) return done("primary_source", `host=${host}`);
  if (hostMatches(host, AGENCY_HOSTS)) return done("agency_press", `host=${host}`);
  if (hostMatches(host, ADVOCACY_HOSTS)) return done("trade_press", `host=${host} (interested party)`, true);
  if (hostMatches(host, TRADE_HOSTS)) return done("trade_press", `host=${host}`);
  if (hostMatches(host, GENERAL_HOSTS)) return done("general_press", `host=${host}`);

  // 4. A .gov we have not enumerated is still the government publishing about itself. Deliberately
  //    `agency_press` and never `primary_source`: we cannot tell a rule text from a press release
  //    without knowing the site, and the whole point of the ladder is that guess must round DOWN.
  if (/\.gov$/.test(host) || /\.gov\./.test(host)) return done("agency_press", `unenumerated .gov host=${host}`);
  if (/\.edu$/.test(host)) return done("trade_press", `academic/extension host=${host}`);

  return done("aggregator", `unrecognised host=${host}`);
}

/** The strongest grade present in a list of graded evidence, or null when the list is empty. */
export function bestGrade(graded) {
  const ranked = (graded ?? []).filter(Boolean).map((g) => g.grade ?? g);
  if (!ranked.length) return null;
  return ranked.reduce((best, g) => (gradeRank(g) < gradeRank(best) ? g : best));
}
