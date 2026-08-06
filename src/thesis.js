// thesis.js — Phase 3a. Turn an analyst note's assertions into STRUCTURED, GROUNDED theses.
//
// ⚠️ WHY THIS IS A SECOND CALL AND NOT PART OF THE ANALYST CALL. The plan for this phase assumed
// one Opus call could emit prose AND schema-constrained claims together, which would have deleted
// the Haiku extraction step. It cannot. Measured 2026-08-06 against `claude-opus-4-8`:
//
//   schema only, no tools ................................ OK (11s)
//   web_search only, no schema ........................... OK (60s and 382s runs)
//   schema + web_search DECLARED but never invoked ....... OK (37s)  <- the request VALIDATES
//   schema + web_search actually running ................. FAILED 5/5
//
// The five failures were 3 non-streaming (~144s/186s/173s), one connection drop (189s) and one
// streaming (62s) — every one an `overloaded_error`, never a 400. The control that settles it: in
// the final run the no-schema search call SUCCEEDED after 382 seconds while the schema version
// FAILED after 61, so this is not "the API was slow". It breaks only once a search actually runs.
//
// Note the plan's predicted mechanism was wrong, which is worth recording so nobody re-tests it:
// it expected a 400 because "web-search results carry citations and structured outputs 400 with
// citations". Citations never appeared — `text_has_citations` was false in both successful search
// runs. The documented citations/structured-outputs conflict is about `citations:{enabled:true}` on
// a *document* content block, not web search.
//
// `overloaded_error` is officially transient, so this is not provably a permanent contract limit.
// But 5/5 against passing same-moment controls is enough to design around, and two calls is the
// more robust shape regardless: the note is worth saving even when structuring fails.
//
// ⚠️ COST CONSEQUENCE, STATED OUT LOUD. Because this is a second call rather than a free rider on
// the analyst call, Phase 3 no longer *deletes* the Haiku extraction — it *replaces* it. The plan's
// "+$1.06/mo" assumed the deletion.
//
// This defaulted to the brief model (Sonnet 5) on cost grounds and now defaults to the ANALYST's
// model. The cost reasoning was sound and the conclusion was still wrong: deciding which of a
// note's assertions are falsifiable, which evidence actually supports each one, and what would
// invalidate it is judgement, not transcription. A weaker model here produces well-formed theses
// that quietly mis-attribute evidence — and because every downstream guard is mechanical (ids
// resolve or they don't), a plausible-but-wrong attribution passes every check we have.
// Override with THESIS_MODEL to trade back down deliberately.

import Anthropic from "@anthropic-ai/sdk";

/** Confidence is ordered so the Challenger can only ever demote — see `demote()`. */
export const CONFIDENCE_ORDER = ["low", "medium", "high"];

// Bounds the plan specified as schema constraints. They are NOT in the schema, because the API
// rejects them: `minItems` values other than 0 or 1 return
//   "output_config.format.schema: For 'array' type, 'minItems' values other than 0 or 1 are not
//    supported (got: [2, 5])"
// (measured 2026-08-06; `minimum`/`maximum` and string-length constraints are refused the same way).
// So the bounds live here and are enforced by `applyBounds` after the response comes back. Checked
// at the time: no shipped schema uses minItems/maxItems, so this is a new constraint, not a bug.
export const BOUNDS = {
  mechanism_chain: { min: 2, max: 5 },
  supporting_evidence: { min: 1, max: 6 },
  counterevidence: { min: 0, max: 4 },
  alternative_explanations: { min: 1, max: 3 },
};

