// panels.js — attempt/outcome bookkeeping for every cached, model-written panel.
//
// WHY THIS EXISTS (Phase 0 audit, docs/AUDIT-2026-10-04.md §3). Storylines, the news digest, market intel
// and signal cards all wrote state ONLY on success. A null return, an empty model answer, a truncated
// JSON body or a thrown API error left nothing behind, so the panel kept rendering the last good output
// as if it were current. Storylines sat on a 2026-09-01 success for a month while every morning's call
// was paid for and discarded, and nothing on screen said so.
//
// Every attempt now records { lastAttemptAt, lastOutcome, lastError, detail } in kv_state under
// `panel_attempt:<kind>`, and on success also lastSuccessAt. Outcomes:
//   ok         — new content persisted
//   empty      — nothing to work from (e.g. no news in the window). Legitimate, but still visible.
//   no_output  — the model answered with nothing usable
//   truncated  — the model hit max_tokens (stop_reason "max_tokens"); output discarded
//   error      — the call threw (API/auth/model id); message in lastError
//   skipped    — not attempted (e.g. the monthly budget guard said no)

import * as store from "./store.js";

export const PANEL_KINDS = ["storylines", "news_digest", "market_intel", "market_cards"];
export const OUTCOMES = ["ok", "empty", "no_output", "truncated", "error", "skipped"];
const key = (kind) => `panel_attempt:${kind}`;

/** Record one attempt. Never throws — bookkeeping must not take down the run it describes. */
export function recordAttempt(kind, outcome, { error = null, detail = null } = {}) {
  try {
    const prev = getAttempt(kind) ?? {};
    const now = new Date().toISOString();
    const rec = {
      ...prev,
      lastAttemptAt: now,
      lastOutcome: outcome,
      lastError: error ? String(error).slice(0, 400) : null,
      detail: detail ?? null,
      ...(outcome === "ok" ? { lastSuccessAt: now } : {}),
      consecutiveFailures: outcome === "ok" || outcome === "empty" ? 0 : (prev.consecutiveFailures ?? 0) + 1,
    };
    store.setState(key(kind), JSON.stringify(rec));
    // Storylines keeps its long-standing meta row; carry the attempt fields alongside generatedAt so
    // anything reading storylines_meta sees both.
    if (kind === "storylines") {
      let meta = {};
      try {
        meta = JSON.parse(store.getState("storylines_meta") || "{}") ?? {};
      } catch {
        meta = {};
      }
      store.setState(
        "storylines_meta",
        JSON.stringify({ ...meta, lastAttemptAt: rec.lastAttemptAt, lastOutcome: rec.lastOutcome, lastError: rec.lastError })
      );
    }
    return rec;
  } catch {
    return null;
  }
}

export function getAttempt(kind) {
  try {
    const v = store.getState(key(kind));
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

/**
 * Run a panel generator and guarantee an attempt is recorded. `fn` should call recordAttempt itself on
 * each of its exits (it knows whether a null means "empty" or "no_output"); this wrapper records
 * `error` on a throw and rethrows, and records a fallback outcome if `fn` returned without recording.
 */
export async function tracked(kind, fn) {
  const before = getAttempt(kind)?.lastAttemptAt ?? null;
  try {
    const result = await fn();
    const after = getAttempt(kind)?.lastAttemptAt ?? null;
    if (after === before) recordAttempt(kind, result ? "ok" : "no_output");
    return result;
  } catch (err) {
    recordAttempt(kind, "error", { error: err?.message ?? String(err) });
    throw err;
  }
}

const HUMAN = {
  empty: "nothing new to work from",
  no_output: "the model returned nothing usable",
  truncated: "the model's answer was cut off at its length limit",
  error: "the call failed",
  skipped: "skipped",
};

/**
 * The line a panel shows when its last attempt did not produce new content. Empty string when the
 * last attempt succeeded (or none has been recorded yet).
 * @param {string} kind
 * @param {(iso:string)=>string} fmt  timestamp formatter for the UI
 */
export function attemptNotice(kind, fmt = (s) => s) {
  const a = getAttempt(kind);
  if (!a || a.lastOutcome === "ok") return "";
  const why = HUMAN[a.lastOutcome] ?? a.lastOutcome;
  const err = a.lastError ? ` (${a.lastError})` : "";
  const since = a.lastSuccessAt ? `last success ${fmt(a.lastSuccessAt)}` : "no recorded success yet";
  const streak = a.consecutiveFailures > 1 ? ` — ${a.consecutiveFailures} attempts in a row` : "";
  return `Last attempt ${fmt(a.lastAttemptAt)}: ${why}${err}${streak}. Showing content from the ${since}.`;
}
