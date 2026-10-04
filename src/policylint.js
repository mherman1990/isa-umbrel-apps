// policylint.js — the six-slot contract, enforced in code.
//
// WHY DETERMINISTIC. Every other quality gate in this pipeline that matters is arithmetic, not
// judgement: `packets.js` verifies quotes as substrings, `thesis.js` resolves evidence ids against
// the store, `enrich.js` validates a Federal Register number's shape before keying on it. The reason
// is always the same — a model asked to check its own compliance with a rule will report compliance.
// So the contract is checked here, by code, before the reviewer ever sees a card, and the reviewer
// is left to do the thing only a model can do: judge whether the causal claim is true.
//
// ⚠️ A MISSING SLOT IS A FAILURE, NOT A WARNING. That is the spec, and it is right: the slots exist
// because each one is a specific way a policy brief goes wrong, and a card that silently ships
// without a posture is exactly the card that makes a reader treat a proposal as settled.
//
// ⚠️ THE ADVICE BOUNDARY HERE IS NARROW ON PURPOSE — READ THIS BEFORE WIDENING IT.
// `compliance.js` was DECOUPLED on 2026-07-11 when Bean Brief became a staff-only internal tool;
// its rules are reserved for the future farmer-facing product, and the internal tool's analytical
// voice was de-muzzled deliberately. This module therefore applies `scanBanned` to EXACTLY ONE
// FIELD — `so_what` — and to nothing else. That is not a re-muzzling: `so_what` is the one slot
// whose job is to state a consequence for a specific farm operation, which is precisely where a
// consequence turns into an instruction. The Analyst Note's explicit licence to give a directional
// read is untouched, because this lint never runs on it. Do not extend this scan to the other slots
// or to any other run type without revisiting the platform-split decision.
//
// 2026-10-04 — THAT DECISION WAS REVISITED FOR EXACTLY ONE RUN TYPE: the Member Brief (`lintMemberDraft`
// below). It is the farmer-facing product compliance.js was reserved for, so every member-facing sentence
// gets the full scanBanned check. The staff tools above are unchanged.

import { MECHANISM_TERMINALS, BANNED_TERMINALS, CERTAINTY_STATES } from "./prompts/policy-domain.js";
import { scanBanned } from "./compliance.js";
import { gradeRank } from "./provenance.js";

const TERMINAL_IDS = new Set(MECHANISM_TERMINALS.map((t) => t.id));
const CERTAINTY_IDS = new Set(CERTAINTY_STATES.map((c) => c.id));

/** Posture states the schema accepts. Each asserts a different procedural fact. */
export const POSTURE_STATUSES = [
  "proposed",
  "comment_open",
  "final",
  "interim_final",
  "effective",
  "litigation",
  "guidance",
  "statutory_deadline",
  "introduced",
  "enacted_law",
  "withdrawn",
];

/** Statuses whose whole point is a date. A card in one of these without a clock date is unusable —
 *  the clock IS the actionable fact, which is the reason this rule exists at all. */
const CLOCK_REQUIRED = new Set(["comment_open", "final", "interim_final", "effective", "statutory_deadline"]);

const MIN_CHAIN_STEPS = 2;
const MAX_CHAIN_STEPS = 5;

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
/** A slot that exists but says nothing is a missing slot. 12 chars is enough to catch "" and "TBD". */
const substantive = (v, min = 12) => nonEmpty(v) && v.trim().length >= min;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A dated window is acceptable for watch_next: "2026-09" or "2026-09-01..2026-09-15" or a quarter. */
const DATED_WINDOW = /^\d{4}-\d{2}(-\d{2})?(\.\.\d{4}-\d{2}(-\d{2})?)?$|^\d{4}-Q[1-4]$/;

/** Phrases that mean "no named next event" however they are dressed up. */
const VAGUE_WATCH = /^(monitor|watch|track|follow|keep an eye|stay tuned|await|tbd|ongoing)\b/i;

/**
 * Check one card against the contract.
 *
 * @param {object} card the card as drafted, AFTER code-side evidence binding
 * @param {{evidence?: Array<{id:string, kind:string, grade:string}>}} ctx resolved evidence — the
 *   caller has already dropped anything that did not resolve against the store, so an id present
 *   here is real by construction.
 * @returns {{ok:boolean, failures:Array<{slot:string, rule:string, detail:string}>}}
 */
