// prompts/policy-domain.js — the stable domain context every policy-brief stage shares.
//
// WHY THIS IS ITS OWN FILE. Three stages need the same domain grounding: the Sonnet synthesis that
// drafts cards, the Opus review that attacks them, and (optionally) triage. Before this, every
// prompt in the codebase was an inline template literal inside the module that used it, which is
// fine for one caller and wrong for three — the reviewer would drift from the writer, and a
// reviewer working from a different definition of "mechanism" than the writer is not a check, it is
// noise.
//
// ⚠️ THIS BLOCK MUST STAY STABLE ACROSS RUNS. It is the cacheable prefix. Interpolating a date, a
// run id, or today's item list into it would invalidate the cache on every request and turn the
// prompt-cache write premium into pure loss — the failure v1.29.0 found on the Ask box. Nothing in
// this file may depend on the current run.
//
// ⚠️ SIZE IS LOAD-BEARING, NOT ACCIDENTAL. Sonnet 5 and Opus will not cache a prefix under 1,024
// tokens; a "tidy up" that trims this to a paragraph would silently stop it caching altogether
// while appearing to work. Locked by test/policy-cards.test.js.
//
// ⚠️ MECHANISM_TERMINALS IS THE SINGLE SOURCE OF TRUTH. The prompt text below is GENERATED from it,
// and policylint.js validates against the same array. Two hand-maintained copies — one describing
// the rule to the model and one enforcing it in code — is how a lint starts rejecting exactly what
// the prompt asked for.

/**
 * The variables a mechanism is allowed to terminate in.
 *
 * The test the list encodes: each of these is something you could in principle look up a number
 * for. "Sentiment" is excluded not because sentiment is unreal but because a claim that ends there
 * cannot be checked, and an unfalsifiable mechanism is the most common way a policy brief sounds
 * analytical while saying nothing.
 */
export const MECHANISM_TERMINALS = [
  {
    id: "rvo_volume",
    label: "RVO volume by D-code",
    gloss: "The Renewable Volume Obligation EPA sets, per renewable-fuel category (D4 biomass-based diesel, D5 advanced, D6 conventional). Raising the D4 obligation raises required biomass-based diesel volume, which is soybean oil demand.",
  },
  {
    id: "rin_generation",
    label: "RIN generation",
    gloss: "How many Renewable Identification Numbers a volume of fuel generates. Pathway approvals, equivalence values and small-refinery exemptions all change generation without changing the RVO.",
  },
  {
    id: "rin_price",
    label: "RIN price",
    gloss: "The traded price of a D4/D6 RIN. It is the clearing price between the obligation and available generation, so it moves on both.",
  },
  {
    id: "ci_score_45z",
    label: "45Z carbon-intensity score",
    gloss: "The CI value assigned to a fuel pathway under the Clean Fuel Production Credit. Model choice (GREET version), feedstock accounting and farm-practice credits all move it.",
  },
  {
    id: "credit_value_45z",
    label: "45Z credit value",
    gloss: "Dollars per gallon a producer earns, which falls as CI rises. It sets how much a producer can pay for soybean oil versus a competing feedstock.",
  },
  {
    id: "crush_margin",
    label: "crush margin",
    gloss: "Board or cash margin between soybeans and the combined meal + oil value. It is the variable that decides whether a plant runs, so it is the usual last step before 'soybean demand'.",
  },
  {
    id: "basis",
    label: "cash basis",
    gloss: "Local cash price minus futures. Processor basis is where a crush-economics change reaches an Iowa farmer first.",
  },
  {
    id: "export_program_eligibility",
    label: "export program eligibility",
    gloss: "Whether a destination, buyer or product qualifies under a USDA/FAS program, a sanitary/phytosanitary agreement, or a sustainability rule such as EUDR.",
  },
  {
    id: "tariff_line",
    label: "tariff line",
    gloss: "A specific HTS line's duty rate, or a retaliatory list that a soybean/soy-product line sits on. Name the line or the product, not 'trade tension'.",
  },
  {
    id: "label_availability",
    label: "crop-protection label availability",
    gloss: "Whether an active ingredient may lawfully be applied to a crop — registration, tolerance, ESA consultation, or a vacatur. It reaches yield and cost per acre.",
  },
  {
    id: "acreage_signal",
    label: "acreage signal",
    gloss: "The soybean:corn price ratio or a program payment that shifts planted acres, and therefore next year's supply.",
  },
  {
    id: "production_cost",
    label: "per-acre production cost",
    gloss: "An input, compliance or reporting cost that lands on the operation directly.",
  },
];

/** Terminals that are never acceptable — the vague endings this contract exists to reject. */
export const BANNED_TERMINALS = ["sentiment", "uncertainty", "market psychology", "confidence", "mood", "optimism", "pessimism"];

