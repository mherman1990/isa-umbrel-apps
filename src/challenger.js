// challenger.js — Phase 3b. One adversarial pass over a note's theses before anyone reads them.
//
// WHY THIS EXISTS, AND WHY THE CHECKS ARE THE CHECKS. Every column in `thesis_challenges` is a
// failure this repo has actually shipped to the reader, not a hypothetical:
//   - `duplicate_sources`      — v1.27.0 found nine "Aug 6 deadlines" that were THREE Federal
//                                Register notices cross-filed; 19% of a "relevant" feed was one
//                                document repeated. Repetition read as corroboration.
//   - `series_measures_claim`  — a yield call resolved against the SOIL MOISTURE series that
//                                motivated it, so it scored a hit for the wrong reason.
//   - `history_sufficient`     — seasonal norms computed from ONE year; a volume percentile that
//                                pinned bullish for eight months while crush fell 10%.
//   - `seasonal_risk`          — the same, seen from the other side.
//   - `evidence_precedes_outcome` — the ordering error that makes a coincidence look causal.
// A model asked "is this thesis good?" answers vaguely. Asked these six, it answers checkably.
//
// BATCHED, ONE CALL PER NOTE. The most valuable checks are INTER-thesis — "are two of these the same
// event?", "does the note rest twice on one datapoint?" — and a per-thesis call cannot see them by
// construction. Cheapen the CONTEXT and the EFFORT, not the model: the Challenger tracks the
// analyst's model because it has to be able to out-argue it.
//
// ⚠️ MODEL-GENERATION CAVEAT, worth re-reading before spending more on this. Opus 5 verifies its own
// work unprompted, and instructions telling it to verify cause OVER-verification. The analyst runs
// Opus 4.8 today, where this earns its keep. If ANALYST_MODEL moves to Opus 5, check
// `store.challengeScorecard()` — an approve rate near 100% after ~20 notes is the stated kill
// criterion, and the honest response is to delete this file, not to tune it.

import Anthropic from "@anthropic-ai/sdk";
import { demote } from "./thesis.js";

/** Verdicts, in the order a reader would consider them. `reject` removes the thesis from the note. */
export const VERDICTS = ["approve", "add_caveat", "lower_confidence", "human_review", "reject"];

export const CHALLENGE_SCHEMA = {
  type: "object",
  properties: {
    challenges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          thesis_index: { type: "integer", description: "0-based index of the thesis being judged, exactly as numbered in the input." },
          verdict: {
            type: "string",
            enum: VERDICTS,
            description:
              "approve = the read holds as stated. add_caveat = it holds but a named limitation must be shown. lower_confidence = the evidence does not support the confidence claimed. human_review = you cannot judge it from what you were given. reject = it is wrong or rests on an error.",
          },
          reason: { type: "string", description: "One or two sentences. Say what is actually wrong, not that you checked." },
          caveat: { type: "string", description: "The limitation to render beside the thesis, in the reader's language. Empty string when the verdict is approve." },
          relationship: {
            type: "string",
            enum: ["independent", "duplicate_of_other_thesis", "depends_on_other_thesis", "contradicts_other_thesis"],
            description: "How this thesis relates to the OTHERS in the same note. This is the check a per-thesis pass cannot make.",
          },
          evidence_precedes_outcome: {
            type: "string",
            enum: ["yes", "no", "unknown"],
            description: "Does the cited evidence actually predate the effect it is used to explain? 'no' means the causal story is running backwards.",
          },
          seasonal_risk: { type: "string", enum: ["none", "possible", "likely"], description: "Could a normal seasonal pattern produce this without the claimed mechanism?" },
          duplicate_sources: {
            type: "string",
            enum: ["none", "some", "all"],
            description: "Do the cited ids resolve to the SAME underlying event? 'all' means the thesis rests on one datapoint that looks like several.",
          },
          series_measures_claim: {
            type: "string",
            enum: ["yes", "no", "not_applicable"],
            description: "Does the falsifiable claim's series measure the CLAIM'S SUBJECT, or merely a driver of it? 'no' means it will resolve for the wrong reason.",
          },
          history_sufficient: {
            type: "string",
            enum: ["yes", "no", "unknown"],
            description: "Is there enough stored history behind the cited series to support a percentile, a norm or a seasonal read?",
          },
        },
        required: [
          "thesis_index",
          "verdict",
          "reason",
          "caveat",
          "relationship",
          "evidence_precedes_outcome",
          "seasonal_risk",
          "duplicate_sources",
          "series_measures_claim",
          "history_sufficient",
        ],
        additionalProperties: false,
      },
    },
    note_level_concern: {
      type: "string",
      description: "One sentence about the note AS A WHOLE — e.g. every thesis leaning on the same datapoint. Empty string if none.",
    },
  },
  required: ["challenges", "note_level_concern"],
  additionalProperties: false,
};