export function lintCard(card = {}, ctx = {}) {
  const failures = [];
  const fail = (slot, rule, detail) => failures.push({ slot, rule, detail });
  const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];

  // ---- 1. what_changed -------------------------------------------------------------------------
  if (!substantive(card.what_changed, 25)) {
    fail("what_changed", "empty", "the action was not stated");
  }

  // ---- 2. posture ------------------------------------------------------------------------------
  const posture = card.posture ?? {};
  if (!POSTURE_STATUSES.includes(posture.status)) {
    fail("posture", "bad_status", `status ${JSON.stringify(posture.status ?? null)} is not one of ${POSTURE_STATUSES.join(", ")}`);
  } else if (CLOCK_REQUIRED.has(posture.status) && !ISO_DATE.test(String(posture.clock_date ?? ""))) {
    // The clock is the only actionable fact on most comment-period and effective-date items.
    fail("posture", "missing_clock", `status "${posture.status}" requires a YYYY-MM-DD clock_date; got ${JSON.stringify(posture.clock_date ?? null)}`);
  }
  if (!substantive(posture.detail, 15)) {
    fail("posture", "empty", "no procedural detail given");
  }

  // ---- 3. mechanism ----------------------------------------------------------------------------
  const mech = card.mechanism ?? {};
  const chain = Array.isArray(mech.chain) ? mech.chain.filter(nonEmpty) : [];
  if (chain.length < MIN_CHAIN_STEPS) {
    fail("mechanism", "chain_too_short", `${chain.length} step(s); a mechanism needs at least ${MIN_CHAIN_STEPS} or it is an observation`);
  }
  if (chain.length > MAX_CHAIN_STEPS) {
    fail("mechanism", "chain_too_long", `${chain.length} steps exceeds the ${MAX_CHAIN_STEPS}-step maximum`);
  }
  if (!TERMINAL_IDS.has(mech.terminal)) {
    fail("mechanism", "bad_terminal", `terminal ${JSON.stringify(mech.terminal ?? null)} is not an allowed variable`);
  }
  // The banned words are checked against the LAST step, which is what the chain actually terminates
  // in — a card can legitimately mention sentiment mid-chain while still ending at a real variable.
  const lastStep = chain.length ? chain[chain.length - 1].toLowerCase() : "";
  const banned = BANNED_TERMINALS.find((b) => lastStep.includes(b));
  if (banned) {
    fail("mechanism", "vague_terminal", `the final step ends in "${banned}", which nothing can check`);
  }

  // ---- 4. evidence -----------------------------------------------------------------------------
  const items = evidence.filter((e) => e.kind === "item");
  const series = evidence.filter((e) => e.kind === "series");
  if (!items.length) {
    fail("evidence", "no_source", "no document or news evidence resolved");
  }
  if (!series.length) {
    // The spec's rule: a policy claim asserted with no corroborating data series is a single-source
    // assertion. Counted separately in the run log because it is the rule most likely to be too
    // strict in practice — some actions genuinely have no series that bears on them.
    fail("evidence", "no_market_series", "no market or data series corroborates the mechanism");
  }

  // ---- 5. certainty ----------------------------------------------------------------------------
  if (!CERTAINTY_IDS.has(card.certainty)) {
    fail("certainty", "bad_state", `certainty ${JSON.stringify(card.certainty ?? null)} is not one of ${[...CERTAINTY_IDS].join(", ")}`);
  } else if (card.certainty === "enacted") {
    // ⚠️ THE RULE FAILS THE CARD RATHER THAN RELABELLING IT. Silently rewriting "enacted" to
    // "proposed" would assert a different procedural fact that may itself be false — we know the
    // evidence is too weak to call it final, which is not the same as knowing it is a proposal.
    //
    // ⚠️ AND IT LOOKS AT ITEM EVIDENCE ONLY, NEVER AT SERIES. Almost every market series here comes
    // from USDA, EIA, CFTC or the Federal Reserve and therefore grades `primary_source` — so testing
    // this against ALL evidence would let any card that happened to cite a CFTC positioning series
    // call itself "enacted" on the strength of a trade-press article. A government statistic is
    // excellent evidence about a number and no evidence at all about whether a rule is final.
    const hasPrimarySource = items.some((e) => gradeRank(e.grade) === 0);
    if (!hasPrimarySource) {
      const best = items.length ? items.map((e) => e.grade).sort((a, b) => gradeRank(a) - gradeRank(b))[0] : "none";
      fail("certainty", "enacted_without_primary", `certainty "enacted" needs a primary source for the ACTION; strongest document/news evidence is ${best}`);
    }
  }

  // ---- 6. so_what ------------------------------------------------------------------------------
  if (!substantive(card.so_what, 25)) {
    fail("so_what", "empty", "no consequence stated");
  } else {
    const hits = scanBanned(card.so_what);
    if (hits.length) {
      fail("so_what", "advice_boundary", `reads as an instruction, not an explanation: ${hits.map((h) => `"${h}"`).join(", ")}`);
    }
  }

  // ---- 7. watch_next ---------------------------------------------------------------------------
  const watch = card.watch_next ?? {};
  if (!substantive(watch.event, 10)) {
    fail("watch_next", "empty", "no next event named");
  } else if (VAGUE_WATCH.test(watch.event.trim())) {
    fail("watch_next", "vague_event", `"${watch.event.trim().slice(0, 40)}" names no specific event`);
  }
  const when = String(watch.date ?? "").trim();
  if (!ISO_DATE.test(when) && !DATED_WINDOW.test(when)) {
    fail("watch_next", "undated", `date ${JSON.stringify(when)} is not a date or a dated window`);
  }

  return { ok: failures.length === 0, failures };
}

