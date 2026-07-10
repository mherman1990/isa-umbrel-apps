// brief.js — the one BRIEF_MODEL (Sonnet) call that turns triaged items into the brief.
//
// The model writes everything ABOVE the final "---" divider; the stats footer is
// appended programmatically so its numbers are always exact (models shouldn't be
// trusted to copy arithmetic). The model is instructed to never invent items and
// to include the URL for every item.

import { anthropicClient } from "./llm.js";
import * as store from "./store.js";

function briefSystemPrompt(statesTracked) {
  return `You write the Iowa Soybean Association's twice-daily policy brief. You are given a JSON list of pre-screened government items (each with uid, title, oneLine, source, date, url, docType, jurisdiction, and any comment deadlines).

Produce EXACTLY this markdown structure:

## ISA Policy Brief — {date} ({AM|PM} edition)

### 🔴 Top developments
3–5 items max. For each: what happened + why it matters to Iowa soy + source link.

### 📌 Tracked item movement
ONLY items marked "tracked": true — these are items the analyst is following; list every one of them here (they may also appear in Top developments if warranted). Omit this section if no items are tracked.

### 📜 Federal rules & notices (Federal Register)
### 🗂️ Rulemaking dockets (Regulations.gov)
### 🏛️ Federal legislation (Congress.gov)
### 🗺️ State legislation (${statesTracked})
### ⚖️ Federal litigation
### 🇪🇺 EU regulation
### 📋 Iowa administrative rules

Each item: **[Jurisdiction/Source]** Title — one line why it matters. [link](url) (date)
Omit empty sections entirely.

### ⏰ Deadlines
Any comment periods or key dates found in the data, soonest first. Omit this section if there are none.

Hard rules:
- NEVER invent items. NEVER add information not present in the input data.
- Keep every item to one line.
- Include the URL for every item as a markdown link.
- Do not write anything after the last section — no sign-off, no stats footer (it is appended automatically).`;
}

// The farmer-facing render (Track A second audience): same items, plain and strictly
// nonpartisan. This is what goes to ISA members, so it must never read as political.
function farmerBriefSystemPrompt(dateLabel) {
  return `You write "The Bean Brief for Farmers", a plain-English, strictly NONPARTISAN policy update for Iowa soybean FARMERS — not political insiders. The reader is a busy farmer who wants to know what is happening in policy that could affect their operation.

Produce EXACTLY this markdown structure:

## The Bean Brief for Farmers — ${dateLabel}

### What's happening
3–6 items in plain language. For each: what happened + what it could mean for an Iowa soybean operation, in neutral terms. Include the source link.

### Worth a look
Shorter items, one line each. Omit this section if there are none.

### Dates to know
Comment deadlines and key dates, soonest first. Omit this section if there are none.

Hard rules:
- STRICTLY nonpartisan and factual. Never say who to support or oppose; no campaign or partisan framing; no political strategy or optics.
- Write for a farmer: plain words, and briefly explain any jargon (e.g., "RFS" → "the federal rule requiring biofuel to be blended into the fuel supply").
- NEVER invent items. Include each item's URL as a markdown link.
- Do not write anything after the last section — no sign-off, no stats footer (it is appended automatically).`;
}

export async function generateBrief({ relevantItems, watchlist, edition, env, stats, audience = "internal" }) {
  const client = anthropicClient(env);
  const model = env.BRIEF_MODEL || "claude-sonnet-5";
  const statesTracked = (watchlist.sources?.legiscan?.states ?? []).join(", ") || "state";
  const maxItems = watchlist.output?.maxItemsInBrief ?? 25;

  const timezone = watchlist.briefEditions?.timezone ?? "America/Chicago";
  const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

  // Highest local score first, capped for the brief. Tracked items are never
  // dropped by the cap — the analyst asked to follow them.
  const sorted = [...relevantItems].sort((a, b) => (b.localScore ?? 0) - (a.localScore ?? 0));
  const trackedOnes = sorted.filter((i) => i.tracked);
  const rest = sorted.filter((i) => !i.tracked).slice(0, Math.max(0, maxItems - trackedOnes.length));
  const items = [...trackedOnes, ...rest]
    .map((item) => ({
      uid: item.uid,
      title: item.title,
      oneLine: item.oneLine ?? "",
      source: item.sourceLabel,
      date: (item.publishedAt ?? "").slice(0, 10),
      url: item.url,
      docType: item.docType,
      jurisdiction: item.jurisdiction,
      commentDeadline: item.raw?.commentsCloseOn ?? null,
      tracked: Boolean(item.tracked),
    }));

  const isFarmer = audience === "farmer";
  let body;
  if (items.length === 0) {
    // No Sonnet call needed for an empty day — that's a $0 brief.
    body = isFarmer
      ? `## The Bean Brief for Farmers — ${dateLabel}\n\nNo major policy updates affecting Iowa soybean farms in this scan. 🌱\n`
      : `## ISA Policy Brief — ${dateLabel} (${edition.toUpperCase()} edition)\n\nNo new items relevant to the watchlist were found in this scan. Quiet day on the policy front. 🌱\n`;
  } else {
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system: isFarmer ? farmerBriefSystemPrompt(dateLabel) : briefSystemPrompt(statesTracked),
      messages: [
        {
          role: "user",
          content: `Date: ${dateLabel}\nEdition: ${edition.toUpperCase()}\n\nItems (JSON):\n${JSON.stringify(items, null, 1)}`,
        },
      ],
    });
    store.recordUsage(model, isFarmer ? "brief-farmer" : "brief", response.usage);
    body = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  }

  // Footer appended programmatically. Farmers get a plain nonpartisan line; the
  // internal edition gets the full scan stats.
  const generatedAt = new Date().toLocaleString("en-US", { timeZone: timezone });
  let footer;
  if (isFarmer) {
    footer = `\n\n---\n*The Bean Brief — ${generatedAt} (${timezone}). Informational and nonpartisan; not an endorsement of any candidate or party.*\n`;
  } else {
    const skippedText = stats.skippedSources.length ? stats.skippedSources.map((s) => s.label).join(", ") : "none";
    footer =
      `\n\n---\n*Scanned: ${stats.fetchedCount} items across ${stats.sourceCount} sources | ` +
      `${relevantItems.length} relevant after triage |\n` +
      `Skipped sources: ${skippedText} | Generated ${generatedAt} (${timezone})*\n`;
  }

  return body + footer;
}
