// brief.js — the one BRIEF_MODEL (Sonnet) call that turns triaged items into the brief.
//
// The model writes everything ABOVE the final "---" divider; the stats footer is
// appended programmatically so its numbers are always exact (models shouldn't be
// trusted to copy arithmetic). The model is instructed to never invent items and
// to include the URL for every item.
//
// ⚠️ WHY THIS FILE WAS REWRITTEN IN 1.29.0 — READ BEFORE CHANGING THE PROJECTION.
//
// This file went untouched from 2026-07-08 through v1.28.0, while three releases landed upstream of
// it: v1.26.0 added graded triage tiers, v1.27.0 grounded official documents and collapsed one
// action's many filings, v1.28.0 grounded news. NONE of it reached the writer. Measured before the
// rewrite: the projection carried ten fields with no tier and ZERO characters of document text,
// while triage saw 2,500 chars of the same document and `compactItems` carried 1,200 to the Ask box.
// So the one output that is emailed twice a day reasoned about federal rules from a headline plus a
// Haiku sentence *about* that headline — the exact failure v1.27.0 was written to eliminate.
//
// It also sorted by `localScore`, the keyword count. That is the wrong primary key for a decision
// brief and we have the measurement to prove it: on the real news corpus a Clean Fuels personnel
// notice scores 10 on keywords, HIGHER than a SCOTUS FIFRA preemption ruling's 8. Keyword score is
// now the last tie-break, never the sort key.
//
// The fix is entirely in what the writer is *given* and *asked for* — same single model call, same
// markdown output. Everything the projection needs was already in memory: `.tier` from triage,
// `.summary` (the enriched document) from enrich, `.eventFilings` from the event grouping.

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";

// Per-item document budget for the brief. Deliberately smaller than the Ask box's 1,200
// (CONTEXT_BODY_CHARS in pipeline.js): the brief needs enough of the operative paragraph to write
// two accurate sentences and quote one phrase, not enough to reason at length. Federal Register
// abstracts run ~300–2,300 chars, so 900 carries most of them whole.
const BRIEF_DOC_CHARS = 900;

// Two budgets, not one cap. The old single `maxItemsInBrief` had every item travel identically;
// now the top slice carries evidence and the tail travels as metadata so it can still appear under
// Deadlines / Could matter later / What to watch without paying for a document it won't quote.
//
// ⚠️ Sending documents for all 25 instead of 10 costs ~+$1.35/mo, silently. If you "simplify" this
// back to one budget, that is the bill.
const DEFAULT_PAYLOAD_ITEMS = 10;
const DEFAULT_ROSTER_ITEMS = 25;

// "Needs attention" means there is something to DO soon. 14 days is the window: long enough that a
// comment deadline is still actionable (drafting + internal review), short enough to stay a to-do
// list rather than a calendar.
const ACTION_WINDOW_DAYS = 14;

function briefSystemPrompt({ statesTracked, actionWindowDays }) {
  return `You write the Iowa Soybean Association's twice-daily policy brief. Your reader is ISA's Chief Officer for Demand & Policy. He reads this twice a day and acts on it, so lead with what changed and what he has to do.

You are given a JSON list of pre-screened government ACTIONS (not documents — see eventFilings). Each carries:
- **title, url, source, date, jurisdiction, docType** — identity. States tracked: ${statesTracked}.
- **priority** — the relevance grade from triage. "must_read" means ISA would act, comment, or brief leadership; then "worth_knowing"; then "background".
- **document** — the action's OWN TEXT (an official abstract or article excerpt). This is sourced fact.
- **oneLine** — one sentence a cheap model wrote ABOUT the title. This is someone else's summary, NOT source text.
- **evidenceBasis** — "document" when real text was retrieved, "title_only" when it was NOT.
- **eventFilings** — how many separate places this ONE action was filed.
- **commentDeadline** and **daysToDeadline** — the day count is already computed for you.
- **tracked** — the analyst pinned this item and is following it.
- **metadataOnly** — true means no document text was sent for this item.

Produce EXACTLY this markdown structure:

## ISA Policy Brief — {date} ({AM|PM} edition)

### 🔴 What changed
3–5 developments, most consequential first. For each, 2–3 sentences: the ACTION (who did what, under what authority), then what it changes for Iowa soybeans, then the number or date that makes it concrete. End the entry with [Title](url) · source · date.

### ⚡ Needs attention
ONLY items where ISA has something to DO within ${actionWindowDays} days — file a comment, brief leadership, contact a member, respond by a date. One line each, naming the action and the date. Omit this section if there are none.

### 🌱 Could matter later
One line each. Early-stage, out-of-state or second-order items that are not decisions yet but are on a path to becoming one. Say WHAT WOULD MAKE IT MATTER. Omit this section if there are none.

### ⏰ Deadlines & required actions
Every comment period and dated obligation in the data, soonest first, each with its days remaining (use daysToDeadline; do not compute dates yourself). Omit this section if there are none.

### 📎 Evidence
For each development in "What changed", the sourced basis for it: a short verbatim phrase from that item's document, attributed to the item. Where an item's evidenceBasis is "title_only", say plainly that the substance was not retrieved. Omit this section if no development has a document.

### 👀 What to watch
The next expected event for each open thread — the report, hearing, decision or filing that would resolve it, and roughly when. Omit this section if the data supports nothing.

Hard rules:
- NEVER invent items. NEVER add information not present in the input data.
- Include the URL for every item you name, as a markdown link.
- Write each development or bullet as ONE line — do not hard-wrap a paragraph across several lines. The email renderer turns every line into its own paragraph, so a wrapped entry arrives broken into fragments.
- Do not write anything after the last section — no sign-off, no stats footer (it is appended automatically).
- An item whose **evidenceBasis is "title_only"** may appear ONLY under "Could matter later", "Deadlines & required actions" or "What to watch", and its line must say the substance was not retrieved. It may NEVER be a "What changed" development — you would be describing a document nobody read.
- An item with **eventFilings greater than 1** is ONE action filed in several places. State how many filings; never present it as several corroborating items. Repetition is not evidence.
- An item with **priority "background"** may never be a "What changed" development.
- Treat **document** as sourced fact and **oneLine** as someone else's summary. Where they differ, follow the document and prefer its wording.
- Do NOT enumerate every input item. Items you don't write about remain available to the reader on the Laws, Rules & Decisions page. A short brief that surfaces the right five actions is the goal.`;
}

