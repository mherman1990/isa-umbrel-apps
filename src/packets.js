// packets.js — turn a grounded document into a structured EVIDENCE PACKET.
//
// WHAT THIS IS FOR. Every reasoning path in the tool receives a mixture of kinds of text: the source
// document's own words, a cheap model's one-line summary *about* that document, computed market prose,
// and cached newsletter intelligence. The prompts explain which is which, but the deep model still has
// to parse and reconcile them inside a very large context. A packet does that reconciliation ONCE, per
// government action, and stores the result: what happened, the claims with the passage each rests on,
// the dates and deadlines, the quantities, and — explicitly — what the document does NOT say.
//
// ⚠️ THE HARD PART IS HONESTY, NOT EXTRACTION, AND IT IS ENFORCED IN CODE.
//
// A confidently-structured packet extracted from a 180-character RSS teaser is worse than no packet at
// all: it launders a headline into something that reads like sourced evidence. Three layers stop that,
// none of which trust the model:
//
//   1. BELOW 800 SOURCE CHARS, NO MODEL CALL HAPPENS AT ALL. 800 is measured, not chosen: on the real
//      68-item news corpus, before grounding, 12 rows had no body, 48 had 1–199 chars, 8 had 200–799,
//      and NONE exceeded 800. So 800 is the actual dividing line between "a feed teaser" and "an
//      article", and it also removes ~74% of news (farmprogress.com returns 403 to every user-agent)
//      from the paid path for free.
//   2. `sufficiency` IS FLOORED BY CODE. The model proposes it; `applyFloor` overrides it downward
//      based on the measured source length. Same rule as `frDocNumOf` in enrich.js — never trust a
//      field you can validate yourself.
//   3. EVERY EVIDENCE QUOTE IS CHECKED AS A VERBATIM SUBSTRING of the source text. Failures are
//      dropped and counted; if more than half fail, sufficiency is downgraded. This makes a fabricated
//      packet mechanically detectable rather than a matter of trust.
//
// COST. Packets are scoped to `must_read` actions only, and keyed on `event_key` so one notice
// cross-filed into four dockets is ONE packet and the PM run reuses what the AM run paid for.
// ⚠️ At must_read only this is ~$1.44/mo. Unscoped — a packet for every relevant official event, ~17/day
// — it is ~$5.28/mo. The scoping rule is load-bearing, not polish.
//
// ORDERING. Packets read `seen_items.body`; they never fetch. So they must run AFTER enrichment and news
// grounding have populated that column — run them earlier and every news packet silently becomes thin.
// Locked by a test.

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import { mapPool } from "./util.js";

/** Below this many characters of source text, a packet is built WITHOUT a model call. Measured: nothing
 *  in the ungrounded news corpus exceeded 800 chars, and real Federal Register abstracts start ~300 but
 *  the ones worth extracting from run well past this. */
export const THIN_SOURCE_CHARS = 800;
/** Above this, a packet may claim "full" sufficiency. Between the two it is capped at "partial". */
const PARTIAL_SOURCE_CHARS = 2000;
/** Document text sent to the extractor. Wider than the brief's 900 — extraction wants the whole
 *  operative text, and this is the cheap model. */
const EXTRACT_DOC_CHARS = 6000;
/** Packets per run. Small on purpose: the budget exists so a backlog cannot produce a surprise bill. */
export const PACKET_BUDGET = 8;
const POOL = 3;
/** Re-extract only when the body has materially grown — catches `groundItemBody` healing a 180-char
 *  teaser into a 5,000-char article. Without this a thread would be re-extracted for no new information. */
const REGROW_FACTOR = 2;

