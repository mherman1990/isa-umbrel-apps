// policycards.js — draft → bind → lint → review, the structured core of the daily policy brief.
//
// WHAT CHANGED AND WHY. The daily brief used to be ONE Sonnet call that emitted markdown prose. That
// made three things impossible at once: nothing could be linted (there were no fields), nothing could
// be counted (there were no records), and "did we already report this thread yesterday?" had no
// answer that did not involve re-reading yesterday's prose. Cards are the fix. The brief still ships
// as markdown — the renderer is downstream — but the markdown is now GENERATED FROM CHECKED RECORDS
// instead of being the primary artefact.
//
// THE PIPELINE, and what enforces what:
//
//   draft   (Sonnet)  — writes cards from actions + an evidence MENU
//   bind    (code)    — resolves every cited id against the store; unresolvable ids are DROPPED
//   lint    (code)    — the six-slot contract, deterministically (policylint.js)
//   review  (Opus)    — judges the causal claim; may reject or downgrade, never rewrite
//
// ⚠️ THE ORDER IS DELIBERATE AND NOT INTERCHANGEABLE. Lint runs BEFORE review so the expensive model
// never spends tokens judging a card that a regex could have rejected — and so the reviewer's
// rejection log measures judgement failures rather than formatting ones. If lint ran last it would
// silently discard cards the reviewer had already been paid to approve.
//
// ⚠️ EVIDENCE IS A MENU, NOT A FREE-TEXT FIELD. The model may only cite ids it was shown, and every
// id is re-checked here against what is actually in the store. This is `thesis.js`'s grounding
// guarantee and this module REUSES its resolver rather than reimplementing it — two evidence
// validators drifting apart is exactly the kind of bug neither would catch.

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import { resolveEvidence } from "./thesis.js";
import { gradeEvidence } from "./provenance.js";
import { lintCards, POSTURE_STATUSES } from "./policylint.js";
import { MECHANISM_TERMINALS, CERTAINTY_STATES } from "./prompts/policy-domain.js";
import { POLICY_SYNTHESIS_SYSTEM, synthesisUserTurn } from "./prompts/policy-synthesis.js";
import { POLICY_REVIEW_SYSTEM, reviewUserTurn } from "./prompts/policy-review.js";

/** Cards drafted per run. A ceiling, not a target — the prompt asks for 3–6. */
const DRAFT_BUDGET = 8;
/** Per-item document budget in the actions payload. Same 900 the prose brief used. */
const DOC_CHARS = 900;
/** How far back a thread counts as "already carded", for the continuation rule. Covers AM→PM and
 *  PM→next AM on a twice-daily schedule, so neither edition re-announces the other's threads. */
export const PRIOR_CARD_HOURS = 36;

/**
 * ⚠️ minItems / maxItems ARE REJECTED BY THE API on `json_schema` output (measured 2026-08-06, same
 * finding as thesis.js — `minimum`/`maximum` and string-length constraints go the same way). Array
 * bounds therefore live here and are applied in code after the response. Do not "fix" the schema by
 * adding them back; the call will fail at runtime, not at review time.
 */
export const BOUNDS = {
  chain: { min: 2, max: 5 },
  evidence: { min: 2, max: 8 },
};