export const THESIS_SCHEMA = {
  type: "object",
  properties: {
    theses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          thesis: { type: "string", description: "The claim in one sentence. What you believe is true or about to be true." },
          narrative: { type: "string", description: "2-4 sentences of prose stating the read. This IS the rendered text — write it for the reader, not as notes." },
          horizon_days: { type: "integer", description: "Days until this can be judged. 30 for 'the next month', 90 for 'this quarter'." },
          mechanism_chain: {
            type: "array",
            items: { type: "string" },
            description: "The causal steps from cause to effect, one per entry, in order. 2 to 5 steps. A chain you cannot state in at least two steps is an observation, not a thesis.",
          },
          supporting_evidence: {
            type: "array",
            items: { type: "string" },
            description:
              "Evidence IDs ONLY, 1 to 6 of them, each copied EXACTLY from the EVIDENCE IDS list you were given. Never invent one, never reformat one. Anything not on that list is dropped before the note renders.",
          },
          counterevidence: { type: "array", items: { type: "string" }, description: "Evidence IDs that cut against the thesis, 0 to 4. Same rules." },
          alternative_explanations: {
            type: "array",
            items: { type: "string" },
            description: "At least one other reading of the same evidence, in prose. A thesis with no alternative reading is unexamined — there is always at least one.",
          },
          confidence: { type: "string", enum: ["low", "medium", "high"], description: "How firmly the note asserted it. Hedged language ('may', 'could', 'risks') is low." },
          confirm: { type: "string", description: "The specific observation that would CONFIRM this — a named report, print or release." },
          invalidate: { type: "string", description: "The specific observation that would KILL this. If you cannot name one, the thesis is not falsifiable and should not be here." },
          falsifiable_claim: {
            type: "object",
            description: "The ledger row for this thesis, worded so it can be scored against a stored series later.",
            properties: {
              claim: { type: "string", description: "The falsifiable claim in one sentence." },
              comparator: {
                type: "string",
                enum: ["rises", "falls", "stays_flat", "stays_above", "stays_below", "not_measurable"],
                description:
                  "How it settles. rises/falls for a DIRECTIONAL claim. stays_above/stays_below for a LEVEL claim, with the number in `threshold`. not_measurable when no stored series can settle it.",
              },
              threshold: { type: "number", description: "The level for stays_above / stays_below, in the series' own unit. 0 for every other comparator." },
              direction: { type: "string", enum: ["up", "down", "flat", "n/a"], description: "Keep consistent with comparator (rises→up, falls→down, stays_flat→flat, else n/a)." },
              series: {
                type: "string",
                description:
                  "EXACT market_series id that MEASURES THE CLAIM'S SUBJECT — not a driver of it. If the claim is about a USDA yield print and no stored series holds that yield, return an empty string. Attaching the soil-moisture series that motivated the claim makes it resolve on whether soil dried out, recording a false hit on a yield call.",
              },
              confirmingEvent: { type: "string", description: "The report or release that settles it." },
            },
            required: ["claim", "comparator", "threshold", "direction", "series", "confirmingEvent"],
            additionalProperties: false,
          },
        },
        required: [
          "thesis",
          "narrative",
          "horizon_days",
          "mechanism_chain",
          "supporting_evidence",
          "counterevidence",
          "alternative_explanations",
          "confidence",
          "confirm",
          "invalidate",
          "falsifiable_claim",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["theses"],
  additionalProperties: false,
};

// ── EVIDENCE IDS ──────────────────────────────────────────────────────────────────────────────────
//
// A tagged union, validated against what is actually in the store. This is the whole grounding
// guarantee and it is obtained with ARITHMETIC, not a model call: an id either resolves against the
// universe the caller assembled or it is dropped and counted. There is no "looks plausible" path.

/** @typedef {{itemUids:Set<string>, seriesIds:Set<string>, signalIds:Set<string>, briefPaths:Set<string>, reportKeys:Set<string>}} EvidenceUniverse */

/** Parse an evidence id into {kind, key, period} without touching the store. */
export function parseEvidenceId(raw) {
  const id = String(raw ?? "").trim();
  const colon = id.indexOf(":");
  if (colon < 1) return null;
  const kind = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (!rest) return null;
  switch (kind) {
    case "item":
      return { kind, key: rest, id };
    case "series": {
      // `series:<id>@<period>` — the period is optional so a thesis can cite a series as a whole.
      const at = rest.lastIndexOf("@");
      return at > 0 ? { kind, key: rest.slice(0, at), period: rest.slice(at + 1), id } : { kind, key: rest, period: null, id };
    }
    case "signal":
      return { kind, key: rest, id };
    case "report": {
      const bar = rest.lastIndexOf("|");
      return bar > 0 ? { kind, key: rest.slice(0, bar), date: rest.slice(bar + 1), id } : { kind, key: rest, date: null, id };
    }
    case "brief":
      return { kind, key: rest, id };
    case "web":
      return { kind, key: rest, id };
    default:
      return null;
  }
}

/**
 * Split a list of evidence ids into the ones that resolve against the store and the ones that do
 * not. Pure — the caller assembles `universe`, so this module never imports the DB and the whole
 * file tests offline.
 *
 * ⚠️ `web:` is the one kind that cannot be checked against stored data, because a web citation is
 * by definition not in the store. It is validated for SHAPE only (an http(s) URL). That is a real
 * hole and it is named here rather than hidden: a fabricated-but-well-formed URL survives. It is
 * still worth accepting, because the analyst call has web search on and its best evidence is often
 * a source we never stored — dropping every `web:` id would push the model toward citing weaker
 * stored items instead.
 */
export function resolveEvidence(ids, universe) {
  const resolved = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const parsed = parseEvidenceId(raw);
    if (!parsed) {
      dropped.push({ id: String(raw ?? ""), reason: "unparseable" });
      continue;
    }
    if (seen.has(parsed.id)) continue; // citing the same thing twice is not two pieces of evidence
    seen.add(parsed.id);
    let ok = false;
    switch (parsed.kind) {
      case "item":
        ok = universe.itemUids?.has(parsed.key) ?? false;
        break;
      case "series":
        ok = universe.seriesIds?.has(parsed.key) ?? false;
        break;
      case "signal":
        ok = universe.signalIds?.has(parsed.key) ?? false;
        break;
      case "brief":
        ok = universe.briefPaths?.has(parsed.key) ?? false;
        break;
      case "report":
        ok = universe.reportKeys?.has(parsed.key) ?? false;
        break;
      case "web":
        ok = /^https?:\/\/[^\s]+$/i.test(parsed.key);
        break;
    }
    (ok ? resolved : dropped).push(ok ? parsed : { id: parsed.id, reason: `no such ${parsed.kind}` });
  }
  return { resolved, dropped };
}