const SYSTEM =
  "You are the adversarial reviewer for an agricultural-markets analyst note. The theses below have already been written and grounded; " +
  "your job is to find what is WRONG with them before the reader acts on them.\n\n" +
  "You are not a second opinion and not an editor. Do not rewrite, do not add analysis, do not praise. For each thesis return a verdict and the six structured checks.\n\n" +
  "THE CHECKS EXIST BECAUSE EACH ONE HAS ALREADY GONE WRONG IN THIS SYSTEM:\n" +
  "- duplicate_sources: several evidence ids that resolve to the same underlying event. One document cross-filed in four places is ONE piece of evidence. Repetition is not corroboration.\n" +
  "- series_measures_claim: the falsifiable claim's series must measure the claim's SUBJECT, not a driver of it. A yield claim resolved against a soil-moisture series scores a hit whenever soil dries out, which it will anyway.\n" +
  "- history_sufficient: a percentile, a 'record for the month' or a seasonal norm needs years of stored history. Computed from one or two, it is noise with a confident label.\n" +
  "- seasonal_risk: could the ordinary seasonal pattern produce this without the claimed mechanism?\n" +
  "- evidence_precedes_outcome: does the evidence predate the effect it explains?\n" +
  "- relationship: how each thesis relates to the OTHERS. Two theses resting on one datapoint is a note that is less diversified than it looks.\n\n" +
  "BE WILLING TO APPROVE. A thesis that is correctly hedged, properly grounded and honestly scoped should get `approve` — inventing objections to look rigorous is its own failure, and a reviewer who never approves is as useless as one who always does.\n" +
  "Where the LEAD-LAG section reports no significant leads, that is the CORRECT result of a multiple-comparison-corrected scan, not a gap. Do not treat it as missing evidence.";

/**
 * One batched adversarial pass. Fail-soft: returns null on any problem, and the caller renders the
 * theses unchallenged rather than losing them. An unchallenged thesis is stored with a null verdict,
 * so the database can always tell "approved" from "never reviewed".
 */
export async function challengeTheses(theses, { context = "", env = process.env, client = null, recordUsage = null } = {}) {
  if (!theses?.length) return null;
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");

  const anthropic = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // Tracks the analyst's model on purpose — a cheaper reviewer cannot out-argue the writer. The
  // saving comes from `effort: medium`, no web search and a small context, not from a weaker model.
  const model = env.CHALLENGER_MODEL || env.ANALYST_MODEL || "claude-opus-4-8";

  const thesisBlock = theses
    .map((t, i) =>
      [
        `--- THESIS ${i} ---`,
        `claim: ${t.thesis}`,
        `narrative: ${t.narrative}`,
        `mechanism: ${t.mechanismChain.join(" -> ")}`,
        `confidence_stated: ${t.confidenceStated}${t.confidence !== t.confidenceStated ? ` (already lowered to ${t.confidence} — evidence did not resolve)` : ""}`,
        `horizon_days: ${t.horizonDays}`,
        `supporting_evidence: ${t.supportingEvidence.join(", ") || "(none resolved)"}`,
        `counterevidence: ${t.counterevidence.join(", ") || "(none)"}`,
        `alternative_explanations: ${t.alternativeExplanations.join(" | ") || "(none)"}`,
        `invalidated_by: ${t.invalidate}`,
        `falsifiable_claim: ${t.falsifiableClaim?.claim ?? "(none)"} [comparator=${t.falsifiableClaim?.comparator ?? "?"}, series=${t.falsifiableClaim?.series || "(none)"}]`,
      ].join("\n")
    )
    .join("\n\n");

  let resp;
  try {
    resp = await anthropic.messages.create({
      model,
      max_tokens: 6000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: CHALLENGE_SCHEMA } },
      // No tools. Same measured reason as thesis.js: a schema-constrained request that also runs a
      // web search fails. The Challenger judges what it was given; it does not go looking.
      system: SYSTEM,
      messages: [{ role: "user", content: `${thesisBlock}\n\n=== SUPPORTING CONTEXT ===\n${context}` }],
    });
  } catch (err) {
    console.log(`⚠️  Thesis challenge skipped: ${err.message}`);
    return null;
  }
  recordUsage?.(model, "challenge", resp.usage.input_tokens, resp.usage.output_tokens, resp.usage);

  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log("⚠️  Thesis challenge: response was not valid JSON despite the schema — skipping");
    return null;
  }
  return {
    challenges: Array.isArray(parsed?.challenges) ? parsed.challenges : [],
    noteLevelConcern: String(parsed?.note_level_concern ?? "").trim(),
    model,
  };
}