export const POLICY_CARD_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      description: "One card per action worth reporting. Fewer, better-grounded cards is the goal — there is no quota.",
      items: {
        type: "object",
        properties: {
          event_key: {
            type: "string",
            description: "Copied EXACTLY from the action's eventKey field. This is the thread identity; a card whose event_key is not in the supplied actions is dropped.",
          },
          headline: { type: "string", description: "A short title for the card, 8 words or fewer. No trailing period." },
          what_changed: {
            type: "string",
            description: "The discrete action, naming the acting body, in 1-2 sentences. Not 'movement on X' — say who did what, under what authority.",
          },
          posture: {
            type: "object",
            description: "Procedural status and the clock. The single most important slot for not misleading the reader.",
            properties: {
              status: { type: "string", enum: POSTURE_STATUSES, description: "Where the action actually sits procedurally." },
              clock_date: {
                type: "string",
                description: "YYYY-MM-DD for the governing date (comment close, effective date, hearing, statutory deadline). Empty string ONLY when the source genuinely gives none.",
              },
              clock_label: { type: "string", description: "What that date is: 'comments close', 'effective', 'oral argument', 'agency must act by'." },
              detail: { type: "string", description: "One sentence of procedural detail — court and posture for litigation, what the comment period covers, what a guidance does and does not bind." },
            },
            required: ["status", "clock_date", "clock_label", "detail"],
            additionalProperties: false,
          },
          mechanism: {
            type: "object",
            description: "The causal path from the action to a named variable.",
            properties: {
              chain: {
                type: "array",
                items: { type: "string" },
                description: "2 to 5 ordered steps, each following from the last, the final step arriving at the terminal variable.",
              },
              terminal: {
                type: "string",
                enum: MECHANISM_TERMINALS.map((t) => t.id),
                description: "The variable the chain ends in. Must be one of these — a chain that ends anywhere else is not checkable.",
              },
              weak_link: {
                type: "string",
                description: "Which step is least established and why, in one sentence. Empty string only if every step is firm — that is rare and you should be suspicious of it.",
              },
            },
            required: ["chain", "terminal", "weak_link"],
            additionalProperties: false,
          },
          evidence: {
            type: "array",
            items: { type: "string" },
            description:
              "Evidence IDs ONLY, copied EXACTLY from the menu. At least one item: id AND at least one series: id. Anything not on the menu is dropped in code before render.",
          },
          so_what: {
            type: "string",
            description:
              "The consequence for an Iowa corn/soybean operation, 1-2 sentences, concrete and local. Explain the consequence; never instruct anyone to buy, sell, hold, price or hedge.",
          },
          watch_next: {
            type: "object",
            properties: {
              event: { type: "string", description: "The NAMED next event. 'Monitor developments' is not an event." },
              date: { type: "string", description: "YYYY-MM-DD, or a dated window: YYYY-MM, YYYY-MM-DD..YYYY-MM-DD, or YYYY-Q3." },
            },
            required: ["event", "date"],
            additionalProperties: false,
          },
          certainty: {
            type: "string",
            enum: CERTAINTY_STATES.map((c) => c.id),
            description: "The ACTION's procedural reality, not your confidence in your own analysis.",
          },
        },
        required: ["event_key", "headline", "what_changed", "posture", "mechanism", "evidence", "so_what", "watch_next", "certainty"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
};

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          card_index: { type: "integer", description: "The 0-based index of the card being judged, exactly as supplied." },
          verdict: { type: "string", enum: ["keep", "downgrade", "reject"] },
          failed_slot: {
            type: "string",
            enum: ["what_changed", "posture", "mechanism", "evidence", "so_what", "watch_next", "certainty", "none"],
            description: "The slot that failed. 'none' is valid ONLY with verdict 'keep'. A rejection that cannot name a slot is not a rejection.",
          },
          reason: { type: "string", description: "One sentence. Empty string when the verdict is 'keep'." },
          corrected_certainty: {
            type: "string",
            enum: ["enacted", "proposed", "contested", "speculative", "none"],
            description: "Required when verdict is 'downgrade'; 'none' otherwise. May only move DOWN the ladder.",
          },
        },
        required: ["card_index", "verdict", "failed_slot", "reason", "corrected_certainty"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

// ── evidence universe + menu ──────────────────────────────────────────────────────────────────────

/**
 * Assemble what a card is allowed to cite.
 *
 * ⚠️ DEAD EVIDENCE IS EXCLUDED FROM THE MENU, NOT FILTERED OUT AFTERWARDS. The spec's rule is that no
 * card may rest on a source that failed. Removing those series before the model ever sees them is
 * what makes that structural: it cannot cite what it was not shown, and if it invents the id anyway
 * the resolver drops it. Filtering after drafting would leave a card whose mechanism was BUILT on a
 * dead series and merely lose the citation — the worst of both.
 *
 * ⚠️ THE TEST IS STALENESS, NOT "DID THE ADAPTER FAIL THIS RUN". Deliberate, and stronger. Adapter id
 * does not map cleanly onto series prefix anyway (`usda_nass` writes `nass:`, `cbot_futures` writes
 * `cbot:`), but the real reason is that a series is bad evidence when it is old regardless of WHY —
 * an adapter that failed today, an API key removed last month, and a feed silently discontinued all
 * produce the same stale number, and only the first would be caught by watching this run's failures.
 * `seriesFreshness` already measures each series against its OWN cadence, so EIA's normal 3-month
 * publication lag is not mistaken for a dead feed.
 */
export function buildEvidenceUniverse({ items, excludeSeriesPrefixes = [] }) {
  const itemUids = new Set(items.map((i) => i.uid).filter(Boolean));
  const stale = new Set(store.seriesFreshness().filter((r) => r.stale).map((r) => r.series));
  const snapshot = store.marketSnapshot();
  const usable = snapshot.filter((m) => !stale.has(m.series) && !excludeSeriesPrefixes.some((p) => m.series.startsWith(p)));
  const excluded = snapshot.length - usable.length;
  const seriesIds = new Set(usable.map((m) => m.series));
  return {
    universe: { itemUids, seriesIds, signalIds: new Set(), briefPaths: new Set(), reportKeys: new Set() },
    series: usable,
    excludedSeries: excluded,
  };
}

/** The menu the model is shown. Every line is an id it may copy, plus what that id is. */
export function renderEvidenceMenu({ items, series }) {
  const itemLines = items.map((i) => {
    const g = gradeEvidence({ sourceId: i.sourceId, url: i.url });
    const basis = i.evidenceBasis ?? "";
    return `  item:${i.uid}  [${g.label}${g.advocacy ? ", interested party" : ""}${basis ? `, ${basis}` : ""}]  ${String(i.title ?? "").slice(0, 110)}`;
  });
  const seriesLines = series.map((m) => {
    const latest = m.latest ? `latest ${m.latest.value} ${m.unit ?? ""} @ ${m.latest.period}` : "no data";
    return `  series:${m.series}  [${m.category}]  ${m.label} — ${latest}`;
  });
  return (
    `DOCUMENTS AND NEWS (cite at least one):\n${itemLines.join("\n") || "  (none)"}\n\n` +
    `MARKET AND DATA SERIES (cite at least one):\n${seriesLines.join("\n") || "  (none)"}`
  );
}

/** Resolve a card's cited ids and attach a provenance grade to each. Unresolvable ids are dropped. */
export function bindEvidence(card, universe, itemsByUid) {
  const { resolved, dropped } = resolveEvidence(card?.evidence, universe);
  const graded = resolved.slice(0, BOUNDS.evidence.max).map((e) => {
    if (e.kind === "item") {
      const it = itemsByUid.get(e.key);
      const g = gradeEvidence({ sourceId: it?.sourceId, url: it?.url });
      return { id: e.id, kind: "item", key: e.key, grade: g.grade, label: g.label, advocacy: g.advocacy, title: it?.title ?? "", url: it?.url ?? "" };
    }
    // A stored market series is the publishing agency's own statistic — primary by construction.
    // It says nothing about whether a RULE is final, which is why policylint's `enacted` rule
    // deliberately ignores series evidence.
    return { id: e.id, kind: "series", key: e.key, grade: "primary_source", label: "primary source", advocacy: false };
  });
  return { evidence: graded, dropped };
}

// ── the model stages ──────────────────────────────────────────────────────────────────────────────

/** Project one action into the compact JSON the writer sees. Mirrors brief.js's projection. */
function projectAction(item, packet) {
  const doc = String(item.summary ?? item.body ?? "").trim();
  const entry = {
    eventKey: item.raw?.eventKey ?? null,
    uid: item.uid,
    title: item.title,
    source: item.sourceLabel,
    sourceId: item.sourceId,
    url: item.url,
    date: String(item.publishedAt ?? "").slice(0, 10),
    docType: item.docType,
    jurisdiction: item.jurisdiction,
    priority: item.tier ?? item.triage_tier ?? null,
    eventFilings: item.eventFilings ?? 1,
    commentDeadline: item.raw?.commentsCloseOn ?? item.commentDeadline ?? null,
    oneLine: item.oneLine ?? "",
    evidenceBasis: packet ? "packet" : doc.length >= 200 ? "document" : "title_only",
  };
  if (packet) {
    const pk = packet.packet;
    entry.packet = {
      sufficiency: packet.sufficiency,
      whatHappened: pk.what_happened,
      claims: pk.claims,
      actionsRequired: pk.actions_required,
      dates: pk.dates,
      quantities: pk.quantities,
      soyMechanisms: pk.soy_mechanisms,
      evidence: pk.evidence,
      unknowns: pk.unknowns,
      notInDocument: pk.not_in_document,
    };
  } else if (doc) {
    entry.document = doc.slice(0, DOC_CHARS) + (doc.length > DOC_CHARS ? " […]" : "");
  }
  return entry;
}

/** Draft stage. One Sonnet call, system prompt cached. */
async function draftCards({ client, model, dateLabel, edition, actions, evidenceMenu, priorThreads, missingLayers }) {
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    // Structured extraction over pre-judged items, exactly like brief.js's prose call — adaptive
    // thinking would spend the budget before the cards are written.
    thinking: { type: "disabled" },
    output_config: { format: { type: "json_schema", schema: POLICY_CARD_SCHEMA } },
    // ⚠️ The breakpoint is on the SYSTEM prompt because that is the stable part (~1,900 tokens of
    // domain block + task, comfortably over Sonnet 5's 1,024-token cache minimum). Everything that
    // changes between runs is in the user turn. Reversing this caches nothing.
    system: [{ type: "text", text: POLICY_SYNTHESIS_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: synthesisUserTurn({ dateLabel, edition, actions, evidenceMenu, priorThreads, missingLayers }) }],
  });
  store.recordUsage(model, "policy_cards", resp.usage.input_tokens, resp.usage.output_tokens, resp.usage);
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text)?.cards ?? [];
  } catch {
    // Defensive despite the schema — every schema-constrained call site in this codebase does the same.
    return null;
  }
}

