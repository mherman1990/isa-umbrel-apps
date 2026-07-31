// newsrank.js — graded relevance for the NEWS stream.
//
// WHY THIS IS A SEPARATE MODULE AND NOT A FLAG ON triage.js
//
// News is 54% of everything collected (68 of 126 stored rows) and was the only stream with no
// relevance signal at all: every row stored `triage_verdict='unscored'`, `triage_tier IS NULL`, and the
// News tab was pure reverse-chronological. So a Supreme Court FIFRA-preemption ruling sat at exactly the
// same weight as "Dad's 1952 Wheatland tractor returns home after 11 years".
//
// The official path could not simply be pointed at news. Three measured reasons:
//
// 1. THE FREE LOCAL GATE DOES NOT WORK ON NEWS — and using it would delete the best items.
//    Measured on the real 68-item corpus with the entity boost removed, a `localScore >= 5` gate keeps
//    12 of 68 and correctly discards 8 of 9 known-noise items for nothing. But it DROPS 3 of the 8
//    known-must-read items:
//      "USMCA renewal rejected: Annual reviews ahead for farm trade"      → score 0
//      "USDA releases June 2026 Acreage Report and Grain Stocks"          → score 0
//      "Crop progress: Soybean quality fades lower"                       → score 3
//    A 37.5% false-negative rate on precisely the items that justify the feature. The cause is
//    structural, not a tuning problem: watchlist focus-area terms are written for POLICY DOCUMENTS
//    ("45Z", "renewable diesel", "pesticide tolerance"), and news uses different vocabulary for the
//    same substance — "USMCA", "Acreage Report", "crop progress". So there is NO local gate here. The
//    keyword match is passed to the model as a hint (`localTopicGuesses`, same as the official path) and
//    never as a filter.
//    ⚠️ Do not "optimise" this by adding a score threshold. That is the one change guaranteed to lose
//    the items the user cares most about, and it will do so silently.
//
// 2. score.js's ENTITY BOOST MAKES ANY GATE MOOT ANYWAY. `output.entitySourceBoost` defaults to 6,
//    `minLocalScoreForTriage` is 5, and every rss item carries `raw.entityId` (rss.js sets it and never
//    sets the `suppressEntityBoost` flag that only email_intake uses). So every news item scores ≥6
//    before a single keyword is examined and the filter drops exactly zero of them.
//
// 3. THE TIER DEFINITIONS DO NOT TRANSFER. triage.js grades "must_read" as "ISA would act, comment, or
//    brief leadership on this" — a rule/docket/bill framing that nothing in a news feed can satisfy as
//    written. Its prompt also instructs the model that "titles in this corpus are often generic or
//    shared verbatim between unrelated filings" and to distrust them, which is exactly wrong for news,
//    where the headline is the single most informative field.
//
// COST. No gate means every news item is triaged: ~68/day in batches of 15 ≈ 5 calls per run. The
// document budget here is 1,200 characters, not the 2,500 the official path uses, because news is
// written as an inverted pyramid — the lede and nut graf carry the significance, whereas a Federal
// Register abstract does not front-load the same way. That keeps this near ~$1.50/month against a
// $5–10/month total. Verdicts are stored, so an item is never paid for twice.
//
// FAIL-SOFT DIVERGES FROM THE OFFICIAL PATH, DELIBERATELY. When a triage batch cannot be parsed,
// triage.js leaves official items UNSEEN so a later run retries them — correct there, because an
// unjudged rule is a missed obligation. For news the opposite is right: the inbox is the primary
// reader, mail that vanishes is a worse failure than mail without a badge, and pipeline.js marks news
// seen at ingest regardless. So a failed news batch yields null verdicts, the items are still stored,
// and they appear in the inbox in time order with no badge.

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";

const BATCH_SIZE = 15;
const DOC_CHARS = 1200;
/** Stop the pass after this many consecutive API errors rather than burning through every batch. */
const MAX_CONSECUTIVE_ERRORS = 2;

export const NEWS_TIERS = ["must_read", "worth_knowing", "background"];