/** Clamp an array field to its documented bounds. The API cannot express these — see BOUNDS. */
function clamp(list, { min, max }) {
  const arr = (Array.isArray(list) ? list : []).filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  return { value: arr.slice(0, max), short: arr.length < min };
}

/** One step down the confidence ladder. Never up — asserted by test. */
export function demote(confidence) {
  const i = CONFIDENCE_ORDER.indexOf(confidence);
  if (i <= 0) return CONFIDENCE_ORDER[0];
  return CONFIDENCE_ORDER[i - 1];
}

/**
 * Enforce in code every constraint the schema could not express, and apply the grounding rule.
 *
 * ⚠️ THE RULE THAT MATTERS: a thesis whose supporting evidence resolves to ZERO ids is forced to
 * `confidence: "low"` and flagged `needsReview`. It is NOT deleted — a real read with sloppy
 * citations is still worth showing, and silently dropping it would hide the failure. But it may
 * never render as confident, because a confident-sounding claim with no resolvable evidence behind
 * it is exactly the thing this whole phase exists to prevent.
 */
export function applyBounds(raw, universe) {
  const support = resolveEvidence(raw?.supporting_evidence, universe);
  const counter = resolveEvidence(raw?.counterevidence, universe);

  const mech = clamp(raw?.mechanism_chain, BOUNDS.mechanism_chain);
  const alts = clamp(raw?.alternative_explanations, BOUNDS.alternative_explanations);
  const supportIds = support.resolved.slice(0, BOUNDS.supporting_evidence.max).map((e) => e.id);
  const counterIds = counter.resolved.slice(0, BOUNDS.counterevidence.max).map((e) => e.id);

  const droppedCount = support.dropped.length + counter.dropped.length;
  const ungrounded = supportIds.length === 0;

  let confidence = CONFIDENCE_ORDER.includes(raw?.confidence) ? raw.confidence : "low";
  if (ungrounded) confidence = "low";

  const notes = [];
  if (ungrounded) notes.push("no supporting evidence resolved");
  if (mech.short) notes.push(`mechanism chain has fewer than ${BOUNDS.mechanism_chain.min} steps`);
  if (alts.short) notes.push("no alternative explanation offered");

  return {
    thesis: String(raw?.thesis ?? "").trim(),
    narrative: String(raw?.narrative ?? "").trim(),
    horizonDays: Number.isFinite(raw?.horizon_days) && raw.horizon_days > 0 ? Math.min(raw.horizon_days, 365) : 30,
    mechanismChain: mech.value,
    supportingEvidence: supportIds,
    counterevidence: counterIds,
    alternativeExplanations: alts.value,
    confidence,
    confidenceStated: CONFIDENCE_ORDER.includes(raw?.confidence) ? raw.confidence : "low",
    confirm: String(raw?.confirm ?? "").trim(),
    invalidate: String(raw?.invalidate ?? "").trim(),
    falsifiableClaim: raw?.falsifiable_claim ?? null,
    droppedEvidence: [...support.dropped, ...counter.dropped],
    droppedCount,
    needsReview: ungrounded || mech.short || alts.short,
    reviewNotes: notes,
  };
}

