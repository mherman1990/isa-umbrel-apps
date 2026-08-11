// pricing.js — model list prices and the one cost formula.
//
// EXTRACTED FROM pipeline.js, unchanged. It moved because it now has a SECOND caller with a very
// different job: `audit` prints a monthly estimate after the fact, while the daily brief's cost
// ceiling has to answer "what has this run spent so far?" mid-run and abort. Leaving the table in
// pipeline.js would have meant either a duplicate copy (two tables drifting apart the next time
// Anthropic changes a price) or brief.js importing pipeline.js, which imports brief.js.
//
// ⚠️ THE CACHE MULTIPLIERS ARE THE PART THAT IS EASY TO GET WRONG. `usage.input_tokens` is the
// UNCACHED REMAINDER, not the total input — cached tokens are reported separately. A cost formula
// that sums only `input_tokens` therefore makes prompt caching look free, which is the bug v1.29.0
// found in `audit`. Every caller must add all three components, which is why `costOf` exists rather
// than each site doing its own arithmetic.

/** Rough list prices per 1M tokens. Update if Anthropic pricing changes. */
export const PRICES = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  // Opus 5 is priced identically to Opus 4.8, so ANALYST_MODEL can move between them as a one-line
  // .env change with no cost difference. Listed explicitly because an unlisted model falls back to
  // the Sonnet default below, which would under-report Opus spend by 40%.
  "claude-opus-5": { input: 5.0, output: 25.0 },
};

/** Prompt-cache billing multipliers, applied to the model's INPUT rate. A 5-minute-TTL write costs
 *  1.25x and a read 0.1x, so a cached prefix pays for itself on the second request that hits it. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** The Sonnet rate is the fallback for an unlisted model — deliberately not the cheapest, so a model
 *  nobody added to the table under-reports as little as possible. */
const DEFAULT_PRICE = PRICES["claude-sonnet-5"];

/**
 * Dollar cost of one call (or one aggregated row).
 * @param {string} model
 * @param {{input?:number, output?:number, cacheRead?:number, cacheWrite?:number}} t token counts;
 *   `input` must be the UNCACHED remainder, exactly as the API reports `usage.input_tokens`.
 */
export function costOf(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  const p = PRICES[model] ?? DEFAULT_PRICE;
  return (
    (input * p.input +
      output * p.output +
      cacheRead * p.input * CACHE_READ_MULTIPLIER +
      cacheWrite * p.input * CACHE_WRITE_MULTIPLIER) /
    1e6
  );
}