// Tier semantics rewritten for news, and aimed at the use the user stated: "this could be where we see
// breaking news that I might want to ... determine if a push is needed." So `must_read` is defined as
// the PUSH CANDIDATE bar — deliberately narrow, because a notification that fires on a personnel
// announcement is a notification nobody trusts again.
const SYSTEM_PROMPT = `You are ranking agricultural NEWS for the Chief Officer for Demand & Policy at the Iowa Soybean Association. His remit is (a) soybean DEMAND — crush, soybean oil, soybean meal, biofuel and renewable diesel, exports, end users — and (b) POLICY — federal and state rules, trade measures, tax credits, litigation, and farmers' freedom to operate. He is not looking for farming how-to, equipment, community features, or personnel news.

These are news articles, not government documents. The HEADLINE is usually the most informative field — trust it, and use the article text in "document" to confirm or correct what it implies. Where document text is missing, judge from the headline and publisher rather than refusing to judge; saying "substance not retrieved" for a news item is unhelpful, because the headline of a news story generally does carry its point.

For each item return strict JSON: {"uid": "...", "relevant": true|false, "tier": "must_read|worth_knowing|background", "topicIds": [...], "oneLine": "...", "type": "news"} — oneLine states WHAT HAPPENED and why it matters for Iowa soybeans, in one sentence, naming the specific thing (the country, the credit, the ruling, the commodity, the figure). Never restate the headline.

Grade "tier" strictly:
- "must_read": a DEVELOPMENT that could move soybean demand, price, cost, or market access, or that changes policy or the freedom to operate. Court rulings and regulatory decisions; trade actions, tariffs, and agreements; biofuel and tax-credit decisions (45Z, RFS, RIN, LCFS, SAF); major USDA data releases (Acreage, Grain Stocks, WASDE, Crop Progress) and material changes in crop condition; crush or renewable-diesel capacity coming on or going off line; China or Brazil supply, demand, or purchasing shifts; farm bill and appropriations movement; input-cost actions on major crop-protection or fertilizer inputs. This tier is the bar for interrupting his day — treat it as such.
- "worth_knowing": a real agricultural or agribusiness development that is contextual rather than decision-changing — an adjacent commodity, a study or analysis, a sentiment survey, an early-stage or out-of-state matter, general market commentary without a new fact.
- "background": everything else. Agronomy how-to and management advice, equipment and maintenance, weather features without market consequence, PERSONNEL and board appointments, awards and nominations, trade shows and events, human-interest and community stories, opinion and lifestyle.

Judge the SUBSTANCE, not the vocabulary. An announcement that a biofuel group has appointed a new board director is "background" however many times it says biofuel, clean fuels, or policy — a personnel move is not a development. Conversely a story whose headline never uses a watchlist term can still be "must_read" if what happened matters. Most items in a farm-press feed are "background"; that is the expected outcome, not a sign you are being too harsh.

Respond ONLY with a JSON array covering every input item, no other text.`;

