// modelcfg.js — per-model request quirks, in ONE place, so a model upgrade in .env can never 400 a call.
//
// WHY THIS EXISTS. Five call sites hard-coded `thinking: { type: "disabled" }` (storylines, the policy
// card stage, the prose brief, item summaries, and — by omission — signal cards). That is valid on
// Sonnet 5 / Opus 4.8, but it is REJECTED (HTTP 400) on Sonnet 5.5, and Opus 5.5 / Fable cannot disable
// thinking at all. Model names live in .env by design, so the first person to set
// BRIEF_MODEL=claude-sonnet-5-5 would have silently broken every one of those features at once — each
// call is wrapped in a try/catch that only logs. Routing through `thinkingOff()` makes "no thinking,
// please" mean the right thing on whatever model is configured.

/**
 * Mutate `request` so the model spends as little as possible on thinking:
 *   Sonnet 5.5          → thinking {type:"between_tools"}  (its documented thinking-off mode)
 *   Opus 5.5 / Fable    → thinking can't be disabled; omit it and set effort "low"
 *   Haiku 4.5 / ≤4.5    → omit (those models don't think unless asked)
 *   everything else     → thinking {type:"disabled"}  (Sonnet 5, Opus 4.6–5)
 * @returns the same request object, for chaining
 */
export function thinkingOff(request) {
  const m = String(request?.model ?? "");
  delete request.thinking;
  if (/^claude-sonnet-5-5/.test(m)) {
    request.thinking = { type: "between_tools" };
  } else if (/^claude-(opus-5-5|fable|mythos)/.test(m)) {
    request.output_config = { ...(request.output_config ?? {}), effort: "low" };
  } else if (/^claude-(haiku|3-|sonnet-4-5|opus-4-5|opus-4-1|sonnet-4-|opus-4-)(?!6|7|8)/.test(m) && !/^claude-(opus-4-[678]|sonnet-4-6)/.test(m)) {
    // pre-4.6 models: no thinking unless explicitly enabled — sending `disabled` is harmless but pointless
  } else {
    request.thinking = { type: "disabled" };
  }
  return request;
}

/**
 * Spreadable form for object-literal call sites: `...thinkingOffFields(model, outputConfig)`.
 * Pass the call's own output_config (if any) so an effort setting is MERGED into it, never clobbered.
 */
export function thinkingOffFields(model, outputConfig = null) {
  const r = thinkingOff({ model, ...(outputConfig ? { output_config: outputConfig } : {}) });
  delete r.model;
  return r;
}

/** True when a response was cut off by max_tokens (the model did not finish). */
export const wasTruncated = (resp) => resp?.stop_reason === "max_tokens";
