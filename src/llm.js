// llm.js — one place to construct the Anthropic client so every call site gets the
// same operational hardening.
//
// The SDK already retries 429/529/5xx with exponential backoff (honoring Retry-After);
// what it does NOT do by default is cap how long a single request may hang. Twice-daily
// runs are serialized behind one in-flight lock, so a stuck call would otherwise block
// the scheduled edition (and any manual run) for the SDK's 10-minute default × retries.
// A tight timeout turns "hang" into "retry, then fail-soft".

import Anthropic from "@anthropic-ai/sdk";

// 120s is comfortably above our largest call (Opus analyst note + adaptive thinking,
// max_tokens 12k) while still bounding a stall. Override with ANTHROPIC_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 120_000;

/** Construct the shared Anthropic client. Throws early if the key is missing. */
export function anthropicClient(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  }
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: Number(env.ANTHROPIC_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxRetries: 2, // SDK default, made explicit: 429/529/5xx with exponential backoff
  });
}