/** Strip markdown fences and parse a JSON array, or return null. Mirrors triage.js. */
function parseVerdicts(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
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

/** Human 👍/👎 corrections feed news ranking too, so a thumbs-down on a feature story teaches this pass. */
function feedbackGuidance() {
  const examples = store.getFeedbackExamples(8);
  if (!examples.length) return "";
  const lines = examples.map((e) => {
    const note = e.feedback_note ? ` The analyst's note: "${e.feedback_note}".` : "";
    if (e.feedback === "down") return `- "${e.title}" — marked NOT relevant.${note} Treat similar items as background.`;
    if (e.feedback === "up") return `- "${e.title}" — marked RELEVANT.${note} Rank similar items up.`;
    return `- "${e.title}" — analyst guidance:${note || " (noted)"}`;
  });
  return `\n\nThe analyst has corrected past verdicts. Apply this judgment:\n${lines.join("\n")}`;
}

/**
 * Grade every news item. Returns a uid→verdict Map; the caller stores them (pipeline.js marks news
 * seen exactly once, WITH the verdict — never markSeen(null) first, which would overwrite it).
 *
 * @param {object[]} items   normalized news-class Items, already grounded by enrich.js
 * @param {object[]} topics  watchlist topics (for valid topicIds + the local hint)
 * @param {object} env
 * @returns {Promise<{verdicts: Map<string,object|null>, stats: object}>}
 */
export async function rankNewsItems(items, topics = [], env = process.env, { log = console.log } = {}) {
  const verdicts = new Map();
  const stats = { graded: 0, must_read: 0, worth_knowing: 0, background: 0, failedBatches: 0, calls: 0 };
  if (!items?.length) return { verdicts, stats };
  if (!env.ANTHROPIC_API_KEY) {
    log("   ⚠️ news ranking skipped — no ANTHROPIC_API_KEY");
    return { verdicts, stats };
  }

  let consecutiveErrors = 0;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.TRIAGE_MODEL || "claude-haiku-4-5";
  const topicList = topics.map((t) => `${t.id}: ${t.label}`).join("\n");
  const systemPrompt = SYSTEM_PROMPT + feedbackGuidance();

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const payload = batch.map((it) => ({
      uid: it.uid,
      headline: it.title,
      publisher: it.publisherName || it.sourceLabel,
      published: (it.publishedAt || "").slice(0, 10),
      // 1,200 chars, not the official path's 2,500 — news front-loads its significance.
      document: (it.summary ?? "").slice(0, DOC_CHARS),
      // A hint, never a filter. See the header: gating on this loses USMCA and the Acreage report.
      localTopicGuesses: it.matchedTopics?.map((t) => t.id) ?? [],
    }));

    // ⚠️ A THROWN API ERROR MUST NOT DISCARD THE BATCHES ALREADY PAID FOR (found in review).
    //
    // The SDK throws on a 429/529/ECONNRESET that outlives its own retries. Left uncaught that
    // propagated out of this function, and pipeline.js only copies the verdict Map AFTER the call
    // returns — so an outage on batch 4 of 5 threw away 45 verdicts that had already been billed, and
    // every one of those items was then stored `unscored` and never re-ranked (collect.js won't
    // re-fetch a seen item). Caught per batch instead: earlier verdicts survive, and a run of
    // consecutive failures stops the pass rather than grinding through five doomed calls.
    let parsed = null;
    let threw = null;
    for (let attempt = 1; attempt <= 2 && parsed === null; attempt++) {
      try {
        const resp = await client.messages.create({
          model,
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{ role: "user", content: `Valid topicIds:\n${topicList}\n\nNews items to rank:\n${JSON.stringify(payload, null, 1)}` }],
        });
        stats.calls++;
        store.recordUsage(model, "news_rank", resp.usage.input_tokens, resp.usage.output_tokens);
        const text = resp.content.find((b) => b.type === "text")?.text ?? "";
        parsed = parseVerdicts(text);
        threw = null;
        if (parsed === null && attempt === 1) log("   ⚠️ news-rank batch returned malformed JSON — retrying once");
      } catch (err) {
        threw = err;
        if (attempt === 1) log(`   ⚠️ news-rank batch errored (${err.message}) — retrying once`);
      }
    }

    if (threw) {
      consecutiveErrors++;
      stats.erroredBatches = (stats.erroredBatches ?? 0) + 1;
      for (const it of batch) verdicts.set(it.uid, null);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // Stop, but RETURN what earlier batches produced — the caller stores those verdicts.
        log(`   ⚠️ news ranking stopped after ${consecutiveErrors} consecutive API errors — ${stats.graded} verdicts from earlier batches are kept`);
        break;
      }
      continue;
    }
    consecutiveErrors = 0;

    if (parsed === null) {
      // Mail must not disappear. Leave these ungraded (null) — pipeline.js still stores them, so they
      // show in the inbox in time order without a badge. See the header for why this differs from
      // triage.js's leave-unseen behaviour.
      stats.failedBatches++;
      log(`   ⚠️ news-rank batch ${Math.floor(i / BATCH_SIZE) + 1} failed twice — ${batch.length} items stay ungraded (still stored, still in the inbox)`);
      for (const it of batch) verdicts.set(it.uid, null);
      continue;
    }

    const byUid = new Map(parsed.filter((v) => v && v.uid).map((v) => [v.uid, v]));
    for (const it of batch) {
      const v = byUid.get(it.uid);
      if (!v) {
        verdicts.set(it.uid, null);
        continue;
      }
      // An omitted/unknown tier lands on worth_knowing, never must_read: the push bar must not be
      // cleared by a parsing accident.
      const tier = NEWS_TIERS.includes(v.tier) ? v.tier : (v.relevant ? "worth_knowing" : "background");
      verdicts.set(it.uid, {
        relevant: Boolean(v.relevant),
        tier,
        topicIds: Array.isArray(v.topicIds) ? v.topicIds : [],
        oneLine: String(v.oneLine ?? ""),
        type: v.type ? String(v.type) : "news",
      });
      stats.graded++;
      stats[tier]++;
    }
  }

  if (stats.graded || stats.failedBatches) {
    log(
      `   📊 News ranking: ${stats.graded} graded — ${stats.must_read} must-read, ${stats.worth_knowing} worth knowing, ` +
        `${stats.background} background (${stats.calls} call${stats.calls === 1 ? "" : "s"})`
    );
  }
  return { verdicts, stats };
}

/**
 * The push-candidate set: the news a future higher-frequency poll would consider notifying on.
 *
 * Exported now, with no caller, ON PURPOSE — it is the seam the user asked for ("this could be where we
 * see breaking news that I might want to at some point to a more frequent auto check and determine if a
 * push is needed"). Keeping the definition of "would we push on this?" in one named place means the
 * future poll makes that decision the same way the UI displays it, rather than re-deriving it.
 *
 * ⚠️ A push built on this MUST still solve two problems this function does NOT:
 *  - CROSS-OUTLET DUPLICATES. eventkey.js keys news on an EXACT normalized title, so one announcement
 *    covered by two outlets is two events. Measured in the real corpus: "USDA to Fund $500 Million
 *    Expansion of Domestic Fertilizer Production" and "USDA puts $500M into fertilizer investment
 *    initiative" are one story and do not collapse. Two pushes for one announcement.
 *  - DELIVERY DEDUPE. alerts.js advances its kv_state watermark BEFORE delivery is attempted, so a
 *    failed send is lost permanently rather than retried.
 */
export function pushCandidates(rows, { sinceHours = 6 } = {}) {
  const cutoff = Date.now() - sinceHours * 3600e3;
  return (rows ?? []).filter(
    (r) =>
      r.triage_tier === "must_read" &&
      r.triage_verdict === "relevant" &&
      Date.parse(r.first_seen_at || 0) >= cutoff
  );
}