/** Review stage. One batched Opus call — the inter-card checks cannot be done per card. */
async function reviewCards({ client, model, dateLabel, cards, evidenceMenu }) {
  const payload = cards.map((c, i) => ({ card_index: i, ...c }));
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    output_config: { format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    system: [{ type: "text", text: POLICY_REVIEW_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: reviewUserTurn({ dateLabel, cards: payload, evidenceMenu }) }],
  });
  store.recordUsage(model, "policy_review", resp.usage.input_tokens, resp.usage.output_tokens, resp.usage);
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text)?.verdicts ?? [];
  } catch {
    return null;
  }
}

const CERTAINTY_ORDER = ["enacted", "contested", "proposed", "speculative"];
/** A downgrade may only move DOWN the ladder. Asserted by test — a reviewer that could raise
 *  certainty would be able to promote a proposal to a final rule, which is the exact failure the
 *  whole certainty field exists to prevent. */
export function applyDowngrade(current, proposed) {
  const ci = CERTAINTY_ORDER.indexOf(current);
  const pi = CERTAINTY_ORDER.indexOf(proposed);
  if (ci < 0 || pi < 0) return current;
  return pi > ci ? proposed : current;
}

/**
 * The whole card stage.
 *
 * @returns {Promise<{cards:Array, stats:object}>} `cards` are the survivors, in render order.
 */
