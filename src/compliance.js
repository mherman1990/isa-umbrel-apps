// compliance.js — the "education, never advice" guardrails for FARMER-FACING market outputs.
//
// ⚠️ DECOUPLED 2026-07-11 (platform split — see docs/STAFF_TOOL_REBUILD.md). Bean Brief is now a
// staff-only internal analysis tool and these guardrails are NO LONGER injected into its prompts.
// This module is retained INTACT as the reusable compliance filter that the future, separate
// farmer-facing tool will run Bean Brief's data through before it reaches farmers. Do not delete;
// do not re-wire it into internal outputs. It stays the single home of the "never advise" rules.
//
// The check explains what is happening / what history shows and NEVER tells a farmer to buy, sell,
// hold, or store — a defense-in-depth filter on OUTPUT (docs/BEANBRIEF_MARKETING_CONTEXT.md §2.2)
// plus the standard footer.

// Intents that must never appear in a card. Kept deliberately narrow to avoid false positives on
// legitimate education (e.g. "storage has real costs", "the market wants grain later").
const BANNED = [
  /\byou should (?:sell|buy|hold|store|price|wait)\b/i,
  /\b(?:we recommend|our advice|our recommendation|the smart move|the right move|best to)\b/i,
  /\bnow is (?:a )?(?:good|bad|great) time to (?:sell|buy|price|hold|store)\b/i,
  /\bprices? (?:will|are going to|is going to|should) (?:rise|fall|climb|drop|go up|go down|increase|decrease)\b/i,
  /\b(?:you should|you'd|you ought to|consider) (?:selling|buying|holding|pricing|hedging)\b/i,
  /\b(?:sell|price|market) (?:your|the) (?:beans|grain|soybeans|crop) now\b/i,
];

/** Scan card text for advice-like phrasing. Returns the matched snippets (empty = clean). */
export function scanBanned(text) {
  const hits = [];
  for (const re of BANNED) {
    const m = re.exec(text || "");
    if (m) hits.push(m[0]);
  }
  return hits;
}

/** The standard education footer (paraphrased, per §2.3 — one per card, never stacked). */
export const EDUCATION_FOOTER =
  "Seasonal and historical patterns are a baseline expectation, not a forecast — they don't hold every year. This is general market education, not a recommendation to buy, sell, or hold; decisions should reflect your own costs, cash-flow needs, risk tolerance, and, where appropriate, your own marketer or advisor.";

/** The compliance instructions to embed in the card-synthesis system prompt. */
export const COMPLIANCE_RULES = `HARD COMPLIANCE RULES (never violate — this is education, not advice):
- NEVER tell a farmer what to do with their grain: no "sell", "buy", "hold", "store now", "wait", "price now", "hedge", or any personalized recommendation, however softly phrased.
- NEVER predict prices ("prices will rise/fall"). Say what history HAS done or what the market IS doing instead.
- NEVER say "now is a good/bad time" or "we recommend / the smart move is".
- Every card is exactly ONE type: WHAT'S HAPPENING (a factual scheduled event), WHAT HISTORY SHOWS (a seasonal/statistical pattern — you MUST state the sample and the caveat, e.g. "in X of the last Y years… not every year"), or REVIEW YOUR PLAN (prompts the farmer toward their own numbers/advisor, never a directive).
- To teach pre-harvest timing safely, you may explain the Revenue Protection Harvest Price Option mechanic (the guarantee settles on the higher of the February spring price or the October harvest price) — explain how the product works, never recommend a sale.
- Ground every claim in the provided data; if a figure isn't provided, don't invent it.`;