/** Days from `fromISO` to `toISO`, both YYYY-MM-DD. Compared as UTC midnights so DST never shifts a
 *  boundary — these are calendar dates, not instants. Returns null on anything unparseable. */
function daysBetweenDates(fromISO, toISO) {
  const a = Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function documentText(item) {
  return String(item.summary ?? item.body ?? "").trim();
}

/** "document" once there is enough text to quote; "title_only" when the substance was never
 *  retrieved. 200 chars is the measured dividing line: `iowa_admin_rules` and `eurlex_oj` still
 *  emit `summary: ""`, ungrounded RSS teasers measured 1–199 chars, and real FR abstracts start
 *  around 300. Below 200 there is nothing a brief could honestly quote. */
function evidenceBasisOf(item) {
  return documentText(item).length >= 200 ? "document" : "title_only";
}

const TIER_ORDER = { must_read: 0, worth_knowing: 1, background: 2 };

/** ⚠️ THE NULL-TIER TRAP, same one `test/filter-tiers.test.js` locks for the LRD filter. An item
 *  with no tier must fall to the MIDDLE, never to "background" — otherwise any item that skipped
 *  or predates grading is silently disqualified from being a development. Fresh `relevant[]` items
 *  always carry `.tier`, so this is the defensive case, and it must stay defensive in this
 *  direction. */
function tierRank(item) {
  return TIER_ORDER[item.tier ?? item.triage_tier] ?? TIER_ORDER.worth_knowing;
}

/** 0 for a real abstract, 1 for a short one, 2 for title-only. Lower sorts first, so at equal tier
 *  a grounded item outranks an ungrounded one — which is v1.27.0/v1.28.0's whole thesis finally
 *  reaching the brief. Phase 2 adds a packet tier above `document`. */
function evidenceRank(item) {
  const n = documentText(item).length;
  if (n >= 800) return 0;
  if (n >= 200) return 1;
  return 2;
}

export async function generateBrief({ relevantItems, watchlist, edition, env, stats }) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-5";
  const statesTracked = (watchlist.sources?.legiscan?.states ?? []).join(", ") || "state";

  // Defaulted in code, not required in watchlist.json — so a Pi that never merges a new key still
  // gets the new behaviour on a code-only Update.
  const payloadBudget = watchlist.output?.briefPayloadItems ?? DEFAULT_PAYLOAD_ITEMS;
  const rosterBudget = watchlist.output?.maxItemsInBrief ?? DEFAULT_ROSTER_ITEMS;

  const timezone = watchlist.briefEditions?.timezone ?? "America/Chicago";
  const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

  // Ordering, in priority order. `localScore` is LAST — see the header note on why the keyword
  // count cannot be the sort key.
  const deadlineOf = (item) => item.raw?.commentsCloseOn ?? item.commentDeadline ?? null;
  const daysToDeadlineOf = (item) => {
    const d = deadlineOf(item);
    return d ? daysBetweenDates(dateLabel, d) : null;
  };
  const actionableRank = (item) => {
    const days = daysToDeadlineOf(item);
    return days !== null && days >= 0 && days <= ACTION_WINDOW_DAYS ? 0 : 1;
  };

  const sorted = [...relevantItems].sort(
    (a, b) =>
      tierRank(a) - tierRank(b) ||
      actionableRank(a) - actionableRank(b) ||
      evidenceRank(a) - evidenceRank(b) ||
      (b.eventFilings ?? 1) - (a.eventFilings ?? 1) ||
      (b.localScore ?? 0) - (a.localScore ?? 0)
  );

  // Tracked items always carry evidence and are never dropped by either budget — the analyst
  // explicitly asked to follow them, and they are the only user-curated signal in the brief. If
  // more than `payloadBudget` items are pinned, the payload grows rather than dropping any.
  const tracked = sorted.filter((i) => i.tracked);
  const untracked = sorted.filter((i) => !i.tracked);

  const payloadSlots = Math.max(0, payloadBudget - tracked.length);
  const payloadRest = untracked.slice(0, payloadSlots);
  const payload = [...tracked, ...payloadRest];

  // Whatever the roster budget has left after the payload. Written as an explicit count rather than
  // a computed end index: this is the arithmetic a future "simplification" would get wrong.
  const rosterSlots = Math.max(0, rosterBudget - payload.length);
  const roster = untracked.slice(payloadRest.length, payloadRest.length + rosterSlots);

  const project = (item, { withDocument }) => {
    const doc = documentText(item);
    const days = daysToDeadlineOf(item);
    const entry = {
      uid: item.uid,
      title: item.title,
      oneLine: item.oneLine ?? "",
      source: item.sourceLabel,
      date: (item.publishedAt ?? "").slice(0, 10),
      url: item.url,
      docType: item.docType,
      jurisdiction: item.jurisdiction,
      commentDeadline: deadlineOf(item) ? String(deadlineOf(item)).slice(0, 10) : null,
      tracked: Boolean(item.tracked),
      // The three fields three releases of upstream work produced and the writer never saw.
      priority: item.tier ?? item.triage_tier ?? null,
      eventFilings: item.eventFilings ?? 1,
      evidenceBasis: evidenceBasisOf(item),
    };
    if (days !== null) entry.daysToDeadline = days;
    if (Array.isArray(item.topicIds) && item.topicIds.length) entry.topicIds = item.topicIds;
    if (withDocument && doc) {
      entry.document = doc.slice(0, BRIEF_DOC_CHARS) + (doc.length > BRIEF_DOC_CHARS ? " […]" : "");
    } else if (!withDocument) {
      entry.metadataOnly = true;
    }
    return entry;
  };

  const items = [
    ...payload.map((i) => project(i, { withDocument: true })),
    ...roster.map((i) => project(i, { withDocument: false })),
  ];

  // House rule: no silent caps. If anything was withheld, say so and say how much.
  const notSent = relevantItems.length - items.length;
  console.log(
    `   📝 Brief: ${relevantItems.length} relevant action${relevantItems.length === 1 ? "" : "s"} → ` +
      `${payload.length} with evidence, ${roster.length} metadata-only` +
      (notSent > 0 ? `, ${notSent} not sent (see Laws, Rules & Decisions)` : "")
  );

  let body;
  if (items.length === 0) {
    // Not reachable from the scheduled run — `runFullPipeline` returns before calling this when
    // nothing is relevant. Kept because this function is exported: an empty list would otherwise
    // bill for a model call that can only produce a stub.
    body = `## ISA Policy Brief — ${dateLabel} (${edition.toUpperCase()} edition)\n\nNo new items relevant to the watchlist were found in this scan. Quiet day on the policy front. 🌱\n`;
  } else {
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      // Adaptive thinking is ON BY DEFAULT on Sonnet 5 and counts against max_tokens. This is a
      // structured write-up over pre-judged items, not a reasoning task, and the 8k ceiling is
      // sized for prose — leaving thinking on would spend that budget before the brief is written.
      thinking: { type: "disabled" },
      system: briefSystemPrompt({ statesTracked, actionWindowDays: ACTION_WINDOW_DAYS }),
      messages: [
        {
          role: "user",
          content: `Date: ${dateLabel}\nEdition: ${edition.toUpperCase()}\n\nActions (JSON):\n${JSON.stringify(items, null, 1)}`,
        },
      ],
    });
    store.recordUsage(model, "brief", response.usage.input_tokens, response.usage.output_tokens);
    body = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  }

  // Footer appended programmatically so its numbers are always exact.
  const generatedAt = new Date().toLocaleString("en-US", { timeZone: timezone });
  const skippedText = stats.skippedSources.length ? stats.skippedSources.map((s) => s.label).join(", ") : "none";
  const footer =
    `\n\n---\n*Scanned: ${stats.fetchedCount} items across ${stats.sourceCount} sources | ` +
    `${relevantItems.length} relevant after triage |\n` +
    `Skipped sources: ${skippedText} | Generated ${generatedAt} (${timezone})*\n`;

  return body + footer;
}

// Exported for tests only: these encode measured thresholds (the 200-char title-only line, the
// null-tier default, keyword score demoted to last) that a future edit could silently undo.
export const __testing = { daysBetweenDates, evidenceBasisOf, tierRank, evidenceRank, BRIEF_DOC_CHARS, ACTION_WINDOW_DAYS };
