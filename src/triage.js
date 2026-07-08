// triage.js — the cheap, high-volume relevance pass (TRIAGE_MODEL, default Haiku).
//
// Items that survived local scoring are sent in batches of ~15. For each item the
// model returns a strict-JSON verdict: relevant or not, which topics, and a one-line
// "why it matters". Every verdict is written to SQLite, so tomorrow the same item
// costs nothing (collect.js filters already-seen items before we ever get here).

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";

const BATCH_SIZE = 15;

const SYSTEM_PROMPT = `You are triaging government documents and political items for relevance to Iowa soybean farmers and the Iowa Soybean Association's policy priorities. For each item, return strict JSON: {"uid": "...", "relevant": true|false, "topicIds": [...], "oneLine": "...", "type": "..."} — oneLine is a one-line why-it-matters for Iowa soy; type is your best guess of the item kind, one of: news|statement|bill_action|vote|event|fundraiser|rule|other. Respond ONLY with a JSON array covering every input item, no other text.`;

/** Human 👍/👎 corrections from the web UI become few-shot guidance for future triage. */
function feedbackGuidance() {
  const examples = store.getFeedbackExamples(8);
  if (examples.length === 0) return "";
  const lines = examples.map((e) => {
    const note = e.feedback_note ? ` The analyst's note: "${e.feedback_note}".` : "";
    if (e.feedback === "down") return `- "${e.title}" — the analyst marked this NOT relevant (or to weigh down).${note} Avoid similar items.`;
    if (e.feedback === "up") return `- "${e.title}" — the analyst marked this RELEVANT.${note} Include similar items.`;
    return `- "${e.title}" — analyst guidance:${note || " (noted)"}`;
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
 * @returns {{ relevant: Item[], triagedCount: number }} relevant items carry .oneLine and .topicIds
 */
export async function triageItems(kept, topics, env) {
  if (kept.length === 0) return { relevant: [], triagedCount: 0 };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const topicList = topics.map((t) => `${t.id}: ${t.label}`).join("\n");
  const systemPrompt = SYSTEM_PROMPT + feedbackGuidance();

  const relevant = [];
  let triagedCount = 0;

  for (let i = 0; i < kept.length; i += BATCH_SIZE) {
    const batch = kept.slice(i, i + BATCH_SIZE);
    const payload = batch.map((item) => ({
      uid: item.uid,
      title: item.title,
      summary: (item.summary ?? "").slice(0, 600),
      source: item.sourceLabel,
      jurisdiction: item.jurisdiction,
      docType: item.docType,
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
      for (const item of batch) store.markSeen(item, null);
      continue;
    }

    const byUid = new Map(verdicts.filter((v) => v && v.uid).map((v) => [v.uid, v]));
    for (const item of batch) {
      const v = byUid.get(item.uid);
      const verdict = v
        ? {
            relevant: Boolean(v.relevant),
            topicIds: Array.isArray(v.topicIds) ? v.topicIds : [],
            oneLine: String(v.oneLine ?? ""),
            type: v.type ? String(v.type) : (item.docType ?? null),
          }
        : null;
      store.markSeen(item, verdict);
      triagedCount++;
      if (verdict?.relevant) {
        relevant.push({
          ...item,
          oneLine: verdict.oneLine,
          topicIds: verdict.topicIds,
          type: verdict.type,
          entityId: item.raw?.entityId ?? null,
        });
      }
    }
  }

  return { relevant, triagedCount };
}