/**
 * Apply verdicts to theses. THE RULES ARE ENFORCED HERE, IN CODE, NOT BY THE MODEL'S GOODWILL:
 *
 *   1. Confidence can only ever go DOWN. `demote()` moves exactly one step and floors at low. A
 *      Challenger that could raise confidence would be an amplifier, not a check — and the failure
 *      would be invisible, because a more confident note reads better.
 *   2. An unrecognised or missing verdict becomes `human_review`, never `approve`. Failing open
 *      would mean a malformed response silently blesses every thesis in the note.
 *   3. `reject` removes the thesis from the note but keeps it in the return value, so the caller can
 *      persist it. A rejected read that is merely deleted comes back next week looking new.
 */
export function applyChallenges(theses, challenges) {
  const byIndex = new Map();
  for (const c of Array.isArray(challenges) ? challenges : []) {
    if (Number.isInteger(c?.thesis_index)) byIndex.set(c.thesis_index, c);
  }

  const applied = theses.map((t, i) => {
    const c = byIndex.get(i) ?? null;
    // No challenge at all is NOT approval — it is "never reviewed", and it is recorded as null.
    if (!c) return { ...t, verdict: null, challengeReason: null, caveat: null, rejected: false, checks: null };

    const verdict = VERDICTS.includes(c.verdict) ? c.verdict : "human_review";
    let confidence = t.confidence;
    if (verdict === "lower_confidence") confidence = demote(t.confidence);
    // human_review is not a silent pass: a thesis nobody could judge should not read as confident.
    if (verdict === "human_review" && t.confidence === "high") confidence = demote(t.confidence);

    return {
      ...t,
      confidence,
      verdict,
      challengeReason: String(c.reason ?? "").trim() || null,
      caveat: verdict === "approve" ? null : String(c.caveat ?? "").trim() || null,
      rejected: verdict === "reject",
      checks: {
        relationship: c.relationship ?? null,
        evidencePrecedesOutcome: c.evidence_precedes_outcome ?? null,
        seasonalRisk: c.seasonal_risk ?? null,
        duplicateSources: c.duplicate_sources ?? null,
        seriesMeasuresClaim: c.series_measures_claim ?? null,
        historySufficient: c.history_sufficient ?? null,
      },
    };
  });

  return {
    kept: applied.filter((t) => !t.rejected),
    rejected: applied.filter((t) => t.rejected),
    all: applied,
  };
}

/**
 * "Where this read is weak" — rendered only when something is actually weak.
 *
 * Shown, not hidden. Every correctness fix in this repo has been "state the caveat inline, because
 * it gets compressed away otherwise": a caveat that lives only in the database protects nobody.
 */
export function renderWeakness({ kept, rejected }, noteLevelConcern = "") {
  const flagged = kept.filter((t) => t.verdict && t.verdict !== "approve");
  if (!flagged.length && !rejected.length && !noteLevelConcern) return "";

  const out = ["## Where this read is weak"];
  if (noteLevelConcern) {
    out.push("");
    out.push(`**Across the note:** ${noteLevelConcern}`);
  }
  for (const t of flagged) {
    out.push("");
    out.push(`- **${t.thesis}** — ${t.caveat || t.challengeReason || "flagged on review"}${t.verdict === "lower_confidence" ? ` _(confidence lowered to ${t.confidence})_` : ""}`);
  }
  for (const t of rejected) {
    out.push("");
    out.push(`- ~~${t.thesis}~~ — **removed on review.** ${t.challengeReason || "Rejected by the adversarial pass."}`);
  }
  return out.join("\n");
}
