// triage.js — the cheap, high-volume relevance pass (TRIAGE_MODEL, default Haiku).
//
// Items that survived local scoring are sent in batches of ~15. For each item the
// model returns a strict-JSON verdict: relevant or not, which topics, and a one-line
// "why it matters". Every verdict is written to SQLite, so tomorrow the same item
// costs nothing (collect.js filters already-seen items before we ever get here).

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";

const BATCH_SIZE = 15;

// TIERS (1.26.0). Relevance used to be a single boolean, which is a blunt instrument for a feed
// whose complaint is "too wide a net": a genuinely relevant EPA docket and a routine notice that
// merely mentions soybeans both came back `relevant: true` and landed in one flat list. The model now
// also grades urgency, and the Laws/Rules/Decisions page defaults to hiding only `background` — so
// nothing is thrown away, it's just one click further from the daily read.
const TIERS = ["must_read", "worth_knowing", "background"];

const SYSTEM_PROMPT = `You are triaging government documents and political items for relevance to Iowa soybean farmers and the Iowa Soybean Association's policy priorities. Each item gives you a title and, where the pipeline could retrieve it, the document's own text in "document" — READ THAT, and base your verdict and your one-line on what the document actually says, not on what the title implies. Titles in this corpus are often generic or shared verbatim between unrelated filings.

For each item, return strict JSON: {"uid": "...", "relevant": true|false, "tier": "must_read|worth_knowing|background", "topicIds": [...], "oneLine": "...", "type": "..."} — oneLine is a one-line why-it-matters for Iowa soy; type is your best guess of the item kind, one of: news|statement|bill_action|vote|event|fundraiser|rule|other.

Write the oneLine so it DISTINGUISHES this document: name the specific substance (the active ingredient, the commodity, the country, the program, the dollar figure) rather than restating the title's category. If two filings share a title, their one-lines must not be interchangeable. When no document text was available, say what is unknown instead of inventing significance — "notice title only; substance not retrieved" is a more useful verdict than a confident guess.

Grade "tier" strictly — it decides what reaches the daily read:
- "must_read": ISA would act, comment, or brief leadership on this. A rule/docket/bill that directly changes what Iowa soybean farmers may do, what they are paid, or what they pay; an open comment period on such a rule; a trade or biofuel decision that moves soybean demand.
- "worth_knowing": real but not actionable this week — a related development, an early-stage or out-of-state proceeding, a study or program announcement worth being aware of.
- "background": procedural or tangential. Meeting notices, routine reauthorizations, boilerplate, items that merely MENTION agriculture or a watchlist term without bearing on Iowa soy, and anything whose relevance you'd have to strain to explain.
Most items are NOT must_read. If an item is only relevant because a keyword appeared in it, that is "background". Respond ONLY with a JSON array covering every input item, no other text.`;

/** Human 👍/👎 corrections from the web UI become few-shot guidance for future triage. */
function feedbackGuidance() {
  // 12 rather than 8: this is the only channel by which 👍/👎 changes anything, and the examples are
  // one line each. Each line now carries the SOURCE too, so a pattern like "Federal Register notices
  // are never relevant" is visible to the model as a pattern rather than as three unrelated titles.
  const examples = store.getFeedbackExamples(12);
  if (examples.length === 0) return "";
  const lines = examples.map((e) => {
    const note = e.feedback_note ? ` The analyst's note: "${e.feedback_note}".` : "";
    const src = e.source_id ? ` [${e.source_id}${e.doc_type ? `/${e.doc_type}` : ""}]` : "";
    if (e.feedback === "down") return `- "${e.title}"${src} — the analyst marked this NOT relevant (or to weigh down).${note} Avoid similar items; treat these as background.`;
    if (e.feedback === "up") return `- "${e.title}"${src} — the analyst marked this RELEVANT.${note} Include similar items.`;
    return `- "${e.title}"${src} — analyst guidance:${note || " (noted)"}`;
  });
  return `\n\nThe analyst has corrected some of your past verdicts and left guidance. Apply this judgment:\n${lines.join("\n")}`;
}

