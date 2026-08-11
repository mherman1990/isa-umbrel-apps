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
