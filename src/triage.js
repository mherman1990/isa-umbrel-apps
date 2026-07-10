// triage.js — the cheap, high-volume relevance pass (TRIAGE_MODEL, default Haiku).
//
// Items that survived local scoring are sent in batches of ~15. For each item the
// model returns a strict-JSON verdict: relevant or not, which topics, and a one-line
// "why it matters". Every verdict is written to SQLite, so tomorrow the same item
// costs nothing (collect.js filters already-seen items before we ever get here).

import { anthropicClient } from "./llm.js";
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

  const client = anthropicClient(env);
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const topicList = topics.map((t) => `${t.id}: ${t.label}`).join("\n");
  const systemPrompt = SYSTEM_PROMPT + feedbackGuidance();

  const relevant = [];
  let triagedCount = 0;
  let lostCount = 0;

  /** One model round-trip for a batch: returns a parsed verdict array, or null on malformed JSON. */
  async function requestVerdicts(payload) {
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
      store.recordUsage(model, "triage", response.usage);
      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      verdicts = parseVerdicts(text);
      if (verdicts === null && attempt === 1) {
        console.log("   ⚠️ triage batch returned malformed JSON — retrying once");
      }
    }
    return verdicts;
  }

  /** Apply a parsed verdict array to its batch: persist each item and collect the relevant ones. */
  function applyVerdicts(batch, verdicts) {
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

  const payloadFor = (batch) =>
    batch.map((item) => ({
      uid: item.uid,
      title: item.title,
      summary: (item.summary ?? "").slice(0, 600),
      source: item.sourceLabel,
      jurisdiction: item.jurisdiction,
      docType: item.docType,
      localTopicGuesses: item.matchedTopics?.map((t) => t.id) ?? [],
    }));

  /**
   * Triage one batch; on malformed JSON, SPLIT and recurse instead of dropping the whole batch.
   * A single bad response used to bury up to BATCH_SIZE relevant items as "unscored" forever
   * (isSeen excludes them next run). Splitting bounds any real loss to a lone item whose own
   * one-item response won't parse — usually a symptom of that one item, not the batch.
   */
  async function processBatch(batch) {
    const verdicts = await requestVerdicts(payloadFor(batch));
    if (verdicts !== null) {
      applyVerdicts(batch, verdicts);
      return;
    }
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      console.log(`   ↔️ triage batch of ${batch.length} failed to parse — splitting into ${mid} + ${batch.length - mid}`);
      await processBatch(batch.slice(0, mid));
      await processBatch(batch.slice(mid));
      return;
    }
    // A single item that still won't parse: record it seen-unscored so the run continues, and
    // count it so the loss is visible rather than silent.
    lostCount++;
    console.log(`   ⚠️ triage could not classify 1 item after splitting — recorded as unscored: ${batch[0].title?.slice(0, 80) ?? batch[0].uid}`);
    store.markSeen(batch[0], null);
  }

  for (let i = 0; i < kept.length; i += BATCH_SIZE) {
    await processBatch(kept.slice(i, i + BATCH_SIZE));
  }

  if (lostCount) console.log(`   ⚠️ ${lostCount} item${lostCount === 1 ? "" : "s"} could not be triaged this run (recorded unscored).`);
  return { relevant, triagedCount };
}