/** Strip markdown fences and parse a JSON array, or return null. */
function parseVerdicts(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Last resort: find the outermost [...] in the text.
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * @returns {{ relevant: Item[], triagedCount: number, verdicts: Map<string, object|null> }}
 *   relevant items carry .oneLine/.topicIds/.tier; `verdicts` maps every triaged uid to its verdict
 *   so the caller can apply one verdict to the other copies of a cross-filed document (pipeline.js
 *   triages one representative per event, not one per filing).
 */
export async function triageItems(kept, topics, env) {
  if (kept.length === 0) return { relevant: [], triagedCount: 0, verdicts: new Map() };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const topicList = topics.map((t) => `${t.id}: ${t.label}`).join("\n");
  const systemPrompt = SYSTEM_PROMPT + feedbackGuidance();

  const relevant = [];
  const verdicts = new Map();
  let triagedCount = 0;

  for (let i = 0; i < kept.length; i += BATCH_SIZE) {
    const batch = kept.slice(i, i + BATCH_SIZE);
    const payload = batch.map((item) => ({
      uid: item.uid,
      title: item.title,
      // DOCUMENT-LEVEL, NOT HEADLINE-LEVEL. This was 600 characters, which for a Federal Register
      // rule truncates the abstract mid-sentence and for the three adapters that shipped
      // `summary: ""` left the model grading a title alone. It showed: verdicts like "Submission for
      // OMB review with insufficient detail to assess relevance to soybeans" are the model saying it
      // was given nothing to judge. enrich.js now supplies real document text, so the budget here
      // has to be big enough to carry it — 2,500 chars covers the great majority of FR abstracts
      // whole, and 15 of them still fit comfortably inside the 4,000-token response budget because
      // the model only writes one line back per item.
      document: (item.summary ?? "").slice(0, 2500),
      source: item.sourceLabel,
      jurisdiction: item.jurisdiction,
      docType: item.docType,
      // Cross-filed copies are collapsed before this call (pipeline.js), so tell the model when a
      // verdict covers more than one filing — a notice cross-filed into four dockets is more
      // consequential than a one-off, not four separate items.
      ...(item.eventFilings > 1 ? { alsoFiledInDockets: item.eventFilings - 1 } : {}),
      localTopicGuesses: item.matchedTopics?.map((t) => t.id) ?? [],
    }));

    let verdicts = null;
    for (let attempt = 1; attempt <= 2 && verdicts === null; attempt++) {
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Valid topicIds:\n${topicList}\n\nItems to triage:\n${JSON.stringify(payload, null, 1)}`,
          },
        ],
      });
      store.recordUsage(model, "triage", response.usage.input_tokens, response.usage.output_tokens);
      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      verdicts = parseVerdicts(text);
      if (verdicts === null && attempt === 1) {
        console.log("   ⚠️ triage batch returned malformed JSON — retrying once");
      }
    }

    if (verdicts === null) {
      // Give up on this batch: mark items seen-but-unscored so the run continues.
      console.log(`   ⚠️ triage batch ${i / BATCH_SIZE + 1} failed twice — ${batch.length} items recorded as unscored`);
      for (const item of batch) {
        store.markSeen(item, null);
        verdicts.set(item.uid, null);
      }
      continue;
    }

    const byUid = new Map(verdicts.filter((v) => v && v.uid).map((v) => [v.uid, v]));
    for (const item of batch) {
      const v = byUid.get(item.uid);
      const verdict = v
        ? {
            relevant: Boolean(v.relevant),
            // An omitted or unrecognized tier defaults to worth_knowing rather than to a guess in
            // either direction: must_read would over-promote, background would silently hide an item
            // the model called relevant.
            tier: TIERS.includes(v.tier) ? v.tier : (v.relevant ? "worth_knowing" : "background"),
            topicIds: Array.isArray(v.topicIds) ? v.topicIds : [],
            oneLine: String(v.oneLine ?? ""),
            type: v.type ? String(v.type) : (item.docType ?? null),
          }
        : null;
      store.markSeen(item, verdict);
      verdicts.set(item.uid, verdict);
      triagedCount++;
      if (verdict?.relevant) {
        relevant.push({
          ...item,
          oneLine: verdict.oneLine,
          topicIds: verdict.topicIds,
          tier: verdict.tier,
          type: verdict.type,
          entityId: item.raw?.entityId ?? null,
        });
      }
    }
  }

  return { relevant, triagedCount, verdicts };
}