/**
 * Render theses as markdown. A DETERMINISTIC TEMPLATE, deliberately — not a second model call.
 * The prose already lives inside the schema (`narrative`, `mechanism_chain`), so a model render
 * pass could silently depart from the structured claims, which would defeat the entire point of
 * structuring them. If the rendering looks thin, fix the schema fields, not this function.
 */
export function renderTheses(theses) {
  if (!theses?.length) return "";
  const out = ["## Theses"];
  for (const t of theses) {
    out.push("");
    out.push(`### ${t.thesis}`);
    out.push("");
    out.push(t.narrative);
    if (t.mechanismChain.length) {
      out.push("");
      out.push(`**How it works:** ${t.mechanismChain.join(" → ")}`);
    }
    const bits = [`**Confidence:** ${t.confidence}`, `**Horizon:** ${t.horizonDays} days`];
    if (t.confidence !== t.confidenceStated) bits.push(`_(stated ${t.confidenceStated}, lowered)_`);
    out.push("");
    out.push(bits.join(" · "));
    if (t.confirm) out.push(`**Confirms if:** ${t.confirm}`);
    if (t.invalidate) out.push(`**Dies if:** ${t.invalidate}`);
    if (t.alternativeExplanations.length) {
      out.push("");
      out.push(`**Read it another way:** ${t.alternativeExplanations.join(" Or: ")}`);
    }
    if (t.supportingEvidence.length) out.push(`**Evidence:** ${t.supportingEvidence.join(", ")}`);
    if (t.counterevidence.length) out.push(`**Against:** ${t.counterevidence.join(", ")}`);
    // The Challenger's caveat renders HERE, beside the claim it qualifies — not only in the
    // "Where this read is weak" footer. A caveat the reader meets after the confident version has
    // already landed is a caveat that arrived too late.
    if (t.caveat) out.push(`_⚠️ ${t.caveat}_`);
    // Shown, not hidden — every correctness fix in this repo is "state the caveat inline, because it
    // gets compressed away otherwise".
    if (t.needsReview) out.push(`_⚠️ Flagged for review: ${t.reviewNotes.join("; ")}._`);
  }
  return out.join("\n");
}

