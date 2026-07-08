// compliance.js — the "education, never advice" guardrails for BeanBrief's farmer cards.
//
// BeanBrief explains what is happening and what history shows; it NEVER tells a farmer to buy,
// sell, hold, or store. The synthesis prompt enforces this, and this module is the defense-in-
// depth check on the OUTPUT (docs/BEANBRIEF_MARKETING_CONTEXT.md §2.2) plus the standard footer.

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