export const PACKET_SCHEMA = {
  type: "object",
  properties: {
    sufficiency: {
      type: "string",
      enum: ["full", "partial", "thin"],
      description:
        "How much of the action this text actually supports. 'thin' when it is a headline or teaser. Be honest — this is checked against the source length and your quotes.",
    },
    what_happened: { type: "string", description: "The ACTION in one sentence: who did what, under what authority." },
    claims: {
      type: "array",
      description: "What the document asserts. Empty array is valid and useful when it asserts nothing checkable.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The claim, in your own words but faithful to the document." },
          kind: {
            type: "string",
            enum: ["fact", "projection", "assertion_by_party"],
            description: "fact = the document states it as so; projection = a forecast; assertion_by_party = someone's position, not established.",
          },
          attributed_to: { type: "string", description: "Who asserts it (agency, company, court, trade group). Empty string if the document itself." },
          evidence_index: { type: "integer", description: "Index into the evidence array supporting this claim, or -1 if none." },
        },
        required: ["text", "kind", "attributed_to", "evidence_index"],
        additionalProperties: false,
      },
    },
    actions_required: {
      type: "array",
      description: "Anything someone must DO. Empty array if nothing.",
      items: {
        type: "object",
        properties: {
          who: { type: "string" },
          what: { type: "string" },
          by_when: { type: "string", description: "YYYY-MM-DD, or empty string if undated." },
        },
        required: ["who", "what", "by_when"],
        additionalProperties: false,
      },
    },
    dates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD." },
          what: { type: "string" },
          kind: { type: "string", enum: ["effective", "comment_close", "hearing", "report", "other"] },
        },
        required: ["date", "what", "kind"],
        additionalProperties: false,
      },
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string", enum: ["agency", "company", "state", "country", "court", "trade_group", "other"] },
        },
        required: ["name", "role"],
        additionalProperties: false,
      },
    },
    quantities: {
      type: "array",
      description: "Numbers that matter, with their unit. Never invent or convert — only what the text states.",
      items: {
        type: "object",
        properties: {
          value: { type: "number" },
          unit: { type: "string", description: "e.g. 'million bushels', 'USD', 'percent', 'acres'." },
          what: { type: "string" },
          as_of: { type: "string", description: "The period the figure refers to, or empty string." },
        },
        required: ["value", "unit", "what", "as_of"],
        additionalProperties: false,
      },
    },
    soy_mechanisms: {
      type: "array",
      description: "How this could reach an Iowa soybean operation. Empty array when there is no plausible channel.",
      items: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            enum: ["production_cost", "demand", "price", "basis", "market_access", "compliance_burden", "land_use", "other"],
          },
          direction: { type: "string", enum: ["supportive", "adverse", "mixed", "uncertain"] },
          explanation: { type: "string", description: "One sentence. Say 'uncertain' rather than guessing a direction." },
        },
        required: ["channel", "direction", "explanation"],
        additionalProperties: false,
      },
    },
    evidence: {
      type: "array",
      description:
        "VERBATIM spans copied exactly from the supplied text — not paraphrases. Every quote is checked as an exact substring and dropped if it does not match, so copy precisely.",
      items: {
        type: "object",
        properties: {
          quote: { type: "string", description: "An exact substring of the supplied document text." },
          locator: { type: "string", description: "Where in the document, if identifiable (section, paragraph). Empty string if not." },
        },
        required: ["quote", "locator"],
        additionalProperties: false,
      },
    },
    unknowns: {
      type: "array",
      items: { type: "string" },
      description: "What a reader would need that this text does not provide.",
    },
    not_in_document: {
      type: "array",
      items: { type: "string" },
      description: "Things a reader might ASSUME are here but are not — the most useful field when the text is thin.",
    },
  },
  required: [
    "sufficiency",
    "what_happened",
    "claims",
    "actions_required",
    "dates",
    "entities",
    "quantities",
    "soy_mechanisms",
    "evidence",
    "unknowns",
    "not_in_document",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract structured evidence from a single government document or news article for the Iowa Soybean Association's policy and market monitor. You are PARSING, not analysing: your job is to separate what the document says from what anyone might infer from it.

Rules that matter more than completeness:
- Every entry in "evidence" must be an EXACT VERBATIM SUBSTRING of the supplied text. Copy, do not paraphrase or tidy. Quotes are checked mechanically and silently dropped if they do not match, which weakens the packet.
- Distinguish a FACT the document states from a PROJECTION and from an ASSERTION BY A PARTY. A trade group's position is not an established fact; label it assertion_by_party and name the party.
- Never invent, convert or round a number. If the text does not give a figure, it does not go in "quantities".
- An empty array is a correct and useful answer. Do not manufacture claims, mechanisms or dates to fill the shape.
- "unknowns" and "not_in_document" are the most valuable fields when the text is short. Use them rather than stretching thin text into confident claims.
- Be honest in "sufficiency". If this is a headline plus a sentence, it is "thin" no matter how significant the underlying action sounds.`;

/** Normalize whitespace for substring comparison WITHOUT changing the stored text. */
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Layer 2: the code decides sufficiency, the model only proposes it.
 * Length is measurable, so it is not a judgement call — and a model that calls 300 characters "full"
 * is exactly the failure this exists to catch.
 */
export function applyFloor(proposed, sourceChars) {
  const order = ["thin", "partial", "full"];
  const ceiling = sourceChars < THIN_SOURCE_CHARS ? "thin" : sourceChars < PARTIAL_SOURCE_CHARS ? "partial" : "full";
  const p = order.indexOf(proposed) >= 0 ? proposed : "thin";
  return order.indexOf(p) <= order.indexOf(ceiling) ? p : ceiling;
}

/**
 * Layer 3: drop any evidence quote that is not a verbatim substring of the source, and downgrade
 * sufficiency when most of them fail. A fabricated packet becomes mechanically detectable.
 */
export function verifyEvidence(packet, sourceText) {
  const hay = norm(sourceText);
  const before = Array.isArray(packet.evidence) ? packet.evidence : [];
  const kept = before.filter((e) => {
    const q = norm(e?.quote);
    return q.length >= 12 && hay.includes(q); // very short "quotes" prove nothing
  });
  const rejected = before.length - kept.length;
  const out = { ...packet, evidence: kept, evidence_rejected: rejected };
  // Claims point at evidence by index; re-point or orphan them rather than leaving dangling indices.
  if (Array.isArray(out.claims)) {
    const keptSet = new Set(kept.map((e) => norm(e.quote)));
    out.claims = out.claims.map((c) => {
      const src = before[c?.evidence_index];
      const stillThere = src && keptSet.has(norm(src.quote));
      return { ...c, evidence_index: stillThere ? kept.findIndex((e) => norm(e.quote) === norm(src.quote)) : -1 };
    });
  }
  // More than half the quotes were not in the source: the packet is not trustworthy as evidence, so cap
  // it at "partial". Cap, never raise — a packet the model already called "thin" stays thin.
  if (before.length && rejected / before.length > 0.5 && out.sufficiency === "full") {
    out.sufficiency = "partial";
    out.evidence_downgraded = true;
  }
  return out;
}

/** Layer 1: a free packet for text too short to extract from. No model call, and honest about why. */
export function buildThinPacket(row, sourceChars) {
  return {
    sufficiency: "thin",
    what_happened: String(row.title ?? "").slice(0, 400),
    claims: [],
    actions_required: [],
    dates: row.comment_deadline ? [{ date: String(row.comment_deadline).slice(0, 10), what: "comment period closes", kind: "comment_close" }] : [],
    entities: [],
    quantities: [],
    soy_mechanisms: [],
    evidence: [],
    evidence_rejected: 0,
    unknowns: [
      sourceChars === 0
        ? "The document text was never retrieved — only a title is stored for this action."
        : `Only ${sourceChars} characters of text are stored for this action, which is a feed teaser rather than the document.`,
    ],
    not_in_document: ["Everything beyond the headline — this packet was built without a model call because there was nothing to extract."],
  };
}

/**
 * Build evidence packets for the must_read actions of one run.
 *
 * @param {{env?: object, budget?: number, log?: Function, client?: object}} opts
 * @returns {Promise<{extracted:number, thin:number, reused:number, failed:number, qualified:number}>}
 */
export async function buildPackets({ env = process.env, budget = PACKET_BUDGET, log = console.log, client = null } = {}) {
  const stats = { extracted: 0, thin: 0, reused: 0, failed: 0, qualified: 0 };
  const candidates = store.packetCandidates();
  stats.qualified = candidates.length;
  if (!candidates.length) return stats;

  // Decide per candidate what work is needed, BEFORE spending any budget.
  const todo = [];
  for (const row of candidates) {
    const sourceChars = norm(row.body).length;
    const existing = store.getPacket(row.event_key);
    if (existing) {
      // Re-extract only when the body materially grew (grounding healed a teaser into an article).
      const grew = sourceChars >= Math.max(THIN_SOURCE_CHARS, (existing.source_chars ?? 0) * REGROW_FACTOR);
      if (!grew) {
        stats.reused++;
        continue;
      }
    }
    if (sourceChars < THIN_SOURCE_CHARS) {
      // Free, honest, and no model call. Stored so the consumer can see WHY it is thin.
      store.upsertPacket({
        eventKey: row.event_key,
        leadUid: row.uid,
        sourceUid: row.uid,
        packet: buildThinPacket(row, sourceChars),
        sufficiency: "thin",
        sourceChars,
        model: null,
      });
      stats.thin++;
      continue;
    }
    todo.push({ row, sourceChars });
  }

  if (!todo.length) {
    if (stats.thin || stats.reused) {
      log(`   🧩 Evidence packets: ${stats.thin} thin (no model call needed), ${stats.reused} already current`);
    }
    return stats;
  }

  // House rule: no silent caps. If the budget bites, say what the true qualifying total was.
  const batch = todo.slice(0, budget);
  const deferred = todo.length - batch.length;

  const api = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";

  await mapPool(batch, POOL, async ({ row, sourceChars }) => {
    const doc = String(row.body ?? "").slice(0, EXTRACT_DOC_CHARS);
    const user =
      `SOURCE: ${row.source_id}${row.jurisdiction ? ` · ${row.jurisdiction}` : ""}${row.doc_type ? ` · ${row.doc_type}` : ""}\n` +
      `TITLE: ${row.title}\n` +
      `${row.comment_deadline ? `RECORDED COMMENT DEADLINE: ${String(row.comment_deadline).slice(0, 10)}\n` : ""}` +
      `URL: ${row.url || "(none)"}\n\n` +
      `DOCUMENT TEXT (${sourceChars} chars stored; ${doc.length} supplied):\n${doc}`;
    try {
      const resp = await api.messages.create({
        model,
        max_tokens: 2500,
        output_config: { format: { type: "json_schema", schema: PACKET_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
      });
      store.recordUsage(model, "packet", resp.usage.input_tokens, resp.usage.output_tokens, resp.usage);
      const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Defensive despite the schema — every other schema-constrained call site does the same.
        stats.failed++;
        log(`   ⚠️  Packet extraction: response was not valid JSON despite the schema — skipping ${row.event_key}`);
        return;
      }
      // Layers 3 then 2, in that order: rejecting quotes can itself force a downgrade, and the length
      // floor must have the final word.
      const verified = verifyEvidence(parsed, doc);
      const sufficiency = applyFloor(verified.sufficiency, sourceChars);
      store.upsertPacket({
        eventKey: row.event_key,
        leadUid: row.uid,
        sourceUid: row.uid,
        packet: { ...verified, sufficiency },
        sufficiency,
        sourceChars,
        model,
      });
      stats.extracted++;
    } catch (err) {
      // Fail-soft: write NO row so the next run retries, and the consumer falls back to the raw
      // document excerpt in the meantime. Never let this break a run.
      stats.failed++;
      log(`   ⚠️  Packet extraction failed for ${row.event_key}: ${err.message}`);
    }
  });

  log(
    `   🧩 Evidence packets: ${stats.extracted} extracted, ${stats.thin} thin (free), ${stats.reused} already current` +
      `${stats.failed ? `, ${stats.failed} failed (will retry next run)` : ""}` +
      `${deferred ? ` — ⚠️ ${stats.qualified} actions qualified, ${batch.length} extracted this run (budget), ${deferred} next run` : ""}`
  );
  return stats;
}