/** The four procedural states. Not a confidence ladder — each asserts a different fact about WHERE
 *  an action sits, which is why the renderer separates them visually rather than shading them. */
export const CERTAINTY_STATES = [
  { id: "enacted", gloss: "Final and in force, or signed and dated. A primary source must establish this." },
  { id: "proposed", gloss: "Published but not final — a proposed rule, an introduced bill, a request for comment. It may never take effect." },
  { id: "contested", gloss: "Final but under active challenge — litigation, a stay, a vacatur on appeal, a repeal effort with a live vehicle." },
  { id: "speculative", gloss: "Reported, signalled or expected, but not yet published as an action. An agency official's remark belongs here." },
];

const terminalList = MECHANISM_TERMINALS.map((t) => `  - ${t.id} (${t.label}) — ${t.gloss}`).join("\n");
const certaintyList = CERTAINTY_STATES.map((c) => `  - ${c.id}: ${c.gloss}`).join("\n");

/**
 * The shared block. Prefixed to the synthesis and review system prompts, in that position, so both
 * share one cacheable prefix.
 */
export const POLICY_DOMAIN_CONTEXT = `You are working on The Bean Brief, the Iowa Soybean Association's policy and market intelligence tool. The reader is ISA's Chief Officer for Demand & Policy and his team. They are expert in the subject matter and do not need terms explained; they need to know what changed, whether it is real yet, and what it does to a number.

This is an INTERNAL STAFF tool. A clear analytical read is welcome and expected. It is not farmer-facing and it is not marketing advice.

=== WHAT MAKES AN ITEM BELONG IN THIS BRIEF ===

The test is: would this item still be worth attention if the futures board had not moved at all today? A regulatory, legislative, trade or judicial development is the SUBJECT. Market data is CORROBORATION — it shows the transmission mechanism is real, or that it is not yet visible. Market data is never the lede here; a price move with no policy action behind it belongs in a different report.

=== THE CAUSAL CHAIN THAT MATTERS ===

Most of what moves soybean and biomass-based diesel demand runs through a small number of well-defined levers. A mechanism must terminate in one of these variables:

${terminalList}

These endings are NEVER acceptable, because nothing can check them: ${BANNED_TERMINALS.join(", ")}. If the only honest ending you can reach is one of those, the mechanism is not established and the card should say so rather than dress it up.

State the mechanism as an ordered chain, each step following from the last, ending at the named variable. Two steps is the minimum — a one-step claim is an observation, not a mechanism. If a step is genuinely uncertain, say which step and why; a chain with a named weak link is far more useful than a confident chain that hides it.

=== PROCEDURAL POSTURE ===

The single most damaging error this brief can make is letting a reader treat a proposed rule as settled. Posture is therefore never optional and never vague. State the procedural status AND the clock:
  - proposed / comment period open — give the comment close date
  - final — give the effective date
  - interim final or direct final — say which, and give the date objections are due
  - litigation — name the court and the posture (motion pending, stay granted, argued, vacated, on appeal)
  - statutory or court-ordered deadline — give the date the agency is obliged to act by
  - guidance or notice — say plainly that it does not itself change an obligation

For a comment period or a litigation schedule, the CLOCK IS OFTEN THE ONLY ACTIONABLE FACT in the item. Never omit it, and never write "soon" or "in the coming weeks" when a date exists in the source.

=== CERTAINTY ===

Every card carries exactly one certainty state:
${certaintyList}

Grade the ACTION, not your confidence in your own analysis. A final rule you find unconvincing is still "enacted"; a proposal you are sure will pass is still "proposed".

=== EVIDENCE AND PROVENANCE ===

Every piece of evidence carries a provenance grade, strongest first: primary source (the government's own record — the Federal Register document, the docket, the bill text, the opinion), then agency press release, then trade press, then general press, then aggregator.

Where a primary source and a news report cover the same action, the primary source governs and the news report is corroboration. A trade group's press release about a rule is an INTERESTED PARTY'S CHARACTERISATION of that rule, never the rule itself — attribute it to them by name.

Quotes drawn from an evidence packet have already been verified in code as verbatim substrings of the source document. Reproduce them exactly; never tidy, trim or paraphrase a verified quote.

=== WHAT NOT TO DO ===

- Do not invent an item, a number, a date or a docket. If it is not in the supplied data, it does not exist.
- Do not present one action filed in several dockets as several corroborating signals. Repetition is not evidence.
- Do not forecast a price or imply a direction to trade. Explain what a policy change does to a variable; the reader decides what that means for them.
- Do not describe a document nobody retrieved. If only a headline was captured, say so plainly.
- Do not fill a gap the source leaves open with general knowledge. "The notice does not address X" is a finding, not a failure.`;
