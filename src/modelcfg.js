// modelcfg.js — per-model request quirks, in ONE place, so a model upgrade in .env can never 400 a call.
//
// WHY THIS EXISTS. Five call sites hard-coded `thinking: { type: "disabled" }` (storylines, the policy
// card stage, the prose brief, item summaries, and — by omission — signal cards). That is valid on
// Sonnet 5 / Opus 4.8, but it is REJECTED (HTTP 400) on Sonnet 5.5, and Opus 5.5 / Fable cannot disable
// thinking at all. Model names live in .env by design, so the first person to set
// BRIEF_MODEL=claude-sonnet-5-5 would have silently broken every one of those features at once — each
// call is wrapped in a try/catch that only logs. Routing through `thinkingOff()` makes "no thinking,
// please" mean the right thing on whatever model is configured.
//
// HOW TO ADD A NEW MODEL (GitHub #42).
// 1. Add one line to THINKING_MODE_TABLE below — prefix, mode, and a comment explaining why.
// 2. If the mode is new, add a branch in the switch inside thinkingOff().
// 3. Add a test case to test/modelcfg.test.js.
// More-specific prefixes must appear BEFORE less-specific ones (e.g. "claude-sonnet-5-5" before "claude-sonnet-5").

/**
 * Thinking-mode table.  Checked in order; first prefix match wins.
 *
 *   "between_tools"  → thinking:{type:"between_tools"}   Sonnet 5.5 documented off-switch
 *   "effort_low"     → output_config.effort="low"        Opus 5.5 / Fable / Mythos can't disable thinking
 *   "omit"           → send nothing                      Pre-4.6 models ignore / reject thinking params
 *   "disabled"       → thinking:{type:"disabled"}        Sonnet 5, Opus 4.6-4.8, Sonnet 4.6
 *
 * Unknown models: warning logged, "omit" used as the safe default (avoids HTTP 400s).
 * @type {Array<{prefix:string, mode:string}>}
 */
export const THINKING_MODE_TABLE = [
  // ── Sonnet 5.5 — "between_tools" is its documented off-switch ──────────────
  { prefix: "claude-sonnet-5-5",  mode: "between_tools" },

  // ── Opus 5.5 / Fable / Mythos — thinking cannot be disabled at all ─────────
  { prefix: "claude-opus-5-5",    mode: "effort_low"    },
  { prefix: "claude-fable",       mode: "effort_low"    },
  { prefix: "claude-mythos",      mode: "effort_low"    },

  // ── Pre-4.6 / no-thinking models — omit the param entirely ─────────────────
  // (sending {type:"disabled"} is harmless on a few but a 400 on others; omit cleanly)
  { prefix: "claude-haiku",       mode: "omit"          },
  { prefix: "claude-3-",          mode: "omit"          },
  { prefix: "claude-sonnet-4-5",  mode: "omit"          },
  { prefix: "claude-sonnet-4-4",  mode: "omit"          },
  { prefix: "claude-sonnet-4-3",  mode: "omit"          },
  { prefix: "claude-sonnet-4-2",  mode: "omit"          },
  { prefix: "claude-sonnet-4-1",  mode: "omit"          },
  { prefix: "claude-sonnet-4-0",  mode: "omit"          },
  { prefix: "claude-opus-4-5",    mode: "omit"          },
  { prefix: "claude-opus-4-4",    mode: "omit"          },
  { prefix: "claude-opus-4-3",    mode: "omit"          },
  { prefix: "claude-opus-4-2",    mode: "omit"          },
  { prefix: "claude-opus-4-1",    mode: "omit"          },
  { prefix: "claude-opus-4-0",    mode: "omit"          },

  // ── Models that accept {type:"disabled"} ────────────────────────────────────
  // NOTE: "claude-sonnet-5-5" above (between_tools) must stay before "claude-sonnet-5" here.
  { prefix: "claude-sonnet-4-6",  mode: "disabled"      },
  { prefix: "claude-opus-4-6",    mode: "disabled"      },
  { prefix: "claude-opus-4-7",    mode: "disabled"      },
  { prefix: "claude-opus-4-8",    mode: "disabled"      },
  { prefix: "claude-sonnet-5",    mode: "disabled"      }, // catches sonnet-5 but NOT sonnet-5-5 (above)
  { prefix: "claude-opus-5",      mode: "disabled"      }, // catches opus-5 but NOT opus-5-5 (above)
];

/**
 * Resolve the thinking mode for a model slug.
 * Returns one of: "between_tools" | "effort_low" | "omit" | "disabled".
 * Logs a warning and returns "omit" for unrecognised models (safe default — no 400).
 * @param {string} model
 * @returns {string}
 */
export function resolveThinkingMode(model) {
  const m = String(model ?? "");
  for (const { prefix, mode } of THINKING_MODE_TABLE) {
    if (m.startsWith(prefix)) return mode;
  }
  // Unknown model — log loudly so the problem is visible before any 400 occurs.
  // Add the new model to THINKING_MODE_TABLE in src/modelcfg.js to silence this.
  console.warn(
    `⚠️  modelcfg: unrecognised model "${m}" — cannot determine thinking mode. ` +
    `Add an entry to THINKING_MODE_TABLE in src/modelcfg.js. ` +
    `Using "omit" (no thinking param) to avoid HTTP 400.`
  );
  return "omit";
}

/**
 * Mutate `request` so the model spends as little as possible on thinking.
 * See THINKING_MODE_TABLE for the per-model mapping.
 * @returns the same request object, for chaining
 */
export function thinkingOff(request) {
  delete request.thinking;
  const mode = resolveThinkingMode(request?.model);
  switch (mode) {
    case "between_tools":
      request.thinking = { type: "between_tools" };
      break;
    case "effort_low":
      request.output_config = { ...(request.output_config ?? {}), effort: "low" };
      break;
    case "disabled":
      request.thinking = { type: "disabled" };
      break;
    case "omit":
    default:
      // No param — already deleted above.
      break;
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