export async function buildPolicyCards({
  relevantItems,
  edition,
  dateLabel,
  env = process.env,
  missingLayers = [],
  missingSeriesPrefixes = [],
  runId = null,
  costCeilingUsd = null,
  log = console.log,
  client = null,
}) {
  const stats = {
    drafted: 0,
    lintedOut: 0,
    reviewRejected: 0,
    downgraded: 0,
    out: 0,
    evidenceDropped: 0,
    lintRules: {},
    rejectionSlots: {},
    aborted: null,
  };

  const api = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const draftModel = env.BRIEF_MODEL || "claude-sonnet-5";
  const reviewModel = env.POLICY_REVIEW_MODEL || env.ANALYST_MODEL || "claude-opus-4-8";

  // ---- inputs ----------------------------------------------------------------------------------
  const packetRows = store.packetsFor(relevantItems.map((i) => i.raw?.eventKey));
  const packetFor = (item) => {
    const p = packetRows.get(item.raw?.eventKey);
    return p && p.sufficiency !== "thin" && p.packet ? p : null;
  };
  const withKeys = relevantItems.filter((i) => i.raw?.eventKey);
  const actions = withKeys.slice(0, 25).map((i) => projectAction(i, packetFor(i)));
  const itemsByUid = new Map(relevantItems.map((i) => [i.uid, i]));
  const validEventKeys = new Set(actions.map((a) => a.eventKey));

  const { universe, series, excludedSeries } = buildEvidenceUniverse({ items: relevantItems, excludeSeriesPrefixes: missingSeriesPrefixes });
  const evidenceMenu = renderEvidenceMenu({ items: relevantItems.slice(0, 40), series });
  // House rule: no silent caps, and no silent exclusions either. A shrunken evidence menu changes
  // what cards are possible, so the count belongs in the log rather than being inferred later.
  if (excludedSeries) {
    log(`   ↳ ${excludedSeries} market series withheld from the evidence menu (stale or from a failed layer)`);
  }
  stats.seriesWithheld = excludedSeries;

  // Threads already carded recently — the model writes an update or skips (see the synthesis prompt).
  const priorMap = store.priorCardsFor([...validEventKeys], PRIOR_CARD_HOURS);
  const priorThreads = [...priorMap.entries()].map(([eventKey, p]) => ({
    eventKey,
    createdAt: p.createdAt,
    certainty: p.certainty,
    whatChanged: String(p.card?.what_changed ?? "").slice(0, 200),
  }));

  if (!actions.length) {
    log("   🃏 Policy cards: no actions carried an event key — nothing to card");
    return { cards: [], stats };
  }

  // ---- cost ceiling, checked before each paid stage ---------------------------------------------
  const overBudget = (stage) => {
    if (!costCeilingUsd || !runId) return false;
    const spent = store.runCostUsd(runId);
    if (spent < costCeilingUsd) return false;
    stats.aborted = `${stage}: run cost $${spent.toFixed(2)} reached the $${costCeilingUsd.toFixed(2)} ceiling`;
    log(`   ⛔ Cost ceiling reached before ${stage} — $${spent.toFixed(2)} of $${costCeilingUsd.toFixed(2)}. Stopping.`);
    return true;
  };

  // ---- 1. draft --------------------------------------------------------------------------------
  if (overBudget("card drafting")) return { cards: [], stats };
  let drafted = await draftCards({
    client: api,
    model: draftModel,
    dateLabel,
    edition,
    actions: actions.slice(0, DRAFT_BUDGET * 3),
    evidenceMenu,
    priorThreads,
    missingLayers,
  });
  if (drafted === null) {
    log("   ⚠️  Policy cards: the draft response was not valid JSON despite the schema — no cards this run");
    return { cards: [], stats };
  }
  // A card citing an event_key that was not supplied is describing something we did not send it.
  drafted = drafted.filter((c) => validEventKeys.has(c?.event_key)).slice(0, DRAFT_BUDGET);
  stats.drafted = drafted.length;
  if (!drafted.length) {
    log("   🃏 Policy cards: none drafted");
    return { cards: [], stats };
  }

  // ---- 2. bind evidence (code) -----------------------------------------------------------------
  const bound = drafted.map((card) => {
    const { evidence, dropped } = bindEvidence(card, universe, itemsByUid);
    stats.evidenceDropped += dropped.length;
    const chain = Array.isArray(card.mechanism?.chain) ? card.mechanism.chain.slice(0, BOUNDS.chain.max) : [];
    return { ...card, mechanism: { ...card.mechanism, chain }, boundEvidence: evidence };
  });
  if (stats.evidenceDropped) {
    log(`   ↳ ${stats.evidenceDropped} cited evidence id${stats.evidenceDropped === 1 ? "" : "s"} did not resolve and ${stats.evidenceDropped === 1 ? "was" : "were"} dropped`);
  }

  // ---- 3. lint (code, before the expensive model) ----------------------------------------------
  const { kept: lintPassed, rejected: lintFailed, ruleCounts } = lintCards(bound, (c) => ({ evidence: c.boundEvidence }));
  stats.lintedOut = lintFailed.length;
  stats.lintRules = ruleCounts;
  for (const { card, failures } of lintFailed) {
    store.insertPolicyCard({
      runId,
      eventKey: card.event_key,
      leadUid: itemsByUid.get(card.event_key)?.uid ?? null,
      edition,
      card,
      certainty: card.certainty ?? "speculative",
      status: "rejected",
      lintFailures: failures.map((f) => `${f.slot}.${f.rule}`),
      rejectSlot: failures[0]?.slot ?? null,
      rejectReason: `lint: ${failures.map((f) => f.detail).join("; ")}`,
    });
  }
  if (lintFailed.length) {
    const summary = Object.entries(ruleCounts).map(([k, n]) => `${k}×${n}`).join(", ");
    log(`   🧹 Lint rejected ${lintFailed.length} of ${bound.length} card${bound.length === 1 ? "" : "s"} — ${summary}`);
  }
  if (!lintPassed.length) {
    log("   🃏 Policy cards: every drafted card failed the six-slot contract — nothing to review");
    return { cards: [], stats };
  }

  // ---- 4. adversarial review (Opus) ------------------------------------------------------------
  let survivors = lintPassed;
  if (overBudget("analyst review")) {
    // Fail-OPEN, and say so loudly. Lint-passing cards are contract-complete; shipping them
    // unreviewed is worse than shipping nothing only if the reader is not told, so the missing
    // review is surfaced in the brief and the run log rather than silently skipped.
    stats.aborted = `${stats.aborted} — cards shipped WITHOUT the adversarial review`;
  } else {
    const verdicts = await reviewCards({
      client: api,
      model: reviewModel,
      dateLabel,
      cards: lintPassed.map(({ boundEvidence, ...c }) => ({ ...c, evidence: boundEvidence.map((e) => `${e.id} [${e.label}]`) })),
      evidenceMenu,
    });
    if (verdicts === null) {
      log("   ⚠️  Review response was not valid JSON — cards ship unreviewed, and the brief says so");
      stats.aborted = "the adversarial review failed to parse; cards shipped unreviewed";
    } else {
      const byIndex = new Map(verdicts.map((v) => [v.card_index, v]));
      survivors = [];
      lintPassed.forEach((card, i) => {
        const v = byIndex.get(i);
        // ⚠️ A card with NO verdict is KEPT, not dropped. A reviewer that returns a short list
        // would otherwise silently delete the brief, and "the reviewer forgot to mention it" is not
        // evidence against a card that already passed the contract.
        if (!v || v.verdict === "keep") {
          survivors.push(card);
          return;
        }
        if (v.verdict === "reject") {
          // A rejection that cannot name a slot is not a rejection — the prompt says so, and this
          // enforces it rather than trusting the model to comply.
          if (!v.failed_slot || v.failed_slot === "none") {
            survivors.push(card);
            return;
          }
          stats.reviewRejected++;
          stats.rejectionSlots[v.failed_slot] = (stats.rejectionSlots[v.failed_slot] ?? 0) + 1;
          store.insertPolicyCard({
            runId,
            eventKey: card.event_key,
            leadUid: itemsByUid.get(card.event_key)?.uid ?? null,
            edition,
            card,
            certainty: card.certainty,
            status: "rejected",
            rejectSlot: v.failed_slot,
            rejectReason: v.reason || "(no reason given)",
          });
          return;
        }
        if (v.verdict === "downgrade") {
          const next = applyDowngrade(card.certainty, v.corrected_certainty);
          if (next !== card.certainty) {
            stats.downgraded++;
            survivors.push({ ...card, certainty: next, downgradedFrom: card.certainty, downgradeReason: v.reason || "" });
            return;
          }
          survivors.push(card);
        }
      });
      log(
        `   ⚖️  Review: ${survivors.length} kept, ${stats.reviewRejected} rejected` +
          `${stats.downgraded ? `, ${stats.downgraded} certainty downgraded` : ""}` +
          `${stats.reviewRejected ? ` (slots: ${Object.entries(stats.rejectionSlots).map(([s, n]) => `${s}×${n}`).join(", ")})` : ""}`
      );
    }
  }

  // ---- 5. file the survivors -------------------------------------------------------------------
  for (const card of survivors) {
    store.insertPolicyCard({
      runId,
      eventKey: card.event_key,
      leadUid: itemsByUid.get(card.event_key)?.uid ?? null,
      edition,
      card,
      certainty: card.certainty,
      status: "kept",
      downgradedFrom: card.downgradedFrom ?? null,
    });
  }
  stats.out = survivors.length;

  // Render order: procedural reality first (a final rule outranks a rumour), then the nearest clock.
  const certaintyRank = (c) => CERTAINTY_ORDER.indexOf(c.certainty ?? "speculative");
  const clockOf = (c) => c.posture?.clock_date || "9999-12-31";
  survivors.sort((a, b) => certaintyRank(a) - certaintyRank(b) || clockOf(a).localeCompare(clockOf(b)));

  log(`   🃏 Policy cards: ${stats.drafted} drafted → ${stats.lintedOut} lint-rejected → ${stats.reviewRejected} review-rejected → ${stats.out} in the brief`);
  return { cards: survivors, stats };
}

export const __testing = { projectAction, CERTAINTY_ORDER, DRAFT_BUDGET };
