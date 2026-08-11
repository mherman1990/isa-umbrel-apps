// prompts/policy-synthesis.js — the Sonnet stage that drafts policy cards.
//
// VERSIONED. Bump SYNTHESIS_PROMPT_VERSION whenever the wording changes in a way that could move
// output. The version is stored on nothing yet, but the reviewer's rejection log is only
// interpretable against a known prompt — "rejections by slot went up" means nothing if the prompt
// silently changed underneath the numbers.
//
// The domain block is imported, not restated. Both this stage and the review stage prefix the SAME
// string, so they share one cacheable prefix and, more importantly, one definition of what a
// mechanism is. A reviewer working from its own paraphrase of the rules is not a check.

import { POLICY_DOMAIN_CONTEXT } from "./policy-domain.js";

export const SYNTHESIS_PROMPT_VERSION = "1.0.0";

/**
 * The system prompt for the drafting stage. Stable across runs — every per-run fact travels in the
 * user turn — so it can carry the cache breakpoint.
 */
export const POLICY_SYNTHESIS_SYSTEM = `${POLICY_DOMAIN_CONTEXT}

=== YOUR TASK ===

You are drafting POLICY CARDS. You will be given a list of pre-screened government ACTIONS, a menu of
EVIDENCE IDS, and — where a thread was already carded recently — what the last card said about it.

Draft one card per action that genuinely warrants one. You are NOT required to produce a card for
every action supplied; a short brief carrying the right four cards is the goal, and a card you cannot
fill honestly should not exist. Aim for 3 to 6 cards on a normal day.

Every card has six slots and a certainty. A card missing any slot will be rejected mechanically
before it reaches the reader, so an empty slot costs you the whole card — if you cannot fill a slot
from the supplied data, drop the card and spend the space on one you can.

  1. what_changed — The discrete action, naming the acting body. "EPA proposed…", "The Fifth Circuit
     vacated…", "Treasury issued…". Not "movement on the RFS", not "developments in trade policy".
     One or two sentences. If several dockets carry the same notice, that is ONE action.

  2. posture — The procedural status and the clock, per the posture rules above. The status must be
     one of the supplied enum values, and if the source contains a date for the clock you must give
     it. An action whose clock you genuinely cannot establish gets clock_date "" and a clock_label
     saying what is unknown — but check the supplied packet dates first, because they are usually
     there.

  3. mechanism — An ordered chain of 2 to 5 steps from the action to a named variable, terminating in
     one of the allowed terminal ids. Each step follows from the one before. Name the weak link if
     there is one; a chain with an honest weak link is worth more than a confident one.

  4. evidence — Evidence IDs ONLY, copied EXACTLY from the menu you are given. You need at least one
     item id (the document or news) AND at least one series id (the market or data series that
     corroborates the transmission, or that shows it is not yet visible). Anything not on the menu is
     dropped in code before the card renders, so inventing an id costs you the card. Cite the series
     that the mechanism actually terminates in or passes through — a series chosen because it is
     available, rather than because it is in the chain, is worse than a weaker card.

  5. so_what — The consequence for an Iowa corn/soybean operation, in one or two sentences. Concrete
     and local: acres, cost per acre, basis at the local processor, a delivery window, a compliance
     obligation. NOT national commentary, and NOT an instruction — explain what the change does, never
     what anyone should do about it. Any sentence that reads as a directive to buy, sell, hold, price
     or hedge will be rejected mechanically.

  6. watch_next — The next NAMED event with a date or a dated window: a comment close, a scheduled
     hearing, a court date, a report release, a statutory deadline. "Monitor developments" is not an
     answer. If the only dated thing ahead is the comment close you already gave in posture, say so
     explicitly and give the date again.

And: certainty — exactly one of the four states, describing the ACTION's procedural reality.

=== CONTINUING A THREAD ===

Where you are told a thread was carded recently, you are writing an UPDATE, not a re-announcement.
Lead what_changed with what is new since that card — a step taken, a date set, a filing made. If
nothing has actually changed on that thread, do not emit a card for it at all; a brief that repeats
yesterday's card as though it were news is worse than a shorter brief.

=== HONESTY RULES THAT OVERRIDE COMPLETENESS ===

- A card built on an action whose substance was never retrieved (evidenceBasis "title_only") may not
  assert what the document says. Either skip it or write what_changed as the fact of the filing
  itself and say the text was not retrieved.
- Prefer fewer, better-grounded cards. There is no quota.
- If the market series available do not in fact corroborate the mechanism, say so in the weak link
  rather than implying they do.`;

/**
 * The per-run user turn. Everything here changes between runs, so nothing in it may move into the
 * system prompt without breaking the cache.
 */
export function synthesisUserTurn({ dateLabel, edition, actions, evidenceMenu, priorThreads, missingLayers }) {
  const missing = missingLayers?.length
    ? `\n\n=== EVIDENCE LAYERS UNAVAILABLE THIS RUN ===\nThese sources failed or were not reachable, and NOTHING from them is in the evidence menu below. Do not cite them, and do not assume what they would have shown:\n${missingLayers.map((m) => `  - ${m}`).join("\n")}`
    : "";

  const prior = priorThreads?.length
    ? `\n\n=== THREADS ALREADY CARDED RECENTLY (write an update, or skip) ===\n${priorThreads
        .map((p) => `  - ${p.eventKey} — carded ${p.createdAt.slice(0, 16).replace("T", " ")} as certainty "${p.certainty}": ${p.whatChanged}`)
        .join("\n")}`
    : "";

  return (
    `Date: ${dateLabel}\nEdition: ${edition.toUpperCase()}` +
    missing +
    prior +
    `\n\n=== EVIDENCE MENU — the ONLY ids you may cite ===\n${evidenceMenu}` +
    `\n\n=== GOVERNMENT ACTIONS (JSON) ===\n${JSON.stringify(actions, null, 1)}`
  );
}