/** Lint a batch, returning kept cards and the failures, with per-rule counts for the run log. */
export function lintCards(cards, ctxFor) {
  const kept = [];
  const rejected = [];
  const ruleCounts = {};
  for (const card of cards ?? []) {
    const { ok, failures } = lintCard(card, ctxFor(card));
    for (const f of failures) {
      const key = `${f.slot}.${f.rule}`;
      ruleCounts[key] = (ruleCounts[key] ?? 0) + 1;
    }
    (ok ? kept : rejected).push({ card, failures });
  }
  return { kept: kept.map((k) => k.card), rejected, ruleCounts };
}

// Exported for tests: these encode the contract's measured thresholds, and a future edit could
// loosen them without any visible symptom.
export const __testing = { CLOCK_REQUIRED, MIN_CHAIN_STEPS, MAX_CHAIN_STEPS, VAGUE_WATCH, DATED_WINDOW };


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// MEMBER BRIEF LINT (1.40.0) — no unsupported claims, enforced in code.
//
// The Member Brief goes to farmer-members under ISA's name, so "every factual statement traces to a
// stored, citable record" is checked here, sentence by sentence, before the reviewer sees the draft and
// again after the reviewer's edits:
//   cite_required     every sentence cites ≥ 1 packet id
//   cite_unknown      every cited id exists in the evidence packet
//   cite_scope        a policy sentence cites its own action's evidence; a market sentence its own facts
//   token_unknown     every {{TOKEN}} exists in the packet (and was not withheld as stale)
//   number_unsourced  every word containing a digit is inside a {{TOKEN}} or appears verbatim in the text
//                     of a source the sentence cites — the model never writes a number of its own
//   enacted_claim     "final / in effect / enacted / signed into law…" only for an In-force action backed
//                     by a primary source
//   proposed_as_decision  a Proposed or Signalled action never reads as decided
//   advice            compliance.scanBanned — education, never advice
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const DECISION_WORDS =
  /\b(?:enacted|finali[sz]ed|final rule|is final|now final|in effect|takes effect|took effect|went into effect|signed into law|became law|is now law|now requires|is required|are required|mandates|has approved|approved the|adopted the|ruled that|struck down|upheld)\b/i;

const ABBREV = /\b(?:U\.S|U\.N|E\.U|Sen|Rep|Gov|Dept|Corp|Inc|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec|Mr|Ms|Dr|St|vs|e\.g|i\.e|approx)\.$/i;

/** Split text into sentences, not breaking on common abbreviations ("U.S.", "Sept.", "St.", "No."). */
export function splitSentences(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out = [];
  let buf = "";
  const parts = t.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9{])/);
  for (const p of parts) {
    buf = buf ? `${buf} ${p}` : p;
    if (ABBREV.test(buf)) continue; // the "sentence" ended on an abbreviation — keep accumulating
    out.push(buf);
    buf = "";
  }
  if (buf) out.push(buf);
  return out;
}

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;
/** Words containing a digit, after removing {{TOKENS}}. "45Z", "2026", "HF2571", "3.2%". */
export function digitWords(text) {
  const stripped = String(text ?? "").replace(TOKEN_RE, " ");
  return (stripped.match(/[^\s,;:()"“”]*\d[^\s,;:()"“”]*/g) ?? []).map((w) => w.replace(/[.!?]+$/, ""));
}