/**
 * Call 2 of the analyst flow: read the just-written note and emit structured, grounded theses.
 * No tools — see the header for why this cannot ride along on the web-search call.
 *
 * Fail-soft by contract: returns `null` on any problem. The note is already saved and delivered by
 * the time this runs, so a structuring failure must never cost the reader their note.
 */
export async function buildTheses(markdown, { evidenceIds, universe, env = process.env, client = null, recordUsage = null } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  if (!markdown || markdown.length < 200) return null;

  const anthropic = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.THESIS_MODEL || env.ANALYST_MODEL || "claude-opus-4-8";

  const system =
    "You convert an analyst note into STRUCTURED THESES so they can be grounded, challenged and scored later. " +
    "You are not writing new analysis — you are stating what the note already argues, precisely enough to be checked.\n\n" +
    "Extract at most 4 theses, the most consequential first. A thesis is a claim about what is true or about to be true that could be WRONG. " +
    "Do not extract descriptions of what already happened, definitions, or context. If the note argues nothing falsifiable, return an empty array — that is a valid and useful answer.\n\n" +
    "THE RULE THAT MATTERS MOST: every id in `supporting_evidence` and `counterevidence` must be copied EXACTLY from the EVIDENCE IDS list below. " +
    "Ids you invent are dropped mechanically before the note renders, and a thesis whose evidence all drops is forced to low confidence and flagged. " +
    "Citing nothing is better than citing something you made up.\n\n" +
    `Bounds (enforced in code, so exceeding them loses content): mechanism_chain ${BOUNDS.mechanism_chain.min}-${BOUNDS.mechanism_chain.max} steps, ` +
    `supporting_evidence ${BOUNDS.supporting_evidence.min}-${BOUNDS.supporting_evidence.max} ids, counterevidence up to ${BOUNDS.counterevidence.max}, ` +
    `at least ${BOUNDS.alternative_explanations.min} alternative explanation.\n` +
    "`series` in falsifiable_claim must MEASURE THE CLAIM'S SUBJECT, not its cause — an empty string is the right answer whenever nothing stored measures it.";

  let resp;
  try {
    resp = await anthropic.messages.create({
      model,
      max_tokens: 16000,
      // Thinking ON, at high effort. This was `disabled` when the call ran on Sonnet as a
      // near-transcription step; on the analyst's model it is doing the judgement described above,
      // and deciding what invalidates a claim is exactly the work thinking is for.
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: THESIS_SCHEMA } },
      system,
      messages: [
        {
          role: "user",
          content: `=== EVIDENCE IDS (copy exactly; anything else is dropped) ===\n${evidenceIds.join("\n")}\n\n=== ANALYST NOTE ===\n${markdown.slice(0, 20000)}`,
        },
      ],
    });
  } catch (err) {
    console.log(`⚠️  Thesis structuring skipped: ${err.message}`);
    return null;
  }
  recordUsage?.(model, "thesis", resp.usage.input_tokens, resp.usage.output_tokens, resp.usage);

  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log("⚠️  Thesis structuring: response was not valid JSON despite the schema — skipping");
    return null;
  }
  const list = Array.isArray(parsed?.theses) ? parsed.theses : [];
  const theses = list.map((t) => applyBounds(t, universe)).filter((t) => t.thesis && t.narrative);

  const droppedTotal = theses.reduce((n, t) => n + t.droppedCount, 0);
  const flagged = theses.filter((t) => t.needsReview).length;
  // House rule: no silent drops. An id that vanished is the signal that the model is inventing
  // citations, and it is invisible unless counted here.
  console.log(
    `🧠 Theses: ${theses.length} structured` +
      (droppedTotal ? `, ${droppedTotal} unresolvable evidence id${droppedTotal === 1 ? "" : "s"} dropped` : "") +
      (flagged ? `, ${flagged} flagged for review` : "")
  );
  return { theses, droppedTotal, flagged, model };
}