/**
 * Lint one sentence object { text, cites } against the packet.
 * @param {object} s
 * @param {object} packet  { sources: Map(id → {text, tier, kind}), tokens: Map(name → {value, stale}), }
 * @param {object} scope   { allowedCites?: Set, band?: "enacted"|"contested"|"proposed"|"speculative" }
 * @returns {{rule:string, detail:string}[]}
 */
export function lintMemberSentence(s, packet, scope = {}) {
  const out = [];
  const text = String(s?.text ?? "").trim();
  const cites = Array.isArray(s?.cites) ? s.cites.map(String) : [];
  if (!text) return out;
  if (!cites.length) out.push({ rule: "cite_required", detail: "sentence has no citation" });
  const known = cites.filter((c) => packet.sources.has(c));
  for (const c of cites) if (!packet.sources.has(c)) out.push({ rule: "cite_unknown", detail: `cites ${c}, which is not in the evidence packet` });
  if (scope.allowedCites) for (const c of known) if (!scope.allowedCites.has(c)) out.push({ rule: "cite_scope", detail: `cites ${c}, which belongs to a different section` });
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = packet.tokens.get(m[1]);
    if (!tok) out.push({ rule: "token_unknown", detail: `{{${m[1]}}} is not a packet token` });
    else if (tok.stale) out.push({ rule: "token_stale", detail: `{{${m[1]}}} was withheld as not updated this cycle` });
  }
  // Whole-word match, not substring: "15" must not pass because a cited source contains "2026-09-15".
  const citedWords = new Set(known.flatMap((c) => digitWords(packet.sources.get(c).text ?? "")).map((w) => w.toLowerCase()));
  for (const w of digitWords(text)) {
    if (!citedWords.has(w.toLowerCase())) out.push({ rule: "number_unsourced", detail: `"${w}" is not a packet token and does not appear in a cited source` });
  }
  if (DECISION_WORDS.test(text)) {
    const m = text.match(DECISION_WORDS)[0];
    if (scope.band === "proposed" || scope.band === "speculative") {
      out.push({ rule: "proposed_as_decision", detail: `"${m}" makes a ${scope.band} action read as decided` });
    } else if (scope.band === "enacted" || scope.band === "contested") {
      if (!known.some((c) => packet.sources.get(c).tier === "primary_source")) out.push({ rule: "enacted_claim", detail: `"${m}" needs a cited primary source` });
    } else {
      out.push({ rule: "enacted_claim", detail: `"${m}" is a decision claim outside a policy item with an In-force band` });
    }
  }
  const advice = scanBanned(text);
  if (advice.length) out.push({ rule: "advice", detail: `reads as advice: ${advice.map((h) => `"${h}"`).join(", ")}` });
  return out;
}

/**
 * Lint a whole Member Brief draft. Returns every failure with the path of the sentence it is in, so
 * the retry prompt can name them and the run log can count them.
 * @returns {{ok:boolean, failures:{path:string, rule:string, detail:string}[]}}
 */
export function lintMemberDraft(draft, packet) {
  const failures = [];
  const each = (list, path, scope) =>
    (list ?? []).forEach((s, i) => {
      for (const f of lintMemberSentence(s, packet, scope)) failures.push({ path: `${path}[${i}]`, ...f });
      if (splitSentences(s?.text).length > 1) failures.push({ path: `${path}[${i}]`, rule: "one_sentence", detail: "each entry must be exactly one sentence" });
    });
  each(draft?.update, "update", { allowedCites: null });
  if (!(draft?.update ?? []).length) failures.push({ path: "update", rule: "update_empty", detail: "the update needs at least one sentence" });
  if ((draft?.update ?? []).length > 3) failures.push({ path: "update", rule: "update_length", detail: `${draft.update.length} sentences; the limit is 3` });
  for (const p of draft?.policy ?? []) {
    const item = packet.policy.get(p?.id);
    if (!item) {
      failures.push({ path: `policy.${p?.id}`, rule: "policy_unknown", detail: "not an action in the packet" });
      continue;
    }
    for (const slot of ["whatChanged", "whereItStands", "whatItMeans", "next"]) {
      each(p?.[slot] ? [p[slot]] : [], `policy.${p.id}.${slot}`, { allowedCites: item.citeIds, band: item.band });
    }
  }
  for (const [k, list] of Object.entries(draft?.markets ?? {})) {
    const fact = packet.markets.get(k);
    each(list, `markets.${k}`, { allowedCites: fact ? fact.citeIds : new Set() });
  }
  return { ok: failures.length === 0, failures };
}
